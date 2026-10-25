# Set up herdr-cloud

You need a Cloudflare account with a domain on it, Node.js 20 or later, and Docker to build the
workspace image.

## 1. Cloudflare account

1. **Workers Paid plan** ($5 a month). Containers and Artifacts are only available on it.
2. **R2:** create the bucket for home-folder archives:
   ```sh
   npx wrangler r2 bucket create herdr-cloud-homes
   ```
3. **Artifacts** (the journal): nothing to do. The `herdr-cloud` namespace is created with the
   first repo. To keep journal data in one jurisdiction (for example the EU), create the namespace
   first with the Artifacts REST API, choosing its jurisdiction; it cannot be changed later. To run
   without a journal, delete the `artifacts` binding from `wrangler.jsonc`.

## 2. Cloudflare Access

In Zero Trust, create a **self-hosted application** for the hostname you will use, for example
`herdr.your-domain.com`:

- **Policy:** Allow, including your email (and later each user's email, or an email domain).
- **Login methods:** any. One-time PIN works with no setup; Google or your company's identity
  provider is smoother.
- Optional, for agents that test the deployment: create a **service token** and add a second
  policy with action **Service Auth** that includes it. Its client ID goes in `SERVICE_CLIENT_ID`;
  it acts as the admin.
- Copy the application's **Application Audience (AUD) tag**, and note your team domain
  (`<team>.cloudflareaccess.com`).

The Worker checks Access's signed token on every request, so it refuses anything that did not
come through Access.

## 3. Configure

```sh
git clone https://github.com/berryk/herdr-cloud.git && cd herdr-cloud
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

In `wrangler.jsonc`, set `routes` to your hostname and fill in `ADMIN_EMAIL`,
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (and `SERVICE_CLIENT_ID` if you made a token). The other
variables have working defaults; each is described in the file.

Secrets:

```sh
openssl rand -base64 32 | npx wrangler secret put SECRETS_KEY   # encrypts users' stored secrets; keep a copy
openssl genpkey -algorithm ed25519 | openssl pkey -outform DER | base64 -w0 | npx wrangler secret put SSH_CA_KEY   # signs workspaces' SSH host keys; keep a copy
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN                 # optional admin fallback, from `claude setup-token`
npx wrangler secret put GITHUB_TOKEN                            # optional admin fallback
```

If you lose `SECRETS_KEY`, users' stored secrets cannot be decrypted and must be entered again.

## 4. Deploy

```sh
tools/push-image.sh      # build container/Dockerfile, push it, pin its digest in wrangler.jsonc
npm run deploy
```

The image is large (Chrome, a remote desktop, build tools), so the first build and push take a
while. Workspaces record the image they run, so pushing a new one and deploying is how you roll
out changes to the container: each workspace moves to it on its next wake.

## 5. First use

1. Open `https://herdr.your-domain.com/`, sign in through Access, type a project name and
   **Open**. The first start takes a minute or two.
2. In **Secrets and logins** (`/settings`), add `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`
   on your own machine) and, if you like, `GITHUB_TOKEN`. To use 1Password, create a service
   account with read-only access to a vault just for workspaces and paste its token; values can
   then be `op://vault/item/field`. Changes apply the next time a workspace wakes.
3. From a laptop: the **Connect** page shows the `~/.ssh/config` block (it needs `cloudflared`).

## 6. Adding users

1. Add their emails (or `@your-company.com`) to the Access application's Allow policy.
2. Add the same to `ALLOWED_EMAILS` in `wrangler.jsonc` (comma-separated) and deploy. Both are
   needed: Access lets them reach the site, the Worker lets them in.
3. `MAX_WORKSPACES` limits how many workspaces each non-admin user may have.

Each user sets their own secrets, including their own Claude token. Their workspaces are keyed
by their email, so users cannot open each other's. The admin sees every workspace's costs.

## Updating

Pull, `npm install`, then `tools/push-image.sh` if anything under `container/` changed, and `npm run deploy`. Workspaces pick up a new image on their next wake (their
home folder is carried over and added `apt` packages are reinstalled), and new Worker code once
they have slept for a few minutes.

## Testing as an agent

With a service token: `HERDR_CLOUD_HOST=herdr.your-domain.com CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... tools/hc.sh /w/agent-test/status`.
For the terminal WebSocket or the browser viewer, send the same two `CF-Access-Client-*` headers;
for SSH, `cloudflared access ssh` reads them from `TUNNEL_SERVICE_TOKEN_ID` and
`TUNNEL_SERVICE_TOKEN_SECRET`. Use a scratch workspace.
