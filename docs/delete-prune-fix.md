# Delete propagation: prune fix (Sketch 1 over tombstone writes)

## Problem

A file deleted on device A never leaves device B. B records
`local:F → 1` every sync, `prunePendingKeys` drops it every sync because the
file is still present locally, and the 2/2 trash never fires. Vaults diverge
silently. The shared drop predicate is correct for plain keys (live while
local is absent and remote is present) and inverted for `local:` keys (live
while local is present and remote is absent). One predicate serves two
lifecycles. The unit fixture never takes the runtime shape, so the suite
stays green.

## Usage (caller's view)

`main.ts` keeps calling one function with the same arguments:

```ts
for (const k of prunePendingKeys(this.settings.pendingDeletes, local, remote.files, (p) => isPathBlocked(p, rules))) {
  delete this.settings.pendingDeletes[k];
}
```

No caller changes. No persisted-schema changes. `data.json` keeps
`Record<string, number>` with the existing `local:` prefix convention.

Runtime shapes the function must honor (add as tests):

```ts
// live prefixed confirmation: local present, remote gone -> keep (drop nothing)
prunePendingKeys({ "local:f.md": 1 }, { "f.md": rec }, {}, () => false) // => []
// remote reappeared -> cancel
prunePendingKeys({ "local:f.md": 1 }, { "f.md": rec }, { "f.md": rec }, () => false) // => ["local:f.md"]
// user deleted locally -> moot
prunePendingKeys({ "local:f.md": 1 }, {}, {}, () => false) // => ["local:f.md"]
// plain key behavior unchanged
prunePendingKeys({ "g.md": 1 }, {}, { "g.md": rec }, () => false) // => []
```

## Shape

Split the drop rule by key kind inside `prunePendingKeys`:

```ts
for (const key of Object.keys(pending)) {
  const raw = stripPendingKey(key);
  const prefixed = key.startsWith(LOCAL_PREFIX);
  const live = prefixed
    ? !blocked(raw) && !!local[raw] && !remoteFiles[raw]
    : !blocked(raw) && !local[raw] && !!remoteFiles[raw];
  if (!live) drop.push(key);
}
```

The two liveness conditions are exact mirrors. Plain keys confirm an
absence turning into a remote delete. Prefixed keys confirm a presence the
remote no longer has. Trash still requires the candidate to recur with the
file byte-identical, so no new path to data loss. The decider, the 2/2
loops, and the `devices` map are untouched.

## Synthesis decision

Sketch 1 is the base. The defect is a wrong predicate, not a missing
protocol feature. Sketch 2 (tombstone writes with GC over the `devices`
map) was adapted only as a deferred follow-up: its read path already exists
in the decider (`deleted` branches plus test), so nothing is lost by waiting.
Tombstones were rejected for now because they add a shared lifecycle across
writer, GC, and decider for a single narrow case (no-baseline resurrection
on fresh installs with hand-copied files), while the reported divergence
needs no protocol change at all.

## Tradeoffs accepted

- We accept keeping the string-prefixed key encoding in exchange for zero
  schema migration in `data.json`. A `{ path, kind }` record would be
  cleaner but forces migration code for a two-case union.
- We accept that a locally edited file holds its `local:` counter at 1
  indefinitely (conflict branch, never trashed) in exchange for never
  trashing an actively edited file.
- We accept the TLA+ scope below (single file, no env interference during
  the confirmation window) in exchange for a machine-checked core property.

## Alternatives considered

- Tombstone writes (`deleted: true` manifest entries instead of removal,
  GC when all known devices have acked or after a TTL). Deeper interface:
  writer, GC policy, and decider must agree on tombstone lifetime, and the
  encrypted manifest grows with every delete. Hides nothing the current
  baseline does not already provide, except the no-baseline case. Loses on
  interface depth.
- This was otherwise the only viable shape because the failure is a
  predicate error, not a missing capability: every other component (decider
  branches, 2/2 loops, tests for the plain direction) already exists.

## Open questions and risks

- Should the stale-`lastSync` ghost be cleared when the user deletes locally
  a file the remote already dropped (`!l && !r` noop leaves the baseline
  entry)? Harmless today (short-circuits before comparison), but is leaving
  it the intended invariant?
- Cached-hash interplay: none, the change touches only pending-key pruning.
- Was the `devices` map introduced for tombstone GC? If so, Sketch 2 has a
  natural owner already.

## Next implementation step

Edit the `prunePendingKeys` drop condition per Shape, fix the line-88
fixture to the runtime shape, add the four cases from Usage, run the full
gates.

## Formal verification (verification work, 2026-11-01)

Model: `/tmp/opencode/sync-delete/DeleteFix.tla` (scratch, outside the repo).
Single file, single device, one file present locally with the remote entry
gone. Old and new prune rules as `PruneOld` / `PruneNew` under
`SPECIFICATION SpecOld` / `SpecNew` with weak fairness on Confirm, Trash,
and the active Prune. Properties: `L1 = <>(trashed)`, `NoEarlyTrash`,
`TypeOK`, deadlock check.

- Old rule: `L1` BREAKS. Counterexample is a 2-step loop: confirm, drop,
  confirm, drop, forever. `NoEarlyTrash` holds vacuously. This is the
  machine-checked bug.
- New rule: all hold. `TypeOK, NoEarlyTrash, NoDeadlock, L1`. 4 states,
  4 steps. Converges in two confirmations, never trashes early.

Rerun: `scripts/statechart DeleteFix.tla --config Old.cfg --view view.js
--out out-old` (and `New.cfg` / `out-new`).

## Test-against plan (verify the implementation against this before merging)

- [ ] `prunePendingKeys` keeps a live prefixed key: local present, remote
  absent, unblocked -> drop list empty.
- [ ] Drops it when remote reappears, when local is gone, and when blocked.
- [ ] Plain-key behavior unchanged (existing two prune tests still pass).
- [ ] Full gates green: `typecheck`, `bun test`, `sigcheck`, `build`.
- [ ] `git status` shows only `src/sync-decide.ts` plus
  `src/sync-decide.test.ts` modified. No manifest, version, or workflow
  changes. No tag or release moves (fix rides the next version).
