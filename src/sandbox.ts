export type SandboxMode = "workspace-write" | "read-only" | "isolated";
export type WindowsSandbox = "mxc" | "elevated";

export function sandboxArguments(mode: string, backend: string, network: boolean, platform = process.platform, runtimeRoot = "", privateRoot = ""): string[] {
  if (!["workspace-write", "read-only", "isolated"].includes(mode)) throw new Error("Invalid CODEX_SANDBOX_MODE.");
  if (backend && !["mxc", "elevated"].includes(backend)) throw new Error("CODEX_WINDOWS_SANDBOX must be mxc or elevated.");
  const args = ["-c", "approval_policy=never"];
  if (mode === "isolated") {
    const filesystem = ["':minimal'='read'", "':workspace_roots'={'.'='write','.git'='read','.agents'='read','.codex'='read','.aws'='read'}", "':tmpdir'='deny'", "':slash_tmp'='deny'"];
    // Absolute path keys are TOML strings, never fragments supplied by an MCP caller.
    if (runtimeRoot) filesystem.push(`${JSON.stringify(runtimeRoot.replace(/\\/g, "/"))}='read'`);
    if (privateRoot) filesystem.push(`${JSON.stringify(privateRoot.replace(/\\/g, "/"))}='deny'`);
    args.push("-c", "default_permissions=codex_mcp_isolated",
      "-c", `permissions.codex_mcp_isolated.filesystem={${filesystem.join(",")}}`,
      // Node's default realpath walk stats denied drive ancestors before opening an allowed script.
      "-c", "shell_environment_policy.set={NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'}",
      "-c", `permissions.codex_mcp_isolated.network.enabled=${network}`);
  } else {
    args.push("--sandbox", mode, "-c", `sandbox_workspace_write.network_access=${network}`);
  }
  if (platform === "win32" && backend) args.push("-c", `windows.sandbox=${backend}`, "-c", "features.prefer_mxc=false");
  return args;
}
