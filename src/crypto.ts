import type { EncryptionMeta } from "./manifest";

const PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export function assertManifestSupported(meta: EncryptionMeta): void {
  if (meta.mode !== "none" && meta.mode !== "aes-gcm") {
    throw new Error(`Unknown manifest encryption mode: ${meta.mode}`);
  }
}

export function e2eWarningCopy(): string {
  return "E2E passphrase loss equals data loss. Store it in a password manager. Reset wipes the remote prefix and re-uploads.";
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKEK(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface VaultKeys {
  meta: EncryptionMeta;
  dataKey: CryptoKey;
}

export async function initVaultKeys(passphrase: string): Promise<VaultKeys> {
  const raw = randomBytes(32);
  const dataKey = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", true, ["encrypt", "decrypt"]);
  const w = await wrapRaw(raw, passphrase);
  raw.fill(0);
  return {
    meta: {
      mode: "aes-gcm",
      kdf: `pbkdf2-sha256-${PBKDF2_ITERATIONS}`,
      salt: w.salt,
      wrappedDataKey: w.wrappedDataKey,
    },
    dataKey,
  };
}

export async function openVaultKeys(meta: EncryptionMeta, passphrase: string): Promise<VaultKeys> {
  if (meta.mode !== "aes-gcm" || !meta.salt || !meta.wrappedDataKey) {
    throw new Error("Remote manifest has no E2E keys.");
  }
  const salt = fromB64(meta.salt);
  const combined = fromB64(meta.wrappedDataKey);
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const kek = await deriveKEK(passphrase, salt);
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, kek, ct as BufferSource);
  } catch {
    throw new Error("Wrong E2E passphrase? Data key unwrap failed.");
  }
  const dataKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  return { meta, dataKey };
}

export async function encryptBytes(dataKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, dataKey, plaintext as BufferSource));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

export async function decryptBytes(dataKey: CryptoKey, combined: Uint8Array): Promise<Uint8Array> {
  if (combined.length < IV_BYTES + 1) throw new Error("Ciphertext too short.");
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, dataKey, ct as BufferSource));
}

export function randomId(): string {
  return [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function wrapRaw(raw: Uint8Array, passphrase: string): Promise<{ salt: string; wrappedDataKey: string }> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKEK(passphrase, salt);
  const iv = randomBytes(IV_BYTES);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, kek, raw as BufferSource));
  const combined = new Uint8Array(IV_BYTES + wrapped.length);
  combined.set(iv);
  combined.set(wrapped, IV_BYTES);
  return { salt: toB64(salt), wrappedDataKey: toB64(combined) };
}

export async function rewrapDataKey(dataKey: CryptoKey, newPassphrase: string): Promise<EncryptionMeta> {
  if (!newPassphrase) throw new Error("New passphrase is empty.");
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
  const w = await wrapRaw(raw, newPassphrase);
  raw.fill(0);
  return { mode: "aes-gcm", kdf: `pbkdf2-sha256-${PBKDF2_ITERATIONS}`, salt: w.salt, wrappedDataKey: w.wrappedDataKey };
}

export interface ManifestEnvelope {
  v: 1;
  enc: "aes-gcm";
  kdf?: string;
  salt: string;
  wrappedDataKey: string;
  payload: string;
}

export async function writeManifestBody(inner: import("./manifest").SyncManifest, keys: VaultKeys | null): Promise<string> {
  if (!keys) return JSON.stringify(inner);
  const pt = new TextEncoder().encode(JSON.stringify(inner));
  const c = await encryptBytes(keys.dataKey, pt);
  const env: ManifestEnvelope = {
    v: 1,
    enc: "aes-gcm",
    kdf: keys.meta.kdf,
    salt: keys.meta.salt ?? "",
    wrappedDataKey: keys.meta.wrappedDataKey ?? "",
    payload: toB64(c),
  };
  return JSON.stringify(env);
}

export function parseManifestEnvelope(raw: string): { encrypted: boolean; meta?: EncryptionMeta; payload?: string; legacy?: import("./manifest").SyncManifest } {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Manifest is not valid JSON.");
  }
  if (o && o["enc"] === "aes-gcm") {
    return {
      encrypted: true,
      meta: { mode: "aes-gcm", kdf: o["kdf"] as string | undefined, salt: o["salt"] as string, wrappedDataKey: o["wrappedDataKey"] as string },
      payload: o["payload"] as string,
    };
  }
  return { encrypted: false, legacy: o as unknown as import("./manifest").SyncManifest };
}

export async function decryptManifestInner(payloadB64: string, dataKey: CryptoKey): Promise<import("./manifest").SyncManifest> {
  const pt = await decryptBytes(dataKey, fromB64(payloadB64));
  return JSON.parse(new TextDecoder().decode(pt)) as import("./manifest").SyncManifest;
}
