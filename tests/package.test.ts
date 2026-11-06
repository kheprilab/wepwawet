import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version.js";

describe("release package", () => {
  it("publishes one CLI binary with the same version as the runtime", async () => {
    const metadata = JSON.parse(await readFile(path.join(import.meta.dirname, "../package.json"), "utf8"));
    expect(metadata.name).toBe("wepwawet");
    expect(metadata.version).toBe(CLI_VERSION);
    expect(metadata.bin).toEqual({ wep: "dist/index.js" });
    expect(metadata.scripts.wep).toBe("node dist/index.js");
  });

  it("cleans stale dist artifacts before every release build", async () => {
    const packageJson = JSON.parse(await readFile(path.join(import.meta.dirname, "../package.json"), "utf8")) as {
      scripts?: { build?: string };
    };

    expect(packageJson.scripts?.build).toMatch(/(?:^|\s)--clean(?:\s|$)/);
  });
});
