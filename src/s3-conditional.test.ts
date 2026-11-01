import { afterEach, describe, expect, test } from "bun:test";
import { getConditional, putTextEtag, setS3Http, signS3Request, type S3Config, type S3HttpResponse } from "./s3";

const CFG: S3Config = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "example-bucket",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  pathStyle: true,
};

afterEach(() => {
  setS3Http(null);
});

function fake(status: number, headers: Record<string, string>, body: Uint8Array): S3HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: () => Promise.resolve(new TextDecoder().decode(body)),
    arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer),
  };
}

describe("getConditional", () => {
  test("sends if-none-match and returns hit with etag", async () => {
    let sent: Record<string, string> = {};
    setS3Http(async (_url, init) => {
      sent = init.headers;
      return fake(200, { etag: '"abc123"' }, new TextEncoder().encode("{}"));
    });
    const res = await getConditional(CFG, "k/manifest.json", '"abc123"');
    expect(sent["if-none-match"]).toBe('"abc123"');
    expect(res.kind).toBe("hit");
    if (res.kind === "hit") {
      expect(res.etag).toBe('"abc123"');
      expect(new TextDecoder().decode(res.bytes)).toBe("{}");
    }
  });

  test("304 maps to not-modified", async () => {
    setS3Http(async () => fake(304, {}, new Uint8Array()));
    const res = await getConditional(CFG, "k/manifest.json", '"abc123"');
    expect(res).toEqual({ kind: "not-modified" });
  });

  test("404 maps to missing", async () => {
    setS3Http(async () => fake(404, {}, new Uint8Array()));
    const res = await getConditional(CFG, "k/manifest.json", '"abc123"');
    expect(res).toEqual({ kind: "missing" });
  });

  test("validator rejection falls back to plain GET", async () => {
    const seen: Array<Record<string, string>> = [];
    let calls = 0;
    setS3Http(async (_url, init) => {
      calls++;
      seen.push(init.headers);
      if (calls === 1) return fake(400, {}, new Uint8Array());
      return fake(200, { etag: '"xyz"' }, new TextEncoder().encode("{}"));
    });
    const res = await getConditional(CFG, "k/manifest.json", '"abc123"');
    expect(calls).toBe(2);
    expect(seen[0]["if-none-match"]).toBe('"abc123"');
    expect(seen[1]["if-none-match"]).toBeUndefined();
    expect(res.kind).toBe("hit");
    if (res.kind === "hit") expect(res.etag).toBe('"xyz"');
  });

  test("transport throw on conditional retries plain", async () => {
    let calls = 0;
    setS3Http(async (_url, _init) => {
      calls++;
      if (calls === 1) throw new Error("network down");
      return fake(200, { etag: '"q"' }, new TextEncoder().encode("{}"));
    });
    const res = await getConditional(CFG, "k/manifest.json", '"abc123"');
    expect(calls).toBe(2);
    expect(res.kind).toBe("hit");
  });

  test("plain GET failure still throws", async () => {
    setS3Http(async () => fake(403, {}, new Uint8Array()));
    await expect(getConditional(CFG, "k/manifest.json")).rejects.toThrow("403");
  });

  test("signer covers if-none-match", async () => {
    const h = await signS3Request(
      CFG,
      { method: "GET", url: "https://s3.example.com/example-bucket/k", payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", headers: { "if-none-match": '"abc123"' } },
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(h["Authorization"] ?? "").toContain("SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date");
  });
});

describe("putTextEtag", () => {
  test("returns response etag", async () => {
    setS3Http(async () => fake(200, { etag: '"def456"' }, new Uint8Array()));
    const res = await putTextEtag(CFG, "k/manifest.json", "{}");
    expect(res).toBe('"def456"');
  });

  test("returns null when etag header is absent", async () => {
    setS3Http(async () => fake(200, {}, new Uint8Array()));
    const res = await putTextEtag(CFG, "k/manifest.json", "{}");
    expect(res).toBeNull();
  });
});
