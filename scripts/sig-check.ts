import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { signS3Request } from "../src/s3";

// Public example credentials from AWS docs. Not real.
const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const REGION = "us-east-1";
const NOW = new Date("2026-11-01T00:00:00Z");

async function sdkSign(method: string, url: string, extraHeaders: Record<string, string>, body: Uint8Array): Promise<string> {
  const u = new URL(url);
  const signer = new SignatureV4({
    credentials: { accessKeyId: AK, secretAccessKey: SK },
    region: REGION,
    service: "s3",
    sha256: Sha256,
  });
  const req = new HttpRequest({
    method,
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: decodeURI(u.pathname),
    query: Object.fromEntries(u.searchParams.entries()),
    headers: { host: u.host, ...extraHeaders },
    body,
  });
  const signed = await signer.sign(req, { signingDate: NOW });
  return signed.headers["authorization"] ?? signed.headers["Authorization"] ?? "";
}

async function mine(method: string, url: string, extraHeaders: Record<string, string>, body: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const h = await signS3Request(
    { endpoint: "https://s3.example.com", region: REGION, bucket: "example-bucket", accessKeyId: AK, secretAccessKey: SK, pathStyle: true },
    { method, url, payloadHash, headers: extraHeaders },
    NOW,
  );
  return h.Authorization;
}

let failures = 0;
async function check(name: string, method: string, url: string, headers: Record<string, string>, body: Uint8Array) {
  const a = await sdkSign(method, url, headers, body);
  const b = await mine(method, url, headers, body);
  const ok = a === b;
  if (!ok) failures++;
  console.log(`${ok ? "MATCH" : "DIFF "} ${name}`);
  if (!ok) {
    console.log(`  sdk : ${a}`);
    console.log(`  mine: ${b}`);
  }
}

const EMPTY = new Uint8Array();
await check("GET object", "GET", "https://s3.example.com/example-bucket/my-vault/.sync2s3/manifest.json", {}, EMPTY);
await check("PUT json", "PUT", "https://s3.example.com/example-bucket/my-vault/.sync2s3/manifest.json", { "content-type": "application/json" }, new TextEncoder().encode("{}"));
await check("LIST prefix", "GET", "https://s3.example.com/example-bucket/?list-type=2&prefix=my-vault%2F", {}, EMPTY);
await check("GET spaced key", "GET", "https://s3.example.com/example-bucket/my-vault/My%20Note.md", {}, EMPTY);

if (failures > 0) {
  console.log(`${failures} MISMATCH`);
  process.exit(1);
}
console.log("signer matches AWS SDK");
