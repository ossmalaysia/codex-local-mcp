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
  loaded = false;
function notice(text: string, error = false) {
  const el = $("notice");
  el.textContent = text;
  el.classList.toggle("error", error);
  el.hidden = false;
}
function show(name: string) {
  document
    .querySelectorAll<HTMLElement>(".page")
    .forEach((el) => (el.hidden = el.id !== name));
  document
    .querySelectorAll<HTMLElement>("nav button")
    .forEach((el) => el.classList.toggle("selected", el.dataset.page === name));
  $("notice").hidden = true;
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
  input("password").value = "";
  input("tunnel-token").value = "";
  $("password-state").textContent = s.passwordSaved
    ? "Password saved"
    : "Not set";
  $("token-state").textContent = s.tokenSaved
    ? "Tunnel token saved."
    : "No tunnel token saved.";
  $("saved-address").textContent = `Address saved: ${s.publicUrl}`;
  $("saved-address").hidden = !s.publicUrl || !s.tokenSaved;
  tunnelView();
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
  };
}
async function save() {
  apply(await invoke("save_settings", { input: data() }));
}
function badge(id: string, text: string, online: boolean) {
  $(id).textContent = text;
  $(id).classList.toggle("online", online);
}
function render(connection: Json) {
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
  let endpointHint = "Start the connection in step 3 to get your address.";
  if (endpoint)
    endpointHint =
      "Your saved address is shown. Start the connection before using it.";
  if (online) endpointHint = "Ready to connect in Claude.";
  $("endpoint-hint").textContent = endpointHint;
  $<HTMLButtonElement>("copy-url").disabled = !endpoint;
  $<HTMLButtonElement>("start").disabled =
    !!connection.running || $("start").hasAttribute("aria-busy");
  $<HTMLButtonElement>("stop").disabled =
    !connection.running || $("stop").hasAttribute("aria-busy");
  const request = connection.lastRequest;
  $("last-request").textContent = request
    ? `Last request: ${request.action} · ${new Date(request.at * 1000).toLocaleTimeString()}`
    : "No requests yet.";
  const tasks: Array<Json> = connection.tasks ?? [];
  $("active-count").textContent = String(
    tasks.filter((t) => t.status === "running").length || "",
  );
  const container = $("tasks");
  container.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "card";
    empty.textContent =
      "No tasks yet. Send a Codex request from Claude to see its progress.";
    container.append(empty);
  }
  for (const task of tasks) container.append(taskCard(task));
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
function taskCard(task: Json) {
  const card = document.createElement("article");
  card.className = "card";
  const heading = document.createElement("div");
  heading.className = "card-head";
  const title = document.createElement("h2");
  title.textContent =
    task.action === "codex_generate_image" ? "Generate image" : "Codex task";
  const status = document.createElement("span");
  status.className = "badge";
  status.textContent = task.status ?? "running";
  heading.append(title, status);
  const elapsed = Math.floor((task.elapsedMs ?? 0) / 1000),
    idle = Math.floor((task.idleMs ?? 0) / 1000);
  const phase = taskPhase(task);
  card.append(
    heading,
    line(phase, "task-stage"),
    line(
      `Elapsed: ${elapsed} seconds · ${task.steps ?? 0} events completed`,
      "hint task-time",
    ),
  );
  if (task.status === "running")
    card.append(
      line(
        `Last Codex event: ${idle} seconds ago. ${idle >= 30 ? "No new event yet; the task is still running." : "Progress updates come from Codex events."}`,
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
  return card;
}
async function refresh() {
  try {
    current = await invoke("state");
    if (!loaded) {
      apply(current.settings);
      loaded = true;
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
bind("start", async () => {
  await save();
  await invoke("start_connection");
  notice(
    "Checking isolation and starting the connection. Watch Activity for progress.",
  );
});
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
