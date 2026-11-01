import type { FileRecord } from "./manifest";

export interface Sync2S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  basePrefix: string;
  pathStyle: boolean;
  accessKeyIdSecret: string;
  secretAccessKeySecret: string;
  passphraseSecret: string;
  newPassphraseSecret: string;
  attachmentCapMB: number;
  allowlist: string;
  pathRules: string;
  syncOnStart: boolean;
  paused: boolean;
  pushOnSave: boolean;
  pullOnFocus: boolean;
  e2eEnabled: boolean;
  lastSync: Record<string, FileRecord>;
  deviceId: string;
  pendingDeletes: Record<string, number>;
}

export const DEFAULT_SETTINGS: Sync2S3Settings = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "my-bucket",
  basePrefix: "my-vault",
  pathStyle: true,
  accessKeyIdSecret: "",
  secretAccessKeySecret: "",
  passphraseSecret: "",
  newPassphraseSecret: "",
  attachmentCapMB: 25,
  allowlist: "md,canvas,png,jpg,jpeg,pdf,excalidraw",
  pathRules: "",
  syncOnStart: true,
  paused: false,
  pushOnSave: true,
  pullOnFocus: true,
  e2eEnabled: false,
  lastSync: {},
  deviceId: "",
  pendingDeletes: {},
};

export function parsePathRules(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length > 0);
}

export function isPathBlocked(path: string, rules: readonly string[]): boolean {
  if (rules.length === 0) return false;
  const clean = path.replace(/^\/+/g, "");
  return rules.some((r) => clean === r || clean.startsWith(r + "/"));
}

export function parseAllowlist(raw: string): Set<string> {
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean),
  );
}

export function isSyncable(path: string, allow: Set<string>): boolean {
  if (path.startsWith(".obsidian/") || path.startsWith(".copilot/") || path.startsWith(".trash/")) return false;
  if (path.startsWith(".sync2s3/")) return false;
  if (path.includes("/.")) return false;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return allow.has(path.slice(dot + 1).toLowerCase());
}
