// Reading a workspace's journal (container/scripts/journal.sh) straight from Artifacts, for the
// History page: what changed in each commit, file contents at any point, and what happened while
// nobody was looking. Nothing here needs the workspace to be awake.

/** A commit as the History page lists it. */
export interface Entry {
  hash: string;
  at: number;
  message: string;
  /** What made it, from the message journal.sh and its hooks write. */
  kind: "agent" | "shell" | "edits" | "restore" | "home" | "baseline";
  parent?: string;
}

export interface Change {
  path: string;
  status: "A" | "M" | "D";
  /** Blob hashes before and after. */
  from?: string;
  to?: string;
}

/** Journal branches: "home" or "work/<project>". */
export const BRANCH = /^(home|work\/[A-Za-z0-9._\/-]{1,200})$/;
export const COMMIT = /^[0-9a-f]{40}$/;
/** A repository-relative path that cannot climb out of its root. */
export function safePath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "");
}

export function kindOf(message: string): Entry["kind"] {
  if (/^\S+ (done|idle|blocked) in /.test(message)) return "agent";
  if (message.startsWith("shell: ")) return "shell";
  if (/^(before restoring|restored) /.test(message)) return "restore";
  if (message.startsWith("home ")) return "home";
  if (message.startsWith("baseline ")) return "baseline";
  return "edits";
}

export const entry = (c: ArtifactsCommitMetadata): Entry => ({ hash: c.hash, at: c.committedAt * 1000, message: c.message.trim(), kind: kindOf(c.message.trim()), parent: c.parents[0] });

/** Files that differ between two trees (either may be absent), descending only into subtrees
 *  whose hashes differ, so a minute's change in a big tree costs a few reads. Stops after `max`. */
export async function diffTrees(repo: ArtifactsRepo, a: string | undefined, b: string | undefined, max = 400): Promise<{ changes: Change[]; more: boolean }> {
  const changes: Change[] = [];
  let reads = 0;
  let more = false;
  const walk = async (x: string | undefined, y: string | undefined, prefix: string): Promise<void> => {
    if (x === y || more) return;
    if (++reads > 300) {
      more = true;
      return;
    }
    const [ex, ey] = await Promise.all([x ? repo.readTree(x) : null, y ? repo.readTree(y) : null]);
    const left = new Map((ex ?? []).map((e) => [e.name, e]));
    const right = new Map((ey ?? []).map((e) => [e.name, e]));
    for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const l = left.get(name);
      const r = right.get(name);
      if (l?.hash === r?.hash) continue;
      const path = prefix + name;
      const lt = l?.type === "tree";
      const rt = r?.type === "tree";
      if (lt || rt) await walk(lt ? l!.hash : undefined, rt ? r!.hash : undefined, path + "/");
      if ((l && !lt) || (r && !rt)) {
        if (changes.length >= max) {
          more = true;
          return;
        }
        const from = l && !lt ? l.hash : undefined;
        const to = r && !rt ? r.hash : undefined;
        changes.push({ path, status: from && to ? "M" : to ? "A" : "D", from, to });
      }
      if (more) return;
    }
  };
  await walk(a, b, "");
  return { changes, more };
}

/** The changes a commit made against its first parent. */
export async function commitChanges(repo: ArtifactsRepo, hash: string): Promise<{ changes: Change[]; more: boolean } | null> {
  const c = await repo.readCommit(hash);
  if (!c) return null;
  const parent = c.parents[0] ? await repo.readCommit(c.parents[0]) : null;
  return diffTrees(repo, parent?.treeHash, c.treeHash);
}

/** Drop terminal escape sequences from a saved pane screen. */
export function plain(screen: string): string {
  return screen
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "");
}

/** Lines of a tab- or space-separated log whose first field (an ISO time) is after `since`. */
export function logSince(text: string, since: number, max: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = Date.parse(line.slice(0, line.search(/[\t ]/)));
    if (t > since) out.push(line);
  }
  return out.slice(-max);
}

export async function text(repo: ArtifactsRepo, ref: string, path: string): Promise<string> {
  try {
    return (await (await repo.readFile({ ref, path }))?.text()) ?? "";
  } catch {
    return "";
  }
}
