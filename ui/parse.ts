/**
 * Turns a codex_generate_image / codex_job_result tool result into what the
 * in-chat view should show. Pure and DOM-free so it can be unit-tested.
 *
 * It reads the same text the server writes for the model (see formatTask and
 * runningResult in src/server.ts), so the two must stay in step.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResultLike {
  content?: ContentBlock[];
  isError?: boolean;
}

export interface ViewImage {
  /** A data: URI, only ever for an allowed raster image type. */
  src: string;
  /** Workspace-relative path of the file. */
  path: string;
  /** Extra detail, such as "preview 1280px q80 ...". */
  detail?: string;
}

export type ViewState =
  | { kind: "running"; jobId: string; workspace?: string; elapsed?: string }
  | {
      kind: "done";
      isError: boolean;
      images: ViewImage[];
      /** Lines worth showing the user, such as a size mismatch. */
      notes: string[];
      workspace?: string;
      /** Set when the call failed: the error, for display. */
      message?: string;
    };

/**
 * Only raster types an <img> can show. A data: URI of any other type is never
 * built, whatever the result claims, so the view cannot be made to load
 * something like data:text/html.
 */
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function allText(result: ToolResultLike): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function line(text: string, prefix: string): string | undefined {
  const match = new RegExp(`^${prefix}: (.+)$`, "m").exec(text);
  return match?.[1].trim();
}

/** "Image: output/cat.png (preview 1280px ...)" -> path and detail. */
function parseLabel(text: string): { path: string; detail?: string } {
  const body = text.replace(/^Image: /, "");
  const open = body.indexOf(" (");
  if (open === -1 || !body.endsWith(")")) return { path: body };
  return { path: body.slice(0, open), detail: body.slice(open + 2, -1) };
}

export function parseToolResult(result: ToolResultLike): ViewState {
  const text = allText(result);

  const jobId = line(text, "job_id");
  if (jobId && /^status: running$/m.test(text)) {
    return {
      kind: "running",
      jobId,
      workspace: line(text, "workspace"),
      elapsed: line(text, "elapsed"),
    };
  }

  const images: ViewImage[] = [];
  let pendingLabel: { path: string; detail?: string } | undefined;
  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text?.startsWith("Image: ")) {
      pendingLabel = parseLabel(block.text);
    } else if (block.type === "image" && block.data && block.mimeType) {
      if (SAFE_IMAGE_TYPES.has(block.mimeType)) {
        images.push({
          src: `data:${block.mimeType};base64,${block.data}`,
          path: pendingLabel?.path ?? "image",
          detail: pendingLabel?.detail,
        });
      }
      pendingLabel = undefined;
    }
  }

  const notes = text
    .split("\n")
    .filter((l) => l.startsWith("Note: ") || l.startsWith("could not open a viewer"));

  const isError = result.isError === true;
  return {
    kind: "done",
    isError,
    images,
    notes,
    workspace: line(text, "workspace"),
    message: isError ? text.replace(/^Error: /, "").split("\n")[0] : undefined,
  };
}
