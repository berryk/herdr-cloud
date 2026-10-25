// OpenSSH host certificates for workspaces (PROTOCOL.certkeys in OpenSSH). Each workspace's sshd
// gets its host key signed by one herdr-cloud key (SSH_CA_KEY), so a laptop trusts every workspace,
// new or recreated, with one "@cert-authority hc-*,hcw-* <key>" line instead of learning each host
// key. Herdr's `machine add` insists on strict host key checking, which this satisfies.

const enc = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}
function cat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}
/** An SSH "string": a length, then the bytes. */
const str = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? enc.encode(b) : b;
  return cat(u32(bytes.length), bytes);
};
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The 32-byte key in an "ssh-ed25519 AAAA… comment" line. */
function ed25519Key(line: string): Uint8Array {
  const blob = unb64(line.trim().split(/\s+/)[1] ?? "");
  const view = new DataView(blob.buffer);
  const typeLen = view.getUint32(0);
  if (new TextDecoder().decode(blob.slice(4, 4 + typeLen)) !== "ssh-ed25519") throw new Error("not an ed25519 key");
  const keyLen = view.getUint32(4 + typeLen);
  return blob.slice(8 + typeLen, 8 + typeLen + keyLen);
}

async function caKey(pkcs8b64: string): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const priv = await crypto.subtle.importKey("pkcs8", unb64(pkcs8b64), { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const pub = unb64(jwk.x!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.x!.length / 4) * 4, "="));
  return { priv, pub };
}

/** The CA's public key as one OpenSSH line, for laptops' known_hosts. */
export async function caPublicLine(pkcs8b64: string): Promise<string> {
  const { pub } = await caKey(pkcs8b64);
  return `ssh-ed25519 ${b64(cat(str("ssh-ed25519"), str(pub)))} herdr-cloud`;
}

/** Sign a workspace's host key (its .pub line) for the given host names; returns the -cert.pub line. */
export async function signHostKey(pkcs8b64: string, hostPub: string, principals: string[], keyId: string, days = 30): Promise<string> {
  const { priv, pub } = await caKey(pkcs8b64);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const type = "ssh-ed25519-cert-v01@openssh.com";
  const body = cat(
    str(type),
    str(crypto.getRandomValues(new Uint8Array(32))), // nonce
    str(ed25519Key(hostPub)),
    u64(now), // serial
    u32(2), // host certificate
    str(keyId),
    str(cat(...principals.map((p) => str(p)))),
    u64(now - 3600n), // valid after (allow for clock skew)
    u64(now + BigInt(days) * 86400n), // valid before
    str(new Uint8Array()), // critical options
    str(new Uint8Array()), // extensions
    str(new Uint8Array()), // reserved
    str(cat(str("ssh-ed25519"), str(pub))), // signature key
  );
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, body));
  return `${type} ${b64(cat(body, str(cat(str("ssh-ed25519"), str(sig)))))} ${keyId}`;
}
