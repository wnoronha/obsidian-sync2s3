import { describe, expect, test } from "bun:test";
import { emptyManifest } from "./manifest";
import { conflictCopyPath, decideSync, prunePendingKeys } from "./sync-decide";

const rec = (hash: string, mtime = 1, size = 1) => ({ hash, mtime, size });

describe("decideSync", () => {
  test("bootstrap uploads local-only files", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    const out = decideSync({ local: { "a.md": rec("h1") }, lastSync: {}, remote });
    expect(out.uploads).toEqual(["a.md"]);
    expect(out.downloads).toEqual([]);
  });

  test("join downloads remote-only files", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    remote.files["b.md"] = rec("h2");
    const out = decideSync({ local: {}, lastSync: {}, remote });
    expect(out.downloads).toEqual(["b.md"]);
  });

  test("both changed with different hash conflicts", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    remote.files["a.md"] = rec("hr", 2);
    const out = decideSync({
      local: { "a.md": rec("hl", 3) },
      lastSync: { "a.md": rec("h0", 1) },
      remote,
    });
    expect(out.conflicts).toEqual(["a.md"]);
  });

  test("local delete propagates only via deleteRemote intent", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    remote.files["a.md"] = rec("h1", 1);
    const out = decideSync({ local: {}, lastSync: { "a.md": rec("h1", 1) }, remote });
    expect(out.deleteRemote).toEqual(["a.md"]);
  });

  test("remote delete marker downloads as deleteLocal", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    remote.files["a.md"] = { ...rec("h1", 1), deleted: true };
    const out = decideSync({ local: { "a.md": rec("h1", 1) }, lastSync: { "a.md": rec("h1", 1) }, remote });
    expect(out.deleteLocal).toEqual(["a.md"]);
  });

  test("remote missing with untouched local deletes locally", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    const out = decideSync({ local: { "a.md": rec("h1", 1) }, lastSync: { "a.md": rec("h1", 1) }, remote });
    expect(out.deleteLocal).toEqual(["a.md"]);
  });

  test("remote missing with changed local conflicts", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    const out = decideSync({ local: { "a.md": rec("h2", 2) }, lastSync: { "a.md": rec("h1", 1) }, remote });
    expect(out.conflicts).toEqual(["a.md"]);
  });

  test("local missing with changed remote conflicts", () => {
    const remote = emptyManifest("my-vault", "my-vault");
    remote.files["a.md"] = rec("h2", 2);
    const out = decideSync({ local: {}, lastSync: { "a.md": rec("h1", 1) }, remote });
    expect(out.conflicts).toEqual(["a.md"]);
  });

  test("unrecorded conflict copy re-uploads (the loop)", () => {
    const copy = "notes/a (Conflicted copy laptop 202611010200).md";
    const remote = emptyManifest("my-vault", "my-vault");
    const out = decideSync({ local: { [copy]: rec("hc", 2) }, lastSync: {}, remote });
    expect(out.uploads).toEqual([copy]);
  });

  test("recorded conflict copy converges to noop", () => {
    const copy = "notes/a (Conflicted copy laptop 202611010200).md";
    const r = rec("hc", 2);
    const remote = emptyManifest("my-vault", "my-vault");
    remote.files[copy] = { ...r };
    const out = decideSync({ local: { [copy]: { ...r } }, lastSync: { [copy]: { ...r } }, remote });
    expect(out.uploads).toEqual([]);
    expect(out.downloads).toEqual([]);
    expect(out.conflicts).toEqual([]);
  });
});

describe("prunePendingKeys", () => {
  const rec = { hash: "h", mtime: 1, size: 1 };
  test("keeps live confirmations, drops the rest", () => {
    const pending = { "a.md": 1, "local:f.md": 1, "c.md": 1, "d.md": 1 };
    const local = { "c.md": rec, "f.md": rec };
    const remote = { "a.md": rec, "c.md": rec };
    const out = prunePendingKeys(pending, local, remote, (p) => p === "d.md");
    expect(out.sort()).toEqual(["c.md", "d.md"]);
  });

  test("drops prefixed key when remote reappears, local is gone, or blocked", () => {
    expect(prunePendingKeys({ "local:f.md": 1 }, { "f.md": rec }, { "f.md": rec }, () => false)).toEqual(["local:f.md"]);
    expect(prunePendingKeys({ "local:f.md": 1 }, {}, {}, () => false)).toEqual(["local:f.md"]);
    expect(prunePendingKeys({ "local:f.md": 1 }, { "f.md": rec }, {}, () => true)).toEqual(["local:f.md"]);
  });

  test("live delete confirmation survives", () => {
    const out = prunePendingKeys({ "gone.md": 1 }, {}, { "gone.md": { hash: "h", mtime: 1, size: 1 } }, () => false);
    expect(out).toEqual([]);
  });
});

describe("conflictCopyPath", () => {
  test("uses conflict copy naming", () => {
    const p = conflictCopyPath("notes/a.md", "laptop", new Date("2026-11-01T02:00:00Z"));
    expect(p).toBe("notes/a (Conflicted copy laptop 202611010200).md");
  });
});
