import { describe, expect, it } from "vitest";
import { capOutput, withEnv } from "../src/codex.js";

describe("capOutput", () => {
  it("leaves short output alone", () => {
    expect(capOutput("hello", 100)).toBe("hello");
  });

  it("keeps the head and the tail of long output", () => {
    const text = "A".repeat(50) + "B".repeat(50) + "C".repeat(50);
    const capped = capOutput(text, 40);

    expect(capped.startsWith("A".repeat(20))).toBe(true);
    expect(capped.endsWith("C".repeat(20))).toBe(true);
    expect(capped).toContain("characters omitted");
  });
});

describe("withEnv", () => {
  it("replaces a variable whatever its case on Windows, and adds it elsewhere", () => {
    const env = withEnv({ NPM_CONFIG_CACHE: "C:\\npm\\cache", KEEP: "1" }, { npm_config_cache: "ours" });
    expect(env.npm_config_cache).toBe("ours");
    expect(env.KEEP).toBe("1");
    // Two keys differing only in case would leave Windows to pick one of them.
    expect("NPM_CONFIG_CACHE" in env).toBe(process.platform !== "win32");
  });
});
