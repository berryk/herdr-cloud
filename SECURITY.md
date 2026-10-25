# Security

herdr-cloud is built for one owner and a few trusted users on the owner's Cloudflare account.
Read this before inviting anyone.

## Trust model

- **Cloudflare Access is the only login.** The web pages, the terminal, the agent browser viewer
  and SSH all go through one Worker on a hostname behind an Access application. The Worker
  verifies Access's signed JWT on every request (signature, audience, issuer, expiry) and does not
  trust Access's headers on their own. It then admits only `ADMIN_EMAIL`, `ALLOWED_EMAILS`, and
  the optional `SERVICE_CLIENT_ID` service token, which acts as the admin.
- **SSH has no second factor.** The workspace's sshd user `dev` has an empty password. sshd is
  never exposed: it is reachable only through the Worker's `/ssh/` route, after Access. Anyone who
  passes Access as a user can open a shell in that user's workspaces, exactly as they can in the
  browser. Host keys are per workspace, but the suggested client config does not check them, since
  the connection already runs over TLS to Cloudflare.
- **Inside a workspace, everything runs as `dev`, with passwordless sudo.** Agents can install
  packages and read every file in the workspace, including your secrets once they are in the
  environment. The container is the boundary; one workspace cannot reach another.
- **Users are separated by email.** A user's workspaces, archives, journals and secrets are keyed
  by their email, and the Worker only routes them to their own. They are not separated from the
  admin: the account owner can reach all data through Cloudflare (Durable Object storage, R2,
  Artifacts, the containers themselves).

## Secrets

- Each user's secrets (environment variables and an optional 1Password service account token)
  are encrypted with AES-GCM under the `SECRETS_KEY` Worker secret, stored in a Durable Object,
  and never returned to the browser. They are passed as environment variables to the Herdr server
  when a workspace starts, so every process in the workspace (agents included) can read them.
- `op://` references are resolved inside the workspace with the user's service account token.
  **Agents can read anything that service account can.** Give it read-only access to a vault that
  holds only what workspaces need.
- Plain SSH sessions do not receive a user's secrets; Herdr panes do.

## Data at rest

- Snapshots, home-folder archives (R2) and journals (Artifacts) contain the home folder: shell
  history, Claude Code conversations, settings and project files. Treat them like the workspace.
- Claude Code credentials stored by `/login` (`~/.claude/.credentials.json`) are kept out of the
  journal but are in snapshots and home archives.
- Deleting a workspace deletes its snapshot reference, archive and journal repos.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (Security → Report a vulnerability) on this
repository rather than a public issue.
