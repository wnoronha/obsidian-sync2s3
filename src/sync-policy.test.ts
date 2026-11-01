import { describe, expect, test } from "bun:test";
import {
  shouldRun,
  isConflictCopyPath,
} from "./sync-policy";

describe("shouldRun", () => {
  test("manual runs while paused", () => {
    expect(shouldRun({ direction: "full", trigger: "manual" }, { paused: true })).toBe(true);
  });

  test("auto triggers stop while paused", () => {
    expect(shouldRun({ direction: "pull", trigger: "focus" }, { paused: true })).toBe(false);
    expect(shouldRun({ direction: "push", trigger: "save" }, { paused: true })).toBe(false);
  });

  test("auto triggers run when unpaused", () => {
    expect(shouldRun({ direction: "push", trigger: "save" }, { paused: false })).toBe(true);
  });
});

describe("isConflictCopyPath", () => {
  test("detects conflict copies", () => {
    expect(isConflictCopyPath("notes/a (Conflicted copy dev-1 202611010200).md")).toBe(true);
    expect(isConflictCopyPath("notes/a.md")).toBe(false);
  });
});
