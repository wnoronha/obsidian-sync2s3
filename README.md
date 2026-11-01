# Sync2S3

Sync an Obsidian vault to S3 compatible storage. Status bar, Sync now, dry runs, conflict copies. Bucket versioning keeps the history.

## Install the plugin

Via BRAT (recommended for beta). Install BRAT from Community plugins, then Add Beta plugin with `https://github.com/wnoronha/obsidian-sync2s3`. Enable Sync2S3. It needs Obsidian 1.11.4 or newer for SecretStorage.

Via manual install. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release. Copy them to `<vault>/.obsidian/plugins/sync2s3/`. Reload Obsidian. Enable Sync2S3 under Community plugins.

Via local dev. Run `bun run build`, then `bun run deploy` with `SYNC2S3_DEPLOY_TARGETS` set to comma-separated plugin folders. Deploy copies `manifest.json`, `main.js`, and `styles.css` into each target. Real paths stay in the local shell. Never commit them.
3. Fill in Connection and Credentials. Store keys through the Change buttons, never as typed text.
4. Press Test. It lists the base prefix and reports a count. It writes nothing.
5. Press Dry run. It prints planned uploads, downloads, and conflicts. It writes nothing.
6. Press Sync now. The first run uploads everything. The second run reports zeros.

You need a bucket that already exists. The plugin never creates buckets.

## Rotate the passphrase

1. Store a new passphrase in New E2E passphrase through its Change button.
2. Press Rotate. It unwraps the data key with the active passphrase, re-wraps it with the staged one, rewrites the manifest, points the active setting at the staged secret, and clears the staged field.
3. Files stay put. No re-upload happens.
4. The old secret stays in Keychain. Point the setting back at it if a vault gets stranded. Remove it manually once every vault syncs clean.

## Reset the remote

Press Reset in Danger zone and confirm. It deletes every object under the prefix and writes a fresh manifest. Local files stay. The next sync re-uploads all. With E2E on, reset asks for the passphrase first and starts fresh keys, which makes it the escape hatch for a lost passphrase.

## Join a second vault

1. Install the plugin in the empty vault and enter the same endpoint, region, bucket, base folder, keys, and passphrase.
2. Dry run reports downloads equal to the file count and zero uploads.
3. Sync now writes decrypted files and creates missing folders.
4. Both vaults report zeros afterwards. An edit on either side arrives on the next sync of the other.

## Settings reference

Connection holds endpoint, region, bucket, base folder, and path style. Region matters because request signing embeds it. A wrong region fails every request with an auth error. Path style off hides base folder. The bucket alone names the vault then. On requests host, bucket, key. Off requests bucket host, key.

Credentials holds the access key and secret key. Only secret IDs reach `data.json`. Values stay in SecretStorage.

Files holds the attachment cap, the extension allowlist, and excluded paths. Files over the cap are skipped and logged. Excluded paths take one path per line. Folders match everything under them. Empty syncs everything. Order is system ignores, then excluded paths, then extension allowlist. Blocked paths stay invisible to sync. Remote copies of blocked paths are kept, never deleted.

Encryption holds the active passphrase, the staged passphrase, the toggle, and Rotate. The toggle encrypts bodies and names with AES-GCM under a per-vault data key. The passphrase wraps that key through PBKDF2. Losing the passphrase loses the vault.

Actions holds Test, Sync now, and Dry run. Dry run shows what the next sync would do and writes nothing.

Log shows the last 50 rows, newest last. Rows carry kinds with colors. Copy writes full timestamps to the clipboard. Clear empties the view. Reopen settings to refresh.

## Sync model

Each sync compares three states. Local files, the last synced state on this device, and the remote manifest. Only the difference moves. Repeats converge on the same result. Saves push single files after a short delay. Focus pulls remote changes. Manual Sync now runs both directions. Pause stops auto push and pull. Manual sync still works.

Two devices editing one file before syncing creates a conflict copy named `Name (Conflicted copy Device YYYYMMDDHHmm).md`. The newer timestamp wins the main path. Nothing merges silently and nothing disappears. A remote edit beats a local delete. The file returns with a log line. Delete it again to make the delete stick.

Deletes need two consecutive syncs to propagate. Excluding a path resets its confirmations. Local deletes move to trash. Remote deletes leave versioned markers when bucket versioning is on. A file that reappears cancels the pending delete.

The remote manifest lives at `<basePrefix>/.sync2s3/manifest.json`. Plaintext vaults store files at `<basePrefix>/<path>`. Encrypted vaults store files at `<basePrefix>/o/<random-id>` and encrypt the manifest too. Bucket plus base folder stay visible. Everything else is opaque.

## Fix connection errors

Test reports the failure with the host named. Anonymous requests against the endpoint return S3 `AccessDenied`, which proves the network path and leaves auth as the suspect. Requests run through Obsidian requestUrl. Check https against http, TLS trust, private DNS, and endpoint reachability.

Auth errors carry an S3 code. `InvalidAccessKeyId` means a wrong key or unknown user. `SignatureDoesNotMatch` means a wrong secret, wrong region, or wrong path style. `AccessDenied` on a signed request means the policy blocks the call.

A wrong E2E passphrase fails at plan time with an unwrap error. Nothing writes first.

## Develop

- `bun install` fetches dependencies.
- `bun run typecheck` runs `tsc --noEmit`.
- `bun test` runs unit tests for merge decisions, crypto roundtrips, manifest envelopes, folder creation, and rule parsing.
- `bun run sigcheck` compares the SigV4 signer against the AWS SDK on four vectors with public example keys.
- `bun run build` writes `main.js`.
- `bun run deploy` copies build output into the vaults listed in `SYNC2S3_DEPLOY_TARGETS`.

`.env` stays untracked and no tooling reads it. `.env.example` lists variable names only.

## Non-goals

Per-folder allow lists, version restore UI, and multi-writer conflict merging. Bucket versioning keeps the history. The plugin does not surface it yet.
