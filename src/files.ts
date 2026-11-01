export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export interface StatCacheEntry {
  hash: string;
  mtime: number;
  size: number;
}

// Returns a copy of the stored record when mtime and size match exactly,
// so callers can skip re-reading and re-hashing the file. Any mismatch
// means the file may have changed: returns null and the caller hashes.
export function cachedSyncRecord<T extends StatCacheEntry>(prev: Record<string, T> | undefined, path: string, mtime: number, size: number): T | null {
  const rec = prev?.[path];
  if (!rec || rec.mtime !== mtime || rec.size !== size) return null;
  return { ...rec };
}

export interface FolderAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export async function ensureFolder(adapter: FolderAdapter, dir: string): Promise<void> {
  if (!dir) return;
  const parts = dir.split("/").filter((s) => s.length > 0);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
  }
}
