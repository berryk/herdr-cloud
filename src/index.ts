import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { benchmarksPage, connectPage, costsPage, indexPage, peoplePage, settingsPage, terminalPage, tooManyPage } from "./page.js";
import { INSTANCES, PRICE, SIZES, bill, cost, emptyUsage, hourly, month, type Usage } from "./meter.js";
import { identify, type AuthEnv, type Identity } from "./auth.js";
import { caPublicLine, signHostKey } from "./sshcert.js";
import { SecretsUpdate, applyUpdate, seal, sealBytes, unseal, unsealBytes, view, type Sealed, type Secrets, type SecretsView } from "./secrets.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOME = "/home/dev";
const WORK = `${HOME}/work`;
const PATH = `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

/** KasmVNC web client for the agent browser (container/scripts/browser.sh). */
const BROWSER_PORT = 6901;
/** RFB client messages that mean a person is there: KeyEvent, PointerEvent, and QEMU extended
 *  key events (255), which KasmVNC's raw keyboard sends. An idle viewer sends nothing. */
const RFB_INPUT = new Set([4, 5, 255]);

const Size = z.object({ cols: z.int().min(1).max(500), rows: z.int().min(1).max(500) });

interface Env extends AuthEnv {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  IDLE_MINUTES: string;
  CHECK_MINUTES: string;
  /** Default workspace size (Cloudflare instance type). */
  INSTANCE: string;
  /** Sizes users may choose, comma-separated (default: every size in SIZES). */
  ALLOWED_INSTANCES?: string;
  SAFETY_HOURS: string;
  /** Minutes between home archives while a workspace is in use (default 30). */
  BACKUP_MINUTES?: string;
  /** Workspaces each non-admin user may have (default 3). */
  MAX_WORKSPACES?: string;
  /** The admin's fallbacks when their settings do not set these. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  GITHUB_TOKEN?: string;
  /** Ed25519 private key (PKCS#8 DER, base64) that signs workspaces' SSH host keys (src/sshcert.ts). */
  SSH_CA_KEY?: string;
  /** 32 random bytes, base64: encrypts each user's stored secrets. */
  SECRETS_KEY?: string;
  /** Home-folder archives: carry ~/ across image upgrades, and a second copy beside the snapshot. */
  HOMES: R2Bucket;
  /** The workspace journal: git repos per workspace (see container/scripts/journal.sh). */
  ARTIFACTS?: Artifacts;
  /** Older journal repos kept after a rollover, in months (default 2). */
  JOURNAL_KEEP_MONTHS?: string;
  /** Roll over early once a journal's history passes this many MB (default 600; repos cap at 1 GB). */
  JOURNAL_ROLLOVER_MB?: string;
  /** Untracked project files bigger than this many MB are left out of snapshots (default 25). */
  JOURNAL_MAX_FILE_MB?: string;
}

interface State {
  name?: string;
  snapshotId?: string;
  /** Image the snapshot was taken from. Snapshots only restore onto that image. */
  snapshotImage?: string;
  /** Image the running container came from (unset for containers started before we tracked it). */
  runningImage?: string;
  /** Size chosen for this workspace (default INSTANCE); applies at its next start. */
  instance?: string;
  /** Size the running container started with, and the size the snapshot was taken on. */
  runningInstance?: string;
  snapshotInstance?: string;
  /** Last good archive of /home/dev in HOMES. */
  homeBackup?: { key: string; at: number; size: number };
  /** "Sleep now" was pressed; the next alarm checkpoints regardless of activity. */
  sleepRequested?: boolean;
  lastActivity?: number;
  restorePending?: boolean;
  lastCheckpoint?: { id: string; at: number; size: number };
  /** When the alarm next runs the idle check (it runs the journal every minute). */
  nextCheck?: number;
  /** Metering cursor for the running container. */
  meter?: { at: number; cpuUsec: number; instance: string };
  journal?: Journal;
  /** Hash of each saved login's file as this workspace last had it (see #syncLogins). */
  loginsSeen?: Record<string, string>;
  /** The host key the workspace's SSH certificate is for, and when the certificate expires. */
  hostCert?: { pub: string; until: number };
  /** Chrome sign-ins: the saved copy this workspace last merged or made, and its cookie
   *  database's hash at that point (see #syncBrowser). */
  browserSeen?: string;
  browserLocal?: string;
  /** Where Cloudflare placed the container at its last start, and the data centre its traffic leaves from. */
  where?: Where;
}

interface Where {
  location?: string;
  region?: string;
  country?: string;
  colo?: string;
  at: number;
}

/** Logins made inside a workspace that follow their owner to every workspace (see #syncLogins). */
const LOGINS: Record<string, { label: string; path: string }> = {
  claude: { label: "Claude", path: ".claude/.credentials.json" },
  github: { label: "GitHub (gh)", path: ".config/gh/hosts.yml" },
};
/** Bigger files are not logins we know; leave them alone (base64 characters). */
const LOGIN_MAX = 96_000;

/** A saved login file (base64), or a tombstone (no data) once it was logged out or forgotten. */
interface Login {
  data?: string;
  hash: string;
  /** When the file was last changed (ms), or when it was logged out or forgotten. */
  at: number;
  /** Workspace it came from, or "settings". */
  from?: string;
}
type Logins = Record<string, Login>;

/** The owner's saved Chrome sign-ins: an encrypted, merged cookie database in HOMES. */
interface BrowserSaved {
  key?: string;
  /** SHA-256 of what was stored (before encryption). */
  hash?: string;
  at: number;
  from?: string;
  size?: number;
  /** "Stop copying" in settings: nothing is saved or merged until it is turned back on. */
  off?: boolean;
}
const browserKey = (email: string) => `_logins/${email}/chrome-cookies.gz.enc`;
/** A cookie database this big is not one to carry around (bytes, gzipped). */
const BROWSER_MAX = 32 * 1024 * 1024;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A person who has signed in, as the People page shows them. */
interface Person {
  email: string;
  first: number;
  last: number;
  /** Days with at least one visit, and the last of them (UTC). */
  days: number;
  lastDay?: string;
  /** Pages opened and SSH connections. */
  visits: number;
  lastSsh?: number;
}

/** The workspace's current journal repo in Artifacts, and the older ones still kept. */
interface Journal {
  repo: string;
  remote: string;
  /** Branches pushed to it so far. */
  branches: string[];
  lastPush?: number;
  /** When this repo was started; unset for repos from before monthly rollover. */
  started?: number;
  /** Estimated size of its history (journal.sh size), and when that was measured. */
  sizeKB?: number;
  sizeAt?: number;
  old?: { repo: string; started: number }[];
}

/** R2 multipart parts must be equal-sized (except the last) and at least 5 MiB. */
const PART_BYTES = 16 * 1024 * 1024;
/** Not archived: caches, the tools the image already ships (Claude Code, uv), and what Chrome
 *  re-downloads by itself. Conversations and settings in ~/.claude and ~/.claude.json are kept,
 *  as are browser logins and history. */
const BROWSER_PROFILE = ".local/share/agent-browser";
const HOME_EXCLUDES = [
  ".cache",
  ".npm",
  ".dbus",
  ".local/share/claude",
  ".local/bin/claude",
  ".local/bin/uv",
  ".local/bin/uvx",
  ...["*Cache*", "BrowserMetrics*", "optimization_guide_model_store", "component_crx_cache", "WasmTtsEngine", "OnDeviceHeadSuggestModel"].map(
    (d) => `${BROWSER_PROFILE}/${d}`,
  ),
];
/** Where the archive is written inside the container before upload. */
const BACKUP_TMP = "/tmp/home-backup.tar.gz";

/** The alarm runs every minute while a container runs: the journal tick and push (Claude state,
 *  shell state and history, projects), so an unannounced stop loses at most a minute of them. The
 *  idle check and home archive run every CHECK_MINUTES. */
const TICK_MS = 60_000;
/** sshd inside the container; reachable only through the Durable Object (the /ssh/ route). */
const SSH_PORT = 22;

/** Just under the longest setInactivityTimeout the platform accepts (6 h). */
const MAX_INACTIVITY_MS = 6 * 3600_000 - 60_000;

interface Listed {
  name: string;
  created: number;
  lastOpened: number;
}

const LEDGER = "_ledger"; // reserved DO name (not URL-reachable: names must start [a-z0-9])

// A workspace's key names its Durable Object, R2 archive and ledger rows. The admin's workspaces
// keep the bare names they had before there were other users; everyone else's are "<email>/<name>",
// so users can only ever reach their own.
const workspaceKey = (env: Env, owner: string, name: string) => (owner === env.ADMIN_EMAIL.toLowerCase() ? name : `${owner}/${name}`);
const ownerOf = (env: Env, key: string) => (key.includes("/") ? key.slice(0, key.indexOf("/")) : env.ADMIN_EMAIL.toLowerCase());
const shortName = (key: string) => key.slice(key.lastIndexOf("/") + 1);
/** Each user's settings live in a DO of their own, also not URL-reachable. */
const userKey = (email: string) => `_user:${email}`;
/** Snapshot names and container labels take a narrower alphabet than emails. */
const slug = (key: string) => key.replace(/[^a-z0-9-]+/g, "-");

const allowedSizes = (env: Env) => (env.ALLOWED_INSTANCES || Object.keys(SIZES).join(",")).split(",").map((x) => x.trim()).filter((x) => INSTANCES[x]);
const defaultSize = (env: Env) => env.INSTANCE || "standard-2";
/** The size this workspace starts with: its choice if still allowed, else the default. */
const sizeOf = (env: Env, s: { instance?: string }) => (s.instance && allowedSizes(env).includes(s.instance) ? s.instance : defaultSize(env));

const minutes = (v: string, d: number) => (Number(v) > 0 ? Number(v) : d) * 60_000;

export class Workspace extends DurableObject<Env> {
  readonly #c: Container;
  /** Short-lived write token for the current journal repo, kept in memory only. */
  #token?: { repo: string; value: string; expires: number };
  /** sshd has a host certificate for the running container (signed once per container start). */
  #hostCert = false;
  /** Open terminal and browser-viewer sockets, closed cleanly when we go to sleep. */
  readonly #sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const c = ctx.container;
    if (!c) throw new Error("Container binding missing");
    this.#c = c;
    // The inactivity timeout and monitor() belong to this instance and are lost when it restarts
    // (a deploy, or the platform moving it). Without them the platform stops the container soon
    // after the last request, with no checkpoint.
    if (c.running) ctx.blockConcurrencyWhile(() => this.#keepAlive("restart"));
  }

  /** Keep the container running while we are away: our alarm loop decides when it sleeps. */
  async #keepAlive(why: string): Promise<void> {
    const name = (await this.#state()).name;
    // Backstop only: our alarm loop decides when to sleep, after snapshotting. The platform caps it at 6 h.
    await this.#c.setInactivityTimeout(Math.min(minutes(this.env.SAFETY_HOURS, 6) * 60, MAX_INACTIVITY_MS));
    // Record how and when the container ends, so a stop we did not ask for shows up in the logs.
    // A pending monitor() also keeps this instance from being evicted (up to 15 minutes).
    const started = Date.now();
    const afterMin = () => Math.round((Date.now() - started) / 60000);
    this.ctx.waitUntil(
      this.#c.monitor().then(
        () => console.log({ event: "container.exited", workspace: name, why, afterMin: afterMin() }),
        (e) => console.error({ event: "container.failed", workspace: name, why, afterMin: afterMin(), error: String(e) }),
      ),
    );
    if (why === "restart") {
      console.log({ event: "keepalive.restored", workspace: name });
      if ((await this.ctx.storage.getAlarm()) === null) await this.#schedule();
    }
  }

  async #state(): Promise<State> {
    return (await this.ctx.storage.get<State>("state")) ?? {};
  }
  async #save(patch: Partial<State>): Promise<State> {
    const s = { ...(await this.#state()), ...patch };
    await this.ctx.storage.put("state", s);
    return s;
  }
  async #touch(): Promise<void> {
    await this.#save({ lastActivity: Date.now() });
  }

  #procEnv(): Record<string, string> {
    // Herdr, its shells and plugins inherit this, so their journal snapshots see the file cap.
    return { HOME, USER: "dev", PATH, SHELL: "/bin/zsh", TERM: "xterm-256color", LANG: "C.UTF-8", JOURNAL_MAX_FILE_MB: this.env.JOURNAL_MAX_FILE_MB || "25" };
  }

  /** The environment for Herdr and everything it starts: the owner's secrets on top of #procEnv.
   *  op:// values are resolved inside the container by with-secrets.sh. */
  async #secretEnv(key: string): Promise<Record<string, string>> {
    const e = this.#procEnv();
    const owner = ownerOf(this.env, key);
    const user = this.env.WORKSPACE.getByName(userKey(owner));
    if (owner === this.env.ADMIN_EMAIL.toLowerCase()) {
      // A token in the environment beats a login, so a saved login switches off the admin's fallback.
      const saved = new Set((await user.loginsView().catch(() => [])).filter((l) => l.at).map((l) => l.id));
      if (this.env.CLAUDE_CODE_OAUTH_TOKEN && !saved.has("claude")) e.CLAUDE_CODE_OAUTH_TOKEN = this.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (this.env.GITHUB_TOKEN && !saved.has("github")) e.GITHUB_TOKEN = this.env.GITHUB_TOKEN;
    }
    try {
      const s = await user.secretsEnv();
      Object.assign(e, s.env);
      if (s.opToken) e.OP_SERVICE_ACCOUNT_TOKEN = s.opToken;
    } catch (err) {
      console.error({ event: "secrets.failed", owner, error: String(err) });
    }
    return e;
  }

  async #run(cmd: string[]): Promise<{ code: number; out: string }> {
    const p = await this.#c.exec(cmd, { user: "dev", cwd: HOME, env: this.#procEnv() });
    const o = await p.output();
    return { code: o.exitCode, out: new TextDecoder().decode(o.stdout) };
  }

  async #cpuUsec(): Promise<number | null> {
    try {
      const p = await this.#c.exec(["cat", "/sys/fs/cgroup/cpu.stat"]);
      const out = new TextDecoder().decode((await p.output()).stdout);
      const m = /usage_usec (\d+)/.exec(out);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  async #usage(m = month()): Promise<Usage> {
    return (await this.ctx.storage.get<Usage>(`usage:${m}`)) ?? emptyUsage();
  }

  /** Add run time and CPU since the last cursor to this month's usage, then report to the ledger. */
  async #accrue(patch: Partial<Usage> = {}): Promise<Usage> {
    const s = await this.#state();
    const u = await this.#usage();
    const now = Date.now();
    if (s.meter && this.#c.running) {
      const inst = INSTANCES[s.meter.instance] ?? INSTANCES["standard-2"];
      const secs = Math.max(0, (now - s.meter.at) / 1000);
      const usec = await this.#cpuUsec();
      const dCpu = usec === null ? 0 : usec >= s.meter.cpuUsec ? usec - s.meter.cpuUsec : usec;
      u.runSeconds += secs;
      u.cpuSeconds += dCpu / 1e6;
      u.gibSeconds += secs * inst.memGiB;
      u.gbSeconds += secs * inst.diskGB;
      s.meter = { ...s.meter, at: now, cpuUsec: usec ?? s.meter.cpuUsec };
      await this.#save({ meter: s.meter });
    } else if (s.meter && !this.#c.running) {
      await this.#save({ meter: undefined }); // stopped outside our control; can't meter the gap
    }
    for (const [k, v] of Object.entries(patch)) (u as any)[k] = k === "lastSnapshotBytes" ? v : (u as any)[k] + (v as number);
    await this.ctx.storage.put(`usage:${month()}`, u);
    if (s.name) {
      try {
        await this.env.WORKSPACE.getByName(LEDGER).report(s.name, month(), u);
      } catch (e) {
        console.error({ event: "ledger.report.failed", error: String(e) });
      }
    }
    return u;
  }

  // ---- ledger (only on the LEDGER instance) ----
  /** Someone opened a page or connected over SSH, for the admin's People page (LEDGER only). */
  async seen(email: string, via: "web" | "ssh"): Promise<void> {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const p = (await this.ctx.storage.get<Person>(`user:${email}`)) ?? { email, first: now, last: now, days: 0, visits: 0 };
    if (p.lastDay !== day) p.days++;
    Object.assign(p, { last: now, lastDay: day, visits: p.visits + 1 }, via === "ssh" ? { lastSsh: now } : {});
    await this.ctx.storage.put(`user:${email}`, p);
  }
  async people(): Promise<Person[]> {
    return [...(await this.ctx.storage.list<Person>({ prefix: "user:" })).values()];
  }

  async report(name: string, m: string, u: Usage): Promise<void> {
    await this.ctx.storage.put(`ledger:${m}:${name}`, u);
  }
  async ledger(): Promise<Record<string, Record<string, Usage>>> {
    const out: Record<string, Record<string, Usage>> = {};
    for (const [k, v] of await this.ctx.storage.list<Usage>({ prefix: "ledger:" })) {
      const [, m, name] = k.split(":");
      (out[m] ??= {})[name] = v;
    }
    return out;
  }

  // ---- workspace registry (only on the LEDGER instance) ----
  async register(name: string): Promise<void> {
    const prev = await this.ctx.storage.get<Listed>(`ws:${name}`);
    await this.ctx.storage.put(`ws:${name}`, { name, created: prev?.created ?? Date.now(), lastOpened: Date.now() });
  }
  async unregister(name: string): Promise<void> {
    await this.ctx.storage.delete(`ws:${name}`);
  }
  async registry(): Promise<Listed[]> {
    // Workspaces from before the registry existed are known only from the cost ledger.
    if (!(await this.ctx.storage.get("ws-backfilled"))) {
      const names = new Set(Object.values(await this.ledger()).flatMap((m) => Object.keys(m)));
      for (const name of names) if (NAME.test(name)) await this.ctx.storage.put(`ws:${name}`, { name, created: 0, lastOpened: 0 });
      await this.ctx.storage.put("ws-backfilled", true);
    }
    return [...(await this.ctx.storage.list<Listed>({ prefix: "ws:" })).values()];
  }

  // ---- user settings (only on userKey(email) instances) ----
  async #secrets(): Promise<Secrets> {
    const sealed = await this.ctx.storage.get<Sealed>("secrets");
    if (!sealed) return { env: {} };
    if (!this.env.SECRETS_KEY) throw new Error("SECRETS_KEY is not set");
    return unseal(this.env.SECRETS_KEY, sealed);
  }
  async secretsView(): Promise<SecretsView> {
    return view(await this.#secrets());
  }
  async updateSecrets(update: unknown): Promise<SecretsView> {
    if (!this.env.SECRETS_KEY) throw new Error("SECRETS_KEY is not set");
    const next = applyUpdate(await this.#secrets(), SecretsUpdate.parse(update));
    await this.ctx.storage.put("secrets", await seal(this.env.SECRETS_KEY, next));
    return view(next);
  }
  /** Only for the user's own workspaces (called from #secretEnv), never sent to a browser. */
  async secretsEnv(): Promise<Secrets> {
    return this.#secrets();
  }

  // ---- saved logins (only on userKey(email) instances) ----
  async #loginStore(): Promise<Logins> {
    const sealed = await this.ctx.storage.get<Sealed>("logins");
    if (!sealed || !this.env.SECRETS_KEY) return {};
    return unseal<Logins>(this.env.SECRETS_KEY, sealed);
  }
  /** Only for the user's own workspaces (called from #syncLogins), never sent to a browser. */
  async loginsGet(): Promise<Logins> {
    return this.#loginStore();
  }
  /** Keep the newer of what is stored and what a workspace saw. Returns whether it was stored. */
  async loginPut(id: string, login: Login): Promise<boolean> {
    if (!this.env.SECRETS_KEY || !LOGINS[id]) return false;
    const all = await this.#loginStore();
    if ((all[id]?.at ?? 0) >= login.at) return false;
    all[id] = login;
    await this.ctx.storage.put("logins", await seal(this.env.SECRETS_KEY, all));
    return true;
  }
  async browserSaved(): Promise<BrowserSaved | undefined> {
    return this.ctx.storage.get<BrowserSaved>("browser");
  }
  async browserPut(saved: BrowserSaved): Promise<void> {
    await this.ctx.storage.put("browser", saved);
  }
  /** Settings: stop copying (and delete the saved copy) or start again. */
  async browserSetOff(email: string, off: boolean): Promise<void> {
    if (off) await this.env.HOMES.delete(browserKey(email));
    await this.ctx.storage.put("browser", { at: Date.now(), off });
  }
  /** For the settings page: which logins are saved (at is 0 when not), never their contents. */
  async loginsView(): Promise<{ id: string; label: string; at: number; from?: string; off?: boolean }[]> {
    const all = await this.#loginStore();
    const files = Object.entries(LOGINS).map(([id, { label }]) => (all[id]?.data ? { id, label, at: all[id].at, from: all[id].from } : { id, label, at: 0 }));
    const b = await this.browserSaved();
    return [...files, { id: "chrome", label: "Chrome sign-ins", at: b?.hash ? b.at : 0, from: b?.from, off: !!b?.off }];
  }

  /** Cheap state for the workspace list (no exec, no metering). */
  async summary(): Promise<{ running: boolean; lastActivity?: number; asleepSince?: number; homeBytes?: number; where?: Where; size: string; runningSize?: string }> {
    const s = await this.#state();
    const running = this.#c.running;
    return { running, lastActivity: s.lastActivity, asleepSince: s.lastCheckpoint?.at, homeBytes: s.homeBackup?.size, where: s.where, size: sizeOf(this.env, s), runningSize: running ? (s.runningInstance ?? defaultSize(this.env)) : undefined };
  }

  /** Choose this workspace's size; it applies at the next start (Sleep now, then open it). */
  async setSize(instance: string): Promise<{ ok: boolean; size?: string; error?: string; appliesAt?: string }> {
    if (!allowedSizes(this.env).includes(instance)) return { ok: false, error: `size must be one of ${allowedSizes(this.env).join(", ")}` };
    await this.#save({ instance });
    const s = await this.#state();
    const running = this.#c.running && (s.runningInstance ?? defaultSize(this.env)) !== instance;
    return { ok: true, size: instance, appliesAt: running ? "next start: press Sleep now, then open it" : "next start" };
  }

  /** Cloudflare gives the container its placement in CLOUDFLARE_* variables (on pid 1, as exec gets
   *  our environment instead); cdn-cgi/trace names the data centre its traffic leaves from. */
  async #locate(name: string): Promise<void> {
    try {
      const script = "tr '\\0' '\\n' < /proc/1/environ | grep '^CLOUDFLARE_'; curl -s -m 5 https://www.cloudflare.com/cdn-cgi/trace | grep '^colo='";
      const out = new TextDecoder().decode((await (await this.#c.exec(["sh", "-c", script])).output()).stdout);
      const v = Object.fromEntries(out.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      const where: Where = { location: v.CLOUDFLARE_LOCATION, region: v.CLOUDFLARE_REGION, country: v.CLOUDFLARE_COUNTRY_A2, colo: v.colo, at: Date.now() };
      await this.#save({ where });
      console.log({ event: "located", workspace: name, ...where });
    } catch (e) {
      console.error({ event: "locate.failed", workspace: name, error: String(e) });
    }
  }

  async #ensureRunning(name: string): Promise<void> {
    if (this.#c.running) {
      // Containers started while start-up could fail before scheduling never got an idle loop.
      if ((await this.ctx.storage.getAlarm()) === null) await this.#schedule();
      return;
    }
    const s = await this.#state();
    const size = sizeOf(this.env, s);
    const common = {
      enableInternet: true,
      instance: size as "standard-2",
      labels: { app: "herdr-cloud", workspace: slug(name) },
    };
    const image = this.#c.images.workstation;
    this.#hostCert = false;
    // Cloudflare can stop a container without warning, leaving the snapshot older than the
    // periodic home archive. Then the archive is the better copy, as it is after an image change.
    const archiveNewer = !!s.homeBackup && s.homeBackup.at > (s.lastCheckpoint?.at ?? 0);
    /** When the copy we start from was taken: newer journal state is laid on top. */
    let base = 0;
    // A snapshot is restored only onto the size it was taken on (disk sizes differ); after a size
    // change the workspace starts fresh from the image and its home archive, like an image change.
    const sameSize = (s.snapshotInstance ?? defaultSize(this.env)) === size;
    if (s.snapshotId && (!s.homeBackup || (s.snapshotImage === image && sameSize && !archiveNewer))) {
      // Same image and size, nothing newer in R2 (or no archive at all): the snapshot is fastest and complete.
      this.#c.start({ ...common, containerSnapshot: { id: s.snapshotId } });
      await this.#save({ name, restorePending: true, runningImage: s.snapshotImage, runningInstance: size });
      base = s.lastCheckpoint?.at ?? 0;
    } else {
      this.#c.start({ ...common, image });
      await this.#save({ name, restorePending: false, runningImage: image, runningInstance: size });
      if (s.homeBackup) {
        // The image has moved on: start fresh from it and unpack the home archive on top.
        if (await this.#restoreHome(s.homeBackup.key)) {
          await this.#save({ restorePending: true });
          // The archive holds this workspace's SSH host key: have sshd load it.
          await this.#c.exec(["sh", "-c", "[ -f /run/sshd.pid ] && kill -HUP $(cat /run/sshd.pid)"]).then((p) => p.exitCode).catch(() => {});
          base = s.homeBackup.at;
          // System packages do not travel in the home archive, only the list of them does.
          this.ctx.waitUntil(
            this.#c
              .exec(["/opt/herdr-cloud/restore-packages.sh"], { user: "dev", cwd: HOME, env: this.#procEnv() })
              .then((p) => p.exitCode)
              .then((code) => console.log({ event: "packages.restore", workspace: name, code }))
              .catch((e) => console.error({ event: "packages.restore.failed", workspace: name, error: String(e) })),
          );
        } else if (s.snapshotId) {
          // Never come up with an empty home: fall back to the old snapshot (and old image).
          await this.#c.destroy();
          this.#c.start({ ...common, instance: (s.snapshotInstance ?? defaultSize(this.env)) as "standard-2", containerSnapshot: { id: s.snapshotId } });
          await this.#save({ restorePending: true, runningImage: s.snapshotImage, runningInstance: s.snapshotInstance ?? defaultSize(this.env) });
          base = s.lastCheckpoint?.at ?? 0;
        }
      }
    }
    await this.#journalRestore(name, base);
    // Before Herdr and Claude start: bring in logins saved from other workspaces (or after a reset).
    await this.#syncLogins(name);
    await this.#syncBrowser(name, true);
    this.ctx.waitUntil(this.#locate(name));
    // Schedule our own idle loop first, so nothing below can leave a container that never sleeps.
    await this.#touch();
    await this.#save({ nextCheck: Date.now() + minutes(this.env.CHECK_MINUTES, 5) });
    await this.#schedule();
    await this.env.WORKSPACE.getByName(LEDGER).register(name);
    await this.#keepAlive("start");
    await this.#save({ meter: { at: Date.now(), cpuUsec: 0, instance: size } });
    await this.#accrue({ starts: 1 });
  }

  /** Stream a tar of /home/dev into HOMES as a multipart upload. Returns null on failure. */
  async #backupHome(name: string): Promise<State["homeBackup"] | null> {
    const key = `${name}/home.tar.gz`;
    const opts = { user: "dev", cwd: HOME };
    // Stamped with when tar began: anything that changed after that is in a later journal push.
    const started = Date.now();
    // Record apt packages added on top of the image, so a newer image can reinstall them.
    try {
      await (await this.#c.exec(["/opt/herdr-cloud/save-packages.sh"], opts)).output();
    } catch (e) {
      console.error({ event: "save-packages.failed", workspace: name, error: String(e) });
    }
    // Tar to the container's disk first, then read it back a part at a time: streaming tar's
    // output straight through let it outrun the uploads and pile up in the Durable Object's memory.
    const excludes = HOME_EXCLUDES.map((e) => `--exclude=dev/${e}`);
    const tar = await (await this.#c.exec(["tar", "-C", "/home", "-cf", BACKUP_TMP, "-I", "gzip -1", ...excludes, "dev"], opts)).output();
    // tar exits 1 when files change while it reads them; the archive is still usable.
    if (tar.exitCode > 1) {
      console.error({ event: "home.backup.failed", workspace: name, error: `tar exited ${tar.exitCode}`, stderr: new TextDecoder().decode(tar.stderr).slice(-500) });
      return null;
    }
    const size = Number(new TextDecoder().decode((await (await this.#c.exec(["stat", "-c", "%s", BACKUP_TMP], opts)).output()).stdout));
    // Completing the upload replaces the previous archive atomically; aborting leaves it in place.
    const upload = await this.env.HOMES.createMultipartUpload(key, { httpMetadata: { contentType: "application/gzip" } });
    try {
      const parts: R2UploadedPart[] = [];
      const mib = PART_BYTES / 1024 / 1024;
      for (let i = 0; i === 0 || i * PART_BYTES < size; i++) {
        const dd = ["dd", `if=${BACKUP_TMP}`, "bs=1M", `skip=${i * mib}`, `count=${mib}`, "status=none"];
        const part = await (await this.#c.exec(dd, opts)).output();
        if (part.exitCode !== 0) throw new Error(`reading part ${i + 1} failed`);
        parts.push(await upload.uploadPart(i + 1, part.stdout));
      }
      await upload.complete(parts);
      console.log({ event: "home.backup", workspace: name, size, parts: parts.length });
      return { key, at: started, size };
    } catch (e) {
      await upload.abort().catch(() => {});
      console.error({ event: "home.backup.failed", workspace: name, error: String(e) });
      return null;
    } finally {
      await this.#c.exec(["rm", "-f", BACKUP_TMP], opts).catch(() => {});
    }
  }

  /** Unpack a home archive from HOMES over /home/dev in a freshly started container. */
  async #restoreHome(key: string): Promise<boolean> {
    const obj = await this.env.HOMES.get(key);
    if (!obj) {
      console.error({ event: "home.restore.missing", key });
      return false;
    }
    const proc = await this.#c.exec(["tar", "-C", "/home", "-xzf", "-"], { user: "dev", cwd: HOME, stdin: obj.body });
    const out = await proc.output();
    if (out.exitCode !== 0) {
      console.error({ event: "home.restore.failed", key, code: out.exitCode, stderr: new TextDecoder().decode(out.stderr) });
      return false;
    }
    console.log({ event: "home.restore", key, size: obj.size });
    return true;
  }

  /** What the container's entrypoint says about the agent browser, for logs when it is unreachable. */
  async #browserDiag(): Promise<string> {
    try {
      const p = await this.#c.exec(["sh", "-c", "tail -n 20 /tmp/browser.log; ps -eo user,pid,args | grep -E 'Xvnc|chrome |i3|init.sh' | grep -v grep"]);
      return new TextDecoder().decode((await p.output()).stdout).slice(-2000);
    } catch (e) {
      return String(e);
    }
  }

  async #schedule(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /** Rollover is due at the start of each month, or early once the history nears the repo cap. */
  #rolloverDue(j: Journal): boolean {
    const started = new Date(j.started ?? 0);
    const now = new Date();
    if (started.getUTCFullYear() !== now.getUTCFullYear() || started.getUTCMonth() !== now.getUTCMonth()) return true;
    return (j.sizeKB ?? 0) > Number(this.env.JOURNAL_ROLLOVER_MB || 600) * 1024;
  }

  /** A write token for the journal repo, minted once an hour and kept in memory only. */
  async #journalToken(j: Journal): Promise<string> {
    const t = this.#token;
    if (t?.repo === j.repo && t.expires > Date.now() + 300_000) return t.value;
    using repo = await this.env.ARTIFACTS!.get(j.repo);
    const n = await repo.createToken("write", 3600);
    this.#token = { repo: j.repo, value: n.plaintext, expires: Date.now() + 3_500_000 };
    return n.plaintext;
  }

  /** Run journal.sh with the repo's remote and a token in that exec's environment only. */
  async #journalRun(j: Journal, script: string): Promise<{ code: number; lines: string[]; err: string }> {
    const env = { ...this.#procEnv(), JOURNAL_REMOTE: j.remote, JOURNAL_TOKEN: await this.#journalToken(j) };
    const out = await (await this.#c.exec(["sh", "-c", `j=/opt/herdr-cloud/journal.sh; [ -x $j ] || exit 0; ${script}`], { user: "dev", cwd: HOME, env })).output();
    const dec = new TextDecoder();
    return { code: out.exitCode, lines: dec.decode(out.stdout).split("\n").filter(Boolean), err: dec.decode(out.stderr).slice(-300) };
  }

  /** Commit what changed and push it; every few minutes also measure the history. */
  async #journalPush(j: Journal): Promise<Journal> {
    const measure = Date.now() - (j.sizeAt ?? 0) > 5 * 60_000;
    const r = await this.#journalRun(j, `$j tick; $j push; c=$?; ${measure ? "$j size; " : ""}exit $c`);
    const size = r.lines.find((l) => l.startsWith("size "));
    const pushed = r.lines.filter((l) => !l.startsWith("size "));
    const next: Journal = { ...j };
    if (pushed.length) Object.assign(next, { branches: [...new Set([...j.branches, ...pushed])].sort(), lastPush: Date.now() });
    if (size) Object.assign(next, { sizeKB: Number(size.slice(5)), sizeAt: Date.now() });
    await this.#save({ journal: next });
    if (r.code !== 0) console.error({ event: "journal.failed", repo: j.repo, code: r.code, error: r.err });
    return next;
  }

  /** Start a fresh repo: the container collapses each branch to one commit of its current state,
   *  so the new repo holds no history; the old one is kept JOURNAL_KEEP_MONTHS months. */
  async #journalRollover(name: string, j: Journal | undefined, why: string): Promise<Journal> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const repo = `ws-${slug(name.toLowerCase()).slice(0, 43)}-${stamp}`;
    // Create the new repo before touching local history, so a failure leaves the old one intact.
    const c = await this.env.ARTIFACTS!.create(repo, { description: `herdr-cloud workspace ${name}`, setDefaultBranch: "home" });
    const old = [...(j?.old ?? [])];
    if (j) {
      const r = await this.#journalRun(j, "exec $j rollover");
      if (r.code !== 0) {
        await this.env.ARTIFACTS!.delete(repo).catch(() => false);
        throw new Error(`rollover exit ${r.code}: ${r.err}`);
      }
      old.push({ repo: j.repo, started: j.started ?? Date.now() });
    }
    // A new repo may not be ready for get() at once; its creation hands back a first token.
    const exp = Number(/[?&]expires=(\d+)/.exec(c.token)?.[1]) * 1000;
    this.#token = { repo, value: c.token, expires: exp > Date.now() ? exp : Date.now() + 600_000 };
    // Repos started before the cutoff month are deleted.
    const keep = Number(this.env.JOURNAL_KEEP_MONTHS ?? 2);
    const now = new Date();
    const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keep, 1);
    const kept = old.filter((o) => o.started >= cutoff);
    for (const o of old.filter((o) => o.started < cutoff)) await this.env.ARTIFACTS!.delete(o.repo).catch(() => false);
    const next: Journal = { repo, remote: c.remote, branches: [], started: Date.now(), old: kept };
    await this.#save({ journal: next });
    console.log({ event: "journal.rollover", workspace: name, why, repo, from: j?.repo, deleted: old.length - kept.length });
    return next;
  }

  /** Every minute and before each sleep: push to the current repo, rolling over first if due. */
  async #journal(name: string, force = false): Promise<string | null> {
    if (!this.env.ARTIFACTS) return null;
    try {
      let j = (await this.#state()).journal;
      // Push what is left to the old repo before leaving it (repos from before rollovers had no start).
      if (j?.started) j = await this.#journalPush(j);
      if (!j?.started || force || this.#rolloverDue(j)) {
        j = await this.#journalRollover(name, j, force ? "requested" : !j ? "first" : !j.started ? "upgrade" : "due");
        await this.#journalPush(j);
      }
      return null;
    } catch (e) {
      console.error({ event: "journal.failed", workspace: name, error: String(e) });
      return String(e);
    }
  }

  /** "Start a fresh journal" from /w/<name>/journal. */
  async journalRollover(): Promise<Record<string, unknown>> {
    const s = await this.#state();
    if (!this.#c.running) return { ok: false, error: "workspace is asleep" };
    const error = await this.#journal(s.name ?? "ws", true);
    return { ok: !error, error: error ?? undefined, repo: (await this.#state()).journal?.repo };
  }

  /** After a start, lay what the journal holds that is newer than the copy we started from (a
   *  snapshot or home archive) over the home folder and the projects: after an unannounced stop
   *  that copy can be half an hour old, the journal at most a minute. */
  async #journalRestore(name: string, base: number): Promise<void> {
    const j = (await this.#state()).journal;
    if (!this.env.ARTIFACTS || !j?.lastPush || j.lastPush <= base) return;
    try {
      const r = await this.#journalRun(j, "exec $j restore");
      console.log({ event: "journal.restore", workspace: name, repo: j.repo, code: r.code, restored: r.lines, stderr: r.err });
    } catch (e) {
      console.error({ event: "journal.restore.failed", workspace: name, error: String(e) });
    }
  }

  /** Recent journal commits per branch, for /w/<name>/journal. */
  async journalLog(limit = 20): Promise<Record<string, unknown>> {
    const j = (await this.#state()).journal;
    if (!this.env.ARTIFACTS || !j) return { enabled: !!this.env.ARTIFACTS, branches: {} };
    using repo = await this.env.ARTIFACTS.get(j.repo);
    const branches: Record<string, unknown> = {};
    for (const b of j.branches) {
      branches[b] = (await repo.log({ ref: b, limit })).map((c) => ({ hash: c.hash.slice(0, 12), at: c.committedAt, message: c.message.trim() }));
    }
    const { remote, lastPush, started, sizeKB, old } = j;
    return { enabled: true, repo: j.repo, remote, started, lastPush, sizeKB, older: old ?? [], branches };
  }

  /** Logins made inside a workspace (claude /login, gh auth login) follow their owner. Each minute
   *  the newer of this workspace's file and the owner's saved copy wins, in both directions: a login
   *  survives a reset, an unannounced stop and new workspaces, a refreshed token reaches the others,
   *  and a logout (or Forget in settings) removes it everywhere. The journal never holds these. */
  async #syncLogins(name: string): Promise<void> {
    if (!this.env.SECRETS_KEY) return;
    try {
      const user = this.env.WORKSPACE.getByName(userKey(ownerOf(this.env, name)));
      const paths = Object.values(LOGINS).map((l) => l.path).join(" ");
      const { out } = await this.#run(["sh", "-c", `for f in ${paths}; do if [ -f "$f" ]; then echo "$f $(sha256sum < "$f" | cut -c1-64) $(stat -c %Y "$f")"; else echo "$f - 0"; fi; done`]);
      const local = new Map(
        out.trim().split("\n").map((l) => {
          const [path, hash, mtime] = l.split(" ");
          return [path, { hash: hash === "-" ? "" : hash, at: Number(mtime) * 1000 }];
        }),
      );
      const stored = await user.loginsGet();
      const seen = { ...(await this.#state()).loginsSeen };
      const from = shortName(name);
      for (const [id, { path }] of Object.entries(LOGINS)) {
        const l = local.get(path);
        if (!l) continue;
        const s = stored[id];
        let now = l.hash;
        if (l.hash && l.hash !== s?.hash && l.at > (s?.at ?? 0)) {
          // Logged in or refreshed here: save it.
          const data = (await this.#run(["base64", "-w0", path])).out.trim();
          if (data && data.length <= LOGIN_MAX && (await user.loginPut(id, { data, hash: l.hash, at: l.at, from }))) console.log({ event: "login.saved", workspace: name, login: id });
        } else if (!l.hash && s?.data && seen[id] === s.hash) {
          // Logged out here: forget it everywhere.
          if (await user.loginPut(id, { hash: "", at: Date.now(), from })) console.log({ event: "login.forgotten", workspace: name, login: id });
        } else if (s && s.hash !== l.hash && s.at >= l.at) {
          // Newer elsewhere, or forgotten: bring this workspace up to it.
          const script = s.data
            ? 'umask 077 && mkdir -p "$(dirname "$P")" && printf %s "$D" | base64 -d > "$P.tmp" && mv -f "$P.tmp" "$P"'
            : 'rm -f "$P"';
          const p = await this.#c.exec(["sh", "-c", script], { user: "dev", cwd: HOME, env: { ...this.#procEnv(), P: path, D: s.data ?? "" } });
          if ((await p.output()).exitCode === 0) {
            now = s.hash;
            console.log({ event: s.data ? "login.restored" : "login.removed", workspace: name, login: id, from: s.from });
          }
        }
        if (now) seen[id] = now;
        else delete seen[id];
      }
      await this.#save({ loginsSeen: seen });
    } catch (e) {
      console.error({ event: "logins.failed", workspace: name, error: String(e) });
    }
  }

  /** Chrome's site sign-ins follow their owner too, as a cookie database merged across workspaces
   *  (container/scripts/browser-logins.sh): at a start the saved copy is merged in before anyone uses
   *  the browser; while the workspace runs, a changed database is merged with the saved copy and
   *  stored back, encrypted. Merging means two workspaces signed in to different sites both keep
   *  them; logging out of a site in one does not log the others out. */
  async #syncBrowser(name: string, atStart: boolean): Promise<void> {
    if (!this.env.SECRETS_KEY) return;
    try {
      const owner = ownerOf(this.env, name);
      const user = this.env.WORKSPACE.getByName(userKey(owner));
      const saved = await user.browserSaved();
      if (saved?.off) return;
      const { out } = await this.#run(["sh", "-c", "b=/opt/herdr-cloud/browser-logins.sh; [ -x $b ] && exec $b stat"]);
      const [localHash] = out.trim().split(" ");
      if (!localHash) return; // an image from before this
      const s = await this.#state();
      const fetchSaved = async () => {
        const obj = saved?.hash ? await this.env.HOMES.get(browserKey(owner)) : null;
        return obj ? unsealBytes(this.env.SECRETS_KEY!, new Uint8Array(await obj.arrayBuffer())) : new Uint8Array();
      };
      const run = async (cmd: string, stdin: Uint8Array) => {
        const body = new ReadableStream({ start: (c) => (stdin.length && c.enqueue(stdin), c.close()) });
        return (await this.#c.exec(["/opt/herdr-cloud/browser-logins.sh", cmd], { user: "dev", cwd: HOME, env: this.#procEnv(), stdin: body })).output();
      };
      if (atStart) {
        if (!saved?.hash || saved.hash === s.browserSeen) return;
        const o = await run("merge", await fetchSaved());
        if (o.exitCode !== 0) throw new Error(`merge exited ${o.exitCode}: ${new TextDecoder().decode(o.stderr).slice(-300)}`);
        await this.#save({ browserSeen: saved.hash });
        console.log({ event: "browser.merged", workspace: name, from: saved.from, size: saved.size });
        return;
      }
      if (localHash === "-" || localHash === s.browserLocal) return;
      const o = await run("pack", await fetchSaved());
      if (o.exitCode !== 0) throw new Error(`pack exited ${o.exitCode}: ${new TextDecoder().decode(o.stderr).slice(-300)}`);
      const packed = new Uint8Array(o.stdout);
      if (!packed.length || packed.length > BROWSER_MAX) return;
      const hash = hex(await crypto.subtle.digest("SHA-256", packed));
      await this.env.HOMES.put(browserKey(owner), await sealBytes(this.env.SECRETS_KEY, packed));
      await user.browserPut({ key: browserKey(owner), hash, at: Date.now(), from: shortName(name), size: packed.length });
      await this.#save({ browserSeen: hash, browserLocal: localHash });
      console.log({ event: "browser.saved", workspace: name, size: packed.length });
    } catch (e) {
      console.error({ event: "browser.sync.failed", workspace: name, atStart, error: String(e) });
    }
  }

  async #active(): Promise<boolean> {
    try {
      return (await this.#run(["sh", "-c", "a=/opt/herdr-cloud/activity.sh; [ -x $a ] && exec $a"])).code === 0;
    } catch {
      return false;
    }
  }

  async #busy(): Promise<boolean> {
    try {
      return (await this.#run(["/opt/herdr-cloud/busy.sh"])).code === 0;
    } catch {
      return false;
    }
  }

  override async alarm(): Promise<void> {
    if (!this.#c.running) {
      const s = await this.#state();
      if (s.meter) console.error({ event: "container.lost", workspace: s.name, lastActivity: s.lastActivity, lastCheckpoint: s.lastCheckpoint?.at });
      await this.#accrue();
      return;
    }
    const pre = await this.#state();
    await this.#journal(pre.name ?? "ws");
    await this.#syncLogins(pre.name ?? "ws");
    // The journal runs every minute; everything below only every CHECK_MINUTES (or on "Sleep now").
    if (!pre.sleepRequested && Date.now() < (pre.nextCheck ?? 0)) return this.#schedule();
    await this.#save({ nextCheck: Date.now() + minutes(this.env.CHECK_MINUTES, 5) - 5_000 });
    await this.#accrue();
    if ((await this.#state()).sleepRequested) {
      await this.#save({ sleepRequested: false });
      await this.checkpoint();
      return;
    }
    // Typing, output or a working command in any shell pane counts as use, however you are
    // connected (browser, SSH or a Herdr client), and so does nothing else: an idle connection,
    // or a dev server sitting quietly, lets it sleep.
    if (await this.#active()) await this.#touch();
    await this.#syncBrowser(pre.name ?? "ws", false);
    const s = await this.#state();
    // Keep a recent copy of ~/ in R2 while in use, in case the container is stopped under us.
    const since = s.homeBackup?.at ?? 0;
    if ((s.lastActivity ?? 0) > since && Date.now() - since >= minutes(this.env.BACKUP_MINUTES ?? "", 30)) {
      // Record the Claude panes too, so a wake after an unannounced stop resumes them.
      await this.#run(["/opt/herdr-cloud/save-layout.sh"]).catch((e) => console.error({ event: "save-layout.failed", error: String(e) }));
      const homeBackup = await this.#backupHome(s.name ?? "ws");
      if (homeBackup) await this.#save({ homeBackup });
    }
    const idleFor = Date.now() - (s.lastActivity ?? 0);
    // Open tabs alone do not keep it awake: only keystrokes, viewer input, activity in a pane
    // (above) or a busy agent do.
    if (idleFor < minutes(this.env.IDLE_MINUTES, 20)) return this.#schedule();
    if (await this.#busy()) {
      await this.#touch();
      return this.#schedule();
    }
    await this.checkpoint();
  }

  /** "Sleep now": checkpoint from the alarm, where a slow home backup cannot time out a request. */
  async requestSleep(): Promise<{ queued: boolean }> {
    if (!this.#c.running) return { queued: false };
    await this.#save({ sleepRequested: true });
    await this.ctx.storage.setAlarm(Date.now());
    return { queued: true };
  }

  /** Save layout, snapshot the whole disk, stop. Next open restores from it. */
  async checkpoint(): Promise<State["lastCheckpoint"] | null> {
    if (!this.#c.running) return null;
    const s = await this.#state();
    try {
      await this.#run(["/opt/herdr-cloud/save-layout.sh"]);
    } catch (e) {
      console.error({ event: "save-layout.failed", error: String(e) });
    }
    await this.#journal(s.name ?? "ws");
    await this.#syncLogins(s.name ?? "ws");
    await this.#syncBrowser(s.name ?? "ws", false);
    const homeBackup = (await this.#backupHome(s.name ?? "ws")) ?? s.homeBackup;
    const snap = await this.#c.snapshotContainer({ name: `${slug(s.name ?? "ws")}-${Date.now()}` });
    const lastCheckpoint = { id: snap.id, at: Date.now(), size: snap.size };
    await this.#accrue({ snapshots: 1, lastSnapshotBytes: snap.size });
    await this.#save({ snapshotId: snap.id, snapshotImage: s.runningImage, snapshotInstance: s.runningInstance ?? defaultSize(this.env), homeBackup, lastCheckpoint, meter: undefined });
    // 1000 tells the terminal page not to reconnect (which would wake us straight back up).
    for (const ws of this.#sockets) ws.close(1000, "asleep: reload to wake");
    this.#sockets.clear();
    await this.#c.destroy();
    console.log({ event: "checkpoint", workspace: s.name, ...lastCheckpoint });
    return lastCheckpoint;
  }

  async status(): Promise<Record<string, unknown>> {
    const usage = await this.#accrue();
    const s = await this.#state();
    const instance = sizeOf(this.env, s);
    return {
      running: this.#c.running,
      clients: this.#sockets.size,
      busy: this.#c.running ? await this.#busy() : false,
      ...s,
      month: month(),
      usage,
      cost: cost(usage),
      hourly: { idle: hourly(instance, 0.02), busy: hourly(instance, 0.5) },
    };
  }

  async reset(): Promise<void> {
    await this.#accrue();
    if (this.#c.running) await this.#c.destroy();
    const s = await this.#state();
    if (s.homeBackup) await this.env.HOMES.delete(s.homeBackup.key);
    if (s.journal && this.env.ARTIFACTS) {
      for (const repo of [s.journal.repo, ...(s.journal.old ?? []).map((o) => o.repo)]) await this.env.ARTIFACTS.delete(repo).catch(() => false);
    }
    await this.ctx.storage.delete("state"); // keep usage history
  }

  override async fetch(request: Request): Promise<Response> {
    const browserPath = request.headers.get("X-Browser-Path");
    if (browserPath) return this.#browser(request, request.headers.get("X-Workspace") ?? "default", browserPath);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const ssh = request.headers.get("X-SSH");
    if (ssh) return this.#ssh(request.headers.get("X-Workspace") ?? "default", ssh === "wake");
    const url = new URL(request.url);
    const size = Size.safeParse({
      cols: Number(url.searchParams.get("cols") ?? 120),
      rows: Number(url.searchParams.get("rows") ?? 40),
    });
    if (!size.success) return new Response("bad size", { status: 400 });
    const name = url.searchParams.get("ws") ?? "default";

    await this.#ensureRunning(name);

    const abort = new AbortController();
    // `herdr` attaches to the persistent session, starting its server if needed. The server keeps
    // the environment of the attach that started it, so secret changes apply after the next wake.
    // Snapshots of images from before with-secrets.sh run herdr directly.
    const herdr = "w=/opt/herdr-cloud/with-secrets.sh; if [ -x $w ]; then exec $w herdr; else exec herdr; fi";
    const proc = await this.#c.exec(["sh", "-c", herdr], {
      pty: size.data,
      user: "dev",
      cwd: WORK,
      env: await this.#secretEnv(name),
      signal: abort.signal,
    });
    if (!proc.stdin || !proc.stdout) {
      abort.abort();
      return new Response("no terminal streams", { status: 500 });
    }

    await this.#afterAttach();

    const [client, server] = Object.values(new WebSocketPair());
    server.binaryType = "arraybuffer";
    server.accept();
    this.#sockets.add(server);
    await this.#touch();
    this.#bridge(server, proc, abort);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** First attach after a restore: rebuild workspaces and resume Claude in the background.
   *  Run it as its own exec and keep the promise: backgrounded children of an exec do not outlive it. */
  async #afterAttach(): Promise<void> {
    if (!(await this.#state()).restorePending) return;
    await this.#save({ restorePending: false });
    this.ctx.waitUntil(
      this.#c
        .exec(["/opt/herdr-cloud/restore-layout.sh"], { user: "dev", cwd: HOME, env: this.#procEnv() })
        .then((p) => p.exitCode)
        .then((code) => console.log({ event: "restore.done", code }))
        .catch((e) => console.error({ event: "restore.failed", error: String(e) })),
    );
  }

  /** Make sure the Herdr server runs with the owner's secrets before an SSH client uses it: a
   *  server started from an SSH session would lack them. Start it the way the browser does, with a
   *  short client attach (the server outlives its client), then let go. */
  async #ensureHerdr(name: string): Promise<void> {
    if ((await this.#run(["herdr", "workspace", "list"])).out.includes('"result"')) return;
    const abort = new AbortController();
    const herdr = "w=/opt/herdr-cloud/with-secrets.sh; if [ -x $w ]; then exec $w herdr; else exec herdr; fi";
    const proc = await this.#c.exec(["sh", "-c", herdr], { pty: { cols: 120, rows: 40 }, user: "dev", cwd: WORK, env: await this.#secretEnv(name), signal: abort.signal });
    // Drain its screen so it never blocks on output.
    this.ctx.waitUntil(proc.stdout?.pipeTo(new WritableStream()).catch(() => {}) ?? Promise.resolve());
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await this.#run(["herdr", "workspace", "list"])).out.includes('"result"')) break;
    }
    await this.#afterAttach();
    // Herdr resumes agents once a client has attached; give it a moment before letting go.
    await new Promise((r) => setTimeout(r, 3000));
    abort.abort();
  }

  /** SSH from a laptop (see the /ssh/ route): bridge the WebSocket to the workspace's sshd. A
   *  sleeping workspace is only woken when asked (hcw-): Herdr's saved machines retry on their own
   *  every couple of minutes and would otherwise never let it sleep. */
  /** Sign this workspace's SSH host key as hc-<name> and hcw-<name>, so laptops that trust the
   *  herdr-cloud key accept it with strict checking (Herdr's machine add insists on that). */
  async #certifyHost(name: string): Promise<void> {
    if (this.#hostCert || !this.env.SSH_CA_KEY) return;
    try {
      const key = `${HOME}/.herdr-cloud/ssh/ssh_host_ed25519_key`;
      const pub = (await this.#run(["cat", `${key}.pub`])).out.trim();
      if (!pub) return;
      // The certificate lives beside the key in the home folder, so it outlasts restarts: sign
      // again only for a new key or one that expires within a week.
      const had = (await this.#state()).hostCert;
      if (had?.pub === pub && had.until - Date.now() > 7 * 86400_000) {
        this.#hostCert = true;
        return;
      }
      const short = shortName(name);
      const days = 30;
      const cert = await signHostKey(this.env.SSH_CA_KEY, pub, [`hc-${short}`, `hcw-${short}`], short, days);
      const body = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(cert + "\n")), c.close()) });
      const write = await this.#c.exec(["sh", "-c", `cat > ${key}-cert.pub.tmp && mv -f ${key}-cert.pub.tmp ${key}-cert.pub`], { user: "dev", cwd: HOME, stdin: body });
      if ((await write.output()).exitCode !== 0) return;
      // sshd reads host certificates when it starts or gets a HUP. It re-executes on a HUP, so
      // wait until it listens again before handing it a connection.
      const reload = "[ -f /run/sshd.pid ] && kill -HUP $(cat /run/sshd.pid); sleep 0.2; for i in $(seq 50); do bash -c 'exec 3<>/dev/tcp/127.0.0.1/22' 2>/dev/null && exit 0; sleep 0.1; done";
      await (await this.#c.exec(["sh", "-c", reload])).output();
      await this.#save({ hostCert: { pub, until: Date.now() + days * 86400_000 } });
      this.#hostCert = true;
      console.log({ event: "ssh.cert.signed", workspace: name });
    } catch (e) {
      console.error({ event: "ssh.cert.failed", workspace: name, error: String(e) });
    }
  }

  async #ssh(name: string, wake: boolean): Promise<Response> {
    if (!this.#c.running && !wake) return new Response("asleep: ssh to it from a terminal, or open it in the browser, to wake it", { status: 409 });
    await this.#ensureRunning(name);
    await this.#touch();
    await this.#ensureHerdr(name);
    await this.#certifyHost(name);
    const sock = this.#c.getTcpPort(SSH_PORT).connect(`10.0.0.1:${SSH_PORT}`);
    const [client, server] = Object.values(new WebSocketPair());
    server.binaryType = "arraybuffer";
    server.accept();
    this.#sockets.add(server);
    const writer = sock.writable.getWriter();
    const close = (why: string) => {
      this.#sockets.delete(server);
      writer.close().catch(() => {});
      sock.close().catch(() => {});
      try {
        server.close(1000, why);
      } catch {}
    };
    // Bytes only: whether you are using it is judged inside the workspace (activity.sh), as SSH
    // and Herdr clients send health checks while idle.
    server.addEventListener("message", (e) => {
      const d = e.data;
      writer.write(typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d)).catch(() => close("ssh write failed"));
    });
    server.addEventListener("close", () => close("client closed"));
    server.addEventListener("error", () => close("client error"));
    this.ctx.waitUntil(
      sock.readable
        .pipeTo(new WritableStream({ write: (chunk) => server.send(chunk) }))
        .catch(() => {})
        .finally(() => close("ssh closed")),
    );
    console.log({ event: "ssh.open", workspace: name });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Proxy the KasmVNC web client (pages and its RFB WebSocket) on BROWSER_PORT. */
  async #browser(request: Request, name: string, path: string): Promise<Response> {
    await this.#ensureRunning(name);
    const target = `http://container${path}${new URL(request.url).search}`;
    const headers = new Headers(request.headers);
    headers.delete("X-Browser-Path");
    headers.delete("X-Workspace");
    const port = this.#c.getTcpPort(BROWSER_PORT);
    let res: Response | undefined;
    // After a cold start or restore the display needs a few seconds to listen.
    for (let i = 0; !res; i++) {
      try {
        res = await port.fetch(target, { method: request.method, headers });
      } catch (e) {
        if (i >= 40) {
          console.error({ event: "browser.proxy.failed", error: String(e), diag: await this.#browserDiag() });
          return new Response("agent browser not reachable", { status: 502 });
        }
        await scheduler.wait(500);
      }
    }
    const upstream = res.webSocket;
    if (!upstream) {
      if (request.method === "GET" && path === "/") await this.#touch();
      return res;
    }

    // Both sides default to Blob messages, which send() would stringify: relay raw bytes.
    upstream.binaryType = "arraybuffer";
    upstream.accept();
    const [client, server] = Object.values(new WebSocketPair());
    server.binaryType = "arraybuffer";
    server.accept();
    this.#sockets.add(server);
    let lastTouch = 0;
    server.addEventListener("message", (ev) => {
      const now = Date.now();
      if (now - lastTouch > 30_000 && ev.data instanceof ArrayBuffer && RFB_INPUT.has(new Uint8Array(ev.data)[0])) {
        lastTouch = now;
        void this.#touch();
      }
      upstream.send(ev.data);
    });
    upstream.addEventListener("message", (ev) => server.send(ev.data));
    const close = () => {
      this.#sockets.delete(server);
      for (const ws of [server, upstream]) {
        try {
          ws.close(1000);
        } catch {
          /* already closed */
        }
      }
    };
    for (const ws of [server, upstream]) {
      ws.addEventListener("close", close);
      ws.addEventListener("error", close);
    }
    const proto = res.headers.get("Sec-WebSocket-Protocol");
    return new Response(null, { status: 101, webSocket: client, headers: proto ? { "Sec-WebSocket-Protocol": proto } : {} });
  }

  #bridge(server: WebSocket, proc: ExecProcess, abort: AbortController): void {
    const input = (proc.stdin as WritableStream<Uint8Array>).getWriter();
    let exited = false;
    let closed = false;
    proc.exitCode.then(() => (exited = true), () => (exited = true));
    const done = () => {
      if (closed) return;
      closed = true;
      this.#sockets.delete(server);
      void this.#touch();
      if (!exited) abort.abort(); // kills this herdr client only; the herdr server keeps running
    };
    let lastTouch = 0;
    server.addEventListener("message", (ev) => {
      const now = Date.now();
      if (now - lastTouch > 30_000) {
        lastTouch = now;
        void this.#touch();
      }
      if (ev.data instanceof ArrayBuffer) {
        input.write(new Uint8Array(ev.data)).catch(done);
        return;
      }
      try {
        const sz = Size.safeParse(JSON.parse(ev.data as string));
        if (sz.success) proc.resize(sz.data.cols, sz.data.rows);
      } catch {
        /* ignore */
      }
    });
    server.addEventListener("close", done);
    server.addEventListener("error", done);
    void (async () => {
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) server.send(chunk);
        server.close(1000, `herdr exited (${await proc.exitCode})`);
      } catch (e) {
        if (!abort.signal.aborted) {
          console.error({ event: "terminal.output.failed", error: String(e) });
          server.close(1011, "terminal failed");
        }
      } finally {
        done();
      }
    })();
  }
}

/** Workspace names are lowercase with hyphens: "My App" and "my_app" both become "my-app". */
function canonical(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  return name.trim().toLowerCase().replace(/[\s_.]+/g, "-");
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

/** A user's own workspaces, keyed for the DO namespace. */
async function workspacesOf(env: Env, me: Identity): Promise<Listed[]> {
  return (await env.WORKSPACE.getByName(LEDGER).registry()).filter((w) => ownerOf(env, w.name) === me.email);
}

/** Non-admins get MAX_WORKSPACES; opening an existing one is always fine. */
async function overLimit(env: Env, me: Identity, key: string): Promise<boolean> {
  if (me.admin) return false;
  const mine = await workspacesOf(env, me);
  return !mine.some((w) => w.name === key) && mine.length >= (Number(env.MAX_WORKSPACES) || 3);
}

export default {
  async fetch(request, env): Promise<Response> {
    const me = await identify(request, env);
    if (!me) return new Response("Forbidden", { status: 403 });
    const url = new URL(request.url);
    // Page loads and SSH connections, not every request, count as visits.
    const ssh = url.pathname.startsWith("/ssh/");
    if (!me.service && request.method === "GET" && (ssh || request.headers.get("Accept")?.includes("text/html"))) {
      await env.WORKSPACE.getByName(LEDGER).seen(me.email, ssh ? "ssh" : "web").catch((e) => console.error({ event: "seen.failed", error: String(e) }));
    }
    if (url.pathname === "/people" && request.method === "GET") return me.admin ? html(peoplePage) : new Response("Not found", { status: 404 });
    if (url.pathname === "/api/people" && request.method === "GET") {
      if (!me.admin) return new Response("Not found", { status: 404 });
      const ledger = env.WORKSPACE.getByName(LEDGER);
      const [people, registry, usage] = await Promise.all([ledger.people(), ledger.registry(), ledger.ledger()]);
      const thisMonth = usage[month()] ?? {};
      return Response.json(
        people.map((p) => {
          const mine = (k: string) => ownerOf(env, k) === p.email;
          const spent = (k: string) => (thisMonth[k] ? cost(thisMonth[k]).total : 0);
          return {
            ...p,
            admin: p.email === env.ADMIN_EMAIL.toLowerCase(),
            workspaces: registry
              .filter((w) => mine(w.name))
              .map((w) => ({ name: w.name.slice(w.name.indexOf("/") + 1), created: w.created, lastOpened: w.lastOpened, cost: spent(w.name) })),
            cost: Object.keys(thisMonth).filter(mine).reduce((t, k) => t + spent(k), 0),
          };
        }),
      );
    }
    if (url.pathname === "/" && request.method === "GET") return html(indexPage);
    if (url.pathname === "/costs" && request.method === "GET") return html(costsPage);
    if (url.pathname === "/settings" && request.method === "GET") return html(settingsPage);
    if (url.pathname === "/connect" && request.method === "GET") return html(connectPage);
    if (url.pathname === "/benchmarks" && request.method === "GET") return html(benchmarksPage());
    if (url.pathname === "/api/me" && request.method === "GET") return Response.json(me);
    if (url.pathname === "/api/settings") {
      const user = env.WORKSPACE.getByName(userKey(me.email));
      try {
        if (request.method === "GET") return Response.json({ ...(await user.secretsView()), logins: await user.loginsView() });
        if (request.method === "PUT") {
          const update = SecretsUpdate.safeParse(await request.json().catch(() => null));
          if (!update.success) return Response.json({ error: z.prettifyError(update.error) }, { status: 400 });
          return Response.json({ ...(await user.updateSecrets(update.data)), logins: await user.loginsView() });
        }
      } catch (e) {
        console.error({ event: "settings.failed", error: String(e) });
        return Response.json({ error: "settings unavailable" }, { status: 500 });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    const forget = url.pathname.match(/^\/api\/logins\/([a-z]+)$/);
    if (forget && (request.method === "DELETE" || (request.method === "POST" && forget[1] === "chrome"))) {
      const user = env.WORKSPACE.getByName(userKey(me.email));
      // Chrome: DELETE stops copying sign-ins and deletes the saved copy; POST starts again.
      if (forget[1] === "chrome") await user.browserSetOff(me.email, request.method === "DELETE");
      else if (!LOGINS[forget[1]]) return new Response("Not found", { status: 404 });
      // A tombstone: each workspace removes its copy within a minute (or when it next wakes).
      else await user.loginPut(forget[1], { hash: "", at: Date.now(), from: "settings" });
      return Response.json({ logins: await user.loginsView() });
    }
    if (url.pathname === "/api/sizes" && request.method === "GET") {
      return Response.json(
        allowedSizes(env).map((instance) => ({
          instance,
          ...INSTANCES[instance],
          about: SIZES[instance] ?? "",
          idle: hourly(instance, 0.02),
          busy: hourly(instance, 0.5),
          default: instance === defaultSize(env),
        })),
      );
    }
    if (url.pathname === "/api/workspaces" && request.method === "GET") {
      const listed = await workspacesOf(env, me);
      const rows = await Promise.all(
        listed.map(async (w) => ({ ...w, name: shortName(w.name), ...(await env.WORKSPACE.getByName(w.name).summary()) })),
      );
      rows.sort((a, b) => Number(b.running) - Number(a.running) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      return Response.json(rows);
    }
    if (url.pathname === "/api/costs" && request.method === "GET") {
      const ledger = await env.WORKSPACE.getByName(LEDGER).ledger();
      const months = Object.keys(ledger).sort().reverse().map((m) => {
        const all = Object.entries(ledger[m]).map(([key, u]) => ({ key, usage: u, cost: cost(u) }));
        // The admin sees the whole account, with other users' workspaces as "<email>/<name>".
        const ws = all
          .filter((w) => me.admin || ownerOf(env, w.key) === me.email)
          .map((w) => ({ name: ownerOf(env, w.key) === me.email ? shortName(w.key) : w.key, own: ownerOf(env, w.key) === me.email, usage: w.usage, cost: w.cost }));
        // The bill is account-wide (shared allowances and plan), so only the admin's view has one.
        return { month: m, workspaces: ws, bill: me.admin ? bill(all.map((w) => w.usage)) : undefined };
      });
      const instance = env.INSTANCE || "standard-2";
      return Response.json({
        months,
        instance,
        resources: INSTANCES[instance],
        price: PRICE,
        hourly: { idle: hourly(instance, 0.02), busy: hourly(instance, 0.5), flat: hourly(instance, 1) },
        notes: [
          "Estimate from our own metering (run time per instance type + container cgroup CPU).",
          "Excludes snapshot storage (unpublished), Workers/DO requests and egress (small).",
          "Included allowances and the $5 plan are account-wide: other Containers on this account share them.",
        ],
      });
    }
    // SSH for laptops: `cloudflared access ssh --hostname https://<host>/ssh/hc-<name>` carries the
    // connection over a WebSocket (Access checks it like any request), and the workspace's sshd
    // gets the bytes. The hc- prefix lets one ssh_config block cover every workspace. /ssh/wake/
    // (which the ssh_config uses when ssh runs in a terminal) and hcw- also wake a sleeping one;
    // plain hc- does not, because Herdr clients reconnect by themselves.
    if (url.pathname === "/api/ssh-ca" && request.method === "GET") {
      if (!env.SSH_CA_KEY) return new Response("no SSH CA configured", { status: 404 });
      return new Response(`@cert-authority hc-*,hcw-* ${await caPublicLine(env.SSH_CA_KEY)}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const sh = /^\/ssh\/(wake\/)?(hcw?-)?([^/]+)$/.exec(url.pathname);
    // Only a WebSocket upgrade is an SSH connection: anything else must not wake the workspace,
    // count as use, or open a connection to its sshd.
    if (sh && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("SSH connections only (cloudflared access ssh)", { status: 426, headers: { Upgrade: "websocket" } });
    if (sh) {
      const name = canonical(sh[3]);
      if (!NAME.test(name)) return new Response("bad workspace name", { status: 400 });
      const key = workspaceKey(env, me.email, name);
      if (await overLimit(env, me, key)) return new Response("workspace limit reached", { status: 403 });
      const fwd = new Request(url, request);
      fwd.headers.set("X-SSH", sh[1] || sh[2] === "hcw-" ? "wake" : "1");
      fwd.headers.set("X-Workspace", key);
      try {
        return await env.WORKSPACE.getByName(key).fetch(fwd);
      } catch (e) {
        console.error({ event: "request.failed", key, action: "ssh", error: e instanceof Error ? e.stack : String(e) });
        return new Response("workspace error", { status: 500 });
      }
    }
    const b = /^\/w\/([^/]+)\/browser(\/.*)?$/.exec(url.pathname);
    if (b) {
      const name = canonical(b[1]);
      if (!NAME.test(name)) return new Response("bad workspace name", { status: 400 });
      const key = workspaceKey(env, me.email, name);
      if (await overLimit(env, me, key)) return html(tooManyPage(Number(env.MAX_WORKSPACES) || 3), 403);
      const prefix = `w/${name}/browser`;
      // The viewer opens its WebSocket at /websockify unless told the prefixed path.
      if (!b[2] || (b[2] === "/" && !url.searchParams.has("path"))) {
        return Response.redirect(new URL(`/${prefix}/?path=${prefix}/websockify&autoconnect=1&resize=remote`, url).toString(), 302);
      }
      const fwd = new Request(url, request);
      fwd.headers.set("X-Browser-Path", b[2]);
      fwd.headers.set("X-Workspace", key);
      try {
        return await env.WORKSPACE.getByName(key).fetch(fwd);
      } catch (e) {
        console.error({ event: "request.failed", key, action: "browser", error: e instanceof Error ? e.stack : String(e) });
        return new Response("workspace error", { status: 500 });
      }
    }
    const m = /^\/w\/([^/]+)(?:\/(terminal|status|checkpoint|journal|size))?$/.exec(url.pathname);
    if (!m) return new Response("Not found", { status: 404 });
    const [, raw, action] = m;
    const name = canonical(raw);
    if (!NAME.test(name)) return new Response("bad workspace name: use letters, digits and hyphens", { status: 400 });
    // Names are lowercase; send /w/Main to /w/main rather than failing.
    if (name !== raw && !action && request.method === "GET") return Response.redirect(new URL(`/w/${name}`, url).toString(), 302);
    const key = workspaceKey(env, me.email, name);
    const ws = env.WORKSPACE.getByName(key);
    try {
      if (!action && request.method === "GET") {
        if (await overLimit(env, me, key)) return html(tooManyPage(Number(env.MAX_WORKSPACES) || 3), 403);
        return html(terminalPage(name));
      }
      if (!action && request.method === "DELETE") {
        await ws.reset();
        await env.WORKSPACE.getByName(LEDGER).unregister(key); // usage history stays for /costs
        return new Response(null, { status: 204 });
      }
      if (action === "terminal") {
        if (await overLimit(env, me, key)) return new Response("workspace limit reached", { status: 403 });
        url.searchParams.set("ws", key);
        return await ws.fetch(new Request(url, request));
      }
      if (action === "status" && request.method === "GET") return Response.json(await ws.status());
      if (action === "journal" && request.method === "GET") return Response.json(await ws.journalLog());
      if (action === "size" && request.method === "POST") {
        const body = await request.json<{ instance?: unknown }>().catch(() => ({ instance: undefined }));
        if (typeof body.instance !== "string") return Response.json({ ok: false, error: "send {\"instance\": \"standard-3\"}" }, { status: 400 });
        const r = await ws.setSize(body.instance);
        return Response.json(r, { status: r.ok ? 200 : 400 });
      }
      if (action === "journal" && request.method === "POST") return Response.json(await ws.journalRollover());
      if (action === "checkpoint" && request.method === "POST") return Response.json(await ws.requestSleep());
      return new Response("Method not allowed", { status: 405 });
    } catch (e) {
      console.error({ event: "request.failed", key, action, error: e instanceof Error ? e.stack : String(e) });
      return new Response("workspace error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
