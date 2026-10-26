# herdr-cloud

[Herdr](https://herdr.dev) and Claude Code in Cloudflare Containers. Each project gets its own
Linux workspace that you open in a browser tab, on your phone, or from your laptop's terminal or
Herdr client. When nothing is happening it saves itself and sleeps, costing nothing, and wakes
where you left off, with Claude resuming its conversations.

**Status:** a reference you can deploy on your own Cloudflare account. It works and is used
daily, but it is not a supported product: expect to read the code. It relies on Cloudflare
features that are still in beta (container snapshots, Artifacts).

## Features

- **Herdr in the browser.** `/w/<project>` attaches to Herdr running in that project's container:
  workspaces, tabs, panes, agent status. Any number of browser tabs and devices share one session.
- **Sleeps to $0.** After 20 minutes with nothing happening (no typing anywhere, no output or CPU
  from a running command, no busy agent) the workspace snapshots its disk and stops. Opening it,
  or typing `ssh hc-<project>`, wakes it in about half a minute.
- **Comes back as it was.** Herdr's layout returns; Claude resumes the same conversation in each
  pane (and an agent that was mid-task is told to carry on); shell panes return to their folder
  with your variables, aliases, functions, old screen and the interrupted command typed in.
- **Phone friendly.** A key bar with Ctrl, Alt, Esc, Tab, arrows and Return, paste, the Herdr
  prefix and a keyboard toggle; swipe to scroll; fonts that cover Claude's and Herdr's symbols.
- **Laptop access over SSH, through Cloudflare Access.** `ssh hc-<project>`,
  `herdr machine add hc-<project>`, VS Code Remote-SSH. No SSH keys: Access is the login.
- **A journal in Cloudflare Artifacts.** Every minute, each agent turn and each shell command that
  changes a project is a git commit: Claude state, shell state and history on one branch, a
  snapshot of each project's working tree on another. An unexpected stop loses at most a minute.
  A fresh repo starts each month.
- **History, fork and share.** Each workspace's History page shows the journal as a timeline per
  project: every agent turn and command, diffs, the files as they were at any point, and restore
  of a file or a whole project (undoable; git branches are never touched). "While you were away"
  sums up agent turns, files changed and commands since you last looked, optionally in Claude's
  words. Fork a workspace as it was at any point, or share a read-only copy of a project at one
  point with an expiring clone token. A Storage page shows what each workspace keeps.
- **Per-user secrets.** Each user stores environment variables (their Claude token, a GitHub
  token) and optionally a 1Password service account token; values can be `op://` references
  resolved inside the workspace. Encrypted at rest, never shown again.
- **Logins that follow you.** Sign in inside any workspace (`/login` in Claude, `gh auth login`)
  and the login is saved, encrypted, and copied into your other workspaces, including new ones.
  Refreshed tokens follow and a logout removes it everywhere. The browser's site sign-ins (its
  cookies) are merged across workspaces the same way.
- **An agent browser.** Chrome on a remote desktop that agents drive (Chrome DevTools MCP) and you
  can watch and take over at `/w/<project>/browser/`.
- **A size per workspace.** Pick 0.5 to 4 vCPU (standard-1 to standard-4) on the workspace list; the Costs page describes each size and what it costs per hour.
- **Multi-user.** An admin plus invited users (by email or domain), each with their own
  workspaces and a workspace limit. A costs page shows usage per workspace.
- **Tools carry over.** Packages you `apt-get install` are reinstalled on newer images; `mise`
  and `atuin` are included; a Herdr plugin hooks agent events.

## Performance

Measured on Cloudflare Containers in October 2026 (full results on the deployment's `/benchmarks` page and in `src/benchmarks.ts`): waking from sleep takes about 5 seconds on every size, keystrokes echo in 20–25 ms through the browser and 26–34 ms over SSH from western Europe, and building Redis takes 109 s on standard-2 and 29 s on standard-4, which costs slightly less per build.

## How it works

One Worker behind Cloudflare Access, one Durable Object per workspace that owns its container, an
R2 bucket for home-folder archives and an Artifacts namespace for journals. The terminal is
`herdr` run through the container's `exec` with a pseudo-terminal, bridged to xterm.js over a
WebSocket. SSH is the same bridge to the container's sshd. [SPEC.md](SPEC.md) explains each part
and why.

## Costs

On the default `standard-2` instance (1 vCPU, 6 GiB): about $0.06 an hour while awake and idle,
about $0.09 an hour with an agent working, nothing while asleep. Cloudflare's Workers Paid plan
($5 a month) is required and includes allowances that cover light use. Artifacts storage beyond
1 GB is $0.50 per GB-month. The `/costs` page estimates your bill from the workspaces' own
metering.

## Set up

See [docs/SETUP.md](docs/SETUP.md). Once deployed, the **Connect** page (`/connect`) shows how to
reach workspaces from a laptop.

## Limitations

- Processes do not survive a sleep; files, layout, shells and Claude's conversations do.
- A running workspace picks up new Worker code only after it has been asleep for a few minutes
  (its Durable Object keeps running the old code while its container is up).
- Container snapshots and Artifacts are Cloudflare betas; their limits and behaviour may change.
- Each journal repo is capped at 1 GB by Artifacts; the monthly rollover keeps it well below.

## Security

Read [SECURITY.md](SECURITY.md) before inviting anyone: Cloudflare Access is the only login, and
everything in a workspace runs as one user with passwordless sudo.

## Licence

Apache License 2.0 (see `LICENSE` and `NOTICE`). Herdr is also Apache-2.0 and is downloaded into the image at build time, as are KasmVNC,
Google Chrome, the 1Password CLI and Claude Code, under their own licences.
