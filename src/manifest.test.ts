import { describe, expect, test } from "bun:test";
import { emptyManifest, filterRemoteView, remoteObjectKey } from "./manifest";

describe("filterRemoteView", () => {
  test("drops blocked paths, keeps baseline entries intact", () => {
    const m = emptyManifest("v", "v");
    m.files["a.md"] = { hash: "h", mtime: 1, size: 1 };
    m.files["Excalidraw/d.md"] = { hash: "h", mtime: 1, size: 1 };
    const view = filterRemoteView(m, (p) => p !== "Excalidraw/d.md");
    expect(Object.keys(view.files)).toEqual(["a.md"]);
    expect(Object.keys(m.files)).toEqual(["a.md", "Excalidraw/d.md"]);
  });
});

describe("remoteObjectKey", () => {
  test("legacy path keys when nameEnc off", () => {
    expect(remoteObjectKey("my-vault", "a b.md", "abc123", false)).toBe("my-vault/a b.md");
    expect(remoteObjectKey("my-vault", "a b.md", undefined, true)).toBe("my-vault/a b.md");
  });

  test("opaque id keys when nameEnc on with rid", () => {
    expect(remoteObjectKey("my-vault", "secret note.md", "abc123", true)).toBe("my-vault/o/abc123");
  });

  test("empty prefix joins cleanly", () => {
    expect(remoteObjectKey("", "a.md", "id1", true)).toBe("o/id1");
  });
});
