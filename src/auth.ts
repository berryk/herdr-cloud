// Who is calling: verify Cloudflare Access's signed JWT rather than trusting its headers.
// developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

export interface AuthEnv {
  /** Access team domain, e.g. "myteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access app in front of this Worker. */
  ACCESS_AUD: string;
  /** Owner of the original single-user workspaces; sees every workspace's costs. */
  ADMIN_EMAIL: string;
  /** Comma-separated emails or "@domain" entries allowed in besides the admin. Access is the first gate. */
  ALLOWED_EMAILS?: string;
  /** Client ID of the Access service token agents use. It acts as the admin. */
  SERVICE_CLIENT_ID?: string;
  /** More service tokens, each acting as an ordinary user: "clientId=email,...". Lets agents test
   *  what non-admin users see. */
  SERVICE_USERS?: string;
}

export interface Identity {
  email: string;
  admin: boolean;
  /** Signed in with an Access service token (an agent testing the deployment), not a person. */
  service?: boolean;
}

const EMAIL = /^[^\s/@]+@[^\s/@]+$/;

let keys: { at: number; byKid: Map<string, CryptoKey> } | undefined;

async function signingKey(env: AuthEnv, kid: string): Promise<CryptoKey | undefined> {
  // Access rotates keys every few weeks and publishes the next one early: refetch on a miss.
  if (!keys?.byKid.has(kid) || Date.now() - keys.at > 3600_000) {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs: ${res.status}`);
    const { keys: jwks } = await res.json<{ keys: (JsonWebKey & { kid: string })[] }>();
    const byKid = new Map<string, CryptoKey>();
    for (const jwk of jwks) {
      byKid.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    }
    keys = { at: Date.now(), byKid };
  }
  return keys.byKid.get(kid);
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** The verified Access claims, or null if the token is missing, forged, expired or for another app. */
async function accessClaims(request: Request, env: AuthEnv): Promise<Record<string, unknown> | null> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  const [h, p, sig] = jwt?.split(".") ?? [];
  if (!h || !p || !sig) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const key = header.alg === "RS256" ? await signingKey(env, header.kid) : undefined;
    if (!key || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`)))) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    if (!aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(claims.exp > now) || claims.nbf > now) return null;
    return claims;
  } catch (e) {
    console.error({ event: "auth.failed", error: String(e) });
    return null;
  }
}

function allowed(email: string, env: AuthEnv): boolean {
  const domain = email.slice(email.indexOf("@"));
  return (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .some((e) => e === email || (e.startsWith("@") && e === domain));
}

export async function identify(request: Request, env: AuthEnv): Promise<Identity | null> {
  const claims = await accessClaims(request, env);
  if (!claims) return null;
  const admin = env.ADMIN_EMAIL.toLowerCase();
  // Service tokens (agents testing the deployment) carry no email; Access puts the token's
  // client ID in common_name instead.
  if (!claims.email) {
    if (env.SERVICE_CLIENT_ID && claims.common_name === env.SERVICE_CLIENT_ID) return { email: admin, admin: true, service: true };
    for (const entry of (env.SERVICE_USERS ?? "").split(",")) {
      const [id, email] = entry.trim().split("=");
      if (id && email && claims.common_name === id && EMAIL.test(email.toLowerCase()) && email.toLowerCase() !== admin) return { email: email.toLowerCase(), admin: false, service: true };
    }
    return null;
  }
  const email = String(claims.email).toLowerCase();
  if (!EMAIL.test(email)) return null;
  if (email === admin) return { email, admin: true };
  return allowed(email, env) ? { email, admin: false } : null;
}
