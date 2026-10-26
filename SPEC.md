# herdr-cloud: spec

A browser-reachable Claude Code workstation that runs real Herdr inside a Cloudflare Container. It sleeps when nothing is happening, and you pick up where you left off in seconds.

Status: working prototype, published as a reference you can deploy yourself. One admin plus a handful of invited users per deployment.

## 1. Goals

1. **Herdr in a browser tab.** Open `https://<host>/w/<project>` and you are inside `herdr` running in that project's container. You get workspaces, tabs, panes, agent notifications and your keybindings.
2. **Uses the Claude subscription, not API credits.** The token comes from `claude setup-token` and is held as a Worker secret. It is injected as `CLAUDE_CODE_OAUTH_TOKEN` when processes start and is never written to the container disk.
3. **Snapshot on idle, restore on open.**
   - The project goes to sleep when it is idle:
     - no agent is busy;
     - nothing has happened for `IDLE_MINUTES`: no typing in the web terminal or input in the browser viewer, and inside the workspace no pane's screen has changed, no foreground command has used CPU and no terminal has been read from (typing over SSH or a Herdr client). Open tabs and idle connections don't count, nor does a command sitting quietly.
   - Before sleeping, `/home/dev` is archived to R2 and the full container disk is snapshotted, so code, `~/.claude` conversations and dotfiles all survive.
   - On the next open, the container starts from that snapshot if the image is unchanged. If the image has moved on, it starts from the new image and unpacks the home archive on top, so every workspace picks up image updates on its next wake.
4. **Automatic resume.**
   - Before a snapshot, the Herdr layout (workspaces and their working folders) is saved.
   - After a restore, the layout is rebuilt and Claude resumes in each pane that had it (`claude --resume <session>` when Herdr knew the session, else `--continue`).
   - Agents that were busy also get an instruction to check state and carry on.
   - Shell panes come back as they were, minus the processes: folder, variables, aliases and functions set by hand, the old screen redrawn, and the command that was running typed in, ready for Enter.
5. **Never sleep on a working agent.** While any Herdr agent reports a busy state, the container stays up.

## 2. Non-goals

- Sharing a workspace between users.
- Live process migration. Processes do not survive a snapshot. Only disk state does, and resume is how we make up for that.
- A custom web UI on top of Herdr beyond the workspace list, settings, costs and connect pages.

## 3. Architecture

```
Browser (xterm.js) ──WSS──> Worker ──> Durable Object "Workspace" (one per project name)
                                         │  owns the Container (this.ctx.container)
                                         │  exec(["herdr"], {pty}) per browser connection
                                         │  alarm loop: idle check → save layout → snapshotContainer → destroy
                                         ▼
                                   Container image (ubuntu 26.04)
                                     herdr 0.9.x (static binary)
                                     claude (native installer)
                                     git, ripgrep, node, python, build-essential
                                     /opt/herdr-cloud/{save-layout,restore-layout,busy}.sh
                                     user `dev`, HOME=/home/dev, projects in /home/dev/work
```

- **Durable Object per project.** A `Workspace` keyed by name (`[a-z0-9-]{1,63}`). Its storage holds `snapshotId`, `lastActivity`, `clients` and `restorePending`.
- **Terminal.**
  - Each WebSocket runs `herdr` as user `dev` through `container.exec([...], { pty })`. The bridge comes from Cloudflare's `terminal-workspace` example: binary frames are keystrokes and text frames are resize events.
  - Herdr's own server keeps sessions alive across browser disconnects, the same way it survives mosh drops today.
- **Start.**
  - If a snapshot exists and was taken from the current image (or there is no home archive): `container.start({ containerSnapshot: { id } })`. Snapshots only restore onto the image they came from.
  - Otherwise: `container.start({ image })`, then, if a home archive exists, stream it from R2 into `tar -x` over `/home/dev`. If that fails, fall back to the old snapshot rather than come up with an empty home.
  - Image-owned config lives outside `/home/dev` (`/etc/zsh/zshrc`, `/etc/kasmpasswd`), so an older home archive cannot hide it. `browser.sh` re-registers the browser MCP server at each start for the same reason.
  - `enableInternet: true`, because Claude, git and package managers need it.
  - The instance size is configurable, defaulting to `standard-2`.
- **Idle and checkpoint (DO alarm, every `CHECK_MINUTES`).**
  1. Skip the check if `now - lastActivity < IDLE_MINUTES`, or if `busy.sh` reports a busy agent. Terminal keystrokes and viewer key/pointer events refresh `lastActivity`; so does a busy agent, and so does `activity.sh` at each check (every `CHECK_MINUTES`): a shell pane's visible screen changed, its foreground command used over `ACTIVITY_CPU_SECONDS` (2) of CPU, or a `/dev/pts` terminal was read from, since the last check.
  2. Run `save-layout.sh`, which writes `herdr api snapshot` to `~/.herdr-cloud/layout.json`.
  3. Stream `tar` of `/home/dev` (minus caches and the image's Claude Code install) to R2 `HOMES/<project>/home.tar.gz` as a multipart upload. Completing it replaces the previous archive; a failure keeps the old one.
  4. Call `snapshotContainer({ name: "<project>-<timestamp>" })`, store the id and the image it came from, close open sockets with 1000, then `destroy()`.
  4. `setInactivityTimeout(SAFETY_HOURS)` is a backstop only. Our own loop decides when to sleep.
     The timeout and `monitor()` belong to the Durable Object instance and are lost when it restarts (deploys, platform moves). Without them the platform stops the container soon after the last request, with no checkpoint. So the constructor re-arms both whenever it finds the container already running.
- **Every minute: the journal.** The alarm ticks every minute while a container runs; the idle check above still runs every `CHECK_MINUTES`. Each tick commits and pushes the journal (below), so an unannounced stop loses at most about a minute of Claude state, shell state and history, and project files. On any start from a snapshot or home archive older than the last push, `journal.sh restore` lays the newer state over the home folder and each journalled project (changed and deleted files only; a project's own index is untouched; a local journal that is ahead is kept).
- **Restore.**
  - After starting from a snapshot, set `restorePending`.
  - On the first browser attach, a background `restore-layout.sh` waits until the Herdr server answers.
  - It then resumes Claude in each saved pane (recreating it with `--cwd` if Herdr did not), skipping panes where Herdr's own integration already restarted it. Panes flagged busy at checkpoint time get the carry-on prompt.
- **Shell state.** Herdr panes run zsh (`SHELL` is passed to the Herdr server; without it Herdr falls back to `/bin/sh`). `/opt/herdr-cloud/shell-state.zsh`, sourced from `/etc/zsh/zshrc`, writes `~/.herdr-cloud/shells/<pane>/state` at each prompt when it changes: the folder, and exported variables, aliases and functions that differ from those after the rc files ran. `preexec` records the running command. `save-shells.sh` (from `save-layout.sh` and the per-minute sync) saves each non-agent pane's screen. A shell's first prompt restores the state if it was written under a different container start (boot id plus pid 1's start time): redraws the screen, sources the state and puts the running command in the line editor. History is appended as each command runs. The per-minute sync carries `~/.zsh_history` and `~/.herdr-cloud/shells` too.
- **Herdr integration.** `init.sh` installs Herdr's Claude integration (a `SessionStart` hook that reports each Claude session to Herdr, so Herdr resumes it after a restart) and links the `herdr-cloud` Herdr plugin (`container/herdr-plugin`). The plugin's event hook (`agent-event.sh`, on `pane.agent_status_changed`) logs to `~/.herdr-cloud/agent-events.log` and, when an agent settles (idle, done, blocked), snapshots its project into the journal. `restore-layout.sh` waits for Herdr's own resume and only sends busy panes the carry-on prompt, launching Claude itself only if Herdr did not.
- **Journal (Cloudflare Artifacts).** Git repos in namespace `herdr-cloud` (binding `ARTIFACTS`), one current repo per workspace, `ws-<workspace>-<YYYYMMDD-HHMMSS>`.
  - **Size plan.** Artifacts caps a repo at 1 GB, does not report repo sizes, and cannot be relied on to reclaim rewritten history, so the journal rolls over to a fresh repo instead: at the start of each month, or early once `journal.sh size` (on-disk size of everything reachable from the journal refs, measured every 5 minutes) passes `JOURNAL_ROLLOVER_MB` (600). The Durable Object creates the new repo first, then `journal.sh rollover` collapses each branch to one baseline commit of its current state (and drops the old history from `journal.git`; projects' repos keep their own gc schedule), and the next push fills the new repo. Older repos are kept `JOURNAL_KEEP_MONTHS` (2) whole months, then deleted at a rollover. `POST /w/<name>/journal` forces a rollover. Untracked project files over `JOURNAL_MAX_FILE_MB` (25) are left out of snapshots, noted in the commit message. `journal.sh` keeps the commits local and cheap:
  - branch `home`: Claude state, shell state and history, dotfiles, from `~/.herdr-cloud/journal.git` with `$HOME` as its work tree (credentials and caches excluded);
  - branch `work/<project>`: each git repo under `~/work`, snapshotted with a throwaway index (untracked files included, `.gitignore` honoured; the project's own index and branches untouched) onto `refs/journal/work`, one commit per agent turn (named after the agent, pane and terminal title), one per shell command that changed files, and one per minute for anything else.
  - Every minute (and before each sleep) the Durable Object runs `journal.sh tick` then `push`, passing the remote and a write token it minted (one hour, kept only in memory) in that exec's environment. Changed refs only. `/w/<name>/journal` lists recent commits per branch. Deleting a workspace deletes its repo.
  - **History page** (`src/history.ts`, `src/historyPage.ts`). Reads go straight to Artifacts through the binding (log, readCommit, readTree, readBlob), so browsing never wakes a workspace. A commit's changes are a tree diff against its first parent that only descends into subtrees whose hashes differ (capped at 400 files and 300 tree reads); diffs are computed in the browser (jsdiff). "While you were away" starts at `lastSeenAt` (set when a terminal or SSH client connects or leaves) and lists per project the agent turns, the net file changes, the shell commands from `commands.log` and the shell panes' saved screens. Everything shown comes from inside a workspace, which agents control, so the page builds it with `textContent` only.
  - **Restore** wakes the workspace and runs `journal.sh pick BRANCH COMMIT [PATH]` with a read remote in that exec's environment: a snapshot first (so a restore is itself in the timeline and can be undone), then the file, or every file that differs, is brought back with `git restore --worktree`; the project's index, branches and commits are untouched. Home can only be restored a file at a time. **Summary** runs `claude -p` in the workspace (with the owner's secrets) on a digest of the period. **Share** creates repo `share-<name>-<rand>`, has `journal.sh share` push one commit of the project's tree at that point (no history, never home), and hands out a read token of 1 to 30 days (the creation token is revoked); shares are listed on the page and deleted on request, on expiry when next listed, and with the workspace. **Fork** copies the source's home archive in R2 to the new workspace and records, per branch, the last commit at or before the fork time; at its first start the new workspace runs `journal.sh pick` for each, then `forget-pushed` so its own new journal gets every branch.
  - A Durable Object whose container is running keeps the code it started with until the workspace sleeps, so new methods reach a busy workspace only after its next sleep.
  - Shell commands: `shell-state.zsh` logs each command (time, pane, exit code, duration, folder) to `~/.herdr-cloud/commands.log`, and after a command run in a project under `~/work` snapshots it in the background; only a command that changed something makes a commit ("shell: <command> (exit N, Ns)").
- **Shell tools.** mise (per-user runtimes in `~/.local/share/mise`) and atuin (Ctrl+R history search; the up arrow is zsh's) are activated in `/etc/zsh/zshrc`.
- **SSH (laptops, Herdr clients, VS Code).** The image runs sshd; it is reachable only through `/ssh/<alias>`, which Access guards like any request and the Durable Object bridges (WebSocket to `getTcpPort(22).connect`). Access is the login: `dev` has an empty password, which sshd accepts as the "none" method. Each workspace makes its own ed25519 host key in `~/.herdr-cloud/ssh/` (carried by the home archive; sshd gets a HUP after an archive is unpacked). The Durable Object signs it as an OpenSSH host certificate for `hc-<name>` and `hcw-<name>` with the `SSH_CA_KEY` Worker secret (`src/sshcert.ts`), on the first SSH connection and again within a week of expiry (30 days), then reloads sshd and waits for it to listen. Laptops trust every workspace with one `@cert-authority hc-*,hcw-* <key>` line (served at `/api/ssh-ca`) and strict checking, which `herdr machine add` requires. Requests to `/ssh/` that are not WebSocket upgrades get 426 at once. sshd's `ClientAliveInterval` closes sessions whose laptop went away. On the laptop, `cloudflared access ssh --hostname https://<host>/ssh/%n` is the ProxyCommand (the list page shows the ssh_config block). `/ssh/hc-<name>` connects only to a running workspace and gets 409 while it sleeps, because Herdr's saved machines retry by themselves every couple of minutes and would never let it sleep; `/ssh/wake/hc-<name>` (and `hcw-<name>`) wake it. The ssh_config block picks the wake path with `Match host hc-* exec "test -t 2"`: ssh typed in a terminal has a terminal on stderr, while Herdr (`--remote` and `machine add`, checked) captures it. Before bridging, the Durable Object makes sure the Herdr server is running with the owner's secrets (a short pty attach, as the browser does), since one started from an SSH session would lack them. SSH bytes are not activity (clients send health checks); `activity.sh` judges use inside the workspace.
- **Auth and users.**
  - The Worker only serves behind Cloudflare Access on a custom hostname. `workers_dev` is disabled.
  - The Worker verifies Access's signed JWT (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) rather than trusting headers. It lets in `ADMIN_EMAIL`, anyone matching `ALLOWED_EMAILS` (emails or `@domain`), and the agent service token (as the admin).
  - Workspaces are owned by whoever opens them. The admin's keep their bare names; everyone else's Durable Object, R2 archive and ledger rows are keyed `<email>/<name>`, so a user can only reach their own. Non-admins get `MAX_WORKSPACES`.
  - `/costs` shows the admin the whole account; others see only their own workspaces, without the account bill.
  - `/people` (admin only) lists everyone who has signed in: first and last visit, days active, last SSH connection, workspaces and this month's cost. A visit is a page load or an SSH connection by a person (service tokens are not counted), recorded in the ledger Durable Object. Access's own logs hold the sign-ins and codes sent.
- **Secrets and logins** (per user, at `/settings`).
  - Each user stores a 1Password service account token and environment variables. Values are literals or `op://` references. They are AES-GCM encrypted under the `SECRETS_KEY` Worker secret in a per-user Durable Object (`_user:<email>`) and never returned to the browser.
  - Herdr starts through `with-secrets.sh`, which resolves `op://` values with one `op run` (per variable if one fails) and drops unresolved ones. Values live only in process memory. The Herdr server keeps the environment it started with, so changes apply on the next wake.
  - Claude: each user's `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on their Team seat. GitHub: `GITHUB_TOKEN`, used by git through a system credential helper and by gh.
  - Agents have sudo, so any secret a workspace gets is readable inside it. Service accounts should be read-only on a vault kept for workspaces.
  - The admin falls back to the `CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_TOKEN` Worker secrets, unless they have a saved login for that tool (an environment token would hide it).
  - **Saved logins.** Logins made inside a workspace follow their owner: `~/.claude/.credentials.json` (Claude) and `~/.config/gh/hosts.yml` (gh; git uses it through the system credential helper when `GITHUB_TOKEN` is unset). Each minute, and at start and before sleep, the Durable Object compares the file (hash, mtime) with the owner's saved copy, sealed under `SECRETS_KEY` in `_user:<email>`: the newer wins in both directions. A file removed after the workspace had the saved version (a logout), or Forget on `/settings`, leaves a tombstone, and each workspace deletes its copy. The journal never holds these files.
  - **Chrome sign-ins.** `browser-logins.sh` copies the agent browser's cookie database (`sqlite3 .backup`, Chrome keeps running) and merges it with the saved copy, newest row winning; the Worker encrypts it under `SECRETS_KEY` into `HOMES` at `_logins/<email>/chrome-cookies.gz.enc`. This runs every `CHECK_MINUTES` when the database changed, and before sleep. At a start, a saved copy the workspace has not merged yet is merged into its profile while Chrome is held back (agent-chrome waits on `/tmp/hc-browser-hold`). Chrome runs with `--password-store=basic`, so cookies use its fixed key and read the same anywhere. Merging keeps sign-ins from several workspaces; a logout from a site does not spread. Session cookies do not carry: Chrome drops them when it starts. Stop copying on `/settings` deletes the saved copy.
- **System packages.** Before each home archive, `save-packages.sh` records apt packages marked manual that the image lacks, plus added apt sources and keyrings, in `~/.herdr-cloud/`. After a home archive is unpacked onto a newer image, `restore-packages.sh` reinstalls them in the background (one at a time if a name has gone). Log: `~/.herdr-cloud/apt-restore.log`.

## 4. HTTP surface

| Method and path | What it does |
|---|---|
| `GET /` | Index page: open a project by name, and your workspaces with Delete |
| `GET /settings`, `GET/PUT /api/settings` | Your secrets and logins (values write-only) |
| `DELETE /api/logins/<claude\|github\|chrome>`, `POST /api/logins/chrome` | Forget a saved login; stop or restart copying Chrome sign-ins |
| `GET /api/me`, `GET /api/workspaces`, `GET /api/costs` | Who you are; your workspaces; costs |
| `GET /api/ssh-ca` | The `@cert-authority` line laptops put in `~/.ssh/known_hosts_herdr_cloud` |
| `GET /people`, `GET /api/people` | Admin: who has signed in and how much they use it |
| `GET /w/:name` | Terminal page (xterm.js) |
| `GET /w/:name/terminal` (WebSocket) | Attaches `herdr` in a PTY |
| `GET /w/:name/browser/*` | KasmVNC viewer of the agent browser (pages and RFB WebSocket) |
| `GET /w/:name/status` | JSON: running, snapshotId, clients, lastActivity, busy |
| `POST /w/:name/checkpoint` | Queues a sleep: the next alarm (immediately) saves the layout, archives home, snapshots and stops |
| `DELETE /w/:name` | Destroys the container and forgets the snapshot (fresh start) |
| `GET /w/:name/history` | History page: the journal's timeline per project, diffs, browse files at any point, restore, fork, share, "while you were away" |
| `GET /w/:name/j/info\|log\|changes\|blob\|tree\|away` | The History page's reads, straight from Artifacts (no wake). `blob` answers as an attachment with `nosniff` and a sandbox CSP |
| `POST /w/:name/j/restore\|summary\|share`, `DELETE /w/:name/j/share?repo=` | Restore a file or project to a commit; Claude's summary of a period; share a project at a commit (wake the workspace) |
| `POST /w/:name/fork` `{to, at}` | New workspace from this one's home archive with the journal at `at` laid over it at its first start |
| `GET /storage`, `GET /api/storage`, `DELETE /api/storage/object\|repo` | Storage per workspace; for the admin, everyone's and the leftovers nothing refers to (deletable) |

## 4a. Cost view

**Metering:**
- Each Workspace DO meters its own container.
- Run time is measured from start, at each alarm tick, and at checkpoint.
- Active CPU comes from the container's cgroup `cpu.stat` `usage_usec`.
- Run time multiplied by the instance's memory and disk gives GiB-seconds and GB-seconds.
- Monthly totals are kept in DO storage (`usage:YYYY-MM`) and mirrored to a reserved `_ledger` DO.

**Pricing:** rates come from Cloudflare's published Containers pricing (`src/meter.ts`):
- CPU: $0.00002 per vCPU-second, on active use only.
- Memory: $0.0000025 per GiB-second.
- Disk: $0.00000007 per GB-second.
- The account bill subtracts the Workers Paid allowances (375 vCPU-minutes, 25 GiB-hours, 200 GB-hours) and adds the $5 plan.

**Where it shows:**
- `/costs` has a month card plus a per-workspace table.
- `/api/costs` returns the same data as JSON.
- The terminal bar shows the month to date and the current hourly rate.

**Not modelled:**
- Snapshot storage (not published).
- Workers/DO requests.
- Egress.
- Allowances shared with other Containers on the account.


## 5. Config (wrangler vars)

| Var | Default | Meaning |
|---|---|---|
| `ADMIN_EMAIL` | | Owner of the deployment: workspaces keep bare names; sees all costs |
| `ALLOWED_EMAILS` | empty | Other emails or `@domain`s let in (Access must allow them too) |
| `MAX_WORKSPACES` | 3 | Workspaces per non-admin user |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | | For verifying Access JWTs |
| `SERVICE_CLIENT_ID` | empty | Client ID of an Access service token that acts as the admin (for agents testing the deployment) |
| `IDLE_MINUTES` | 20 | Idle time before checkpoint |
| `CHECK_MINUTES` | 5 | Alarm interval |
| `INSTANCE` | standard-2 | Container size |
| `SAFETY_HOURS` | 6 | Platform inactivity backstop (the platform maximum) |
| `BACKUP_MINUTES` | 30 | Home archive to R2 while in use; Cloudflare can stop a container without warning, and a wake then prefers the newer of snapshot and archive |
| `JOURNAL_KEEP_MONTHS` | 2 | Older journal repos kept after a rollover |
| `JOURNAL_ROLLOVER_MB` | 600 | Journal history size that triggers an early rollover |
| `JOURNAL_MAX_FILE_MB` | 25 | Untracked project files bigger than this are left out of snapshots |
| `ACTIVITY_CPU_SECONDS` (container env) | 2 | CPU a foreground command must use between checks to count as activity |

## 6. Ideas not built

- Reconcile the cost view against Cloudflare's GraphQL Analytics for billed numbers (needs an analytics-read token).
- A mobile agent dashboard (agents, status, quick prompts) on Herdr's socket API.
- Notifications (for example Telegram) when an agent finishes or is blocked, from the Herdr plugin's agent events.
- Per-user monthly budgets.

## 7. Open questions and risks

- **Snapshot behaviour.** `snapshotContainer` size, time and retention limits are unmeasured. They need testing on a real project with `node_modules`.
- **Herdr agent states.** The exact strings that `herdr agent list` reports have to be checked against 0.9.5. `busy.sh` treats anything other than idle, done or blocked-on-user as busy.
- **Platform inactivity timer.** Does an attached-but-quiet PTY count as activity? The safety timeout covers this either way.
- **Subscription terms.** Each user brings their own Claude token (`claude setup-token`); tokens are personal and not shared.
