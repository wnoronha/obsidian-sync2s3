import { describe, expect, test } from "bun:test";
import { isPathBlocked, isSyncable, parseAllowlist, parsePathRules } from "./settings";

describe("parsePathRules", () => {
  test("trims, strips slashes, drops empties", () => {
    expect(parsePathRules("  Excalidraw/ \n\n/Templates/Draft.md/\n")).toEqual(["Excalidraw", "Templates/Draft.md"]);
    expect(parsePathRules("")).toEqual([]);
  });
});

describe("isPathBlocked", () => {
  test("empty rules block nothing", () => {
    expect(isPathBlocked("a/b.md", [])).toBe(false);
  });

  test("blocks exact and prefix hits only", () => {
    const rules = ["Excalidraw", "Templates/Draft.md"];
    expect(isPathBlocked("Excalidraw/drawing.md", rules)).toBe(true);
    expect(isPathBlocked("Templates/Draft.md", rules)).toBe(true);
    expect(isPathBlocked("Templates/Other.md", rules)).toBe(false);
    expect(isPathBlocked("ExcalidrawX/a.md", rules)).toBe(false);
  });
});

describe("isSyncable", () => {
  const allow = parseAllowlist("md,canvas,png");
  test("keeps normal notes and attachments", () => {
    expect(isSyncable("Welcome.md", allow)).toBe(true);
    expect(isSyncable("Excalidraw/drawing.png", allow)).toBe(true);
  });

  test("drops system folders and hidden paths", () => {
    expect(isSyncable(".obsidian/app.json", allow)).toBe(false);
    expect(isSyncable(".sync2s3/manifest.json", allow)).toBe(false);
    expect(isSyncable("Notes/.hidden.md", allow)).toBe(false);
  });

  test("drops unlisted extensions and extensionless files", () => {
    expect(isSyncable("clip.mp4", allow)).toBe(false);
    expect(isSyncable("LICENSE", allow)).toBe(false);
  });
});
