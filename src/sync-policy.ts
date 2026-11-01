export type SyncDirection = "push" | "pull" | "full";
export type SyncTrigger = "save" | "focus" | "visible" | "manual" | "startup" | "vault-event";

export interface SyncRequest {
  direction: SyncDirection;
  trigger: SyncTrigger;
  paths?: string[];
}

export interface SyncOptions {
  manual?: boolean;
  direction?: SyncDirection;
  paths?: string[];
  trigger?: SyncTrigger;
}

export interface PauseLike {
  paused: boolean;
}

export function isManualTrigger(trigger: SyncTrigger): boolean {
  return trigger === "manual";
}

export function shouldRun(request: SyncRequest, state: PauseLike): boolean {
  if (isManualTrigger(request.trigger)) return true;
  if (state.paused) return false;
  return true;
}

export function isConflictCopyPath(path: string): boolean {
  return path.includes(" (Conflicted copy ");
}
