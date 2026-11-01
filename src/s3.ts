export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle: boolean;
}

function trimEndpoint(e: string): string {
  return e.replace(/\/+$/g, "");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", k as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function signatureKey(secret: string, date: string, region: string, service = "s3"): Promise<Uint8Array> {
  const kDate = await hmac("AWS4" + secret, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function objectUrl(cfg: S3Config, key: string): string {
  const base = trimEndpoint(cfg.endpoint);
  if (cfg.pathStyle) {
    return `${base}/${cfg.bucket}/${encodeKey(key)}`;
  }
  const u = new URL(base);
  return `${u.protocol}//${cfg.bucket}.${u.host}/${encodeKey(key)}`;
}

interface SignedArgs {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payloadHash: string;
}

export async function signS3Request(cfg: S3Config, args: SignedArgs, now = new Date()): Promise<Record<string, string>> {
  const url = new URL(args.url);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host;
  const canonicalUri = url.pathname;
  const query = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": amzDate,
    ...(args.headers ?? {}),
  };
  if (cfg.sessionToken) headers["x-amz-security-token"] = cfg.sessionToken;
  const signedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalRequest = [args.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, args.payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signingKey = await signatureKey(cfg.secretAccessKey, dateStamp, cfg.region);
  const signature = toHex(await hmac(signingKey, stringToSign));
  return {
    ...args.headers,
    "x-amz-content-sha256": args.payloadHash,
    "x-amz-date": amzDate,
    ...(cfg.sessionToken ? { "x-amz-security-token": cfg.sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface S3HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type S3HttpFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<S3HttpResponse>;

async function fetchHttp(url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }): Promise<S3HttpResponse> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body ? (init.body as unknown as BodyInit) : undefined,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    status: res.status,
    ok: res.ok,
    headers,
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer(),
  };
}

let httpFn: S3HttpFn = fetchHttp;

export function setS3Http(fn: S3HttpFn | null): void {
  httpFn = fn ?? fetchHttp;
}

async function s3fetch(cfg: S3Config, method: string, keyOrQuery: string, opts: { query?: Record<string, string>; body?: Uint8Array; contentType?: string; isKey?: boolean; extraHeaders?: Record<string, string> } = {}): Promise<S3HttpResponse> {
  let url: string;
  if (opts.isKey === false) {
    const base = trimEndpoint(cfg.endpoint);
    url = cfg.pathStyle ? `${base}/${cfg.bucket}/` : objectUrl(cfg, "");
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);
    url = u.toString();
  } else {
    url = objectUrl(cfg, keyOrQuery);
    if (opts.query) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(opts.query)) u.searchParams.set(k, v);
      url = u.toString();
    }
  }
  const payloadHash = await sha256Hex(opts.body ?? "");
  const headers = await signS3Request(cfg, {
    method,
    url,
    payloadHash,
    headers: { ...(opts.contentType ? { "content-type": opts.contentType } : {}), ...(opts.extraHeaders ?? {}) },
  });
  try {
    return await httpFn(url, { method, headers, body: opts.body });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const host = new URL(url).host;
    throw new Error(
      `S3 ${method} ${host} network failed: ${msg}. Requests run through Obsidian requestUrl. Check https-vs-http, TLS trust, private DNS, and endpoint reachability.`,
    );
  }
}

export async function putObject(cfg: S3Config, key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
  const res = await s3fetch(cfg, "PUT", key, { body, contentType });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
}

export async function putText(cfg: S3Config, key: string, text: string, contentType = "application/json"): Promise<void> {
  await putObject(cfg, key, new TextEncoder().encode(text), contentType);
}

export type ConditionalGetResult = { kind: "hit"; bytes: Uint8Array; etag: string | null } | { kind: "not-modified" } | { kind: "missing" };

export async function getConditional(cfg: S3Config, key: string, ifNoneMatch?: string): Promise<ConditionalGetResult> {
  const get = (inm?: string) =>
    s3fetch(cfg, "GET", key, inm ? { extraHeaders: { "if-none-match": inm } } : {});
  let res: S3HttpResponse;
  try {
    res = await get(ifNoneMatch);
  } catch (e) {
    if (!ifNoneMatch) throw e;
    res = await get(undefined);
  }
  if (res.status === 304 && ifNoneMatch) return { kind: "not-modified" };
  if (!res.ok && ifNoneMatch) {
    // Store or proxy rejected the validator. Retry once without it.
    res = await get(undefined);
  }
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status} ${await res.text()}`);
  if (res.status === 304) throw new Error(`S3 GET ${key} returned unexpected 304`);
  return { kind: "hit", bytes: new Uint8Array(await res.arrayBuffer()), etag: res.headers["etag"] ?? null };
}

export async function putTextEtag(cfg: S3Config, key: string, text: string, contentType = "application/json"): Promise<string | null> {
  const res = await s3fetch(cfg, "PUT", key, { body: new TextEncoder().encode(text), contentType });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
  return res.headers["etag"] ?? null;
}

export async function getObject(cfg: S3Config, key: string): Promise<Uint8Array | null> {
  const res = await s3fetch(cfg, "GET", key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function getText(cfg: S3Config, key: string): Promise<string | null> {
  const bytes = await getObject(cfg, key);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export async function deleteObject(cfg: S3Config, key: string): Promise<void> {
  const res = await s3fetch(cfg, "DELETE", key);
  if (!res.ok) {
    throw new Error(`S3 DELETE ${key} failed: ${res.status} ${await res.text()}`);
  }
}

export async function listObjects(cfg: S3Config, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < 20; i++) {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await s3fetch(cfg, "GET", "", { isKey: false, query });
    if (!res.ok) throw new Error(`S3 LIST ${prefix} failed: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(m[1]);
    const trunc = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml)?.[1] === "true";
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!trunc || !next) break;
    token = next;
  }
  return out;
}
