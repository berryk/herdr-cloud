// The History page (a workspace's journal: what changed, diffs, restores, forks and shares) and
// the Storage page. Everything shown here comes from inside a workspace, which agents control, so
// the pages build it with textContent, never as HTML.

const DIFF = "https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js";

const STYLE = String.raw`body{font:15px system-ui;background:#111;color:#ddd;max-width:980px;margin:3vh auto;padding:0 16px}
a{color:#8cf}h1{margin:8px 0}h2{font-size:18px;margin:28px 0 8px}small,.dim{color:#888}
button,select,input{font:inherit;font-size:14px;padding:5px 10px;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:#eee;cursor:pointer}
button:disabled{opacity:.5;cursor:default}button.go{border-color:#5a8;color:#9e9}button.warn{border-color:#a73;color:#eb8}
.card{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:12px 14px;margin:10px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grow{flex:1}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.tabs button.on{background:#2a4a6a;border-color:#4a7aa0}
.day{color:#999;font-size:13px;margin:16px 0 4px;border-bottom:1px solid #2a2a2a;padding-bottom:3px}
.c{border-bottom:1px solid #1f1f1f}.c>.h{display:flex;gap:10px;padding:7px 2px;cursor:pointer;align-items:baseline}.c>.h:hover{background:#181818}
.t{color:#888;font-size:13px;white-space:nowrap;font-variant-numeric:tabular-nums}.msg{flex:1;min-width:0;overflow-wrap:anywhere}
.k{font-size:11px;padding:1px 6px;border-radius:9px;white-space:nowrap;background:#262626;color:#aaa}
.k.agent{background:#1d3b2a;color:#8e8}.k.shell{background:#1d2c3f;color:#8bf}.k.restore{background:#3f301d;color:#eb8}
.body{padding:4px 0 12px 12px}.files{list-style:none;padding:0;margin:6px 0}
.files li{display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:14px}.files .p{font-family:ui-monospace,monospace;overflow-wrap:anywhere;flex:1;min-width:0}
.st{font-family:ui-monospace,monospace;width:1.2em;text-align:center}.st.A{color:#8e8}.st.D{color:#e88}.st.M{color:#eb8}
.files button{font-size:12px;padding:1px 7px}
pre{background:#0c0c0c;border:1px solid #2a2a2a;border-radius:6px;padding:8px;overflow:auto;font-size:12.5px;line-height:1.4;max-height:60vh;margin:6px 0}
.diff div{white-space:pre;font-family:ui-monospace,monospace;font-size:12.5px;line-height:1.45;padding:0 6px}
.diff .add{background:#12301c;color:#b6f0c4}.diff .del{background:#3a1717;color:#f3bcbc}.diff .gap{color:#777;background:#161616;font-style:italic}
dialog{background:#141414;color:#ddd;border:1px solid #333;border-radius:10px;width:min(1100px,94vw);max-height:90vh;padding:0}
dialog::backdrop{background:rgba(0,0,0,.7)}dialog .dh{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid #2a2a2a;position:sticky;top:0;background:#141414}
dialog .db{padding:8px 12px;overflow:auto;max-height:calc(90vh - 60px)}dialog .diff{overflow:auto;border:1px solid #2a2a2a;border-radius:6px}
.stat{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0}.stat b{font-size:22px;color:#fff;display:block}
#msg{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#222;border:1px solid #444;border-radius:8px;padding:8px 14px;display:none;max-width:90vw}
code{background:#1a1a1a;padding:1px 4px;border-radius:4px;font-size:13px;overflow-wrap:anywhere}
@media (max-width:600px){body{margin:2vh auto}.c>.h{flex-wrap:wrap}.t{order:-1}}`;

export function historyPage(name: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>History · ${name}</title><style>${STYLE}</style><script src="${DIFF}"></script></head>
<body><p class="row"><a href="/">← workspaces</a><span class="dim">·</span><a href="/w/${name}">open ${name}</a><span class="dim">·</span><a href="/storage">storage</a></p>
<h1>History of ${name}</h1>
<p class="dim" id="state">loading…</p>
<p class="dim">Every minute, and after every agent turn and every shell command that changes a project, the workspace saves its projects' files (uncommitted ones too) and its home folder's settings and conversations. Look back, compare, and put any file or project back as it was. Restores take a snapshot first, so you can undo them here too; your git branches and commits are never changed.</p>

<h2>While you were away</h2>
<div class="card" id="away"><div class="row"><span>Since</span><select id="since"></select><span class="grow"></span><button id="sum" title="Runs Claude inside the workspace (wakes it)">Summarise with Claude</button></div><div id="awayout" class="dim">loading…</div></div>

<h2>Timeline</h2>
<div class="row"><div class="tabs" id="tabs"></div><span class="grow"></span><select id="repo" hidden title="Older months are kept for a while"></select></div>
<div id="log"></div><p><button id="more" hidden>Show older</button></p>

<dialog id="dlg"><div class="dh"><b id="dt" class="grow" style="overflow-wrap:anywhere"></b><span id="dact" class="row"></span><button id="dclose">Close</button></div><div class="db" id="dbody"></div></dialog>
<div id="msg"></div>
<script>
const NAME = ${JSON.stringify(name)};
const api = (op, q) => "/w/" + NAME + "/j/" + op + (q ? "?" + new URLSearchParams(q) : "");
const $ = id => document.getElementById(id);
const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids) if (k != null) e.append(k); return e; };
const fmt = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayOf = t => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
const label = b => b === "home" ? "Home folder" : b.slice(5);
const short = h => h.slice(0, 8);
function toast(t, ms) { const m = $("msg"); m.textContent = t; m.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(() => m.style.display = "none", ms || 4000); }
async function post(op, body) { const r = await fetch(api(op), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return r.json().catch(() => ({ ok: false, error: "HTTP " + r.status })); }

let INFO, repo, branch, offset = 0;

// ---- dialogs: diff, file view, browse, share, fork ----
function dialog(title, actions, body) {
  $("dt").textContent = title; $("dact").replaceChildren(...actions); $("dbody").replaceChildren(body); if (!$("dlg").open) $("dlg").showModal();
}
$("dclose").onclick = () => $("dlg").close();
async function blobText(hash, rp) {
  if (!hash) return "";
  const r = await fetch(api("blob", { repo: rp || repo, hash }));
  if (!r.ok) throw new Error(await r.text());
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.slice(0, 8000).includes(0)) throw new Error("binary file (" + b.length + " bytes)");
  return new TextDecoder().decode(b);
}
function renderDiff(a, b) {
  const box = el("div", { className: "diff" });
  const parts = Diff.diffLines(a, b);
  if (parts.length === 1 && !parts[0].added && !parts[0].removed) { box.append(el("div", { className: "gap", textContent: "no changes" })); return box; }
  const CTX = 3;
  parts.forEach((p, i) => {
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.added || p.removed) { for (const l of lines) box.append(el("div", { className: p.added ? "add" : "del", textContent: (p.added ? "+ " : "- ") + l })); return; }
    const head = i === 0 ? [] : lines.slice(0, CTX), tail = i === parts.length - 1 ? [] : lines.slice(-CTX);
    if (lines.length <= head.length + tail.length + 1) { for (const l of lines) box.append(el("div", { textContent: "  " + l })); return; }
    for (const l of head) box.append(el("div", { textContent: "  " + l }));
    box.append(el("div", { className: "gap", textContent: "⋯ " + (lines.length - head.length - tail.length) + " unchanged lines" }));
    for (const l of tail) box.append(el("div", { textContent: "  " + l }));
  });
  return box;
}
/** A file's change: from blob A to blob B. restoreTo lists [label, commit] restore buttons; ctx
 *  names the repo and branch when they are not the timeline's. */
async function showDiff(path, from, to, restoreTo, ctx) {
  const acts = restoreTo.filter(r => r[1]).map(([lab, commit]) => { const b = el("button", { className: "warn", textContent: lab }); b.onclick = () => restore(commit, path, b, ctx); return b; });
  dialog(path, acts, el("p", { className: "dim", textContent: "loading…" }));
  try { $("dbody").replaceChildren(renderDiff(await blobText(from, ctx && ctx.repo), await blobText(to, ctx && ctx.repo))); }
  catch (e) { $("dbody").replaceChildren(el("p", { className: "dim", textContent: String(e.message || e) })); }
}
async function browse(commit, path) {
  const up = el("button", { textContent: "Up", disabled: !path }); up.onclick = () => browse(commit, path.split("/").slice(0, -1).join("/"));
  dialog(label(branch) + " at " + short(commit) + (path ? " / " + path : ""), [up], el("p", { className: "dim", textContent: "loading…" }));
  const r = await fetch(api("tree", { repo, commit, path })); const items = r.ok ? await r.json() : [];
  const ul = el("ul", { className: "files" });
  for (const it of items) {
    const p = (path ? path + "/" : "") + it.name;
    const a = el("a", { href: "#", textContent: it.name + (it.type === "tree" ? "/" : ""), className: "p" });
    a.onclick = e => { e.preventDefault(); it.type === "tree" ? browse(commit, p) : viewFile(commit, p, it.hash); };
    ul.append(el("li", {}, a));
  }
  $("dbody").replaceChildren(items.length ? ul : el("p", { className: "dim", textContent: "empty" }));
}
async function viewFile(commit, path, hash) {
  const back = el("button", { textContent: "Back" }); back.onclick = () => browse(commit, path.split("/").slice(0, -1).join("/"));
  const rb = el("button", { className: "warn", textContent: "Restore this file" }); rb.onclick = () => restore(commit, path, rb);
  dialog(path + " at " + short(commit), [back, rb], el("p", { className: "dim", textContent: "loading…" }));
  try { $("dbody").replaceChildren(el("pre", { textContent: await blobText(hash) })); }
  catch (e) { $("dbody").replaceChildren(el("p", { className: "dim", textContent: String(e.message || e) })); }
}
async function restore(commit, path, btn, ctx) {
  const at = ctx || { repo, branch };
  const what = path ? path : "every file in " + label(at.branch);
  if (!confirm("Put " + what + " back as it was at " + short(commit) + "?\n\nThis wakes the workspace if it is asleep. A snapshot is taken first, so you can undo it from this page.")) return;
  if (btn) { btn.disabled = true; btn.textContent = "restoring…"; }
  const r = await post("restore", { repo: at.repo, branch: at.branch, commit, path: path || undefined });
  if (btn) { btn.disabled = false; btn.textContent = r.ok ? "restored" : "failed"; }
  toast(r.ok ? "Restored " + what + "." : "Restore failed: " + r.error, r.ok ? 4000 : 9000);
  if (r.ok) { offset = 0; loadLog(); }
}
function share(commit) {
  const days = el("select", {}, ...[["1 day", 1], ["7 days", 7], ["30 days", 30]].map(([t, v]) => el("option", { value: v, textContent: t, selected: v === 7 })));
  const go = el("button", { className: "go", textContent: "Create link" });
  const out = el("div", {});
  dialog("Share " + label(branch) + " at " + short(commit), [], el("div", {},
    el("p", { textContent: "Makes a read-only copy of this project's files as they were at this point, with no history and nothing from your home folder, and a token to clone it. Anyone with the token can read it until it expires. This wakes the workspace if it is asleep." }),
    el("div", { className: "row" }, el("span", { textContent: "Expires after" }), days, go), out));
  go.onclick = async () => {
    go.disabled = true; go.textContent = "creating…";
    const r = await post("share", { repo, branch, commit, days: Number(days.value) });
    go.textContent = r.ok ? "created" : "Create link"; go.disabled = r.ok;
    if (!r.ok) { out.replaceChildren(el("p", { textContent: "Failed: " + r.error })); return; }
    const cmd = "git -c http.extraHeader=\"Authorization: Bearer " + r.token + "\" clone " + r.remote + " " + label(branch).replace(/[^A-Za-z0-9._-]+/g, "-");
    const copy = el("button", { textContent: "Copy" }); copy.onclick = () => navigator.clipboard.writeText(cmd).then(() => copy.textContent = "copied");
    out.replaceChildren(el("p", { textContent: "Send this to whoever needs it; it is shown only now. It expires " + new Date(r.expires).toLocaleString() + ". Delete the share below to cut access sooner." }), el("pre", { textContent: cmd }), copy);
    loadInfo();
  };
}
function forkFrom(at, what) {
  const inp = el("input", { placeholder: "new workspace name", value: NAME + "-fork" });
  const go = el("button", { className: "go", textContent: "Fork" });
  const out = el("div", {});
  dialog("Fork " + NAME + " " + what, [], el("div", {},
    el("p", { textContent: "Makes a new workspace: a copy of this one's home folder (projects with their git history, settings, conversations, installed tools), with every project and your settings put back as they were at " + new Date(at).toLocaleString() + ". Agents in the fork resume the conversations as they stood then. This workspace is not changed." }),
    el("div", { className: "row" }, inp, go), out));
  go.onclick = async () => {
    go.disabled = true; go.textContent = "copying…";
    const r = await fetch("/w/" + NAME + "/fork", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: inp.value, at }) }).then(r => r.json()).catch(() => ({ ok: false, error: "failed" }));
    go.disabled = false; go.textContent = "Fork";
    if (!r.ok) { out.replaceChildren(el("p", { textContent: "Failed: " + r.error })); return; }
    out.replaceChildren(el("p", {}, "Created. ", el("a", { href: "/w/" + r.name, textContent: "Open " + r.name }), " (its first start takes about a minute)."));
  };
}

// ---- the timeline ----
function filesList(changes, more, commit, parent) {
  const ul = el("ul", { className: "files" });
  for (const c of changes) {
    const d = el("button", { textContent: "diff" }); d.onclick = () => showDiff(c.path, c.from, c.to, [["Restore to before this", parent], ["Restore to after this", commit]]);
    ul.append(el("li", {}, el("span", { className: "st " + c.status, textContent: c.status }), el("span", { className: "p", textContent: c.path }), d));
  }
  if (more) ul.append(el("li", { className: "dim", textContent: "and more…" }));
  if (!changes.length) ul.append(el("li", { className: "dim", textContent: "no file changes" }));
  return ul;
}
function commitRow(c) {
  const h = el("div", { className: "h" }, el("span", { className: "t", textContent: fmt(c.at) }), el("span", { className: "k " + c.kind, textContent: c.kind }), el("span", { className: "msg", textContent: c.message.split("\n")[0] }));
  const body = el("div", { className: "body", hidden: true });
  const row = el("div", { className: "c" }, h, body);
  h.onclick = async () => {
    body.hidden = !body.hidden; if (body.hidden || body.dataset.done) return;
    body.dataset.done = 1; body.replaceChildren(el("span", { className: "dim", textContent: "loading…" }));
    const r = await fetch(api("changes", { repo, commit: c.hash })); const d = r.ok ? await r.json() : { changes: [] };
    const acts = el("div", { className: "row" });
    const add = (t, f, cls) => { const b = el("button", { textContent: t, className: cls || "" }); b.onclick = () => f(b); acts.append(b); };
    add("Browse files", () => browse(c.hash, ""));
    if (branch !== "home") add("Restore project to here", b => restore(c.hash, "", b), "warn");
    add("Fork from here", () => forkFrom(c.at, "from " + fmt(c.at) + " on " + dayOf(c.at)));
    if (branch !== "home") add("Share", () => share(c.hash));
    const extra = c.message.split("\n").slice(1).join("\n").trim();
    body.replaceChildren(...(extra ? [el("div", { className: "dim", textContent: extra })] : []), filesList(d.changes, d.more, c.hash, c.parent), acts);
  };
  return row;
}
let lastDay = "";
async function loadLog() {
  if (offset === 0) { $("log").replaceChildren(el("p", { className: "dim", textContent: "loading…" })); lastDay = ""; }
  const r = await fetch(api("log", { repo, branch, offset, limit: 60 })); const list = r.ok ? await r.json() : [];
  if (offset === 0) $("log").replaceChildren();
  for (const c of list) {
    const d = dayOf(c.at); if (d !== lastDay) { $("log").append(el("div", { className: "day", textContent: d })); lastDay = d; }
    $("log").append(commitRow(c));
  }
  if (offset === 0 && !list.length) $("log").append(el("p", { className: "dim", textContent: "Nothing saved yet." }));
  offset += list.length; $("more").hidden = list.length < 60;
}
$("more").onclick = loadLog;
function tabs() {
  const r = INFO.repos.find(x => x.repo === repo);
  const bs = [...r.branches.filter(b => b !== "home"), ...r.branches.filter(b => b === "home")];
  if (!bs.includes(branch)) branch = bs[0];
  $("tabs").replaceChildren(...bs.map(b => { const t = el("button", { textContent: label(b), className: b === branch ? "on" : "" }); t.onclick = () => { branch = b; offset = 0; tabs(); loadLog(); }; return t; }));
}
$("repo").onchange = () => { repo = $("repo").value; offset = 0; tabs(); loadLog(); };

// ---- while you were away ----
async function loadAway() {
  const since = Number($("since").value);
  $("awayout").replaceChildren(el("span", { className: "dim", textContent: "loading…" }));
  const r = await fetch(api("away", since ? { since } : {})); const a = r.ok ? await r.json() : null;
  if (!a) { $("awayout").textContent = "unavailable"; return; }
  const out = [];
  const nCmd = (a.commands || []).length;
  out.push(el("div", { className: "stat" }, ...[[a.turns, "agent turns"], [a.files, "files changed"], [nCmd, "shell commands"], [a.projects.length, "projects touched"]].map(([n, t]) => el("span", {}, el("b", { textContent: n }), el("small", { textContent: t })))));
  if (a.watching) out.push(el("p", { className: "dim", textContent: "Someone is connected to the workspace now, so this period is still running." }));
  for (const p of a.projects) {
    const box = el("div", { className: "card" }, el("b", { textContent: label(p.branch) }), el("span", { className: "dim", textContent: " · " + p.turns + " agent turns · " + p.changes.length + (p.more ? "+" : "") + " files" }));
    if (p.agentTurns.length) box.append(el("ul", { className: "files" }, ...p.agentTurns.map(t => el("li", {}, el("span", { className: "t", textContent: fmt(t.at) }), el("span", { className: "msg", textContent: t.message.split("\n")[0] })))));
    const ul = el("ul", { className: "files" });
    for (const c of p.changes) {
      const d = el("button", { textContent: "diff" });
      d.onclick = () => showDiff(c.path, c.from, c.to, [["Undo these changes", p.from]], { repo: INFO.repos[0].repo, branch: p.branch });
      ul.append(el("li", {}, el("span", { className: "st " + c.status, textContent: c.status }), el("span", { className: "p", textContent: c.path }), d));
    }
    if (p.more) ul.append(el("li", { className: "dim", textContent: "and more…" }));
    box.append(ul);
    if (p.from) { const u = el("button", { className: "warn", textContent: "Undo all of it in " + label(p.branch) }); u.onclick = () => restore(p.from, "", u, { repo: INFO.repos[0].repo, branch: p.branch }); box.append(u); }
    out.push(box);
  }
  if (nCmd) out.push(el("details", {}, el("summary", { textContent: "Shell commands (" + nCmd + ")" }), el("pre", { textContent: a.commands.map(c => fmt(Date.parse(c.at)) + "  " + (c.code ? "[exit " + c.code + "] " : "") + c.cwd + " $ " + c.cmd).join("\n") })));
  for (const s of a.screens || []) out.push(el("details", {}, el("summary", { textContent: "Shell pane " + s.pane + ", as last saved" }), el("pre", { textContent: s.text })));
  if (!a.projects.length && !nCmd) out.push(el("p", { className: "dim", textContent: "Nothing changed in this period." }));
  $("awayout").replaceChildren(...out);
}
$("since").onchange = loadAway;
$("sum").onclick = async () => {
  const b = $("sum"); b.disabled = true; b.textContent = "asking Claude…";
  const since = Number($("since").value);
  const r = await post("summary", since ? { since } : {});
  b.disabled = false; b.textContent = "Summarise with Claude";
  $("awayout").prepend(el("div", { className: "card" }, el("b", { textContent: "Claude's summary" }), el("pre", { textContent: r.ok ? r.summary : "Failed: " + r.error, style: "white-space:pre-wrap" })));
};

async function loadInfo() {
  INFO = await (await fetch(api("info"))).json();
  const st = [INFO.running ? "Running" : "Asleep", INFO.lastSeenAt ? "last looked at " + ago(INFO.lastSeenAt) : ""];
  if (INFO.forkedFrom) st.push("forked from " + INFO.forkedFrom.from + " as it was " + new Date(INFO.forkedFrom.at).toLocaleString());
  $("state").textContent = st.filter(Boolean).join(" · ");
  const sh = $("shares") || el("div", { id: "shares" });
  if (INFO.shares.length) {
    sh.replaceChildren(el("h2", { textContent: "Shared copies" }), ...INFO.shares.map(s => {
      const del = el("button", { className: "warn", textContent: "Delete" });
      del.onclick = async () => { if (!confirm("Delete this share? The link stops working.")) return; await fetch(api("share", { repo: s.repo }), { method: "DELETE" }); loadInfo(); };
      return el("div", { className: "card row" }, el("span", { className: "grow", textContent: label(s.branch) + " at " + short(s.commit) + " · shared " + ago(s.created) + " · expires " + new Date(s.expires).toLocaleString() }), del);
    }));
    $("log").after(sh);
  } else sh.remove();
}
(async () => {
  await loadInfo();
  if (!INFO.enabled) { $("awayout").textContent = "This workspace has no history yet: it starts saving once the workspace has run for a minute."; $("log").replaceChildren(); return; }
  const seen = INFO.lastSeenAt;
  const opts = [[seen, seen ? "you last looked (" + ago(seen) + ")" : "you last looked"], [Date.now() - 3600e3, "the last hour"], [new Date().setHours(0, 0, 0, 0), "today began"], [Date.now() - 86400e3, "24 hours ago"], [Date.now() - 7 * 86400e3, "7 days ago"]];
  $("since").replaceChildren(...opts.filter(o => o[0]).map(([v, t]) => el("option", { value: v, textContent: t })));
  repo = INFO.repos[0].repo;
  if (INFO.repos.length > 1) {
    $("repo").hidden = false;
    $("repo").replaceChildren(...INFO.repos.map(r => el("option", { value: r.repo, textContent: r.current ? "This month" : "From " + new Date(r.started).toLocaleDateString([], { month: "long", day: "numeric" }) })));
  }
  tabs(); loadLog(); loadAway();
})();
</script></body></html>`;
}

export const storagePage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Storage · herdr-cloud</title><style>${STYLE}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #222;vertical-align:top}th{color:#999;font-weight:500}td.n{text-align:right;white-space:nowrap}
@media (max-width:600px){table.ws thead{display:none}table.ws tr{display:block;border-bottom:1px solid #2a2a2a;padding:6px 0}table.ws td{display:flex;justify-content:space-between;border:0;padding:2px 0}table.ws td::before{content:attr(data-l);color:#888}td.n{text-align:right}}</style></head>
<body><p><a href="/">← herdr-cloud</a></p><h1>Storage</h1>
<p class="dim">What each workspace keeps while it sleeps. The <b>home archive</b> (R2) is a copy of your home folder: projects, settings, conversations, installed tools. The <b>snapshot</b> is the whole disk, kept by Cloudflare Containers, so waking is quick. The <b>history</b> (Artifacts) is the minute-by-minute record behind each workspace's History page; a month's history is kept for two months after it ends.</p>
<div id="out">loading…</div>
<script>
const $ = id => document.getElementById(id);
const el = (tag, props, ...kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); for (const k of kids) if (k != null) e.append(k); return e; };
const mb = b => b == null ? "–" : b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
const ago = t => { if (!t) return ""; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
function cell(l, main, sub, num) { const t = el("td", { className: num ? "n" : "" }, main, sub ? el("small", { textContent: " " + sub }) : null); t.dataset.l = l; return t; }
function wsTable(rows, owner) {
  const head = ["Workspace", ...(owner ? ["Owner"] : []), "Home archive", "Snapshot", "History", "Shares"];
  return el("table", { className: "ws" }, el("thead", {}, el("tr", {}, ...head.map(h => el("th", { textContent: h })))),
    el("tbody", {}, ...rows.map(w => el("tr", {},
      cell("Workspace", owner ? el("span", { textContent: w.name }) : el("a", { href: "/w/" + w.name + "/history", textContent: w.name })),
      ...(owner ? [cell("Owner", w.owner)] : []),
      cell("Home archive", mb(w.home && w.home.size), w.home ? ago(w.home.at) : "", true),
      cell("Snapshot", mb(w.snapshot && w.snapshot.size), w.snapshot ? ago(w.snapshot.at) : "", true),
      cell("History", w.journal ? "~" + mb((w.journal.sizeKB || 0) * 1024) : "–", w.journal && w.journal.older ? "+" + w.journal.older + " older" : "", true),
      cell("Shares", String(w.shares || 0), "", true)))));
}
(async () => {
  const d = await (await fetch("/api/storage")).json();
  const out = [];
  const r2 = d.workspaces.reduce((t, w) => t + ((w.home && w.home.size) || 0), 0) + ((d.chrome && d.chrome.size) || 0);
  out.push(el("h2", { textContent: "Your workspaces" }), d.workspaces.length ? wsTable(d.workspaces) : el("p", { className: "dim", textContent: "None yet." }));
  out.push(el("p", { className: "dim", textContent: "Chrome sign-ins (encrypted, shared by your workspaces): " + (d.chrome ? mb(d.chrome.size) + ", saved " + ago(d.chrome.at) : "none") + ". Your R2 total: " + mb(r2) + ". R2 costs $0.015 per GB a month after the account's first 10 GB; snapshot and Artifacts storage prices are not published yet." }));
  if (d.everyone) {
    out.push(el("h2", { textContent: "Everyone (admin)" }), wsTable(d.everyone, true));
    const o = d.orphans;
    out.push(el("h2", { textContent: "Leftovers (admin)" }), el("p", { className: "dim", textContent: "Stored, but no workspace, share or saved sign-in refers to them any more (for example after a workspace was deleted mid-upload, or from before a change). Safe to delete." }));
    const del = (kind, id, row) => { const b = el("button", { className: "warn", textContent: "Delete" }); b.onclick = async () => { if (!confirm("Delete " + id + " for good?")) return; const r = await fetch("/api/storage/" + kind + "?" + new URLSearchParams(kind === "object" ? { key: id } : { name: id }), { method: "DELETE" }).then(r => r.json()); if (r.ok) row.remove(); else alert(r.error); }; return b; };
    const rows = [...o.objects.map(x => { const tr = el("tr", {}, el("td", { textContent: "R2" }), el("td", { textContent: x.key, style: "overflow-wrap:anywhere" }), el("td", { className: "n", textContent: mb(x.size) }), el("td", { className: "n", textContent: ago(Date.parse(x.uploaded)) })); tr.append(el("td", {}, del("object", x.key, tr))); return tr; }),
      ...o.repos.map(x => { const tr = el("tr", {}, el("td", { textContent: "Artifacts" }), el("td", { textContent: x.name, style: "overflow-wrap:anywhere" }), el("td", { className: "n", textContent: "" }), el("td", { className: "n", textContent: ago(Date.parse(x.lastPushAt || x.createdAt)) })); tr.append(el("td", {}, del("repo", x.name, tr))); return tr; })];
    out.push(rows.length ? el("table", {}, el("tbody", {}, ...rows)) : el("p", { className: "dim", textContent: "None." }));
  }
  $("out").replaceChildren(...out);
})();
</script></body></html>`;
