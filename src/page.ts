import { BENCHMARKS, BENCH_DATE, HARDWARE, type SizeResult } from "./benchmarks.js";
import { hourly } from "./meter.js";
const XTERM = "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0";
/** Phones' own monospace fonts lack many symbols Claude Code and Herdr draw (⏺ ⎿ ✻ ⏵ braille
 *  spinners…). JetBrains Mono for text, with Noto fallbacks that cover the rest. */
const FONTS = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+Mono&family=Noto+Sans+Symbols&family=Noto+Sans+Symbols+2&family=Noto+Sans+Math&display=block";
const FONT_FAMILY = `"JetBrains Mono", "Noto Sans Mono", "Noto Sans Symbols 2", "Noto Sans Symbols", "Noto Sans Math", monospace`;
/** Key icons drawn inline, since symbol glyphs are missing from many phones' fonts. */
const svg = (body: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  pad: svg('<path d="M12 3l3 3.5H9zM12 21l-3-3.5h6zM3 12l3.5-3v6zM21 12l-3.5 3V9z" fill="currentColor" stroke="none"/>'),
  paste: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 4h6v2H9z"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  ret: svg('<path d="M20 5v7a2 2 0 0 1-2 2H6"/><path d="M10 10l-4 4 4 4"/>'),
};
const FIT = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0";

export const indexPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>herdr-cloud</title>
<style>body{font:16px system-ui;background:#111;color:#ddd;max-width:560px;margin:10vh auto;padding:0 16px}
input,button{font:inherit;padding:8px 12px;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:#eee}
a{color:#8cf}li{margin:6px 0}table{border-collapse:collapse;width:100%}td{padding:6px 8px 6px 0}
.dim{color:#888;font-size:14px}.st{font-size:14px;color:#888}.st.on{color:#7d7}.where{display:block;font-size:12px;color:#888}
button.del{font-size:13px;padding:3px 8px;color:#e88;border-color:#533}
button.size{font-size:12px;padding:1px 6px;margin-top:2px;white-space:nowrap;color:#aaa;border-color:#333;background:none}
dialog{background:#181818;color:#ddd;border:1px solid #333;border-radius:10px;max-width:520px;width:calc(100% - 32px);padding:16px}
dialog::backdrop{background:#000a}dialog h3{margin:0 0 4px}
label.opt{display:flex;gap:10px;padding:10px;border:1px solid #2a2a2a;border-radius:8px;margin:8px 0;cursor:pointer}
label.opt:has(input:checked){border-color:#5a8}label.opt b{color:#fff}label.opt small{color:#999;display:block}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
</style></head>
<body><h1>herdr-cloud</h1><p><a href="/connect">Connect</a> · <a href="/costs">Costs</a> · <a href="/benchmarks">Benchmarks</a> · <a href="/settings">Secrets and logins</a> <span class="dim" id="me"></span></p>
<form id="f"><input id="n" placeholder="project name" pattern="[A-Za-z0-9][A-Za-z0-9 _.\\-]{0,62}" autocapitalize="none" autocorrect="off" required autofocus>
<button>Open</button></form>
<h3>Workspaces</h3><table id="ws"><tbody><tr><td>loading…</td></tr></tbody></table>
<p class="dim">Open a workspace here, or from a laptop over SSH or Herdr: see <a href="/connect">Connect</a>. Tap a workspace's size to change it.</p>
<dialog id="sz"><form method="dialog" id="szf"><h3>Size of <span id="szn"></span></h3>
<p class="dim">You pay only while it is awake (prices: idle / with an agent working). Measured speeds: <a href="/benchmarks" target="_blank">Benchmarks</a>. A new size applies the next time the workspace starts; it then starts from your home folder rather than its snapshot, and reinstalls packages you added with apt in the background.</p>
<div id="szo"></div><p id="szm" class="dim"></p>
<div class="row"><button value="cancel" formnovalidate>Cancel</button><button id="szs" value="save">Save</button></div></form></dialog>
<script>
const go = n => location.href = "/w/" + n.trim().toLowerCase().replace(/[\\s_.]+/g, "-");
document.getElementById("f").onsubmit = e => { e.preventDefault(); go(document.getElementById("n").value); };
const ago = t => { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// Where Cloudflare placed the container (at its last start, e.g. "lhr01") and its region.
const CITY = { lhr: "London", man: "Manchester", cdg: "Paris", mrs: "Marseille", ams: "Amsterdam", fra: "Frankfurt",
  muc: "Munich", ber: "Berlin", mad: "Madrid", mxp: "Milan", zrh: "Zurich", vie: "Vienna", arn: "Stockholm",
  cph: "Copenhagen", osl: "Oslo", hel: "Helsinki", waw: "Warsaw", prg: "Prague", dub: "Dublin", bru: "Brussels",
  iad: "Ashburn", ewr: "Newark", ord: "Chicago", dfw: "Dallas", atl: "Atlanta", mia: "Miami", lax: "Los Angeles",
  sjc: "San Jose", sea: "Seattle", den: "Denver", yyz: "Toronto", gru: "São Paulo", nrt: "Tokyo", hkg: "Hong Kong",
  sin: "Singapore", syd: "Sydney", bom: "Mumbai" };
const REGION = { WEUR: "Western Europe", EEUR: "Eastern Europe", ENAM: "eastern North America", WNAM: "western North America",
  SAM: "South America", APAC: "Asia-Pacific", OC: "Oceania", ME: "Middle East", AFR: "Africa" };
const where = w => {
  const p = w.where; if (!p) return "";
  const code = (p.location || p.colo || "").toLowerCase();
  const city = CITY[code.slice(0, 3)] || code.toUpperCase() || "unknown";
  const tip = [p.location, p.region && (REGION[p.region] || p.region), p.colo && "traffic via " + p.colo].filter(Boolean).join(" · ");
  return '<span class="where" title="' + esc(tip) + '">' + (w.running ? "in " : "last ran in ") + esc(city) + '</span>';
};
const money = n => "$" + n.toFixed(n < 0.1 ? 3 : 2);
let SIZES = [];
const sizeLabel = n => { const z = SIZES.find(x => x.instance === n); return z ? z.vcpu + " vCPU · " + z.memGiB + " GiB" : n; };
async function load() {
  if (!SIZES.length) SIZES = await (await fetch("/api/sizes")).json();
  const rows = await (await fetch("/api/workspaces")).json();
  document.querySelector("#ws tbody").innerHTML = rows.map(w =>
    '<tr><td><a href="/w/' + w.name + '">' + esc(w.name) + '</a>' + where(w)
    + '<button class="size" data-size="' + w.name + '" data-cur="' + w.size + '" title="Change size">'
    + esc(sizeLabel(w.size)) + (w.runningSize && w.runningSize !== w.size ? " (after restart)" : "") + '</button></td>'
    + '<td class="st ' + (w.running ? "on" : "") + '">' + (w.running ? "running" : "asleep") + '</td>'
    + '<td class="dim">used ' + ago(w.lastActivity) + '</td>'
    + '<td><button class="del" data-n="' + w.name + '" title="Delete this workspace">Delete</button></td></tr>').join("")
    || "<tr><td>none yet</td></tr>";
}
// The size picker: one option per allowed size, with what it suits and what it costs.
let sizeFor = null;
document.getElementById("szf").onsubmit = async e => {
  if (e.submitter && e.submitter.value !== "save") return;
  e.preventDefault();
  const pick = document.querySelector('input[name="size"]:checked'); if (!pick) return;
  const r = await (await fetch("/w/" + sizeFor + "/size", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: pick.value }) })).json();
  if (!r.ok) { document.getElementById("szm").textContent = r.error; return; }
  document.getElementById("sz").close();
  if (r.appliesAt.startsWith("next start:") && confirm("Saved. Restart now to use it? Sleep now saves everything; open the workspace again to start it at the new size.")) {
    await fetch("/w/" + sizeFor + "/checkpoint", { method: "POST" });
  }
  load();
};
document.getElementById("ws").onclick = async e => {
  const sz = e.target.dataset && e.target.dataset.size;
  if (sz) {
    sizeFor = sz; document.getElementById("szn").textContent = sz; document.getElementById("szm").textContent = "";
    document.getElementById("szo").innerHTML = SIZES.map(z => '<label class="opt"><input type="radio" name="size" value="' + z.instance + '"'
      + (z.instance === e.target.dataset.cur ? " checked" : "") + '><span><b>' + z.vcpu + ' vCPU · ' + z.memGiB + ' GiB memory · ' + z.diskGB + ' GB disk</b>'
      + (z.default ? ' <span class="dim">(default)</span>' : '') + '<small>' + esc(z.about) + '</small><small>' + money(z.idle) + '/h idle · ' + money(z.busy) + '/h busy · '
      + esc(z.instance) + '</small></span></label>').join("");
    document.getElementById("sz").showModal();
    return;
  }
  const n = e.target.dataset && e.target.dataset.n; if (!n) return;
  if (prompt('Delete workspace "' + n + '"? Its files, snapshot and home backup are removed for good, so push anything you need first.\\n\\nType the name to confirm:') !== n) return;
  e.target.disabled = true; e.target.textContent = "deleting…";
  const r = await fetch("/w/" + n, { method: "DELETE" });
  if (!r.ok) alert("Delete failed: " + r.status);
  load();
};
load();
fetch("/api/me").then(r => r.json()).then(m => {
  document.getElementById("me").textContent = "· " + m.email;
  if (m.admin) document.getElementById("me").insertAdjacentHTML("beforebegin", '· <a href="/people">People</a> ');
});
</script></body></html>`;

export const connectPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect · herdr-cloud</title>
<style>body{font:15px/1.5 system-ui;background:#111;color:#ddd;max-width:760px;margin:5vh auto;padding:0 16px}
a{color:#8cf}h2{margin-top:32px;border-bottom:1px solid #2a2a2a;padding-bottom:4px}.dim,small{color:#888}
pre{position:relative;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:6px;padding:10px 64px 10px 12px;overflow-x:auto;font-size:13px;line-height:1.4}
code{background:#1a1a1a;padding:1px 4px;border-radius:4px;font-size:13px}pre code{padding:0;background:none}
button.copy{position:absolute;top:6px;right:6px;font:12px system-ui;padding:3px 8px;border-radius:5px;border:1px solid #444;background:#222;color:#ccc;cursor:pointer}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid #222;vertical-align:top}th{color:#999;font-weight:500}
ol li,ul li{margin:4px 0}</style></head>
<body><p><a href="/">← workspaces</a></p><h1>Connect</h1>
<p>Every workspace is a Linux machine running <a href="https://herdr.dev">Herdr</a>. Reach it from a browser, a phone, or a laptop terminal; they all share the same panes, agents and files.</p>

<h2>In the browser</h2>
<p>Open the workspace from the <a href="/">list</a> (or go to <code>/w/&lt;name&gt;</code>). A sleeping workspace wakes when you open it, which takes up to a minute. On a phone, the key bar above the keyboard has Ctrl, Esc, Tab, the arrows, paste and the Herdr prefix (<code>^B</code>); swipe to scroll.</p>

<h2>From a laptop (one-time setup)</h2>
<p class="dim"><b>Set up before 25 October 2026?</b> Do step 2, then in your ssh config change <code>UserKnownHostsFile /dev/null</code> to <code>UserKnownHostsFile ~/.ssh/known_hosts_herdr_cloud</code> and <code>StrictHostKeyChecking no</code> (or <code>accept-new</code>) to <code>yes</code>. Herdr needs this to add a workspace as a machine.</p>
<ol>
<li>Install <code>cloudflared</code>: <code>brew install cloudflared</code> on a Mac, <code>winget install Cloudflare.cloudflared</code> on Windows, or the package from <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/">Cloudflare's downloads</a> on Linux.</li>
<li>Save the herdr-cloud host key, so SSH and Herdr can check every workspace is really yours (one line, the same for every workspace, new or recreated):</li>
</ol>
<div id="cakey"></div>
<ol start="3">
<li>Add this to <code>~/.ssh/config</code> (on Windows <code>C:\\Users\\&lt;you&gt;\\.ssh\\config</code>; create the file if it does not exist):</li>
</ol>
<div id="sshcfg"></div>
<p class="dim">The first connection opens your browser to sign in, as you do here; there are no SSH keys to manage. On Windows without Git for Windows, leave out the first two lines (the <code>Match</code> block needs Git's <code>test</code>) and use <code>hcw-&lt;name&gt;</code> when you want SSH to wake a sleeping workspace. In WSL, install the Linux <code>cloudflared</code> inside WSL: the Windows one does not count.</p>

<h2>SSH</h2>
<p>Each workspace is <code>hc-&lt;name&gt;</code>:</p>
<div id="ssh-examples"></div>
<p>Typing <code>ssh</code> in a terminal wakes a sleeping workspace (on Windows only with Git for Windows installed; <code>hcw-&lt;name&gt;</code> always wakes it). <code>scp</code>, <code>rsync</code> and <code>sftp</code> work the same way (use <code>hcw-&lt;name&gt;</code> if one has to wake it, as they are not typed in a terminal). A plain SSH shell does not get your <a href="/settings">secrets</a>; panes inside Herdr do, so run Claude there.</p>

<h2>Herdr on your laptop</h2>
<p>Add each workspace as a machine, once. Its workspaces and agents then appear in your local Herdr sidebar beside your own:</p>
<div id="herdr-examples"></div>
<p>Herdr reconnects by itself, but it never wakes a sleeping workspace, so a Herdr left open cannot keep one awake. After a workspace has slept, wake it with <code>ssh hcw-&lt;name&gt; true</code> (or open it here); Herdr reconnects within a couple of minutes. Keep Herdr on your laptop up to date: workspaces run the latest release. To attach to just one workspace without saving it: <code>herdr --remote hc-&lt;name&gt;</code>.</p>

<h2>VS Code, Cursor and other editors</h2>
<p>Remote-SSH works with the same names: <b>Remote-SSH: Connect to Host…</b> then <code>hc-&lt;name&gt;</code>, and open <code>/home/dev/work</code>. Wake a sleeping workspace with <code>ssh hcw-&lt;name&gt; true</code> first.</p>

<h2>When it sleeps</h2>
<table>
<tr><th>Keeps it awake</th><th>Does not</th></tr>
<tr><td>Typing, in the browser, over SSH or from a Herdr client<br>A pane's screen changing (output, an editor)<br>A running command using CPU, even silently<br>A busy agent</td>
<td>An open tab or an idle connection<br>A command sitting quietly, like an idle dev server</td></tr>
</table>
<p>After 20 minutes with none of these it saves everything and sleeps (checked every 5 minutes, so up to 5 minutes later). <b>Sleep now</b> on a workspace's page does it at once. Processes stop when it sleeps; files, Herdr's layout, your shells' folders, variables and screens, and Claude's conversations come back when it wakes.</p>

<h2>If something goes wrong</h2>
<table>
<tr><th>You see</th><th>Do this</th></tr>
<tr><td><code>websocket: bad handshake</code></td><td>The workspace is asleep and the connection was not typed in a terminal: run <code>ssh hcw-&lt;name&gt; true</code>.</td></tr>
<tr><td>Herdr shows the machine as reconnecting or <b>! error</b></td><td>Same: it is probably asleep. Wake it with <code>ssh hcw-&lt;name&gt; true</code>.</td></tr>
<tr><td><code>Host key verification failed</code> or <code>No ED25519 host key is known</code></td><td>The host key file from step 2 is missing, or your ssh config still says <code>/dev/null</code> (see the note under the laptop setup). A workspace that has not restarted since 25 October 2026 also fails: press <b>Sleep now</b> on its page, then connect again.</td></tr>
<tr><td><code>EOF</code> or <code>failed to get app info</code>, now and then</td><td>The link between your laptop and Cloudflare dropped. Update <code>cloudflared</code> (<code>brew upgrade cloudflared</code>, <code>winget upgrade Cloudflare.cloudflared</code>) and retry; Herdr retries by itself.</td></tr>
<tr><td>A browser window keeps opening to sign in</td><td>Your Cloudflare sign-in expired. Run <code>cloudflared access login https://<span class="host"></span></code> once.</td></tr>
<tr><td><code>workspace limit reached</code></td><td>Delete a workspace you no longer need on the <a href="/">list</a>.</td></tr>
<tr><td>The first connection hangs</td><td>A workspace that has never run takes about a minute to start. Try again once it has.</td></tr>
</table>
<script>
const host = location.host;
document.querySelectorAll(".host").forEach(e => e.textContent = host);
// ssh typed in a terminal (stderr is one) wakes a sleeping workspace; Herdr's own connections,
// which capture stderr and reconnect by themselves, do not.
const cfg = ['Match host hc-* exec "test -t 2"',
  "  ProxyCommand cloudflared access ssh --hostname https://" + host + "/ssh/wake/%n",
  "Host hc-* hcw-*", "  User dev",
  "  ProxyCommand cloudflared access ssh --hostname https://" + host + "/ssh/%n",
  "  UserKnownHostsFile ~/.ssh/known_hosts_herdr_cloud", "  StrictHostKeyChecking yes", "  LogLevel ERROR",
  "  PreferredAuthentications none", "  ServerAliveInterval 30"].join("\\n");
// A code block with a Copy button.
const block = text => {
  const pre = document.createElement("pre"), code = document.createElement("code"), b = document.createElement("button");
  code.textContent = text; b.className = "copy"; b.textContent = "Copy";
  b.onclick = () => navigator.clipboard.writeText(text).then(() => { b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1500); });
  pre.append(code, b); return pre;
};
document.getElementById("sshcfg").replaceWith(block(cfg));
// The CA line: as a command for Mac, Linux and WSL, and for Windows PowerShell.
fetch("/api/ssh-ca").then(r => r.ok ? r.text() : "").then(line => {
  line = line.trim(); if (!line) return;
  const box = document.getElementById("cakey");
  box.append(document.createTextNode("Mac, Linux or WSL:"), block("mkdir -p ~/.ssh && echo '" + line + "' > ~/.ssh/known_hosts_herdr_cloud"),
    document.createTextNode("Windows (PowerShell):"), block("Set-Content -Encoding ascii $HOME\\\\.ssh\\\\known_hosts_herdr_cloud '" + line + "'"));
});
fetch("/api/workspaces").then(r => r.json()).then(ws => {
  const names = ws.map(w => w.name); const n = names[0] || "main";
  const sshEx = ["ssh hc-" + n + "                 # a shell (wakes it if asleep)", "ssh hcw-" + n + " true           # just wake it",
    "scp notes.md hc-" + n + ":work/       # copy a file in"].join("\\n");
  document.getElementById("ssh-examples").append(block(sshEx));
  const herdrEx = (names.length ? names : ["main"]).map(x => "herdr machine add hc-" + x + " --label " + x).join("\\n");
  document.getElementById("herdr-examples").append(block(herdrEx));
});
</script></body></html>`;

/** /benchmarks: measured results per workspace size (data in benchmarks.ts). */
export function benchmarksPage(): string {
  const B = BENCHMARKS;
  const busy = (z: SizeResult) => hourly(z.size, 0.5);
  const head = '<tr><th></th>' + B.map((z) => `<th>${z.size.replace("standard-", "std-")}</th>`).join("") + "</tr>";
  // One table row: a label, then a cell per size; `best` marks the best value ("low" or "high").
  const row = (label: string, f: (z: SizeResult) => number, fmt: (n: number) => string, best?: "low" | "high", note = "") => {
    const vals = B.map(f);
    const target = best === "low" ? Math.min(...vals) : best === "high" ? Math.max(...vals) : NaN;
    return `<tr><td>${label}${note ? `<small>${note}</small>` : ""}</td>` + vals.map((v) => `<td${v === target ? ' class="best"' : ""}>${fmt(v)}</td>`).join("") + "</tr>";
  };
  const s1 = (n: number) => n.toFixed(1) + " s";
  const ms = (n: number) => n.toFixed(0) + " ms";
  const mbs = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + " GB/s" : n.toFixed(0) + " MB/s");
  const mbit = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + " Gb/s" : n.toFixed(0) + " Mb/s");
  const usd = (n: number) => "$" + n.toFixed(4);
  const table = (title: string, rows: string[]) => `<h2>${title}</h2><div class="scroll"><table>${head}${rows.join("")}</table></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Benchmarks · herdr-cloud</title>
<style>body{font:15px/1.5 system-ui;background:#111;color:#ddd;max-width:860px;margin:5vh auto;padding:0 16px}
a{color:#8cf}h2{margin-top:30px}small,.dim{color:#888}td small{display:block;font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:6px 8px;border-bottom:1px solid #2a2a2a;white-space:nowrap}th{color:#999;font-weight:500}
th:first-child,td:first-child{text-align:left;white-space:normal;min-width:150px}td.best{color:#7d7;font-weight:600}
table.hw td{text-align:left;white-space:normal}table.hw td:first-child{color:#999;width:8em}ul li{margin:6px 0}@media (max-width:520px){th,td{padding:5px 3px;font-size:13px}th:first-child,td:first-child{min-width:96px}}</style></head>
<body><p><a href="/">← workspaces</a> · <a href="/costs">Costs</a></p><h1>Benchmarks</h1>
<p class="dim">Measured ${BENCH_DATE}: one fresh workspace per size, all on the same image, tested at the same time. The client was a server in Roubaix, France, 7 ms from Cloudflare, so latency is what you would see from the UK or western Europe. Green marks the best value in each row.</p>
<h2>What stands out</h2><ul>
<li><b>Waking takes about 5 seconds</b> on every size, from a snapshot of about 170 MB. A brand-new workspace also starts in about 5 seconds when Cloudflare already has the image in that location, and in about 30 seconds when it has to fetch it.</li>
<li><b>Typing feels local:</b> keys echo back in 20–25 ms through the browser and 26–34 ms over SSH (medians).</li>
<li><b>standard-2, 3 and 4 run single-threaded work at the same speed</b> (same AMD EPYC CPUs); the larger sizes add cores. standard-1 gets half a CPU and is about 3–4 times slower at real work, so keep it for light editing.</li>
<li><b>Parallel builds scale with cores:</b> building Redis takes ${B[1].redisBuild} s, ${B[2].redisBuild} s and ${B[3].redisBuild} s on standard-2, 3 and 4. Because the larger sizes finish sooner, <b>a build costs slightly less on standard-4 than on standard-2</b>, and standard-1 costs the most.</li>
<li><b>The network is fast and close</b> to what agents use: 0.5–1.6 Gbit/s down, about 0.4 Gbit/s up, and 5–17 ms to connect to the Anthropic API, GitHub, npm and PyPI.</li>
</ul>
${table("Starting and stopping", [
  row("First start", (z) => z.startFresh, s1, "low", "new workspace; standard-1 had to fetch the image in Paris"),
  row("Wake from sleep", (z) => z.wake, s1, "low", "to a working SSH shell"),
  row("Go to sleep", (z) => z.sleep, s1, "low", "save layout, journal, home archive and snapshot; standard-3 hit a slow upload"),
  row("Snapshot size", (z) => z.snapshotMB, (n) => n + " MB"),
])}
${table("Responsiveness", [
  row("Key echo, browser", (z) => z.webEcho[0], ms, "low", "median; 90th percentile below"),
  row("&nbsp;&nbsp;90th percentile", (z) => z.webEcho[1], ms, "low"),
  row("Key echo, SSH", (z) => z.sshEcho[0], ms, "low", "median, through cloudflared"),
  row("&nbsp;&nbsp;90th percentile", (z) => z.sshEcho[1], ms, "low"),
  row("ssh hc-&lt;name&gt; true", (z) => z.sshCommand, s1, "low", "a whole SSH connection, warm"),
])}
${table("Real work", [
  row("Compile SQLite", (z) => z.sqliteCompile, s1, "low", "gcc -O2, one file, single-threaded"),
  row("Build Redis", (z) => z.redisBuild, s1, "low", "make -j, all cores"),
  row("&nbsp;&nbsp;cost per build", (z) => (z.redisBuild * busy(z)) / 3600, usd, "low", "at the busy hourly rate"),
  row("npm install", (z) => z.npmInstall, s1, "low", "typescript, vite, react, esbuild, eslint"),
  row("Python loop", (z) => z.pythonLoop, s1, "low", "30 million iterations"),
])}
${table("Throughput", [
  row("SHA-256, one process", (z) => z.sha1, mbs, "high"),
  row("SHA-256, all cores", (z) => z.shaAll, mbs, "high"),
  row("Disk write", (z) => z.diskWrite, mbs, "high", "1 GiB, synced"),
  row("Disk read", (z) => z.diskRead, mbs, "high", "1 GiB, direct"),
  row("Download", (z) => z.netDown, mbit, "high", "25 MB from Cloudflare, median of 3, separate run"),
  row("Upload", (z) => z.netUp, mbit, "high", "25 MB to Cloudflare"),
])}
${table("Connecting to services", [
  row("Anthropic API", (z) => z.connect.anthropic, (n) => n.toFixed(0) + " ms", "low", "TCP connect, median of 5"),
  row("GitHub", (z) => z.connect.github, (n) => n.toFixed(0) + " ms", "low"),
  row("npm registry", (z) => z.connect.npm, (n) => n.toFixed(0) + " ms", "low"),
  row("PyPI", (z) => z.connect.pypi, (n) => n.toFixed(0) + " ms", "low"),
])}
<h2>Hardware</h2><div class="scroll"><table class="hw">${HARDWARE.map((h) => `<tr><td>${h.item}</td><td>${h.value}<small>${h.evidence}</small></td></tr>`).join("")}</table></div>
<p class="dim">Each vCPU is a share of the same chip, so single-core speed is the same on every size from standard-2 up; larger sizes add cores. Cloudflare is testing 5th-gen EPYC "Turin" servers, so some locations may move to newer hardware and a rerun could differ. Source: <a href="https://blog.cloudflare.com/gen-12-servers">Cloudflare's Gen 12 servers</a>.</p>
<h2>Where they ran</h2><p>${B.map((z) => `${z.size}: ${z.location}`).join(" · ")}. Cloudflare picks the location at each start.</p>
<h2>Cost per hour</h2><p>${B.map((z) => `${z.size}: $${hourly(z.size, 0.02).toFixed(3)} idle, $${busy(z).toFixed(3)} busy`).join("<br>")}<br><span class="dim">Asleep: $0. See <a href="/costs">Costs</a>.</span></p>
<h2>Method</h2><p class="dim">Each size ran in its own new workspace. Inside it: <code>openssl speed sha256</code> for 5 s (one process, then one per visible CPU); <code>gcc -O2 -c sqlite3.c</code> on the SQLite 3.50.4 amalgamation; <code>make -j$(nproc) MALLOC=libc</code> on Redis 7.4.1; <code>npm install</code> of the packages above into an empty project; <code>dd</code> with <code>conv=fdatasync</code> and <code>iflag=direct</code>; Cloudflare's speed test endpoints; <code>curl</code> connect times. From outside: time to a working <code>ssh hcw-&lt;name&gt; true</code> for first start and wake, Sleep now until the container stopped, and 30 keystrokes each through the web terminal's WebSocket and an SSH session, timing the first byte echoed back. One run per size, so treat small differences as noise.</p>
</body></html>`;
}

export const tooManyPage = (max: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workspace limit</title><style>body{font:16px system-ui;background:#111;color:#ddd;max-width:560px;margin:10vh auto;padding:0 16px}a{color:#8cf}</style></head>
<body><h1>Workspace limit reached</h1><p>You can have ${max} workspaces. Delete one you no longer need on the <a href="/">workspace list</a>, then try again.</p></body></html>`;

export const settingsPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secrets · herdr-cloud</title>
<style>body{font:15px system-ui;background:#111;color:#ddd;max-width:720px;margin:5vh auto;padding:0 16px}
a{color:#8cf}input,button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:#eee;box-sizing:border-box}
.row{display:flex;gap:8px;margin:6px 0;flex-wrap:wrap}.row .n{flex:0 1 230px;min-width:0}.row .v{flex:1 1 260px;min-width:0}
.card{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:12px 16px;margin:14px 0}small,.dim{color:#888}
code{background:#222;padding:1px 4px;border-radius:4px}#msg{margin-left:10px}</style></head>
<body><p><a href="/">← workspaces</a></p><h1>Secrets and logins</h1>
<p class="dim">Your workspaces get these as environment variables. Values are encrypted at rest and never shown again. Changes apply the next time a workspace wakes (press <b>Sleep now</b>, then reload).</p>
<div class="card"><h3>1Password</h3>
<p>Status: <b id="op">…</b></p>
<div class="row"><input class="v" id="opt" type="password" placeholder="Service account token (ops_…)" autocomplete="off"><button id="oprm" type="button">Remove</button></div>
<small>Create a service account in 1Password with <b>read-only</b> access to a vault just for workspaces (for example <code>herdr-cloud</code>). Agents in your workspaces can read everything that vault holds, so keep other secrets elsewhere. With a token set, any value below can be an <code>op://vault/item/field</code> reference, and <code>op</code> works inside your workspaces.</small></div>
<div class="card"><h3>Environment variables</h3><div id="env"></div>
<div class="row"><button id="add" type="button">Add variable</button></div>
<small><code>CLAUDE_CODE_OAUTH_TOKEN</code>: from <code>claude setup-token</code> on your own machine, signed in with your Claude Team seat. <code>GITHUB_TOKEN</code>: used by git and gh for github.com.</small></div>
<button id="save">Save</button><span id="msg" class="dim"></span>
<div class="card"><h3>Saved logins</h3><div id="logins"></div>
<small>Sign in inside any workspace (<code>/login</code> in Claude, or <code>gh auth login</code>) and the login is saved here, encrypted, within a minute. It is copied into your other workspaces, new ones and reset ones, and refreshed tokens follow. Logging out in a workspace, or <b>Forget</b>, removes it from all of them. A token set above takes priority over a saved login.<br><br>
Chrome sign-ins: the workspace browser's cookies are saved the same way every few minutes while you browse, and merged into each workspace when it starts, so a site you signed in to in one is signed in everywhere (sites that keep you signed in; a sign-in that ends when the browser closes does not carry over). Logging out of a site in one workspace does not log the others out.</small></div>
<script>
const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let opToken;
function row(name = "", ref, set) {
  const d = document.createElement("div"); d.className = "row";
  d.innerHTML = '<input class="n" placeholder="NAME" value="' + esc(name) + '" autocapitalize="characters" autocorrect="off">'
    + '<input class="v" type="password" autocomplete="off" placeholder="' + (ref ? esc(ref) + ' (leave blank to keep)' : set ? "set (leave blank to keep)" : "value or op:// reference") + '">'
    + '<button type="button">✕</button>';
  d.querySelector("button").onclick = () => d.remove();
  $("env").append(d);
}
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
function logins(list) {
  $("logins").innerHTML = "";
  list.forEach(l => {
    const d = document.createElement("div"); d.className = "row";
    const chrome = l.id === "chrome";
    const state = l.off ? "not copied between workspaces" : l.at ? "saved " + ago(l.at) + (l.from ? " from " + esc(l.from) : "") : "not saved";
    const action = chrome ? (l.off ? "Copy again" : "Stop copying") : l.at ? "Forget" : "";
    d.innerHTML = "<span class=v><b>" + esc(l.label) + "</b> <span class=dim>" + state + "</span></span>" + (action ? "<button type=button>" + action + "</button>" : "");
    if (action) d.querySelector("button").onclick = async () => {
      const ask = chrome ? (l.off ? "" : "Stop copying Chrome sign-ins between workspaces and delete the saved copy? Each workspace keeps its own.")
        : "Forget the " + l.label + " login? Every workspace will be logged out within a minute.";
      if (ask && !confirm(ask)) return;
      const r = await fetch("/api/logins/" + l.id, { method: chrome && l.off ? "POST" : "DELETE" });
      if (r.ok) logins((await r.json()).logins);
    };
    $("logins").append(d);
  });
}
function show(v) {
  logins(v.logins || []);
  $("op").textContent = v.opToken ? "connected (token stored)" : "not connected";
  $("env").innerHTML = "";
  v.env.forEach(e => row(e.name, e.ref, true));
  if (!v.env.length) { row("CLAUDE_CODE_OAUTH_TOKEN"); row("GITHUB_TOKEN"); }
}
async function load() { show(await (await fetch("/api/settings")).json()); }
$("add").onclick = () => row();
$("oprm").onclick = () => { opToken = null; $("opt").value = ""; $("op").textContent = "will be removed on save"; };
$("save").onclick = async () => {
  // A blank value keeps what is stored; a name left out is removed.
  const env = [...$("env").children].map(d => { const [n, v] = d.querySelectorAll("input"); return { name: n.value.trim().toUpperCase(), value: v.value || undefined }; })
    .filter(e => e.name);
  const body = { env };
  const t = $("opt").value.trim();
  if (t) body.opToken = t; else if (opToken === null) body.opToken = null;
  $("msg").textContent = "saving…";
  const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { $("msg").textContent = "Not saved: " + (j.error || r.status); return; }
  $("opt").value = ""; opToken = undefined; show(j); $("msg").textContent = "Saved. Applies on the next wake.";
};
load();
</script></body></html>`;

export const terminalPage = (name: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<title>${name} · herdr-cloud</title>
<link rel="stylesheet" href="${XTERM}/css/xterm.css">
<link rel="stylesheet" href="${FONTS}">
<style>html{height:100%}body{height:100dvh;margin:0;background:#000;display:flex;flex-direction:column;overflow:hidden}
#bar{flex:none;height:24px;font:12px system-ui;color:#999;background:#111;display:flex;gap:12px;align-items:center;padding:0 8px;white-space:nowrap;overflow-x:auto}
#bar button{font:inherit;background:#222;color:#ccc;border:1px solid #333;border-radius:4px}
#t{flex:1;min-height:0}
/* Extra keys for phones and tablets, whose keyboards have no Esc, Ctrl or arrows. */
#kb{flex:none;position:relative;display:none;-webkit-user-select:none;user-select:none}
#keys{display:flex;gap:4px;padding:6px;background:#000;overflow-x:auto;scrollbar-width:none}
#kb button{flex:1 1 0;height:38px;min-width:0;padding:0;border:0;border-radius:18px;background:#1f1f1f;color:#ddd;font:14px "JetBrains Mono",ui-monospace,monospace;touch-action:manipulation;white-space:nowrap;overflow:hidden;display:flex;align-items:center;justify-content:center}
#kb button.on{background:#2a4a6a}
/* Arrows and paging, opened from the ✥ key, float above the row. */
#pad{position:absolute;bottom:100%;right:8px;display:none;grid-template-columns:repeat(3,58px);grid-auto-rows:46px;gap:6px;padding:8px;background:#111;border:1px solid #333;border-radius:16px}
#pad.open{display:grid}#pad button{height:auto;font-size:18px}#pad button.ret{background:#2a4a6a}
/* iOS zooms into inputs under 16px, which the terminal's hidden input would trigger on every tap. */
.xterm-helper-textarea{font-size:16px!important}
/* Phones and tablets only (body.phone, from the browser's user agent): pointer media queries
   can't tell a Surface from an Android phone. The keys button overrides it (body.kb-show / kb-hide). */
body.phone #kb,body.kb-show #kb{display:block}
body.kb-hide #kb{display:none}
@media (max-width:640px){#cost,#costs{display:none}}[hidden]{display:none!important}</style></head>
<body><div id="bar"><a href="/" style="color:#8cf" title="All workspaces">← workspaces</a><b>${name}</b><span id="st">connecting…</span><span id="cost"></span><a id="costs" href="/costs" style="color:#8cf">costs</a><a href="/w/${name}/browser/" target="_blank" style="color:#8cf" title="The Chrome that agents drive, live">browser</a><span style="flex:1"></span>
<button id="kbtoggle" title="Show or hide the phone key bar">keys</button><button id="copy" hidden title="The browser blocked copying Herdr's selection: tap to copy it">Copy</button><button id="cp" title="Snapshot now and stop the container">Sleep now</button></div><div id="t"></div>
<div id="kb"><div id="pad"></div><div id="keys"></div></div>
<script type="module">
import { Terminal } from "${XTERM}/lib/xterm.mjs";
import { FitAddon } from "${FIT}/lib/addon-fit.mjs";
const name = ${JSON.stringify(name)};
const st = document.getElementById("st");
// Measure cells with the real font, or columns come out wrong; give up waiting after 3 s.
await Promise.race([document.fonts.load('14px "JetBrains Mono"'), new Promise(r => setTimeout(r, 3000))]);
const term = new Terminal({ macOptionClickForcesSelection: true, scrollback: 10000, fontSize: 14, fontFamily: ${JSON.stringify(FONT_FAMILY)} });
const fit = new FitAddon(); term.loadAddon(fit); term.open(document.getElementById("t")); fit.fit();
// Herdr copies a selection by sending it to the terminal (OSC 52): hand it to the browser's clipboard.
// Browsers can refuse without a recent click or key press; then a Copy button copies it on tap.
const copyBtn = document.getElementById("copy"); let copyText = "";
const copied = () => { const was = st.textContent; st.textContent = "copied to clipboard"; setTimeout(() => { if (st.textContent === "copied to clipboard") st.textContent = was; }, 1500); };
copyBtn.onclick = () => navigator.clipboard.writeText(copyText).then(() => { copyBtn.hidden = true; copied(); }, () => { st.textContent = "copy blocked by the browser"; });
term.parser.registerOscHandler(52, data => {
  const b64 = data.slice(data.indexOf(";") + 1);
  if (!b64 || b64 === "?") return true; // a request to read the clipboard: not offered
  try { copyText = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); } catch { return true; }
  navigator.clipboard.writeText(copyText).then(() => { copyBtn.hidden = true; copied(); }, () => { copyBtn.hidden = false; });
  return true;
});
// xterm turns Ctrl+V into a literal ^V and swallows the browser's paste. Let the browser paste instead.
term.attachCustomKeyEventHandler(e => !(e.type === "keydown" && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "v"));
const enc = new TextEncoder(); let sock, tries = 0;
const send = d => sock && sock.readyState === 1 && sock.send(d);
function connect() {
  const u = new URL(location.pathname + "/terminal", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("cols", term.cols); u.searchParams.set("rows", term.rows);
  st.textContent = tries ? "waking / reconnecting…" : "starting (a cold start or restore can take ~30s)…";
  sock = new WebSocket(u); sock.binaryType = "arraybuffer";
  sock.onopen = () => { tries = 0; term.reset(); st.textContent = "attached"; };
  sock.onmessage = e => term.write(new Uint8Array(e.data));
  sock.onclose = e => {
    if (e.code === 1000 || tries >= 10) { st.textContent = e.reason || "disconnected"; term.writeln("\\r\\n[" + (e.reason || "disconnected") + "] reload to reattach"); return; }
    const d = Math.min(1000 * 2 ** tries++, 30000); st.textContent = "reconnecting in " + d / 1000 + "s"; setTimeout(connect, d);
  };
}
connect();
// Extra keys. Ctrl and Alt apply to the next key, from the bar or the keyboard.
const mods = { ctrl: false, alt: false };
const ctrlOf = ch => ch === " " || ch === "@" ? "\\x00" : ch === "?" ? "\\x7f"
  : (c => c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : ch)(ch.toUpperCase().charCodeAt(0));
function type(d) {
  if (mods.ctrl && d.length === 1) d = ctrlOf(d);
  if (mods.alt) d = "\\x1b" + d;
  if (mods.ctrl || mods.alt) { mods.ctrl = mods.alt = false; paintMods(); }
  send(enc.encode(d));
}
const arrow = k => (term.modes.applicationCursorKeysMode ? "\\x1bO" : "\\x1b[") + k;
const pad = document.getElementById("pad");
const KEYS = [
  ["Ctrl", "ctrl"], ["Alt", "alt"], ["Esc", () => type("\\x1b")], ["Tab", () => type("\\t")],
  [${JSON.stringify(ICONS.pad)}, () => pad.classList.toggle("open"), "Arrows and paging", true],
  ["^B", () => type("\\x02"), "Herdr prefix (Ctrl+B)"],
  [${JSON.stringify(ICONS.paste)}, async () => { try { const t = await navigator.clipboard.readText(); if (t) term.paste(t); } catch { st.textContent = "paste blocked: long-press the terminal instead"; } }, "Paste"],
  [${JSON.stringify(ICONS.keyboard)}, () => {
    if (document.activeElement === term.textarea) { pad.classList.remove("open"); term.blur(); } else term.focus();
  }, "Show or hide the keyboard", true],
];
const PAD = [
  ["PgUp", () => type("\\x1b[5~")], ["↑", () => type(arrow("A"))], ["PgDn", () => type("\\x1b[6~")],
  ["←", () => type(arrow("D"))], [${JSON.stringify(ICONS.ret)}, () => type("\\r"), "Return"], ["→", () => type(arrow("C"))],
  null, ["↓", () => type(arrow("B"))], null,
];
const keyBar = document.getElementById("keys");
function addKey(parent, [label, act, title, noFocus]) {
  const b = document.createElement("button"); b.title = title || label;
  if (label.startsWith("<svg")) b.innerHTML = label; else b.textContent = label;
  if (typeof act === "string") b.dataset.mod = act;
  // Keep focus (and the on-screen keyboard) on the terminal.
  b.addEventListener("pointerdown", e => e.preventDefault());
  b.addEventListener("click", () => {
    if (typeof act === "string") { mods[act] = !mods[act]; paintMods(); } else act();
    if (!noFocus) term.focus();
  });
  parent.append(b);
}
KEYS.forEach(k => addKey(keyBar, k));
PAD.forEach(k => k ? addKey(pad, k) : pad.append(document.createElement("span")));
pad.querySelector('[title="Return"]').classList.add("ret");
function paintMods() { for (const b of keyBar.querySelectorAll("[data-mod]")) b.classList.toggle("on", mods[b.dataset.mod]); }
term.onData(type);

// Swipes scroll. Herdr runs full-screen with the mouse on, where xterm's own touch scrolling
// does nothing, so turn swipes into wheel events: xterm hands those to the app, or scrolls its
// own scrollback when the app does not want them. A flick keeps going for a moment.
const tEl = document.getElementById("t");
let lastY = null, vel = 0, lastT = 0, fling = 0, acc = 0, at = { x: 0, y: 0 };
const rowPx = () => tEl.querySelector(".xterm-screen").clientHeight / term.rows;
function wheel(px) {
  acc += px; const h = rowPx();
  for (; Math.abs(acc) >= h; acc -= Math.sign(acc) * h)
    term.element.querySelector(".xterm-screen").dispatchEvent(new WheelEvent("wheel", {
      deltaY: Math.sign(acc) * h, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
}
tEl.addEventListener("touchstart", e => {
  cancelAnimationFrame(fling); acc = 0; vel = 0;
  if (e.touches.length === 1) { lastY = e.touches[0].clientY; lastT = e.timeStamp; at = { x: e.touches[0].clientX, y: lastY }; }
}, { capture: true, passive: true });
tEl.addEventListener("touchmove", e => {
  if (lastY === null || e.touches.length !== 1) return;
  e.preventDefault(); e.stopPropagation();
  const y = e.touches[0].clientY, dy = lastY - y, dt = Math.max(1, e.timeStamp - lastT);
  vel = 0.8 * (dy / dt) + 0.2 * vel; lastY = y; lastT = e.timeStamp;
  wheel(dy);
}, { capture: true, passive: false });
tEl.addEventListener("touchend", () => {
  lastY = null;
  let v = vel * 16, prev = performance.now();
  const step = now => {
    v *= Math.pow(0.95, (now - prev) / 16); prev = now;
    if (Math.abs(v) < 0.5) return;
    wheel(v); fling = requestAnimationFrame(step);
  };
  if (Math.abs(v) > 2) fling = requestAnimationFrame(step);
}, { capture: true, passive: true });
term.onResize(({ cols, rows }) => send(JSON.stringify({ cols, rows })));
addEventListener("resize", () => fit.fit());
// The key bar shows on phones and tablets, told apart by the user agent. In desktop mode an iPad
// says Macintosh and Chrome on a tablet or unfolded phone says Linux, but both have touch; Windows
// touchscreen laptops don't get the bar. The keys button shows or hides it by hand, remembered here.
const ua = navigator.userAgent;
if (navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobi/.test(ua) || (/Macintosh|Linux/.test(ua) && !/CrOS/.test(ua) && navigator.maxTouchPoints > 0))
  document.body.classList.add("phone");
const kbPref = (() => { try { return localStorage.getItem("hc-keys"); } catch { return null; } })();
if (kbPref) document.body.classList.add("kb-" + kbPref);
fit.fit();
const kbShown = () => getComputedStyle(document.getElementById("kb")).display !== "none";
document.getElementById("kbtoggle").onclick = () => {
  const next = kbShown() ? "hide" : "show";
  document.body.classList.remove("kb-show", "kb-hide"); document.body.classList.add("kb-" + next);
  try { localStorage.setItem("hc-keys", next); } catch {}
  fit.fit(); term.focus();
};
// On phones the keyboard shrinks the visual viewport, not the layout one: follow it so the
// prompt and the extra keys stay above the keyboard.
if (window.visualViewport) visualViewport.addEventListener("resize", () => {
  document.body.style.height = visualViewport.height + "px"; scrollTo(0, 0); fit.fit();
});
const money = n => "$" + (n < 1 ? n.toFixed(3) : n.toFixed(2));
async function refreshCost() {
  try {
    const s = await (await fetch(location.pathname + "/status")).json();
    document.getElementById("cost").textContent = "this month ≈ " + money(s.cost.total) + " · " + (s.usage.runSeconds / 3600).toFixed(1) + " h · now ≈ " + money(s.busy ? s.hourly.busy : s.hourly.idle) + "/h" + (s.busy ? " (agent busy)" : "");
  } catch {}
}
setTimeout(refreshCost, 8000); setInterval(refreshCost, 60000);
document.getElementById("cp").onclick = async () => {
  if (!confirm("Snapshot and stop " + name + "? Running agents will be interrupted.")) return;
  st.textContent = "snapshotting…"; sock && sock.close();
  const r = await fetch(location.pathname + "/checkpoint", { method: "POST" });
  st.textContent = r.ok ? "going to sleep (saving, takes a minute or two). Reload to wake." : "checkpoint failed";
};
</script></body></html>`;

export const costsPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Costs · herdr-cloud</title>
<style>body{font:15px system-ui;background:#111;color:#ddd;max-width:860px;margin:5vh auto;padding:0 16px}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}th,td{text-align:right;padding:6px 8px;border-bottom:1px solid #2a2a2a}
th:first-child,td:first-child{text-align:left}th{color:#999;font-weight:500}a{color:#8cf}.big{font-size:28px;color:#fff}
.card{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:12px 16px;margin:12px 0}small{color:#888}
tr.total td{border-top:2px solid #444;border-bottom:none;font-weight:600;color:#fff}</style></head>
<body><p><a href="/">← herdr-cloud</a></p><h1>Costs</h1><div id="out">loading…</div>
<script>
const $ = n => "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
const h = s => (s / 3600).toFixed(1) + " h";
(async () => {
  const [d, sizes] = await Promise.all([fetch("/api/costs").then(r => r.json()), fetch("/api/sizes").then(r => r.json())]);
  // Each workspace picks its size on the workspace list; asleep, any size costs nothing.
  let html = '<h2>Workspace sizes</h2><table><tr><th>Size</th><th>Resources</th><th>Idle / busy</th></tr>'
    + sizes.map(z => '<tr><td style="text-align:left"><b style="white-space:nowrap">' + z.instance + '</b>' + (z.default ? ' <small>(default)</small>' : '') + '<br><small>' + z.about + '</small></td><td style="white-space:nowrap">'
      + z.vcpu + ' vCPU<br>' + z.memGiB + ' GiB · ' + z.diskGB + ' GB</td><td style="white-space:nowrap">' + $(z.idle) + '/h<br>' + $(z.busy) + '/h</td></tr>').join("")
    + '</table><small>Idle: awake with little CPU use. Busy: an agent working (about half the CPU). Asleep: $0. To change one, tap its size on the <a href="/">workspace list</a>. Measured speeds: <a href="/benchmarks">Benchmarks</a>.</small>';
  if (!d.months.length) html += "<p>No usage recorded yet.</p>";
  for (const m of d.months) {
    const b = m.bill;
    html += '<h2>' + m.month + '</h2>' + (b ? '<div class="card"><span class="big">' + $(b.total) + '</span> estimated bill '
      + '<small>(' + $(b.usageAfterIncluded) + ' usage after included allowances + $' + b.plan + ' Workers Paid plan; gross usage ' + $(b.gross.total) + ')</small></div>'
      : '<div class="card"><span class="big">' + $(m.workspaces.reduce((t, w) => t + w.cost.total, 0)) + '</span> usage by your workspaces</div>');
    html += '<table><tr><th>Workspace</th><th>Run time</th><th>CPU</th><th>Starts</th><th>Snapshots</th><th>CPU $</th><th>Memory $</th><th>Disk $</th><th>Total $</th></tr>';
    for (const w of m.workspaces.sort((a, b) => b.cost.total - a.cost.total)) {
      const u = w.usage, c = w.cost;
      html += '<tr><td>' + (w.own ? '<a href="/w/' + w.name + '">' + w.name + '</a>' : w.name) + '</td><td>' + h(u.runSeconds) + '</td><td>' + (u.cpuSeconds / 60).toFixed(1) + ' min</td><td>'
        + u.starts + '</td><td>' + u.snapshots + (u.lastSnapshotBytes ? ' (' + (u.lastSnapshotBytes / 1e9).toFixed(2) + ' GB)' : '') + '</td><td>'
        + $(c.cpu) + '</td><td>' + $(c.memory) + '</td><td>' + $(c.disk) + '</td><td><b>' + $(c.total) + '</b></td></tr>';
    }
    // Gross usage of the workspaces listed, before the account's included allowances.
    const sum = f => m.workspaces.reduce((t, w) => t + f(w), 0);
    if (m.workspaces.length > 1) html += '<tr class="total"><td>Total</td><td>' + h(sum(w => w.usage.runSeconds)) + '</td><td>' + (sum(w => w.usage.cpuSeconds) / 60).toFixed(1) + ' min</td><td>'
      + sum(w => w.usage.starts) + '</td><td>' + sum(w => w.usage.snapshots) + '</td><td>' + $(sum(w => w.cost.cpu)) + '</td><td>' + $(sum(w => w.cost.memory)) + '</td><td>'
      + $(sum(w => w.cost.disk)) + '</td><td>' + $(sum(w => w.cost.total)) + '</td></tr>';
    html += '</table>';
  }
  html += '<small>' + d.notes.join("<br>") + '</small>';
  document.getElementById("out").innerHTML = html;
})();
</script></body></html>`;

export const peoplePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>People · herdr-cloud</title>
<style>body{font:15px system-ui;background:#111;color:#ddd;max-width:860px;margin:5vh auto;padding:0 16px}a{color:#8cf}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0 20px}
.tile{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px}.big{font-size:26px;color:#fff}
small,.dim{color:#888}.person{background:#181818;border:1px solid #2a2a2a;border-radius:8px;padding:12px 14px;margin:10px 0}
.top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.email{font-weight:600;color:#fff;overflow-wrap:anywhere}
.cost{white-space:nowrap}.meta{color:#999;font-size:13px;margin-top:4px}.meta span{white-space:nowrap}
.ws{list-style:none;margin:10px 0 0;padding:0;border-top:1px solid #2a2a2a}
.ws li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #222;font-size:14px}
.ws li:last-child{border-bottom:0}.ws .n{font-family:ui-monospace,monospace;overflow-wrap:anywhere}.ws .r{color:#999;white-space:nowrap;text-align:right}
@media (max-width:520px){body{margin:3vh auto}.big{font-size:22px}}</style></head>
<body><p><a href="/">← herdr-cloud</a></p><h1>People</h1>
<p class="dim">Everyone who has signed in, counted when they open a page or connect over SSH (agents' service tokens are not counted). Sign-ins themselves, including codes sent, are in Cloudflare Zero Trust under Logs → Access.</p>
<div class="tiles" id="tiles"></div><div id="out">loading…</div>
<script>
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
const day = t => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const usd = n => "$" + n.toFixed(2);
(async () => {
  const people = await (await fetch("/api/people")).json();
  people.sort((a, b) => b.last - a.last);
  const week = Date.now() - 7 * 86400000, today = new Date().toISOString().slice(0, 10);
  const tile = (n, label) => '<div class="tile"><div class="big">' + n + '</div><small>' + label + '</small></div>';
  document.getElementById("tiles").innerHTML = tile(people.length, "signed in so far") + tile(people.filter(p => p.lastDay === today).length, "today")
    + tile(people.filter(p => p.last > week).length, "in the last 7 days") + tile(people.filter(p => p.workspaces.length).length, "with a workspace")
    + tile(usd(people.reduce((t, p) => t + p.cost, 0)), "workspace cost this month");
  const meta = p => ["seen " + ago(p.last), p.lastSsh ? "ssh " + ago(p.lastSsh) : "", "first " + day(p.first), p.days + (p.days === 1 ? " day" : " days"), p.visits + (p.visits === 1 ? " visit" : " visits")]
    .filter(Boolean).map(s => "<span>" + s + "</span>").join(" · ");
  const ws = p => p.workspaces.length
    ? '<ul class="ws">' + p.workspaces.sort((a, b) => b.lastOpened - a.lastOpened).map(w => '<li><span class="n">' + esc(w.name) + '</span><span class="r">' + (w.lastOpened ? "opened " + ago(w.lastOpened) : "never opened") + " · " + usd(w.cost) + "</span></li>").join("") + "</ul>"
    : '<div class="meta">No workspaces</div>';
  document.getElementById("out").innerHTML = people.map(p => '<div class="person"><div class="top"><span class="email">' + esc(p.email) + (p.admin ? ' <span class="dim">(admin)</span>' : "")
    + '</span><span class="cost" title="Workspace cost this month">' + usd(p.cost) + '</span></div><div class="meta">' + meta(p) + "</div>" + ws(p) + "</div>").join("") || "No one yet.";
})();
</script></body></html>`;
