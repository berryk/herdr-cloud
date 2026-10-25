// Per-user secrets: a 1Password service account token plus environment variables whose values
// are either op:// references (resolved inside the container by with-secrets.sh) or literals.
// Stored AES-GCM encrypted under the SECRETS_KEY Worker secret, on top of Durable Object storage's
// own encryption at rest, and never returned to the browser.

import { z } from "zod";

export interface Secrets {
  opToken?: string;
  env: Record<string, string>;
}

/** What the settings page may see: which values are set, and references (which are not secret). */
export interface SecretsView {
  opToken: boolean;
  env: { name: string; ref?: string }[];
}

/** Set by the platform or managed separately, so not settable as plain variables. */
const RESERVED = new Set(["HOME", "USER", "PATH", "TERM", "LANG", "SHELL", "OP_SERVICE_ACCOUNT_TOKEN"]);

export const SecretsUpdate = z.object({
  /** A new token, null to remove it, or absent to keep it. */
  opToken: z.string().trim().min(20).max(4096).nullable().optional(),
  /** The full list of variables to keep. An entry without a value keeps its current value. */
  env: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).refine((n) => !RESERVED.has(n), "reserved name"),
        value: z.string().max(8192).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export function view(s: Secrets): SecretsView {
  return {
    opToken: !!s.opToken,
    env: Object.entries(s.env).map(([name, v]) => (v.startsWith("op://") ? { name, ref: v } : { name })),
  };
}

export function applyUpdate(s: Secrets, u: z.infer<typeof SecretsUpdate>): Secrets {
  const next: Secrets = { opToken: u.opToken === undefined ? s.opToken : (u.opToken ?? undefined), env: s.env };
  if (u.env) {
    next.env = {};
    for (const { name, value } of u.env) {
      const v = value === undefined || value === "" ? s.env[name] : value;
      if (v !== undefined) next.env[name] = v;
    }
  }
  return next;
}

async function key(secret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export async function seal<T = Secrets>(secret: string, s: T): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(JSON.stringify(s)));
  return { iv, data };
}

export async function unseal<T = Secrets>(secret: string, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, await key(secret), sealed.data);
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Encrypt bytes (a saved browser profile file): the IV, then the ciphertext. */
export async function sealBytes(secret: string, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), bytes));
  const out = new Uint8Array(12 + data.length);
  out.set(iv);
  out.set(data, 12);
  return out;
}

export async function unsealBytes(secret: string, sealed: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12) }, await key(secret), sealed.slice(12)));
}
