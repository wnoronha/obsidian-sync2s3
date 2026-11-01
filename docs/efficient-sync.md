# Sketch 1 — Efficient idle sync (ETag + stat cache)

## Problem

Every sync run pays full price even when nothing changed. One manifest GET,
one full local rehash, one manifest PUT, two LISTs. Focus pulls and vault
events trigger runs constantly. Large vaults feel each run as CPU plus S3
chatter. Evidence: `syncNow` in `src/main.ts` fetches, scans, writes, and
toasts unconditionally on the old path.

## Goals

- Idle runs cost ~one cheap request and near-zero CPU.
- No behavior change to merge, conflict, delete, or encryption semantics.
- No new persisted state. No settings schema change.

## Non-goals

- Op journals, delta uploads, server-side logic.
- Changing triggers (save, vault events, focus stay).
- `.obsidian` sync (explicitly later).

## Design

### 1. Response headers through the HTTP layer (`src/s3.ts`)

`S3HttpResponse` gains `headers: Record<string, string>` with lowercased keys.
Both transports populate it: `fetchHttp` from Fetch `Headers`, the Obsidian
`requestUrl` adapter in `main.ts` from its response headers. No header means
empty object, never undefined.

### 2. Signed conditional GET plus ETag-returning PUT (`src/s3.ts`)

`s3fetch` accepts `extraHeaders`. They flow into `signS3Request`, so S3
authenticates them. No signer change needed.

- `getConditional(cfg, key, ifNoneMatch?)` returns `hit | not-modified
  | missing`. 304 maps to `not-modified`. 404 maps to `missing`.
  `if-none-match` is sent verbatim (S3 quotes ETags; round-trip as-is).
- `putTextEtag(cfg, key, text)` behaves like `putText` and returns the
  response ETag header or null. Existing `getObject`, `getText`,
  `putObject`, `putText` signatures stay untouched.

Fallback is automatic. Endpoints ignoring `If-None-Match` return 200 and the
code treats it as a normal fetch. GET with `If-None-Match` never yields 412.

### 3. In-memory manifest cache (`src/main.ts`)

`Sync2S3Plugin` holds `{ key, etag, raw } | null`. Key is
`endpoint|bucket|basePrefix`. The manifest fetch becomes: conditional GET
with cached ETag on key match, full fetch otherwise. 304 reuses cached raw.
Missing clears the cache. Manifest PUT stores the returned ETag plus the
written body. Restart starts cold with one full GET. No persistence, no
schema change.

### 4. Stat-cache hashing (`src/main.ts` + `src/files.ts`)

`scanLocal` receives the previous `lastSync` map. Pure helper
`cachedHash(prev, path, mtime, size)` returns the stored hash when mtime
and size match exactly, else null. Match skips file read plus SHA-256.
Edits change mtime, so they rehash. New, deleted, and unblocked files have
no usable entry and hash normally. Same-ms same-size collision is accepted
and documented (same trade as git's raciness check, without the smoke
window).

## Edge cases

- Encrypted vaults: conditional GET applies to ciphertext. Envelope parse
  unchanged. Key rotation rewrites via PUT path, cache updates.
- Migration and bootstrap: `!raw` and `migrating` still force PUT through
  the existing `remoteDirty` gate.
- Prefix or bucket switch: cache key mismatch forces full fetch.
- Remote reset elsewhere: cached ETag yields 404, treated as missing.

## Test plan

- New `src/s3-conditional.test.ts` with injected fake transport: 304 path,
  200 path with ETag capture, 404 path, PUT ETag capture, and proof that
  `if-none-match` lands in `SignedHeaders`.
- Unit tests for `cachedHash` hit, miss, and size-mismatch cases.
- Existing gates unchanged: `typecheck`, `bun test`, `sigcheck`, `build`.

## Rollout

Bump `manifest.json` plus `package.json` only when cutting a new version.
This change stays on 0.1.0: same tag moves to the squashed commit.
