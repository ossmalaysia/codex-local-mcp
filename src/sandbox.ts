export type SandboxMode = "workspace-write" | "read-only" | "isolated";
export type WindowsSandbox = "mxc" | "elevated";

export interface SandboxOverrides {
  /** Codex may read the workspace but write nothing (codex_task review mode). */
  readOnly?: boolean;
  /** Extra absolute folders Codex may write to, such as a package cache. */
  writableRoots?: string[];
}

/** Absolute paths become TOML strings; never fragments supplied by an MCP caller. */
const tomlPath = (p: string) => JSON.stringify(p.replace(/\\/g, "/"));

export function sandboxArguments(mode: string, backend: string, network: boolean, platform = process.platform, runtimeRoot = "", privateRoot = "", overrides: SandboxOverrides = {}): string[] {
  if (!["workspace-write", "read-only", "isolated"].includes(mode)) throw new Error("Invalid CODEX_SANDBOX_MODE.");
  if (backend && !["mxc", "elevated"].includes(backend)) throw new Error("CODEX_WINDOWS_SANDBOX must be mxc or elevated.");
  const args = ["-c", "approval_policy=never"];
  if (mode === "isolated") {
    const workspace = overrides.readOnly ? "read" : "write";
    const filesystem = ["':minimal'='read'", `':workspace_roots'={'.'='${workspace}','.git'='read','.agents'='read','.codex'='read','.aws'='read'}`, "':tmpdir'='deny'", "':slash_tmp'='deny'"];
    if (runtimeRoot) filesystem.push(`${tomlPath(runtimeRoot)}='read'`);
    if (!overrides.readOnly) for (const root of overrides.writableRoots ?? []) filesystem.push(`${tomlPath(root)}='write'`);
    if (privateRoot) filesystem.push(`${tomlPath(privateRoot)}='deny'`);
    args.push("-c", "default_permissions=codex_mcp_isolated",
      "-c", `permissions.codex_mcp_isolated.filesystem={${filesystem.join(",")}}`,
      // Node's default realpath walk stats denied drive ancestors before opening an allowed script.
      "-c", "shell_environment_policy.set={NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'}",
      "-c", `permissions.codex_mcp_isolated.network.enabled=${network}`);
  } else {
    args.push("--sandbox", overrides.readOnly ? "read-only" : mode, "-c", `sandbox_workspace_write.network_access=${network}`);
    const roots = overrides.readOnly ? [] : overrides.writableRoots ?? [];
    if (roots.length) args.push("-c", `sandbox_workspace_write.writable_roots=[${roots.map(tomlPath).join(",")}]`);
  }
  if (platform === "win32" && backend) args.push("-c", `windows.sandbox=${backend}`, "-c", "features.prefer_mxc=false");
  return args;
}
