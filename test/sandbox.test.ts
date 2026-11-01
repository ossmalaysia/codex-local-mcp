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
  it("refuses full access and weaker Windows implementations", () => {
    expect(() => sandboxArguments("danger-full-access", "mxc", true)).toThrow();
    expect(() => sandboxArguments("isolated", "unelevated", false)).toThrow();
  });
});
