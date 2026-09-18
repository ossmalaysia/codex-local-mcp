import { describe, expect, it } from "vitest";
import { capOutput } from "../src/codex.js";

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
