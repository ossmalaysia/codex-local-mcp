/**
 * In-chat view for codex_generate_image (an MCP App).
 *
 * The host renders this in a sandboxed frame under the tool call and hands it
 * the tool result. Generated images arrive as image blocks and are shown here.
 * If the image is still being generated, the result says "status: running",
 * and the view collects it itself through codex_job_result, so the picture
 * appears in the chat whether or not the model polls.
 *
 * Everything from the result is inserted with textContent or as an <img> data
 * URI of an allowed type: filenames come from Codex and are never trusted as
 * markup.
 */
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import { parseToolResult, type ToolResultLike, type ViewState } from "./parse.js";

/** Each poll waits server-side for up to this long; under the 60s request limit. */
const POLL_WAIT_SEC = 40;
/** 45 polls of ~40s covers the server's 30-minute maximum Codex timeout. */
const MAX_POLLS = 45;

const root = document.getElementById("root")!;
const app = new App({ name: "Codex image viewer", version: "1.0.0" });
let following: string | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(state: ViewState): void {
  root.replaceChildren();

  if (state.kind === "running") {
    const box = el("div", "status");
    box.append(el("span", "spinner"), el("span", "", "Codex is generating the image"));
    if (state.elapsed) box.append(el("span", "muted", ` · ${state.elapsed}`));
    root.append(box);
    return;
  }

  if (state.isError) {
    root.append(el("div", "error", state.message ?? "Codex could not generate the image."));
  }

  for (const image of state.images) {
    const figure = el("figure");
    const img = el("img");
    img.src = image.src;
    img.alt = image.path;
    const caption = el("figcaption");
    caption.append(el("span", "path", image.path));
    if (image.detail) caption.append(el("span", "muted", image.detail));
    figure.append(img, caption);
    root.append(figure);
  }

  for (const note of state.notes) root.append(el("div", "note", note));

  if (!state.isError && state.images.length === 0) {
    root.append(el("div", "muted", "Codex finished without producing an image."));
  }
  if (state.workspace) root.append(el("div", "workspace", state.workspace));
}

/** Collect a running job's result, re-rendering as it progresses. */
async function follow(jobId: string): Promise<void> {
  if (following === jobId) return;
  following = jobId;

  for (let i = 0; i < MAX_POLLS; i++) {
    let result: ToolResultLike;
    try {
      result = (await app.callServerTool({
        name: "codex_job_result",
        arguments: { job_id: jobId, wait_sec: POLL_WAIT_SEC },
      })) as ToolResultLike;
    } catch (err) {
      render({
        kind: "done",
        isError: true,
        images: [],
        notes: [],
        message: `Lost contact while waiting for the image: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const state = parseToolResult(result);
    render(state);
    if (state.kind !== "running") return;
  }
  render({
    kind: "done",
    isError: true,
    images: [],
    notes: [],
    message: "Still running after 30 minutes. The image will appear in its workspace when Codex finishes.",
  });
}

function handle(result: ToolResultLike): void {
  const state = parseToolResult(result);
  render(state);
  if (state.kind === "running") void follow(state.jobId);
}

// Set before connect(), so the initial result is not missed.
app.ontoolresult = (result) => handle(result as ToolResultLike);

root.append(el("div", "muted", "Waiting for Codex…"));
void app.connect();
