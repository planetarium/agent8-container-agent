import { describe, expect, it } from "bun:test";
import { join, normalize } from "node:path";
import { ensureSafePath } from "./server.ts";

describe("ensureSafePath", () => {
  const workdir = "/workspace";

  it("should return the original path when a normal path is provided", () => {
    const userPath = "project/src/file.ts";
    const result = ensureSafePath(workdir, userPath);
    expect(result).toBe(normalize(join(workdir, userPath)));
  });

  it("should return the original path when a nested path is provided", () => {
    const userPath = "project/src/components/utils/file.ts";
    const result = ensureSafePath(workdir, userPath);
    expect(result).toBe(normalize(join(workdir, userPath)));
  });

  it("should prevents traversal", () => {
    const userPath = "../../file.ts";
    const result = ensureSafePath(workdir, userPath);
    expect(result).toBe(normalize(join(workdir, "file.ts")));
  });
});
