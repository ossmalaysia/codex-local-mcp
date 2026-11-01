type Json = Record<string, any>;
declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(name: string, args?: Json): Promise<T> };
      event: {
        listen(
          name: string,
          callback: (event: { payload: any }) => void,
        ): Promise<unknown>;
      };
    };
  }
}
const invoke = <T = Json>(name: string, args?: Json) =>
  window.__TAURI__.core.invoke<T>(name, args);
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
let settings: Json = {},
  current: Json = {},
  loaded = false,
  openaiSignedIn = false,
  noticeTimer = 0,
  page = "workspace",
  running = false;
// The service rejects settings changes while the connection runs, so these
// pages are locked instead of failing on save.
const settingsPages = ["workspace", "accounts", "connection"];
const settingsButtons = ["browse", "generate-password", "cloudflare-create"];
function lockView() {
  $("locked-note").hidden = !running || !settingsPages.includes(page);
  for (const id of settingsPages)
    $(id)
      .querySelectorAll<HTMLInputElement>("input, select")
      .forEach((field) => (field.disabled = running));
  input("show-prompts").disabled = running;
  $("show-prompts-hint").textContent = running
    ? "Stop the connection to change this setting."
    : "Off by default. Prompts can contain private text. They show only in this window and are not saved. The change applies the next time you start the connection.";
  document
    .querySelectorAll<HTMLButtonElement>("[data-next]")
    .forEach((button) => {
      if (!button.hasAttribute("aria-busy"))
        button.textContent = running ? "Continue →" : "Save and continue →";
    });
  for (const id of settingsButtons) {
    const button = $<HTMLButtonElement>(id);
    if (!button.hasAttribute("aria-busy")) button.disabled = running;
  }
}
function notice(text: string, error = false) {
  $("notice").textContent = text;
  $("notice-bar").classList.toggle("error", error);
  $("notice-bar").hidden = false;
  // Errors stay until dismissed; confirmations clear themselves so they do
  // not linger above later, unrelated work.
  clearTimeout(noticeTimer);
  if (!error) noticeTimer = setTimeout(hideNotice, 8000);
}
function hideNotice() {
  clearTimeout(noticeTimer);
  $("notice-bar").hidden = true;
}
function show(name: string) {
  page = name;
  lockView();
  document
    .querySelectorAll<HTMLElement>(".page")
    .forEach((el) => (el.hidden = el.id !== name));
  document.querySelectorAll<HTMLElement>("nav button").forEach((el) => {
    const selected = el.dataset.page === name;
    el.classList.toggle("selected", selected);
    if (selected) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
  hideNotice();
}
// Checks every field before anything reaches the service, so a bad value is
// reported next to its field instead of as a backend error.
function validate() {
  const fields = document.querySelectorAll<HTMLInputElement>(
    "main input, main select",
  );
  for (const field of fields) {
    if (field.checkValidity()) continue;
    const page = field.closest<HTMLElement>(".page");
    if (page) show(page.id);
    const details = field.closest("details");
    if (details) details.open = true;
    field.reportValidity();
    field.focus();
    const label = document.querySelector(`label[for="${field.id}"]`);
    throw new Error(
      `${label?.textContent?.trim() ?? "A field"}: ${field.validationMessage}`,
    );
  }
}
async function action(button: HTMLButtonElement, work: () => Promise<void>) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const text = button.textContent;
  button.textContent = "Please wait…";
  try {
    await work();
  } catch (e) {
    notice(String(e), true);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = text;
    await refresh();
  }
}
function bind(id: string, work: () => Promise<void>) {
  const button = $<HTMLButtonElement>(id);
  button.addEventListener("click", () => void action(button, work));
}
const executionFields: Record<string, string> = {
  "task-model": "model",
  "task-reasoning": "reasoning_effort",
  "task-timeout": "timeout_sec",
  "image-count": "count",
  "image-size": "size",
  "image-quality": "quality",
  "image-format": "output_format",
  "image-compression": "output_compression",
  "image-background": "background",
  "image-budget": "target_file_kb",
};
const executionDefaults: Json = {
  model: "",
  reasoning_effort: "default",
  timeout_sec: 300,
  count: 1,
  size: "1024x1024",
  quality: "low",
  output_format: "jpeg",
  output_compression: 80,
  background: "opaque",
  target_file_kb: 256,
};
function executionData() {
  return Object.fromEntries(
    Object.entries(executionFields).map(([id, key]) => [
      key,
      input(id).type === "number" ? Number(input(id).value) : input(id).value,
    ]),
  );
}
function apply(s: Json) {
  settings = s;
  for (const [id, key] of Object.entries(executionFields))
    input(id).value = String(s.execution?.[key] ?? executionDefaults[key]);
  for (const [id, key] of Object.entries({
    folder: "workspace",
    username: "username",
    tunnel: "tunnel",
    "public-url": "publicUrl",
    backend: "backend",
    port: "port",
  }))
    input(id).value = String(s[key] ?? "");
  input("network").checked = !!s.network;
  input("show-prompts").checked = !!s.showPrompts;
  input("password").value = "";
  input("tunnel-token").value = "";
  $("password-state").textContent = s.passwordSaved
    ? "Password saved"
    : "Not set";
  $("token-state").textContent = s.tokenSaved
    ? "Tunnel token saved."
    : "No tunnel token saved.";
  $("saved-address-text").textContent = `Address saved: ${s.publicUrl}`;
  const addressSaved = !!s.publicUrl && !!s.tokenSaved;
  $("saved-address").hidden = !addressSaved;
  // A saved address is the normal case; keep the create form out of the way
  // until the user asks to change it.
  $("cloudflare-setup").hidden = addressSaved;
  $("change-address").hidden = false;
  $("generate-password").classList.toggle("primary", !s.passwordSaved);
  tunnelView();
}
function prefixPreview() {
  const select = $<HTMLSelectElement>("domain");
  const domain = select.selectedOptions[0]?.textContent ?? "";
  const prefix = input("prefix").value.trim().toLowerCase();
  $("prefix-preview").textContent =
    domain && prefix ? `Your address: https://${prefix}.${domain}` : "";
}
function tunnelView() {
  $("named").hidden = input("tunnel").value !== "named";
  $("tunnel-hint").textContent =
    input("tunnel").value === "named"
      ? "Use your saved address or sign in to Cloudflare to create one."
      : "A new temporary address is created each time you start.";
}
function data() {
  return {
    execution: executionData(),
    workspace: input("folder").value,
    username: input("username").value,
    password: input("password").value,
    tunnel: input("tunnel").value,
    tunnelToken: input("tunnel-token").value,
    publicUrl: input("public-url").value,
    backend: input("backend").value,
    network: input("network").checked,
    port: Number(input("port").value),
    showPrompts: input("show-prompts").checked,
  };
}
async function save() {
  // Fields are locked while running, so there is nothing new to save.
  if (running) return;
  validate();
  apply(await invoke("save_settings", { input: data() }));
}
function stepDone(step: string, connection: Json) {
  switch (step) {
    case "workspace":
      return !!settings.workspace;
    case "accounts":
      return openaiSignedIn && !!settings.passwordSaved;
    case "connection":
      return connection.connected === true;
    case "claude":
      // Claude has reached the server at least once.
      return !!connection.lastRequest;
    default:
      return false;
  }
}
function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
function badge(id: string, text: string, online: boolean) {
  $(id).textContent = text;
  $(id).classList.toggle("online", online);
}
function render(connection: Json) {
  running = !!connection.running;
  lockView();
  const online = connection.connected === true;
  badge("connection-badge", connection.status ?? "Stopped", online);
  badge("endpoint-state", online ? "Ready" : "Offline", online);
  badge("activity-status", connection.status ?? "Stopped", online);
  const endpoint =
    connection.endpoint ||
    (settings.tunnel === "named" && settings.publicUrl
      ? settings.publicUrl + "/mcp"
      : "");
  input("endpoint").value = endpoint;
  let endpointHint = "Start the connection to get your address.";
  if (endpoint)
    endpointHint =
      "Your saved address is shown. Start the connection before using it.";
  if (online) endpointHint = "Ready to connect in Claude.";
  $("endpoint-hint").textContent = endpointHint;
  $("claude-start").hidden = !!connection.running;
  $<HTMLButtonElement>("copy-url").disabled = !endpoint;
  for (const id of ["start", "claude-start"])
    $<HTMLButtonElement>(id).disabled =
      !!connection.running || $(id).hasAttribute("aria-busy");
  $<HTMLButtonElement>("stop").disabled =
    !connection.running || $("stop").hasAttribute("aria-busy");
  // Rendered every second, after action() re-enables its button, so a copy
  // button cannot stay enabled when there is no saved password to copy.
  for (const id of ["copy-password", "claude-copy-password"]) {
    const button = $<HTMLButtonElement>(id);
    if (!button.hasAttribute("aria-busy"))
      button.disabled = !settings.passwordSaved;
    button.title = settings.passwordSaved ? "" : "Save a password first";
  }
  document.querySelectorAll<HTMLElement>("nav button").forEach((el) => {
    const done = stepDone(el.dataset.page ?? "", connection);
    el.classList.toggle("done", done);
    const mark = el.querySelector(".done-mark");
    if (mark) mark.textContent = done ? "✓" : "";
    if (mark) mark.setAttribute("aria-label", done ? "done" : "");
  });
  const request = connection.lastRequest;
  $("last-request").textContent = request
    ? `Last request: ${request.action} · ${new Date(request.at * 1000).toLocaleTimeString()}`
    : "No requests yet.";
  const tasks: Array<Json> = connection.tasks ?? [];
  $("active-count").textContent = String(
    tasks.filter((t) => t.status === "running").length || "",
  );
  const container = $("tasks");
  if (!tasks.length) {
    cards.clear();
    const empty = document.createElement("div");
    empty.className = "card";
    empty.textContent =
      "No tasks yet. Send a Codex request from Claude to see its progress.";
    container.replaceChildren(empty);
    return;
  }
  const wanted = tasks.map(taskCard);
  for (const id of cards.keys())
    if (!tasks.some((t) => String(t.id) === id)) cards.delete(id);
  // Reattaching cards every second would reset the prompt's scroll position
  // and open state, so the list only changes when the tasks do.
  const unchanged =
    wanted.length === container.children.length &&
    wanted.every((card, i) => container.children[i] === card);
  if (!unchanged) container.replaceChildren(...wanted);
}
const phaseNames: Record<string, string> = {
  queued: "Waiting for the workspace",
  preparing: "Preparing the workspace",
  running: "Waiting for Codex",
  running_command: "Running a command",
  writing_files: "Saving files",
  collecting_files: "Collecting output files",
  generating_image: "Generating the image",
  thinking: "Planning the next step",
  searching: "Searching the web",
  using_tool: "Using a tool",
};
function line(text: string, className = "") {
  const p = document.createElement("p");
  p.textContent = text;
  p.className = className;
  return p;
}
function taskParameters(task: Json) {
  const opts = task.options ?? {};
  const params = [
    `Model: ${opts.model || "Codex default"}`,
    `Reasoning: ${opts.reasoning_effort || "default"}`,
    `Timeout: ${opts.timeout_sec ?? 300}s`,
  ];
  if (task.action === "codex_generate_image")
    params.push(
      `${opts.count ?? 1} image(s) · ${opts.size ?? "1024x1024"}`,
      `Generation: ${opts.quality ?? "low"}`,
      `File: ${opts.output_format ?? "jpeg"} · quality ${opts.output_compression ?? 80}`,
      `Background: ${opts.background ?? "opaque"}`,
      `Target: ${opts.target_file_kb ?? 256} KB`,
    );
  const chips = document.createElement("div");
  chips.className = "task-params";
  for (const value of params) {
    const chip = document.createElement("span");
    chip.textContent = value;
    chips.append(chip);
  }
  return chips;
}
function taskPhase(task: Json) {
  if (task.status === "completed") return "Task completed";
  if (task.status === "failed") return "Task failed";
  return phaseNames[task.phase] ?? "Waiting for progress";
}
const statusClass: Record<string, string> = {
  running: "busy",
  completed: "online",
  failed: "error",
};
type TaskView = {
  card: HTMLElement;
  heading: HTMLElement;
  body: HTMLElement;
  prompt?: HTMLElement;
};
const cards = new Map<string, TaskView>();
// The prompt never changes for a task, so it is built once and kept while the
// rest of the card refreshes.
function promptBlock(task: Json) {
  const text = String(task.prompt);
  const block = document.createElement("details");
  block.className = "task-prompt";
  block.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "Prompt sent by Claude";
  block.append(summary, line(text, "prompt-text"));
  if (task.promptTruncated)
    block.append(
      line(
        `Showing the first ${[...text].length} of ${task.promptChars} characters.`,
        "hint",
      ),
    );
  const copy = document.createElement("button");
  copy.className = "quiet";
  copy.textContent = "Copy prompt";
  copy.addEventListener(
    "click",
    () =>
      void action(copy, async () => {
        await navigator.clipboard.writeText(text);
        notice("Prompt copied.");
      }),
  );
  block.append(copy);
  return block;
}
function taskCard(task: Json) {
  const id = String(task.id);
  let view = cards.get(id);
  if (!view) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("div");
    heading.className = "card-head";
    const body = document.createElement("div");
    card.append(heading, body);
    view = { card, heading, body };
    cards.set(id, view);
  }
  if (task.prompt && !view.prompt) {
    view.prompt = promptBlock(task);
    view.heading.after(view.prompt);
  }
  fillTask(view.heading, view.body, task);
  return view.card;
}
function fillTask(heading: HTMLElement, card: HTMLElement, task: Json) {
  card.replaceChildren();
  const title = document.createElement("h2");
  title.textContent =
    task.action === "codex_generate_image" ? "Generate image" : "Codex task";
  const statusName = String(task.status ?? "running");
  const status = document.createElement("span");
  status.className = `badge ${statusClass[statusName] ?? ""}`;
  status.textContent = statusName[0].toUpperCase() + statusName.slice(1);
  heading.replaceChildren(title, status);
  const idle = Math.floor((task.idleMs ?? 0) / 1000);
  const phase = taskPhase(task);
  card.append(
    line(phase, "task-stage"),
    line(
      `Elapsed: ${duration(task.elapsedMs ?? 0)} · ${task.steps ?? 0} events completed`,
      "hint task-time",
    ),
  );
  if (task.status === "running")
    card.append(
      line(
        `Last Codex event: ${duration(task.idleMs ?? 0)} ago. ${idle >= 30 ? "No new event yet; the task is still running." : "Progress updates come from Codex events."}`,
        "hint",
      ),
    );
  card.append(taskParameters(task));
  const history = document.createElement("ol");
  history.className = "task-history";
  history.setAttribute("aria-label", "Task stages");
  for (const event of (task.history ?? []).slice(-8)) {
    const li = document.createElement("li");
    li.textContent = `${Math.floor(event.atMs / 1000)}s · ${phaseNames[event.phase] ?? "Codex event"}`;
    history.append(li);
  }
  if (history.childElementCount) card.append(history);
  if (task.files !== undefined)
    card.append(
      line(
        `Output files: ${task.files} · Exit code: ${task.exitCode ?? "unavailable"}`,
        "hint",
      ),
    );
  if (task.outputFiles?.length)
    for (const file of task.outputFiles) {
      const dimensions = file.width
        ? " · " + file.width + "×" + file.height
        : "";
      card.append(
        line(
          `${file.name} · ${(file.bytes / 1024).toFixed(1)} KB${dimensions}`,
          "hint",
        ),
      );
    }
  if (task.usage?.output_tokens !== undefined)
    card.append(
      line(
        `Tokens: ${task.usage.input_tokens ?? 0} input · ${task.usage.output_tokens} output`,
        "hint",
      ),
    );
  card.append(
    line(String(task.workspace ?? "").replace(/^\\\\\?\\/, ""), "task-path"),
  );
}
async function refresh() {
  try {
    current = await invoke("state");
    if (!loaded) {
      apply(current.settings);
      loaded = true;
      // Reopening the window from the tray while connected is about
      // watching work, not repeating setup.
      if (current.connection?.running) show("activity");
    }
    $("version").textContent = `Version ${current.version} · Rust`;
    render(current.connection);
    const update = current.update;
    $("install-update").hidden = !update;
    if (update)
      $("install-update").textContent = `Install version ${update.version}`;
  } catch (e) {
    if (!loaded) notice(String(e), true);
  }
}
async function account() {
  const value = await invoke("account_status");
  badge(
    "openai-state",
    value.signedIn ? "Signed in" : "Not signed in",
    value.signedIn,
  );
  openaiSignedIn = !!value.signedIn;
  let detail = "Sign in to use Codex. Your browser will open.";
  if (value.signedIn) detail = "Your OpenAI sign-in is saved.";
  if (value.signedIn && value.method === "apiKey")
    detail = "Signed in with an API key.";
  if (value.signedIn && value.email) detail = `Signed in as ${value.email}`;
  $("account-detail").textContent = detail;
  $("account-login").textContent = value.signedIn
    ? "Sign in with another account"
    : "Sign in to OpenAI";
}
function domains(value: Json) {
  badge(
    "cloudflare-state",
    value.signedIn ? "Signed in" : "Not signed in",
    value.signedIn,
  );
  const select = $<HTMLSelectElement>("domain");
  select.replaceChildren();
  for (const d of value.domains ?? []) {
    const option = document.createElement("option");
    option.value = d.id;
    option.textContent = d.name;
    select.append(option);
  }
  $("domain-fields").hidden = !value.signedIn || !select.options.length;
  $("cloudflare-login").textContent = value.signedIn
    ? "Sign in with another account"
    : "Sign in to Cloudflare";
  prefixPreview();
}
document
  .querySelectorAll<HTMLButtonElement>("[data-page]")
  .forEach((button) =>
    button.addEventListener("click", () => show(button.dataset.page!)),
  );
document.querySelectorAll<HTMLButtonElement>("[data-next]").forEach((button) =>
  button.addEventListener(
    "click",
    () =>
      void action(button, async () => {
        await save();
        show(button.dataset.next!);
      }),
  ),
);
input("tunnel").addEventListener("change", tunnelView);
input("prefix").addEventListener("input", prefixPreview);
input("domain").addEventListener("change", prefixPreview);
$("notice-close").addEventListener("click", hideNotice);
input("show-prompts").addEventListener("change", async () => {
  try {
    await save();
    notice(
      input("show-prompts").checked
        ? "Prompts will show in Activity after you start the connection."
        : "Prompts will stay hidden after you start the connection.",
    );
  } catch (e) {
    input("show-prompts").checked = !!settings.showPrompts;
    notice(String(e), true);
  }
});
bind("locked-stop", async () => {
  await invoke("stop_connection");
  notice("Connection stopped. You can change settings now.");
});
$("change-address").addEventListener("click", () => {
  $("cloudflare-setup").hidden = false;
  $("change-address").hidden = true;
});
bind("browse", async () => {
  const folder = await invoke<string | null>("plugin:dialog|open", {
    options: {
      directory: true,
      multiple: false,
      title: "Choose a workspace folder",
    },
  });
  if (folder) input("folder").value = folder;
});
bind("open-workspace", async () => {
  await save();
  await invoke("open_workspace");
});
bind("sandbox-check", async () => {
  await save();
  await invoke("sandbox_check");
  notice(
    "Sandbox check passed. Codex can write only within the allowed workspace.",
  );
});
bind("account-status", account);
bind("account-login", async () => {
  notice("Complete sign-in in your browser.");
  await invoke("account_login");
  await account();
  notice("OpenAI sign-in saved.");
});
bind("generate-password", async () => {
  await save();
  apply(await invoke("generate_password"));
  notice(
    "Secure password generated and saved. Use Copy saved password when Claude asks.",
  );
});
for (const id of ["copy-password", "claude-copy-password"])
  bind(id, async () => {
    await invoke("copy_password");
    notice("Saved password copied to the clipboard.");
  });
bind("cloudflare-status", async () =>
  domains(await invoke("cloudflare_status")),
);
bind("cloudflare-login", async () => {
  notice("Complete Cloudflare sign-in in your browser.");
  domains(await invoke("cloudflare_login"));
  notice("Cloudflare sign-in saved.");
});
bind("cloudflare-create", async () => {
  await save();
  apply(
    await invoke("cloudflare_create", {
      zone: input("domain").value,
      prefix: input("prefix").value.trim().toLowerCase(),
    }),
  );
  notice("Your custom address is saved. You can start the connection.");
});
async function start() {
  await save();
  await invoke("start_connection");
  notice(
    "Checking isolation and starting the connection. Watch Activity for progress.",
  );
}
bind("start", start);
bind("claude-start", start);
bind("stop", async () => {
  await invoke("stop_connection");
  notice("Connection stopped.");
});
bind("copy-url", async () => {
  await navigator.clipboard.writeText(input("endpoint").value);
  notice("MCP server URL copied.");
});
bind("open-claude", async () => {
  await invoke("open_claude");
  notice("Claude settings opened in your browser.");
});
function updateResult(value: Json) {
  notice(
    value.available
      ? `Version ${value.update.version} is available. Select Install update to continue.`
      : "You have the latest version.",
  );
}
bind("check-update", async () => updateResult(await invoke("check_update")));
bind("install-update", async () => {
  notice(
    "Downloading and verifying the signed update. Setup will open when it is ready.",
  );
  await invoke("install_update");
});
void window.__TAURI__.event.listen("update-check", (event) => {
  updateResult(event.payload);
  void refresh();
});
void window.__TAURI__.event.listen("update-error", (event) =>
  notice(String(event.payload), true),
);
void window.__TAURI__.event.listen("update-progress", (event) => {
  const { received, total } = event.payload;
  if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
    notice(
      `Downloading update: ${Math.floor((received * 100) / total)}% (${(received / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB).`,
    );
  }
});
async function loadAccount() {
  try {
    await account();
  } catch (e) {
    $("openai-state").textContent = "Check sign-in";
    $("account-detail").textContent = String(e);
  }
}
async function loadCloudflare() {
  try {
    domains(await invoke("cloudflare_status"));
  } catch {
    $("cloudflare-state").textContent = "Sign-in unavailable";
  }
}
await refresh();
void loadAccount();
void loadCloudflare();
setInterval(() => void refresh(), 1000);
export {};
