import { describe, expect, it } from "vitest";
import { sandboxArguments } from "../src/sandbox.js";

describe("sandbox enforcement", () => {
  it("explicitly disables command networking when the user disables it", () => {
    expect(sandboxArguments("workspace-write", "", false)).toContain("sandbox_workspace_write.network_access=false");
  });
  it("uses a deny-by-default filesystem profile without legacy mode overrides", () => {
    const args = sandboxArguments("isolated", "mxc", false, "win32");
    expect(args).toContain("permissions.codex_mcp_isolated.filesystem={':minimal'='read',':workspace_roots'={'.'='write','.git'='read','.agents'='read','.codex'='read','.aws'='read'},':tmpdir'='deny',':slash_tmp'='deny'}");
    expect(args).toContain("permissions.codex_mcp_isolated.network.enabled=false");
    expect(args).toContain("windows.sandbox=mxc");
    expect(args).toContain("features.prefer_mxc=false");
    expect(args).toContain("approval_policy=never");
    expect(args).not.toContain("--sandbox");
  });
  it("adds a writable cache root, or makes the workspace read-only for review", () => {
    const cache = sandboxArguments("workspace-write", "", true, "linux", "", "", { writableRoots: ["C:\\root\\.cache\\demo"] });
    expect(cache).toContain('sandbox_workspace_write.writable_roots=["C:/root/.cache/demo"]');
    const review = sandboxArguments("workspace-write", "", true, "linux", "", "", { readOnly: true, writableRoots: ["/c"] });
    expect(review.slice(review.indexOf("--sandbox"), review.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(review.join(" ")).not.toContain("writable_roots");
    const isolated = sandboxArguments("isolated", "", false, "linux", "", "/private", { writableRoots: ["/root/.cache/demo"] });
    expect(isolated.find((a) => a.startsWith("permissions.codex_mcp_isolated.filesystem="))).toContain(`"/root/.cache/demo"='write',"/private"='deny'`);
    const isolatedReview = sandboxArguments("isolated", "", false, "linux", "", "", { readOnly: true, writableRoots: ["/c"] });
    const fsArg = isolatedReview.find((a) => a.startsWith("permissions.codex_mcp_isolated.filesystem="))!;
    expect(fsArg).toContain("':workspace_roots'={'.'='read'");
    expect(fsArg).not.toContain('"/c"');
  });
  it("refuses full access and weaker Windows implementations", () => {
    expect(() => sandboxArguments("danger-full-access", "mxc", true)).toThrow();
    expect(() => sandboxArguments("isolated", "unelevated", false)).toThrow();
  });
});
