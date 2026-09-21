import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Show a file to the human at the keyboard. MCP image blocks reach the model's
 * context but clients do not render them into the chat, so for a local server
 * the OS viewer is the only way the user actually sees the picture.
 *
 * Resolves to an error message rather than throwing: a child process reports a
 * failed launch through an asynchronous "error" event, which try/catch cannot
 * see and which would terminate this server if left unhandled.
 */
export function openInViewer(absPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let file: string;
    let args: string[];

    if (process.platform === "win32") {
      const comspec =
        process.env.ComSpec ||
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
      file = comspec;
      // The empty "" is start's title argument; without it a quoted path
      // becomes the window title and nothing opens.
      args = ["/d", "/s", "/c", `start "" "${absPath}"`];
    } else if (process.platform === "darwin") {
      file = "open";
      args = [absPath];
    } else {
      file = "xdg-open";
      args = [absPath];
    }

    let settled = false;
    const done = (result?: string) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: process.platform === "win32",
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        done(
          err.code === "ENOENT"
            ? `could not open a viewer: ${file} is not available on this system`
            : `could not open a viewer: ${err.message}`,
        );
      });
      child.on("spawn", () => {
        child.unref();
        done(undefined);
      });
    } catch (err) {
      done(err instanceof Error ? err.message : String(err));
    }
  });
}
