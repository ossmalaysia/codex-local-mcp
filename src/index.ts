#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { readArtifact, imageMimeType, uriToPath } from "./artifacts.js";
import { openInViewer } from "./open.js";
import { executeTask, imagePromptTemplate, taskFailed, type TaskResult } from "./task.js";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; annotations?: Record<string, unknown> }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string;
      description?: string;
    };

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function formatTask(result: TaskResult) {
  const { artifacts } = result;
  const header = [
    `workspace: ${result.workspace}`,
    `exit code: ${result.exitCode ?? "n/a"}${result.signal ? ` (killed by ${result.signal})` : ""}${
      result.timedOut ? " (TIMED OUT - process killed)" : ""
    }`,
    `duration: ${(result.durationMs / 1000).toFixed(1)}s`,
  ].join("\n");

  const fileList = artifacts.files.length
    ? artifacts.files
        .map(
          (f) =>
            `- ${f.path} (${f.bytes} bytes)${f.inlined ? " [shown below]" : ""}${
              f.note ? ` - ${f.note}` : ""
            }`,
        )
        .join("\n")
    : "(none)";

  const content: Content[] = [
    {
      type: "text",
      text: `${header}\n\n--- codex output ---\n${result.output}\n\n--- files created or changed ---\n${fileList}${
        artifacts.truncated ? "\n(file list truncated)" : ""
      }`,
    },
  ];
  for (const image of artifacts.images) {
    content.push({
      type: "text",
      text: image.note ? `Image: ${image.path} (${image.note})` : `Image: ${image.path}`,
    });
    content.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
      annotations: { audience: ["user", "assistant"], priority: 0.9 },
    });
  }

  // Full-resolution files are referenced, not embedded. A client that supports
  // resource links can fetch them on demand via resources/read.
  for (const link of artifacts.links) {
    content.push({
      type: "resource_link",
      uri: link.uri,
      name: link.name,
      mimeType: link.mimeType,
      description: link.description,
    });
  }

  return { content, isError: taskFailed(result) };
}

const server = new McpServer({ name: "codex-local-mcp", version: "0.1.0" });

server.registerTool(
  "codex_run",
  {
    title: "Run a task with the local Codex CLI",
    description:
      "Hand a natural-language task to the local Codex CLI coding agent. Codex can write and run " +
      "code, install packages and call APIs inside an isolated workspace folder, then this returns " +
      "its output plus any files it created. Blocking: it does not return until Codex finishes.",
    inputSchema: {
      prompt: z.string().min(1).describe("The task for Codex, written as you would to a developer."),
      workspace: z
        .string()
        .optional()
        .describe(
          "Relative workspace folder name under the workspace root. Reuse the same name to " +
            "continue working on the same files. Defaults to a new timestamped folder.",
        ),
      timeout_sec: z
        .number()
        .optional()
        .describe(`Seconds before Codex is killed. Default ${config.defaultTimeoutSec}.`),
      model: z.string().optional().describe("Override the Codex model for this run."),
    },
  },
  async (args) => {
    try {
      return formatTask(await executeTask(args));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "codex_generate_image",
  {
    title: "Generate images via the local Codex CLI",
    description:
      "Generate images with the local Codex CLI. The prompt is passed through as written. Returns " +
      "the saved file paths and shows the images inline, downscaling a preview when a file is too " +
      "large to inline. Defaults to a fast low-quality 1024x1024 draft; raise quality for final assets.",
    inputSchema: {
      prompt: z.string().min(1).describe("What the image should depict."),
      count: z.number().int().min(1).max(10).optional().describe("How many images. Default 1."),
      size: z
        .string()
        .optional()
        .describe(
          'Pixel size, e.g. "1024x1024" (fastest, the default), "1536x1024" landscape, ' +
            '"1024x1536" portrait, "2048x2048", "3840x2160".',
        ),
      quality: z
        .enum(["low", "medium", "high", "auto"])
        .optional()
        .describe(
          'Generation quality. Default "low" - fastest, good for drafts. Use "high" for final assets.',
        ),
      workspace: z.string().optional().describe("Workspace folder name. Defaults to a new folder."),
      timeout_sec: z.number().optional().describe("Seconds before Codex is killed."),
      open: z
        .boolean()
        .optional()
        .describe(
          "Open the generated images in the user's default image viewer. Default true, because " +
            "MCP clients do not render tool-result images into the chat.",
        ),
    },
  },
  async (args) => {
    try {
      const result = await executeTask({
        prompt: imagePromptTemplate(
          args.prompt,
          args.count ?? 1,
          args.size ?? "1024x1024",
          args.quality ?? "low",
        ),
        workspace: args.workspace,
        timeout_sec: args.timeout_sec,
      });

      const response = formatTask(result);
      if (args.open !== false) {
        const opened: string[] = [];
        const failures: string[] = [];
        for (const file of result.artifacts.files) {
          if (!imageMimeType(file.path)) continue;
          const failure = await openInViewer(path.join(result.workspace, file.path));
          if (failure) failures.push(failure);
          else opened.push(file.path);
        }
        if (opened.length) {
          response.content.push({
            type: "text",
            text: `Opened in the default image viewer: ${opened.join(", ")}`,
          });
        }
        if (failures.length) {
          response.content.push({ type: "text", text: failures[0] });
        }
      }
      return response;
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "codex_read_artifact",
  {
    title: "Read a file produced by Codex",
    description:
      "Read one file from a Codex workspace, for artifacts that were too large to inline. " +
      "Images come back as image content, everything else as text.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Path to the file, relative to the workspace root or absolute inside it."),
      max_bytes: z.number().optional().describe("Refuse files larger than this. Default 5000000."),
    },
  },
  async (args) => {
    try {
      const file = await readArtifact(args.path, args.max_bytes ?? 5_000_000);
      const content: Content[] = [
        { type: "text", text: `${file.absPath} (${file.bytes} bytes)` },
      ];
      if (file.base64 && file.mimeType?.startsWith("image/")) {
        content.push({ type: "image", data: file.base64, mimeType: file.mimeType });
      } else if (file.base64) {
        content.push({
          type: "text",
          text: `Binary file (${file.mimeType}); fetch it via its resource link to get the bytes.`,
        });
      } else {
        content.push({ type: "text", text: file.text ?? "" });
      }
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

/**
 * Serve workspace files as MCP resources so the resource_link blocks returned
 * by the tools can actually be fetched, instead of the caller needing the file
 * pasted into the response. Reads are confined to the workspace root by
 * readArtifact, exactly like codex_read_artifact.
 */
server.registerResource(
  "workspace-file",
  new ResourceTemplate("file:///{+path}", { list: undefined }),
  {
    title: "Codex workspace file",
    description:
      "A file produced by Codex inside the workspace root. Reads outside the root are refused.",
  },
  async (uri) => {
    // fileURLToPath handles drive letters, POSIX roots and percent-encoding.
    // Hand-stripping the leading slash turns an absolute POSIX path into a
    // relative one, which then resolves under the root twice over.
    const target = uriToPath(uri.href);
    const file = await readArtifact(target, 50_000_000);
    return {
      contents: [
        file.base64 && file.mimeType
          ? { uri: uri.href, mimeType: file.mimeType, blob: file.base64 }
          : { uri: uri.href, mimeType: "text/plain", text: file.text ?? "" },
      ],
    };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stdout is the MCP transport; anything human-facing must go to stderr.
  console.error(`codex-local-mcp ready (root: ${config.root}, bin: ${config.codexBin})`);
}

main().catch((err) => {
  console.error("codex-local-mcp failed to start:", err);
  process.exit(1);
});
