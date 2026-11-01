import { describe, expect, test } from "bun:test";
import { cachedSyncRecord, ensureFolder, parentDir } from "./files";

describe("parentDir", () => {
  test("nested, top-level, bare", () => {
    expect(parentDir("00 - X/note.md")).toBe("00 - X");
    expect(parentDir("a/b/c.md")).toBe("a/b");
    expect(parentDir("note.md")).toBe("");
  });
});

describe("ensureFolder", () => {
  test("creates missing chain once, skips existing", async () => {
    const existing = new Set(["a"]);
    const made: string[] = [];
    const adapter = {
      exists: async (p: string) => existing.has(p),
      mkdir: async (p: string) => {
        made.push(p);
        existing.add(p);
      },
    };
    await ensureFolder(adapter, "a/b/c");
    expect(made).toEqual(["a/b", "a/b/c"]);
    made.length = 0;
    await ensureFolder(adapter, "a/b/c");
    expect(made).toEqual([]);
    await ensureFolder(adapter, "");
    expect(made).toEqual([]);
  });
});

describe("cachedSyncRecord", () => {
  const prev = { "a.md": { hash: "h1", mtime: 100, size: 5, rid: "r1" } };
  test("hit returns a copy preserving extras", () => {
    const hit = cachedSyncRecord(prev, "a.md", 100, 5);
    expect(hit).toEqual({ hash: "h1", mtime: 100, size: 5, rid: "r1" });
    expect(hit).not.toBe(prev["a.md"]);
  });
  test("mtime or size mismatch misses", () => {
    expect(cachedSyncRecord(prev, "a.md", 101, 5)).toBeNull();
    expect(cachedSyncRecord(prev, "a.md", 100, 6)).toBeNull();
  });
  test("unknown path misses", () => {
    expect(cachedSyncRecord(prev, "b.md", 100, 5)).toBeNull();
    expect(cachedSyncRecord(undefined, "a.md", 100, 5)).toBeNull();
  });
});
