export interface FileRecord {
  hash: string;
  mtime: number;
  size: number;
  deleted?: boolean;
  rid?: string;
}

export interface EncryptionMeta {
  mode: "none" | "aes-gcm";
  kdf?: string;
  salt?: string;
  wrappedDataKey?: string;
}

export interface SyncManifest {
  version: 1;
  vaultId: string;
  basePrefix: string;
  updatedAt: number;
  encryption: EncryptionMeta;
  nameEnc?: boolean;
  files: Record<string, FileRecord>;
  devices: Record<string, number>;
}

export function emptyManifest(vaultId: string, basePrefix: string): SyncManifest {
  return {
    version: 1,
    vaultId,
    basePrefix,
    updatedAt: Date.now(),
    encryption: { mode: "none" },
    files: {},
    devices: {},
  };
}

export function manifestKey(basePrefix: string): string {
  const p = basePrefix.replace(/^\/+|\/+$/g, "");
  return p === "" ? ".sync2s3/manifest.json" : `${p}/.sync2s3/manifest.json`;
}

export function joinRemote(basePrefix: string, relative: string): string {
  const b = basePrefix.replace(/^\/+|\/+$/g, "");
  const r = relative.replace(/^\/+/g, "");
  return b === "" ? r : `${b}/${r}`;
}

export function remoteObjectKey(basePrefix: string, path: string, rid: string | undefined, nameEnc: boolean | undefined): string {
  if (nameEnc && rid) return joinRemote(basePrefix, `o/${rid}`);
  return joinRemote(basePrefix, path);
}

export function filterRemoteView(remote: SyncManifest, visible: (path: string) => boolean): SyncManifest {
  return { ...remote, files: Object.fromEntries(Object.entries(remote.files).filter(([p]) => visible(p))) };
}
