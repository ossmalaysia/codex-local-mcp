import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Local git projects that codex_task may work on, from CODEX_PROJECTS:
 *
 *   {"<name>": {"path": "<absolute clone>", "setup": "<cmd>", "checks": {"<check>": "<cmd>"}}}
 *
 * The desktop app writes exactly this shape. A malformed value must never stop
 * the server: it is reported, readably, by the two tools that need it.
 */

export interface Project {
  name: string;
  /** Absolute path to the user's clone. Never shown to callers. */
  path: string;
  setup?: string;
  checks: Record<string, string>;
}

export type ProjectConfig =
  | { ok: true; projects: Map<string, Project> }
  | { ok: false; error: string };

/** Project and check names become path segments and prompt labels. */
const NAME_CHARS = /^[A-Za-z0-9._-]{1,64}$/;
/** "." and ".." match the characters but would climb out as a path segment. */
export function validName(name: string): boolean {
  return NAME_CHARS.test(name) && name !== "." && name !== "..";
}

/**
 * Refs reach git as an argument. No leading "-" (an option), no ".." (a range
 * or a path climb), and no ":" or "+" (a refspec that writes local refs).
 */
const REF = /^[A-Za-z0-9._/-]{1,200}$/;

export class ProjectError extends Error {}

export function parseProjects(raw: string): ProjectConfig {
  if (!raw.trim()) return { ok: true, projects: new Map() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "CODEX_PROJECTS is not valid JSON." };
  }
  if (!isObject(value)) {
    return { ok: false, error: "CODEX_PROJECTS must be a JSON object of project names." };
  }
  const projects = new Map<string, Project>();
  // Sorted, here and for checks, so both implementations list them identically.
  for (const [name, entry] of Object.entries(value).sort(byKey)) {
    const fail = (why: string): ProjectConfig => ({
      ok: false,
      error: `CODEX_PROJECTS: project "${name.slice(0, 64)}" ${why}`,
    });
    if (!validName(name)) return fail("has an invalid name; use 1-64 letters, digits, '.', '_' or '-'.");
    if (!isObject(entry)) return fail("must be an object with a \"path\".");
    for (const key of Object.keys(entry)) {
      if (!["path", "setup", "checks"].includes(key)) return fail(`has an unknown field "${key}".`);
    }
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) {
      return fail("needs \"path\": an absolute path to a local git clone.");
    }
    if (entry.setup !== undefined && (typeof entry.setup !== "string" || !entry.setup.trim())) {
      return fail("has a \"setup\" that is not a non-empty string.");
    }
    const checks: Record<string, string> = {};
    if (entry.checks !== undefined) {
      if (!isObject(entry.checks)) return fail("has \"checks\" that is not an object of commands.");
      for (const [check, command] of Object.entries(entry.checks).sort(byKey)) {
        if (!validName(check)) return fail(`has an invalid check name "${check.slice(0, 64)}".`);
        if (typeof command !== "string" || !command.trim()) {
          return fail(`has check "${check}" whose command is not a non-empty string.`);
        }
        checks[check] = command;
      }
    }
    projects.set(name, {
      name,
      path: path.resolve(entry.path),
      setup: entry.setup as string | undefined,
      checks,
    });
  }
  return { ok: true, projects };
}

/** Code-unit order, which matches the Rust service's byte order for these ASCII names. */
function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parsed once: config is read once at import, so the value cannot change. */
let parsed: ProjectConfig | undefined;
export function loadProjects(): Map<string, Project> {
  parsed ??= parseProjects(config.projectsJson);
  if (!parsed.ok) throw new ProjectError(parsed.error);
  return parsed.projects;
}

export function validateRef(ref: string): void {
  if (!REF.test(ref) || ref.startsWith("-") || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new ProjectError(
      `Invalid ref "${ref.slice(0, 200)}": use a branch, tag or commit made of letters, digits and . _ / -, ` +
        "not starting with '-' and without '..'.",
    );
  }
}

/** Look up a project and its requested checks, failing before any job starts. */
export function resolveProject(name: string, checks: string[] = []): Project {
  const projects = loadProjects();
  const project = projects.get(name);
  if (!project) {
    const known = [...projects.keys()];
    throw new ProjectError(
      `Unknown project "${name.slice(0, 64)}". ` +
        (known.length ? `Configured projects: ${known.join(", ")}.` : "No projects are configured (CODEX_PROJECTS)."),
    );
  }
  for (const check of checks) {
    if (!Object.hasOwn(project.checks, check)) {
      const known = Object.keys(project.checks);
      throw new ProjectError(
        `Unknown check "${check.slice(0, 64)}" for project "${name}". ` +
          (known.length ? `Configured checks: ${known.join(", ")}.` : "This project has no checks configured."),
      );
    }
  }
  // Stated without the path: callers never learn where the clone lives.
  let isDir = false;
  try {
    isDir = fs.statSync(project.path).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDir) throw new ProjectError(`Project "${name}" points to a folder that does not exist on this computer.`);
  return project;
}

/** What codex_projects shows: names and capabilities, never local paths. */
export function describeProjects(): string {
  const projects = loadProjects();
  if (!projects.size) {
    return "No projects are configured. Add local git clones to CODEX_PROJECTS to use codex_task.";
  }
  return [...projects.values()]
    .map((p) => {
      const checks = Object.keys(p.checks);
      return [
        `project: ${p.name}`,
        `checks: ${checks.length ? checks.join(", ") : "(none)"}`,
        `setup: ${p.setup ? "defined" : "none"}`,
      ].join("\n");
    })
    .join("\n\n");
}
