import { describe, expect, test } from "bun:test";
import { decryptBytes, encryptBytes, initVaultKeys, openVaultKeys, parseManifestEnvelope, rewrapDataKey, decryptManifestInner, writeManifestBody } from "./crypto";

describe("e2e envelope", () => {
  test("roundtrip text and binary", async () => {
    const keys = await initVaultKeys("test-passphrase-only");
    expect(keys.meta.mode).toBe("aes-gcm");
    const pt = new TextEncoder().encode("hello vault");
    const ct = await encryptBytes(keys.dataKey, pt);
    expect(ct.length).toBeGreaterThan(pt.length);
    expect(ct.slice(12)).not.toEqual(pt.slice(0, ct.length - 12));
    const back = await decryptBytes(keys.dataKey, ct);
    expect(new TextDecoder().decode(back)).toBe("hello vault");
  });

  test("keys survive manifest roundtrip", async () => {
    const keys = await initVaultKeys("test-passphrase-only");
    const stored = JSON.parse(JSON.stringify(keys.meta));
    const reopened = await openVaultKeys(stored, "test-passphrase-only");
    const pt = new TextEncoder().encode("second device");
    const back = await decryptBytes(reopened.dataKey, await encryptBytes(keys.dataKey, pt));
    expect(new TextDecoder().decode(back)).toBe("second device");
  });

  test("wrong passphrase fails closed", async () => {
    const keys = await initVaultKeys("correct-horse");
    await expect(openVaultKeys(keys.meta, "wrong-battery")).rejects.toThrow();
  });

  test("rewrap preserves data access under new passphrase", async () => {
    const keys = await initVaultKeys("old-secret");
    const ct = await encryptBytes(keys.dataKey, new TextEncoder().encode("stable"));
    const newMeta = await rewrapDataKey(keys.dataKey, "new-secret");
    const reopened = await openVaultKeys(newMeta, "new-secret");
    const back = await decryptBytes(reopened.dataKey, ct);
    expect(new TextDecoder().decode(back)).toBe("stable");
    await expect(openVaultKeys(newMeta, "old-secret")).rejects.toThrow();
  });

  test("manifest envelope roundtrip hides paths", async () => {
    const keys = await initVaultKeys("vault-pass");
    const inner = { version: 1 as const, vaultId: "v", basePrefix: "v", updatedAt: 1, encryption: keys.meta, files: { "secret note.md": { hash: "h", mtime: 1, size: 1, rid: "abc" } }, devices: {} };
    const body = await writeManifestBody(inner, keys);
    expect(body).not.toContain("secret note.md");
    const env = parseManifestEnvelope(body);
    expect(env.encrypted).toBe(true);
    const reopened = await openVaultKeys(env.meta!, "vault-pass");
    const back = await decryptManifestInner(env.payload!, reopened.dataKey);
    expect(back.files["secret note.md"].rid).toBe("abc");
  });

  test("plaintext manifest parses as legacy", () => {
    const env = parseManifestEnvelope(JSON.stringify({ version: 1, files: {} }));
    expect(env.encrypted).toBe(false);
  });
});
