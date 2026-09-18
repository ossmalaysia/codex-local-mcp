import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Show a file to the human at the keyboard. MCP image blocks reach the model's
 * context but clients do not render them into the chat, so for a local server
 * the OS viewer is the only way the user actually sees the picture.
 */
export function openInViewer(absPath: string): string | undefined {
  try {
    if (process.platform === "win32") {
      const comspec =
        process.env.ComSpec ||
        path.join(process.env.SystemRoot || "C:\Windows", "System32", "cmd.exe");
      // The empty "" is start's title argument; without it a quoted path
      // becomes the window title and nothing opens.
      spawn(comspec, ["/d", "/s", "/c", `start "" "${absPath}"`], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
    } else {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(cmd, [absPath], { detached: true, stdio: "ignore" }).unref();
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
