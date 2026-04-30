import { describe, it, expect } from "vitest";
import { safeNext } from "../safe-next";

describe("safeNext", () => {
  it("returns '/' for null/empty", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("accepts simple relative paths", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/admin")).toBe("/admin");
    expect(safeNext("/path/to?x=1")).toBe("/path/to?x=1");
  });

  it("rejects absolute URLs", () => {
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("http://evil.com/path")).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("//evil.com/path")).toBe("/");
  });

  it("rejects backslash injection (Windows parsers)", () => {
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext("\\\\evil.com")).toBe("/");
  });

  it("rejects values that don't start with single slash", () => {
    expect(safeNext("admin")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
  });
});
