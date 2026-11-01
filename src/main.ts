import { Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TAbstractFile, TFile, requestUrl, setIcon, type BaseComponent } from "obsidian";
import { DEFAULT_SETTINGS, isPathBlocked, isSyncable, parseAllowlist, parsePathRules, type Sync2S3Settings } from "./settings";
import { cachedSyncRecord } from "./files";
import { emptyManifest, filterRemoteView, manifestKey, remoteObjectKey, type EncryptionMeta, type FileRecord, type SyncManifest } from "./manifest";
import { ensureFolder, parentDir } from "./files";
import { conflictCopyPath, decideSync, prunePendingKeys } from "./sync-decide";
import { shouldRun, type SyncOptions, type SyncTrigger } from "./sync-policy";
import { assertManifestSupported, decryptBytes, decryptManifestInner, encryptBytes, initVaultKeys, openVaultKeys, parseManifestEnvelope, randomId, rewrapDataKey, writeManifestBody, type VaultKeys } from "./crypto";
import { deleteObject, getConditional, getObject, getText, listObjects, putObject, putTextEtag, setS3Http, type S3Config } from "./s3";

const MIN_SYNC_INTERVAL_MS = 10_000;

function confirmModal(app: import("obsidian").App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const modal = new Modal(app);
    modal.setTitle("Sync2S3 confirm");
    modal.contentEl.createEl("p", { text: message });
    new Setting(modal.contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          done(false);
          modal.close();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Wipe remote")
          .setWarning()
          .onClick(() => {
            done(true);
            modal.close();
          }),
      );
    modal.onClose = () => done(false);
    modal.open();
  });
}

function randomDevice(): string {
  return `dev-${Math.random().toString(36).slice(2, 8)}`;
}

async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveSecret(app: unknown, idOrValue: string): Promise<string> {
  if (!idOrValue) return "";
  const store = (app as Record<string, unknown>)["secretStorage"] as
    | { getSecret?: (id: string) => Promise<string | null>; get?: (id: string) => Promise<string | null> }
    | undefined;
  try {
    if (store?.getSecret) {
      const v = await store.getSecret(idOrValue);
      if (typeof v === "string" && v) return v;
    } else if (store?.get) {
      const v = await store.get(idOrValue);
      if (typeof v === "string" && v) return v;
    }
  } catch {
    // fall through to raw value
  }
  return idOrValue;
}

function exactBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export type LogKind = "info" | "ok" | "error" | "plan" | "conflict" | "prune" | "delete" | "migration";

export interface LogEntry {
  time: string;
  kind: LogKind;
  msg: string;
}

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md") return "text/markdown";
  if (ext === "canvas" || ext === "json") return "application/json";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

export default class Sync2S3Plugin extends Plugin {
  settings: Sync2S3Settings = { ...DEFAULT_SETTINGS };
  private statusEl: HTMLElement | null = null;
  private statusIcon: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private lastSummary = "not synced yet";
  private syncing = false;
  private debounceTimer: number | null = null;
  private pushTimer: number | null = null;
  private pushQueue = new Set<string>();
  private syncGen = 0;
  private applyingRemote = false;
  private lastRunAt = 0;
  private log: LogEntry[] = [];
  settingTab: Sync2S3SettingTab | null = null;
  private manifestCache: { key: string; etag: string; raw: string } | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (!this.settings.deviceId) {
      this.settings.deviceId = randomDevice();
      await this.saveSettings();
    }
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("sync2s3-status");
    this.statusEl.style.cursor = "pointer";
    this.statusIcon = this.statusEl.createSpan({ cls: "sync2s3-ico" });
    this.statusText = this.statusEl.createSpan({ cls: "sync2s3-txt" });
    this.registerDomEvent(this.statusEl, "click", () => this.openSettings());
    this.setStatus("idle");
    setS3Http(async (url, init) => {
      const buf = init.body ? init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength) : undefined;
      const res = await requestUrl({ url, method: init.method, headers: init.headers, body: buf as ArrayBuffer | undefined, throw: false });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers,
        text: async () => res.text,
        arrayBuffer: async () => res.arrayBuffer,
      };
    });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow(false, { manual: true }) });
    this.addCommand({ id: "dry-run", name: "Dry run", callback: () => void this.syncNow(true, { manual: true }) });
    this.addCommand({ id: "pull-now", name: "Pull now", callback: () => void this.syncNow(false, { manual: true, direction: "pull" }) });
    this.addCommand({ id: "pause-sync", name: "Pause sync", callback: () => void this.pauseSync() });
    this.addCommand({ id: "resume-sync", name: "Resume sync", callback: () => void this.resumeSync() });
    this.addCommand({ id: "cancel-sync", name: "Cancel sync", callback: () => this.cancelSync() });
    this.settingTab = new Sync2S3SettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultFileEvent(f, "vault-event")));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultFileEvent(f, "save")));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (this.applyingRemote) return;
      if (!this.relevantPath(f.path)) return;
      this.schedule();
    }));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      if (this.applyingRemote) return;
      const next = f instanceof TAbstractFile ? f.path : "";
      const prev = typeof oldPath === "string" ? oldPath : "";
      if (!this.relevantPath(next) && !this.relevantPath(prev)) return;
      this.schedule();
    }));
    this.registerDomEvent(window, "focus", () => this.schedulePull("focus"));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.schedulePull("visible");
    });
    if (this.settings.syncOnStart) setTimeout(() => void this.syncNow(false, { trigger: "startup" }), 2000);
  }

  setStatus(s: "idle" | "syncing" | "error" | "paused", detail = ""): void {
    if (!this.statusEl || !this.statusIcon || !this.statusText) return;
    this.statusIcon.removeClass("sync2s3-spin");
    this.statusIcon.removeClass("sync2s3-err");
    if (s === "syncing") {
      this.paintIcon("satellite-dish", "refresh-cw");
      this.statusIcon.addClass("sync2s3-spin");
      this.statusText.setText("syncing");
      this.statusEl.title = "Sync2S3: syncing. Click for settings.";
    } else if (s === "error") {
      this.paintIcon("cloud-off", "x");
      this.statusIcon.addClass("sync2s3-err");
      this.statusText.setText("error");
      this.statusEl.title = `Sync2S3: error ${detail}. Click for settings.`;
    } else if (s === "paused" || this.isPaused()) {
      this.paintIcon("pause", "cloud-off");
      this.statusText.setText("paused");
      this.statusEl.title = `Sync2S3: paused (${this.lastSummary}). Click for settings.`;
    } else {
      this.paintIcon("satellite", "cloud");
      this.statusText.setText("");
      this.statusEl.title = `Sync2S3: ${this.lastSummary}. Click for settings.`;
    }
  }

  isPaused(): boolean {
    return this.settings.paused;
  }

  async pauseSync(): Promise<void> {
    this.settings.paused = true;
    this.cancelSync();
    await this.saveSettings();
    this.pushLog("paused: auto sync off, manual sync still works");
    this.setStatus("paused");
    this.settingTab?.display();
  }

  async resumeSync(): Promise<void> {
    this.settings.paused = false;
    await this.saveSettings();
    this.pushLog("resumed: auto sync on", "ok");
    this.setStatus("idle");
    this.settingTab?.display();
  }

  cancelSync(): void {
    this.syncGen++;
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.pushQueue.clear();
    if (this.syncing) this.pushLog("cancel requested: current run aborts at next checkpoint");
    this.setStatus(this.isPaused() ? "paused" : "idle");
  }

  private throwIfCancelled(gen: number): void {
    if (gen !== this.syncGen) throw new Error("sync cancelled");
  }

  openSettings(): void {
    try {
      const app = this.app as unknown as {
        setting?: { open?: () => void; openTabById?: (id: string) => void };
        commands?: { executeCommandById?: (id: string) => void };
      };
      const id = this.manifest.id;
      const jump = (): boolean => {
        const setting = app.setting;
        if (setting && typeof setting.openTabById === "function") {
          setting.openTabById(id);
          return true;
        }
        return false;
      };
      if (jump()) return;
      if (app.setting && typeof app.setting.open === "function") {
        app.setting.open();
        window.setTimeout(() => {
          if (!jump()) this.pushLog("settings opened without tab jump: openTabById is missing", "error");
        }, 50);
        return;
      }
      if (app.commands && typeof app.commands.executeCommandById === "function") {
        app.commands.executeCommandById("app:open-settings");
        window.setTimeout(() => {
          if (!jump()) this.pushLog("settings opened without tab jump after command fallback", "error");
        }, 100);
        return;
      }
      new Notice("Sync2S3: settings unavailable");
      this.pushLog("settings open failed: app.setting is missing", "error");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Sync2S3: settings failed to open: ${msg.slice(0, 120)}`);
      this.pushLog(`settings open failed: ${msg}`, "error");
    }
  }

  private paintIcon(name: string, fallback: string): void {
    if (!this.statusIcon) return;
    setIcon(this.statusIcon, name);
    if (!this.statusIcon.querySelector("svg")) setIcon(this.statusIcon, fallback);
  }

  private relevantPath(path: string): boolean {
    if (!path) return false;
    if (!isSyncable(path, parseAllowlist(this.settings.allowlist))) return false;
    return !isPathBlocked(path, parsePathRules(this.settings.pathRules));
  }

  private onVaultFileEvent(f: TAbstractFile, _trigger: SyncTrigger): void {
    if (this.applyingRemote) return;
    if (!this.relevantPath(f.path)) return;
    if (f instanceof TFile) {
      if (this.settings.pushOnSave) this.schedulePush(f.path);
      else this.schedule();
      return;
    }
    this.schedule();
  }

  private schedulePush(path: string): void {
    if (!shouldRun({ direction: "push", trigger: "save" }, this.settings)) return;
    this.pushQueue.add(path);
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => {
      const paths = [...this.pushQueue];
      this.pushQueue.clear();
      this.pushTimer = null;
      void this.syncNow(false, { direction: "push", paths, trigger: "save" });
    }, 1000);
  }

  private schedulePull(trigger: Extract<SyncTrigger, "focus" | "visible">): void {
    if (!this.settings.pullOnFocus) return;
    if (!shouldRun({ direction: "pull", trigger }, this.settings)) return;
    if (this.applyingRemote) return;
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.syncNow(false, { direction: "pull", trigger }), 1500);
  }

  private schedule(): void {
    if (this.applyingRemote) return;
    if (!shouldRun({ direction: "full", trigger: "vault-event" }, this.settings)) return;
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.syncNow(false, { trigger: "vault-event" }), 3000);
  }

  pushLog(msg: string, kind: LogKind = "info"): void {
    this.log.push({ time: new Date().toISOString(), kind, msg });
    if (this.log.length > 200) this.log = this.log.slice(-200);
  }

  getLog(): LogEntry[] {
    return [...this.log];
  }

  private effectiveBasePrefix(): string {
    if (!this.settings.pathStyle) return "";
    return this.settings.basePrefix.replace(/^\/+|\/+$/g, "");
  }

  formatLog(): string {
    return this.log.map((e) => `${e.time} ${e.msg}`).join("\n");
  }

  clearLog(): void {
    this.log = [];
  }

  async testConnection(): Promise<void> {
    try {
      const accessKeyId = await resolveSecret(this.app, this.settings.accessKeyIdSecret);
      const secretAccessKey = await resolveSecret(this.app, this.settings.secretAccessKeySecret);
      if (!accessKeyId || !secretAccessKey) {
        new Notice("Sync2S3: set S3 keys in settings first");
        return;
      }
      const cfg = this.s3Config(accessKeyId, secretAccessKey);
      const prefix = this.effectiveBasePrefix();
      const keys = await listObjects(cfg, prefix ? `${prefix}/` : "");
      this.pushLog(`connection ok: ${keys.length} keys under ${prefix || "(root)"}`, "ok");
      new Notice(`Sync2S3: connection ok, ${keys.length} keys`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.pushLog(`connection failed: ${msg}`, "error");
      new Notice(`Sync2S3: connection failed: ${msg.slice(0, 200)}`);
    }
  }

  async resetRemote(): Promise<void> {
    const basePrefix = this.effectiveBasePrefix();
    const label = `s3://${this.settings.bucket}/${basePrefix || "(root)"}`;
    const ok = await confirmModal(this.app, `Wipe ${label}? Deletes every object under the prefix. Local files stay. Next sync re-uploads all.`);
    if (!ok) return;
    try {
      const accessKeyId = await resolveSecret(this.app, this.settings.accessKeyIdSecret);
      const secretAccessKey = await resolveSecret(this.app, this.settings.secretAccessKeySecret);
      if (!accessKeyId || !secretAccessKey) {
        new Notice("Sync2S3: set S3 keys in settings first");
        return;
      }
      const cfg = this.s3Config(accessKeyId, secretAccessKey);
      let keys: VaultKeys | null = null;
      if (this.settings.e2eEnabled) {
        const pp = await resolveSecret(this.app, this.settings.passphraseSecret);
        if (!pp) {
          new Notice("Sync2S3: set E2E passphrase first. Or disable E2E to reset to plaintext.");
          return;
        }
        keys = await initVaultKeys(pp);
      }
      const existing = await listObjects(cfg, basePrefix ? `${basePrefix}/` : "");
      for (const k of existing) await deleteObject(cfg, k);
      const fresh = emptyManifest(this.app.vault.getName(), basePrefix || this.app.vault.getName());
      if (keys) {
        fresh.encryption = keys.meta;
        fresh.nameEnc = true;
      }
      fresh.devices[this.settings.deviceId] = Date.now();
      const resetBody = await writeManifestBody(fresh, keys);
      const resetEtag = await putTextEtag(cfg, manifestKey(basePrefix), resetBody);
      this.manifestCache = resetEtag ? { key: `${this.settings.endpoint}|${this.settings.bucket}|${basePrefix}`, etag: resetEtag, raw: resetBody } : null;
      this.settings.lastSync = {};
      this.settings.pendingDeletes = {};
      await this.saveSettings();
      this.pushLog(`reset remote: deleted ${existing.length} keys under ${label}`, "delete");
      new Notice(`Sync2S3: reset done, deleted ${existing.length} keys. Next sync re-uploads.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.pushLog(`reset failed: ${msg}`, "error");
      new Notice(`Sync2S3: reset failed: ${msg.slice(0, 200)}`);
    }
  }

  async changePassphrase(): Promise<void> {
    try {
      if (!this.settings.e2eEnabled) {
        new Notice("Sync2S3: enable E2E first");
        return;
      }
      const accessKeyId = await resolveSecret(this.app, this.settings.accessKeyIdSecret);
      const secretAccessKey = await resolveSecret(this.app, this.settings.secretAccessKeySecret);
      if (!accessKeyId || !secretAccessKey) {
        new Notice("Sync2S3: set S3 keys in settings first");
        return;
      }
      const cfg = this.s3Config(accessKeyId, secretAccessKey);
      const basePrefix = this.effectiveBasePrefix();
      const mkey = manifestKey(basePrefix);
      const raw = await getText(cfg, mkey);
      if (!raw) {
        new Notice("Sync2S3: no remote manifest yet. Sync once to create it.");
        return;
      }
      const env = parseManifestEnvelope(raw);
      let meta: EncryptionMeta | undefined;
      let inner: SyncManifest | null = null;
      if (!env.encrypted) {
        const legacy = env.legacy as SyncManifest | undefined;
        if (legacy?.encryption?.mode === "aes-gcm") {
          meta = legacy.encryption;
          inner = legacy;
        } else {
          new Notice("Sync2S3: remote is not encrypted. Nothing to re-wrap.");
          return;
        }
      }
      const current = await resolveSecret(this.app, this.settings.passphraseSecret);
      const stagedId = this.settings.newPassphraseSecret;
      const next = await resolveSecret(this.app, stagedId);
      if (!stagedId || !next) {
        new Notice("Sync2S3: stage a new passphrase in New E2E passphrase first");
        return;
      }
      if (!current) {
        new Notice("Sync2S3: the active E2E passphrase setting is empty");
        return;
      }
      if (next === current) {
        new Notice("Sync2S3: staged passphrase must differ from the active one");
        return;
      }
      const keys = await openVaultKeys(meta as EncryptionMeta, current);
      if (!inner && env.payload) inner = await decryptManifestInner(env.payload as string, keys.dataKey);
      if (!inner) {
        new Notice("Sync2S3: remote manifest has no file list");
        return;
      }
      const newMeta = await rewrapDataKey(keys.dataKey, next);
      const rotatedBody = await writeManifestBody(inner, { meta: newMeta, dataKey: keys.dataKey });
      const rotatedEtag = await putTextEtag(cfg, mkey, rotatedBody);
      this.manifestCache = rotatedEtag ? { key: `${this.settings.endpoint}|${this.settings.bucket}|${basePrefix}`, etag: rotatedEtag, raw: rotatedBody } : null;
      this.settings.passphraseSecret = stagedId;
      this.settings.newPassphraseSecret = "";
      await this.saveSettings();
      this.settingTab?.display();
      this.pushLog("passphrase rotated: staged passphrase is now active, files untouched", "ok");
      new Notice("Sync2S3: rotation done. The form shows the new state. The old secret stays in Keychain for rollback. Remove it there once all vaults sync clean.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.pushLog(`passphrase change failed: ${msg}`, "error");
      new Notice(`Sync2S3: passphrase change failed: ${msg.slice(0, 200)}`);
    }
  }

  private s3Config(accessKeyId: string, secretAccessKey: string): S3Config {
    return {
      endpoint: this.settings.endpoint.replace(/\/+$/g, ""),
      region: this.settings.region,
      bucket: this.settings.bucket,
      accessKeyId,
      secretAccessKey,
      pathStyle: this.settings.pathStyle,
    };
  }

  private async scanLocal(): Promise<{ local: Record<string, FileRecord>; skipped: string[]; skippedRule: string[] }> {
    const allow = parseAllowlist(this.settings.allowlist);
    const rules = parsePathRules(this.settings.pathRules);
    const capBytes = this.settings.attachmentCapMB * 1024 * 1024;
    const local: Record<string, FileRecord> = {};
    const skipped: string[] = [];
    const skippedRule: string[] = [];
    for (const f of this.app.vault.getFiles()) {
      if (!(f instanceof TFile)) continue;
      if (!isSyncable(f.path, allow)) continue;
      if (isPathBlocked(f.path, rules)) {
        skippedRule.push(f.path);
        continue;
      }
      if (f.stat.size > capBytes) {
        skipped.push(f.path);
        continue;
      }
      const hit = cachedSyncRecord(this.settings.lastSync, f.path, f.stat.mtime, f.stat.size);
      if (hit) {
        local[f.path] = hit;
        continue;
      }
      const buf = new Uint8Array(await this.app.vault.adapter.readBinary(f.path));
      local[f.path] = { hash: await sha256HexBytes(buf), mtime: f.stat.mtime, size: f.stat.size };
    }
    return { local, skipped, skippedRule };
  }

  async syncNow(dryRun: boolean, opts: SyncOptions = {}): Promise<{ uploads: number; downloads: number; conflicts: number } | null> {
    const manual = opts.manual ?? false;
    const direction = opts.direction ?? "full";
    const paths = opts.paths;
    const trigger = opts.trigger ?? "manual";
    if (this.syncing) {
      return null;
    }
    const requestTrigger: SyncTrigger = manual ? "manual" : trigger;
    if (!shouldRun({ direction, trigger: requestTrigger }, this.settings)) {
      return null;
    }
    if (direction === "push" && paths && paths.length > 0 && !paths.some((p) => this.relevantPath(p))) {
      this.pushLog("push skipped: queued paths are not syncable");
      return null;
    }
    if (!manual && !dryRun) {
      const wait = MIN_SYNC_INTERVAL_MS - (Date.now() - this.lastRunAt);
      if (wait > 0) {
        if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
        this.debounceTimer = window.setTimeout(() => void this.syncNow(false, { direction, paths, trigger }), wait);
        return null;
      }
    }
    const gen = this.syncGen;
    this.syncing = true;
    this.setStatus("syncing");
    try {
      const accessKeyId = await resolveSecret(this.app, this.settings.accessKeyIdSecret);
      const secretAccessKey = await resolveSecret(this.app, this.settings.secretAccessKeySecret);
      if (!accessKeyId || !secretAccessKey) {
        new Notice("Sync2S3: set S3 keys in settings first");
        return null;
      }
      if (!this.settings.bucket || !this.settings.endpoint) {
        new Notice("Sync2S3: set endpoint and bucket first");
        return null;
      }
      const cfg = this.s3Config(accessKeyId, secretAccessKey);
      const basePrefix = this.effectiveBasePrefix();
      const mkey = manifestKey(basePrefix);
      const cacheKey = `${this.settings.endpoint}|${this.settings.bucket}|${basePrefix}`;
      const cached = this.manifestCache && this.manifestCache.key === cacheKey ? this.manifestCache : null;
      const cond = await getConditional(cfg, mkey, cached?.etag);
      let raw: string | null;
      if (cond.kind === "missing") {
        raw = null;
        this.manifestCache = null;
      } else if (cond.kind === "not-modified") {
        raw = cached ? cached.raw : null;
        if (!cached) this.manifestCache = null;
      } else {
        raw = new TextDecoder().decode(cond.bytes);
        this.manifestCache = cond.etag ? { key: cacheKey, etag: cond.etag, raw } : null;
      }
      let remote: SyncManifest;
      let keys: VaultKeys | null = null;
      let migrating = false;
      let remoteBefore: SyncManifest | null = null;
      const needPassphrase = async (): Promise<string | null> => {
        const pp = await resolveSecret(this.app, this.settings.passphraseSecret);
        if (!pp) new Notice("Sync2S3: set E2E passphrase in settings first");
        return pp || null;
      };
      if (!raw) {
        remote = emptyManifest(this.app.vault.getName(), basePrefix || this.app.vault.getName());
        if (this.settings.e2eEnabled) {
          const pp = await needPassphrase();
          if (!pp) return null;
          keys = await initVaultKeys(pp);
          remote.encryption = keys.meta;
          remote.nameEnc = true;
        }
      } else {
        const env = parseManifestEnvelope(raw);
        if (!env.encrypted) {
          remote = env.legacy as SyncManifest;
          assertManifestSupported(remote.encryption);
          if (this.settings.e2eEnabled) {
            const pp = await needPassphrase();
            if (!pp) return null;
            if (remote.encryption.mode === "aes-gcm") {
              keys = await openVaultKeys(remote.encryption, pp);
            } else {
              keys = await initVaultKeys(pp);
              remote.encryption = keys.meta;
            }
            if (!remote.nameEnc) {
              const fresh = emptyManifest(remote.vaultId, remote.basePrefix);
              fresh.encryption = keys.meta;
              fresh.nameEnc = true;
              fresh.devices = remote.devices;
              remoteBefore = remote;
              remote = fresh;
              this.settings.lastSync = {};
              migrating = true;
              this.pushLog("name migration: re-uploading all files under opaque IDs", "migration");
            }
          }
        } else {
          if (!this.settings.e2eEnabled) {
            new Notice("Sync2S3: remote vault is encrypted. Enable E2E with the same passphrase.");
            return null;
          }
          const pp = await needPassphrase();
          if (!pp) return null;
          keys = await openVaultKeys(env.meta as EncryptionMeta, pp);
          remote = await decryptManifestInner(env.payload as string, keys.dataKey);
          assertManifestSupported(remote.encryption);
          if (!remote.nameEnc) {
            // Bodies encrypted, names plaintext (v1 bodies-only era). Re-key under IDs, same data key.
            this.settings.lastSync = {};
            const fresh = emptyManifest(remote.vaultId, remote.basePrefix);
            fresh.encryption = keys.meta;
            fresh.nameEnc = true;
            fresh.devices = remote.devices;
            remoteBefore = remote;
            remote = fresh;
            migrating = true;
            this.pushLog("name migration: re-uploading all files under opaque IDs", "migration");
          }
        }
      }
      const toRemote = (b: Uint8Array): Promise<Uint8Array> => (keys ? encryptBytes(keys.dataKey, b) : Promise.resolve(b));
      const fromRemote = (b: Uint8Array): Promise<Uint8Array> => (keys ? decryptBytes(keys.dataKey, b) : Promise.resolve(b));
      const { local, skipped, skippedRule } = await this.scanLocal();
      if (skipped.length > 0) this.pushLog(`skipped over cap: ${skipped.join(", ")}`);
      if (skippedRule.length > 0) this.pushLog(`skipped by path rule: ${skippedRule.join(", ")}`);
      const rules = parsePathRules(this.settings.pathRules);
      const remoteView = filterRemoteView(remote, (p) => !isPathBlocked(p, rules));
      const out = decideSync({ local, lastSync: this.settings.lastSync, remote: remoteView });
      this.pushLog(`plan up=${out.uploads.length} down=${out.downloads.length} conflict=${out.conflicts.length} delR=${out.deleteRemote.length} delL=${out.deleteLocal.length} skipRule=${skippedRule.length}`, "plan");
      if (dryRun) {
        new Notice(`Sync2S3: dry run up ${out.uploads.length}, down ${out.downloads.length}, conflicts ${out.conflicts.length}, skipped ${skippedRule.length}`);
        return { uploads: out.uploads.length, downloads: out.downloads.length, conflicts: out.conflicts.length };
      }
      // First-run bootstrap guard: empty remote means upload-only, never delete.
      const bootstrapping = Object.keys(remoteView.files).length === 0;
      const nameEnc = remote.nameEnc === true;
      const rkey = (p: string, rid?: string): string =>
        remoteObjectKey(basePrefix, p, rid ?? remote.files[p]?.rid ?? this.settings.lastSync[p]?.rid, nameEnc);
      const uploadsToRun = direction === "pull" ? [] : out.uploads;
      const downloadsToRun = direction === "push" ? [] : out.downloads;
      const conflictsToRun = direction === "push" ? [] : out.conflicts;
      const deleteRemoteToRun = direction !== "full" || bootstrapping ? [] : out.deleteRemote;
      const deleteLocalToRun = direction === "push" || bootstrapping ? [] : out.deleteLocal;
      if (direction !== "full") {
        const hint = paths && paths.length > 0 ? ` paths=${paths.join(",")}` : "";
        this.pushLog(`direction ${direction} trigger=${requestTrigger}${hint}`);
      }
      this.throwIfCancelled(gen);
      const processed = new Set<string>();
      let conflicts = 0;
      let deletedRemote = 0;
      let deletedLocal = 0;
      const settingsBefore = JSON.stringify({ l: this.settings.lastSync, p: this.settings.pendingDeletes });
      for (const p of uploadsToRun) {
        this.throwIfCancelled(gen);
        const buf = new Uint8Array(await this.app.vault.adapter.readBinary(p));
        let rid = remote.files[p]?.rid ?? this.settings.lastSync[p]?.rid;
        if (nameEnc && !rid) rid = randomId();
        await putObject(cfg, remoteObjectKey(basePrefix, p, rid, nameEnc), await toRemote(buf), contentTypeFor(p));
        this.settings.lastSync[p] = rid ? { ...local[p], rid } : local[p];
        processed.add(p);
      }
      if (downloadsToRun.length > 0 || conflictsToRun.length > 0 || deleteLocalToRun.length > 0) this.applyingRemote = true;
      for (const p of downloadsToRun) {
        this.throwIfCancelled(gen);
        const rawBytes = await getObject(cfg, rkey(p));
        if (rawBytes === null) continue;
        const bytes = await fromRemote(rawBytes);
        await ensureFolder(this.app.vault.adapter, parentDir(p));
        await this.app.vault.adapter.writeBinary(p, exactBuffer(bytes));
        const rid = remote.files[p]?.rid;
        const f = this.app.vault.getFileByPath(p);
        const rec = f ? { hash: await sha256HexBytes(bytes), mtime: f.stat.mtime, size: bytes.length } : { hash: "", mtime: Date.now(), size: bytes.length };
        this.settings.lastSync[p] = rid ? { ...rec, rid } : rec;
        processed.add(p);
      }
      for (const p of conflictsToRun) {
        this.throwIfCancelled(gen);
        conflicts++;
        const remoteRaw = await getObject(cfg, rkey(p));
        const remoteBytes = remoteRaw ? await fromRemote(remoteRaw) : null;
        const lrec = local[p];
        const rrec = remote.files[p];
        if (!lrec && remoteBytes) {
          // Local copy is gone but the remote side changed: the edit wins.
          await ensureFolder(this.app.vault.adapter, parentDir(p));
          await this.app.vault.adapter.writeBinary(p, exactBuffer(remoteBytes));
          const rid = rrec?.rid;
          const f = this.app.vault.getFileByPath(p);
          const rec = f ? { hash: await sha256HexBytes(remoteBytes), mtime: f.stat.mtime, size: remoteBytes.length } : { hash: "", mtime: Date.now(), size: remoteBytes.length };
          this.settings.lastSync[p] = rid ? { ...rec, rid } : rec;
          processed.add(p);
          this.pushLog(`conflict: remote edit restored ${p}, local delete did not stick`, "conflict");
          continue;
        }
        const remoteNewer = remoteBytes && rrec && lrec ? rrec.mtime > lrec.mtime : false;
        const copyPath = conflictCopyPath(p, this.settings.deviceId);
        const put = async (path: string, plaintext: Uint8Array): Promise<string | undefined> => {
          let rid = remote.files[path]?.rid ?? this.settings.lastSync[path]?.rid;
          if (nameEnc && !rid) rid = randomId();
          await putObject(cfg, remoteObjectKey(basePrefix, path, rid, nameEnc), await toRemote(plaintext), contentTypeFor(path));
          return rid;
        };
        const recordCopy = async (path: string, plaintext: Uint8Array, rid: string | undefined): Promise<void> => {
          const f = this.app.vault.getFileByPath(path);
          const hash = await sha256HexBytes(plaintext);
          const mtime = f ? f.stat.mtime : Date.now();
          const rec: FileRecord = { hash, mtime, size: plaintext.length };
          this.settings.lastSync[path] = rid ? { ...rec, rid } : rec;
          processed.add(path);
        };
        if (remoteNewer && remoteBytes) {
          const localBytes = new Uint8Array(await this.app.vault.adapter.readBinary(p));
          await ensureFolder(this.app.vault.adapter, parentDir(copyPath));
          await this.app.vault.adapter.writeBinary(copyPath, exactBuffer(localBytes));
          await this.app.vault.adapter.writeBinary(p, exactBuffer(remoteBytes));
          const copyRid = await put(copyPath, localBytes);
          await recordCopy(copyPath, localBytes, copyRid ?? remote.files[copyPath]?.rid);
        } else {
          await ensureFolder(this.app.vault.adapter, parentDir(copyPath));
          if (remoteBytes) await this.app.vault.adapter.writeBinary(copyPath, exactBuffer(remoteBytes));
          const buf = new Uint8Array(await this.app.vault.adapter.readBinary(p));
          await put(p, buf);
          let copyRid: string | undefined;
          if (remoteBytes) {
            copyRid = await put(copyPath, remoteBytes);
            await recordCopy(copyPath, remoteBytes, copyRid ?? remote.files[copyPath]?.rid);
          }
        }
        const f = this.app.vault.getFileByPath(p);
        if (f) {
          const buf = new Uint8Array(await this.app.vault.adapter.readBinary(p));
          const prev = this.settings.lastSync[p];
          this.settings.lastSync[p] = { hash: await sha256HexBytes(buf), mtime: f.stat.mtime, size: buf.length, ...(prev?.rid ? { rid: prev.rid } : remote.files[p]?.rid ? { rid: remote.files[p].rid as string } : {}) };
          processed.add(p);
        }
        this.pushLog(`conflict copy: ${copyPath}`, "conflict");
      }
      if (migrating) {
        const live = new Set<string>();
        for (const [p, rec] of Object.entries(this.settings.lastSync)) {
          live.add(remoteObjectKey(basePrefix, p, rec.rid, nameEnc));
        }
        live.add(mkey);
        // Reverse map for opaque keys so excluded paths keep their remote copies.
        const knownFiles = remoteBefore?.files ?? remote.files;
        const keyToPath = new Map<string, string>();
        for (const [p, rec] of Object.entries(knownFiles)) {
          keyToPath.set(remoteObjectKey(basePrefix, p, rec.rid, remoteBefore?.nameEnc ?? remote.nameEnc), p);
        }
        const existing = await listObjects(cfg, basePrefix ? `${basePrefix}/` : "");
        for (const k of existing) {
          if (k === mkey || live.has(k)) continue;
          const owner = keyToPath.get(k);
          if (owner && isPathBlocked(owner, rules)) continue;
          await deleteObject(cfg, k);
          this.pushLog(`migration pruned stale key: ${k}`, "prune");
        }
      }
      if (!bootstrapping) {
        for (const p of deleteRemoteToRun) {
          this.throwIfCancelled(gen);
          const n = (this.settings.pendingDeletes[p] ?? 0) + 1;
          this.settings.pendingDeletes[p] = n;
          if (n >= 2) {
            await deleteObject(cfg, rkey(p));
            delete this.settings.pendingDeletes[p];
            delete this.settings.lastSync[p];
            deletedRemote++;
            this.pushLog(`propagated delete remote: ${p}`, "delete");
            new Notice(`Sync2S3: deleted remote ${p}`);
          } else {
            this.pushLog(`delete remote pending 1/2: ${p}`);
          }
        }
        for (const p of deleteLocalToRun) {
          this.throwIfCancelled(gen);
          const n = (this.settings.pendingDeletes[`local:${p}`] ?? 0) + 1;
          this.settings.pendingDeletes[`local:${p}`] = n;
          if (n >= 2) {
            const f = this.app.vault.getFileByPath(p);
            if (f) await this.app.vault.trash(f, false);
            delete this.settings.pendingDeletes[`local:${p}`];
            delete this.settings.lastSync[p];
            deletedLocal++;
            this.pushLog(`propagated delete local: ${p}`, "delete");
            new Notice(`Sync2S3: deleted local ${p}`);
          }
        }
      }
      // Clear pending counters for reappeared, blocked, or fully gone paths.
      // A confirmation must not survive an exclusion window or outlive its file.
      for (const k of prunePendingKeys(this.settings.pendingDeletes, local, remote.files, (p) => isPathBlocked(p, rules))) {
        delete this.settings.pendingDeletes[k];
      }
      const remoteDirty = !raw || migrating || processed.size > 0 || deletedRemote > 0 || deletedLocal > 0;
      if (remoteDirty) {
        this.throwIfCancelled(gen);
        remote.files = { ...remote.files };
        if (direction === "full") {
          for (const [p, rec] of Object.entries(this.settings.lastSync)) remote.files[p] = { ...rec };
          for (const p of [...deleteRemoteToRun, ...deleteLocalToRun]) {
            if (!this.settings.lastSync[p]) delete remote.files[p];
          }
        } else {
          for (const p of processed) {
            const rec = this.settings.lastSync[p];
            if (rec) remote.files[p] = { ...rec };
            else delete remote.files[p];
          }
        }
        remote.updatedAt = Date.now();
        remote.devices[this.settings.deviceId] = Date.now();
        const manifestBody = await writeManifestBody(remote, keys);
        const manifestEtag = await putTextEtag(cfg, mkey, manifestBody);
        this.manifestCache = manifestEtag ? { key: cacheKey, etag: manifestEtag, raw: manifestBody } : null;
        // Touch listing once so bad prefixes fail loudly.
        await listObjects(cfg, basePrefix ? `${basePrefix}/` : "");
      }
      this.throwIfCancelled(gen);
      const settingsDirty = JSON.stringify({ l: this.settings.lastSync, p: this.settings.pendingDeletes }) !== settingsBefore;
      if (settingsDirty) await this.saveSettings();
      const upCount = uploadsToRun.length;
      const downCount = downloadsToRun.length;
      this.lastSummary = `${direction} up ${upCount} down ${downCount} conflicts ${conflicts}`;
      this.setStatus(this.isPaused() ? "paused" : "idle");
      if (manual || upCount > 0 || downCount > 0 || conflicts > 0 || deletedRemote > 0 || deletedLocal > 0) {
        new Notice(`Sync2S3: ${direction} up ${upCount}, down ${downCount}, conflicts ${conflicts}`);
      }
      return { uploads: upCount, downloads: downCount, conflicts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "sync cancelled") {
        this.pushLog("sync cancelled");
        this.setStatus(this.isPaused() ? "paused" : "idle");
        return null;
      }
      this.pushLog(`error: ${msg}`, "error");
      this.setStatus("error", msg.slice(0, 60));
      new Notice(`Sync2S3: sync failed: ${msg.slice(0, 200)}`);
      return null;
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
      if (!dryRun) this.lastRunAt = Date.now();
      if (this.statusEl?.textContent?.includes("syncing")) this.setStatus(this.isPaused() ? "paused" : "idle");
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<Sync2S3Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class Sync2S3SettingTab extends PluginSettingTab {
  plugin: Sync2S3Plugin;
  constructor(app: import("obsidian").App, plugin: Sync2S3Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private addSecret(setting: Setting, get: () => string, set: (v: string) => void): void {
    const SecretComp = SecretComponent as unknown as
      | (new (app: unknown, el: HTMLElement) => { setValue: (v: string) => { onChange: (cb: (v: string) => void) => unknown } })
      | undefined;
    if (typeof SecretComp !== "undefined" && SecretComp) {
      setting.addComponent((el: HTMLElement) => {
        const c = new SecretComp(this.app, el);
        c.setValue(get()).onChange((v: string) => {
          set(v);
          void this.plugin.saveSettings();
        });
        return c as unknown as BaseComponent;
      });
    } else {
      setting.addText((t) => t.setPlaceholder("secret").setValue(get()).onChange((v) => {
        set(v);
        void this.plugin.saveSettings();
      }));
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const section = (name: string): void => {
      new Setting(containerEl).setName(name).setHeading();
    };
    section("Connection");
    const cardConnection = containerEl.createDiv({ cls: "sync2s3-card" });
    new Setting(cardConnection).setName("Endpoint").setDesc("S3 endpoint URL.").addText((t) =>
      t.setValue(s.endpoint).onChange((v) => {
        s.endpoint = v.trim();
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardConnection).setName("Region").setDesc("Server region. Signing fails when it differs.").addText((t) =>
      t.setValue(s.region).onChange((v) => {
        s.region = v.trim() || "us-east-1";
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardConnection).setName("Bucket").setDesc("Bucket name. It must already exist.").addText((t) =>
      t.setValue(s.bucket).onChange((v) => {
        s.bucket = v.trim();
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardConnection).setName("Path style").setDesc("On requests host/bucket/key. Off requests bucket.host/key and hides Base folder.").addToggle((t) =>
      t.setValue(s.pathStyle).onChange((v) => {
        s.pathStyle = v;
        void this.plugin.saveSettings();
        baseFolderRow.settingEl.style.display = v ? "" : "none";
        this.plugin.pushLog(v ? "path style on: base folder applies" : "path style off: bucket alone names the vault");
      }),
    );
    const baseFolderRow = new Setting(cardConnection).setName("Base folder").setDesc("Prefix inside the bucket. One bucket holds many vaults.").addText((t) =>
      t.setValue(s.basePrefix).onChange((v) => {
        s.basePrefix = v.trim();
        void this.plugin.saveSettings();
      }),
    );
    baseFolderRow.settingEl.style.display = s.pathStyle ? "" : "none";
    section("Credentials");
    const cardCredentials = containerEl.createDiv({ cls: "sync2s3-card" });
    this.addSecret(new Setting(cardCredentials).setName("Access key").setDesc("Stored in SecretStorage."), () => s.accessKeyIdSecret, (v) => (s.accessKeyIdSecret = v));
    this.addSecret(new Setting(cardCredentials).setName("Secret key").setDesc("Stored in SecretStorage."), () => s.secretAccessKeySecret, (v) => (s.secretAccessKeySecret = v));
    section("Files");
    const cardFiles = containerEl.createDiv({ cls: "sync2s3-card" });
    new Setting(cardFiles).setName("Attachment cap (MB)").setDesc("Skips files over the cap and logs them.").addText((t) =>
      t.setValue(String(s.attachmentCapMB)).onChange((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.attachmentCapMB = n;
          void this.plugin.saveSettings();
        }
      }),
    );
    new Setting(cardFiles).setName("Allowlist").setDesc("Comma-separated extensions.").addText((t) =>
      t.setValue(s.allowlist).onChange((v) => {
        s.allowlist = v;
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardFiles).setName("Excluded paths").setDesc("One path per line. Folders match everything under them. Empty syncs everything.").addTextArea((t) => {
      t.setPlaceholder("Excalidraw\nTemplates/Draft.md");
      t.setValue(s.pathRules);
      t.onChange((v) => {
        s.pathRules = v;
        void this.plugin.saveSettings();
      });
      return t;
    });
    new Setting(cardFiles).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStart).onChange((v) => {
        s.syncOnStart = v;
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardFiles).setName("Push on save").setDesc("Upload the saved file shortly after each save. Off falls back to full sync.").addToggle((t) =>
      t.setValue(s.pushOnSave).onChange((v) => {
        s.pushOnSave = v;
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardFiles).setName("Pull on focus").setDesc("Download changes when the app regains focus. Off disables focus pull.").addToggle((t) =>
      t.setValue(s.pullOnFocus).onChange((v) => {
        s.pullOnFocus = v;
        void this.plugin.saveSettings();
      }),
    );
    new Setting(cardFiles).setName("Paused").setDesc("Stops auto push and pull. Manual sync still works.").addToggle((t) =>
      t.setValue(s.paused).onChange((v) => {
        if (v) void this.plugin.pauseSync();
        else void this.plugin.resumeSync();
      }),
    );
    section("Encryption");
    const cardEncryption = containerEl.createDiv({ cls: "sync2s3-card" });
    this.addSecret(new Setting(cardEncryption).setName("E2E passphrase").setDesc("Active passphrase. Stored in SecretStorage."), () => s.passphraseSecret, (v) => (s.passphraseSecret = v));
    this.addSecret(new Setting(cardEncryption).setName("New E2E passphrase").setDesc("Stage the next passphrase here. Leave it empty otherwise."), () => s.newPassphraseSecret, (v) => (s.newPassphraseSecret = v));
    new Setting(cardEncryption)
      .setName("E2E encryption")
      .setDesc("Encrypts file bodies and names with AES-GCM. If the remote is plaintext, the next sync re-uploads everything encrypted.")
      .addToggle((t) =>
        t.setValue(s.e2eEnabled).onChange((v) => {
          s.e2eEnabled = v;
          void this.plugin.saveSettings();
        }),
      );
    new Setting(cardEncryption)
      .setName("Change E2E passphrase")
      .setDesc("Re-wraps the data key with the staged passphrase, then makes it active. Files stay put.")
      .addButton((b) => b.setButtonText("Rotate").onClick(() => void this.plugin.changePassphrase()));
    section("Actions");
    const cardActions = containerEl.createDiv({ cls: "sync2s3-card" });
    new Setting(cardActions)
      .setName("Test connection")
      .setDesc("Lists the base prefix. Reports status without syncing.")
      .addButton((b) => b.setButtonText("Test").onClick(() => void this.plugin.testConnection()));
    new Setting(cardActions)
      .setName("Sync now")
      .setDesc("Full sync both directions.")
      .addButton((b) => b.setButtonText("Sync now").onClick(() => void this.plugin.syncNow(false, { manual: true })));
    new Setting(cardActions)
      .setName("Pull now")
      .setDesc("Download only. Manual pull works while paused.")
      .addButton((b) => b.setButtonText("Pull now").onClick(() => void this.plugin.syncNow(false, { manual: true, direction: "pull" })));
    new Setting(cardActions)
      .setName("Pause sync")
      .setDesc("Stops auto push and pull. Manual sync still works.")
      .addButton((b) => b.setButtonText("Pause").onClick(() => void this.plugin.pauseSync()))
      .addButton((b) => b.setButtonText("Resume").onClick(() => void this.plugin.resumeSync()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.plugin.cancelSync()));
    new Setting(cardActions)
      .setName("Dry run")
      .setDesc("Shows what the next sync would do. Writes nothing.")
      .addButton((b) => b.setButtonText("Dry run").onClick(() => void this.plugin.syncNow(true, { manual: true })));
    section("Danger zone");
    const cardDanger = containerEl.createDiv({ cls: "sync2s3-card" });
    new Setting(cardDanger)
      .setName("Reset remote vault")
      .setDesc("Wipes the whole prefix. Local files stay. Escape hatch for a lost passphrase.")
      .addButton((b) => b.setButtonText("Reset").setWarning().onClick(() => void this.plugin.resetRemote()));
    section("Log");
    const entries = this.plugin.getLog().slice(-50);
    const cardLog = containerEl.createDiv({ cls: "sync2s3-card" });
    new Setting(cardLog)
      .setName("")
      .setDesc(entries.length > 0 ? `${entries.length} rows, newest last. Reopen settings to refresh.` : "Empty so far. Sync once to fill it.")
      .addButton((b) =>
        b.setButtonText("Copy").onClick(() => {
          const text = this.plugin.formatLog();
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(
              () => new Notice("Sync2S3: log copied"),
              () => new Notice("Sync2S3: copy failed, select the text manually"),
            );
          } else {
            new Notice("Sync2S3: clipboard unavailable, select the text manually");
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("Clear").onClick(() => {
          this.plugin.clearLog();
          this.display();
        }),
      );
    if (entries.length > 0) {
      const box = containerEl.createDiv({ cls: "sync2s3-log" });
      for (const e of entries) {
        const row = box.createDiv({ cls: `sync2s3-log-row sync2s3-log-${e.kind}` });
        row.createSpan({ cls: "sync2s3-log-time", text: e.time.slice(11, 19) });
        row.createSpan({ cls: "sync2s3-log-msg", text: e.msg });
      }
      box.scrollTop = box.scrollHeight;
    }
  }
}
