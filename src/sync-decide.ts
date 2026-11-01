import type { FileRecord, SyncManifest } from "./manifest";

export type Action =
  | { kind: "upload"; path: string }
  | { kind: "download"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "deleteRemote"; path: string }
  | { kind: "deleteLocal"; path: string }
  | { kind: "noop"; path: string };

export interface DecideInput {
  local: Record<string, FileRecord>;
  lastSync: Record<string, FileRecord>;
  remote: SyncManifest;
}

export interface DecideOutput {
  actions: Action[];
  uploads: string[];
  downloads: string[];
  conflicts: string[];
  deleteRemote: string[];
  deleteLocal: string[];
}

const LOCAL_PREFIX = "local:";

export function stripPendingKey(key: string): string {
  return key.startsWith(LOCAL_PREFIX) ? key.slice(LOCAL_PREFIX.length) : key;
}

export function prunePendingKeys(
  pending: Record<string, number>,
  local: Record<string, unknown>,
  remoteFiles: Record<string, unknown>,
  blocked: (path: string) => boolean,
): string[] {
  const drop: string[] = [];
  for (const key of Object.keys(pending)) {
    const raw = stripPendingKey(key);
    // The two key kinds have mirrored liveness: a plain key confirms an
    // absence turning into a remote delete, a `local:` key confirms a
    // presence the remote no longer has.
    const live = key.startsWith(LOCAL_PREFIX)
      ? !blocked(raw) && !!local[raw] && !remoteFiles[raw]
      : !blocked(raw) && !local[raw] && !!remoteFiles[raw];
    if (!live) drop.push(key);
  }
  return drop;
}

function same(a?: FileRecord, b?: FileRecord): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.hash === b.hash && a.size === b.size && !!a.deleted === !!b.deleted;
}

export function decideSync(input: DecideInput): DecideOutput {
  const paths = new Set<string>([
    ...Object.keys(input.local),
    ...Object.keys(input.lastSync),
    ...Object.keys(input.remote.files),
  ]);
  const actions: Action[] = [];
  for (const path of [...paths].sort()) {
    const l = input.local[path];
    const s = input.lastSync[path];
    const r = input.remote.files[path];
    const localChanged = !same(l, s);
    const remoteChanged = !same(r, s);

    if (!l && !r) {
      actions.push({ kind: "noop", path });
      continue;
    }
    // Bootstrap: no lastSync entry and only one side has it
    if (!s) {
      if (l && !r) {
        actions.push({ kind: "upload", path });
        continue;
      }
      if (!l && r && !r.deleted) {
        actions.push({ kind: "download", path });
        continue;
      }
      if (!l && r && r.deleted) {
        actions.push({ kind: "noop", path });
        continue;
      }
    }
    if (l && !r) {
      // Remote missing. With a baseline it means remote deleted.
      if (!s) {
        actions.push({ kind: "upload", path });
      } else if (!localChanged) {
        actions.push({ kind: "deleteLocal", path });
      } else {
        // Remote deleted, local changed -> conflict (keep local, surface it)
        actions.push({ kind: "conflict", path });
      }
      continue;
    }
    if (!l && r) {
      if (r.deleted) {
        actions.push({ kind: "noop", path });
        continue;
      }
      if (!s) {
        // Never seen locally, exists remotely -> download
        actions.push({ kind: "download", path });
        continue;
      }
      if (!remoteChanged) {
        // Deleted locally, remote unchanged -> propagate delete
        actions.push({ kind: "deleteRemote", path });
        continue;
      }
      // Deleted locally but remote changed -> conflict
      actions.push({ kind: "conflict", path });
      continue;
    }
    // Both present
    if (!localChanged && !remoteChanged) {
      actions.push({ kind: "noop", path });
      continue;
    }
    if (localChanged && !remoteChanged) {
      actions.push({ kind: "upload", path });
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (r.deleted) {
        actions.push({ kind: "deleteLocal", path });
      } else {
        actions.push({ kind: "download", path });
      }
      continue;
    }
    // Both changed
    if (same(l, r)) {
      actions.push({ kind: "noop", path });
    } else {
      actions.push({ kind: "conflict", path });
    }
  }
  return {
    actions,
    uploads: actions.filter((a) => a.kind === "upload").map((a) => a.path),
    downloads: actions.filter((a) => a.kind === "download").map((a) => a.path),
    conflicts: actions.filter((a) => a.kind === "conflict").map((a) => a.path),
    deleteRemote: actions.filter((a) => a.kind === "deleteRemote").map((a) => a.path),
    deleteLocal: actions.filter((a) => a.kind === "deleteLocal").map((a) => a.path),
  };
}

export function conflictCopyPath(path: string, device: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const dot = path.lastIndexOf(".");
  const stem = dot >= 0 ? path.slice(0, dot) : path;
  const ext = dot >= 0 ? path.slice(dot) : "";
  return `${stem} (Conflicted copy ${device} ${stamp})${ext}`;
}
