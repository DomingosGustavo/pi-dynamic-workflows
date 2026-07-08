import { execFile, execFileSync, spawn } from "node:child_process";
import { rmSync, unlinkSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkflowWorktreeMetadata, WorktreeIsolation } from "./options.js";

const execFileAsync = promisify(execFile);

const WORKTREE_TMP_ROOT = "pi-dynamic-workflows";
const WORKTREE_PREFIX = "workflow-";
const ACTIVE_MARKER_DIR = ".active";

interface NormalizedWorktreeIsolation {
  mode: "worktree";
  baseRef: string;
  rootDir?: string;
  branch?: string;
  keep: boolean | "onError";
  dirty: "fail" | "ignore" | "patch";
  merge: "none";
}

interface WorktreeCleanupRecord {
  repoRoot?: string;
  path: string;
  branch?: string;
  createdBranch: boolean;
  keep: boolean | "onError";
  markerPath?: string;
}

interface ActiveWorktreeMarker {
  pid: number;
  repoRoot: string;
  path: string;
  branch?: string;
  createdBranch: boolean;
  keep: boolean | "onError";
  startedAt: number;
}

export interface ActiveWorkflowWorktree {
  path: string;
  cwd: string;
  finish(success: boolean): Promise<WorkflowWorktreeMetadata>;
}

const activeWorktrees = new Set<WorktreeCleanupRecord>();
let processCleanupHooksInstalled = false;

export class WorkflowWorktreeManager {
  constructor(private readonly cwd: string) {}

  async create(isolation: WorktreeIsolation | undefined): Promise<ActiveWorkflowWorktree | undefined> {
    const options = normalizeWorktreeIsolation(isolation);
    if (!options) return undefined;

    const repoRoot = await gitOutput(this.cwd, ["rev-parse", "--show-toplevel"]);
    const relativeCwd = relative(repoRoot, this.cwd);
    if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
      throw new Error(`workflow worktree cwd must be inside a Git repository: ${this.cwd}`);
    }

    const dirtyStatus = await gitOutput(repoRoot, ["status", "--porcelain"]);
    if (dirtyStatus && options.dirty === "fail") {
      throw new Error("workflow worktree isolation requires a clean parent repository; use dirty: 'ignore' or 'patch'");
    }

    const worktreePath = await createWorktreePath(options.rootDir);
    let cleanupRecord: WorktreeCleanupRecord | undefined;
    try {
      const { createdBranch } = await addWorktree(repoRoot, worktreePath, options);
      cleanupRecord = {
        repoRoot,
        path: worktreePath,
        branch: options.branch,
        createdBranch,
        keep: options.keep,
        markerPath: activeMarkerPath(worktreePath),
      };
      await registerActiveWorktree(cleanupRecord);
      if (dirtyStatus && options.dirty === "patch") {
        await applyParentPatch(repoRoot, worktreePath);
        await copyUntrackedFiles(repoRoot, worktreePath);
      }
    } catch (error) {
      if (cleanupRecord) {
        await cleanupWorktree(cleanupRecord);
        await unregisterActiveWorktree(cleanupRecord);
      } else await rm(worktreePath, { recursive: true, force: true });
      throw error;
    }

    const effectiveCwd = join(worktreePath, relativeCwd);
    return {
      path: worktreePath,
      cwd: effectiveCwd,
      finish: async (success: boolean) => {
        const status = await safeGitOutput(worktreePath, ["status", "--short"]);
        const diff = await safeGitOutput(worktreePath, ["diff", "--binary", "HEAD"]);
        const kept = options.keep === true || (options.keep === "onError" && !success);
        const metadata: WorkflowWorktreeMetadata = {
          path: worktreePath,
          cwd: effectiveCwd,
          kept,
          status,
          diff,
        };

        if (!kept) {
          const cleanupError = await cleanupWorktree(cleanupRecord);
          if (cleanupError) metadata.error = cleanupError;
        }
        await unregisterActiveWorktree(cleanupRecord);

        return metadata;
      },
    };
  }
}

export async function pruneStale(): Promise<void> {
  const root = defaultWorktreeRoot();
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORKTREE_PREFIX)) continue;
    const worktreePath = join(root, entry.name);
    if (isActiveWorktreePath(worktreePath)) continue;

    const markerPath = activeMarkerPath(worktreePath);
    const marker = markerPath ? await readActiveMarker(markerPath) : undefined;
    if (marker && isProcessAlive(marker.pid)) continue;
    if (marker && marker.keep !== false) {
      await removeActiveMarker(markerPath);
      continue;
    }

    const repoRoot = marker?.repoRoot ?? (await repoRootFromWorktree(worktreePath));
    const cleanupRecord: WorktreeCleanupRecord = {
      repoRoot,
      path: worktreePath,
      branch: marker?.branch,
      createdBranch: marker?.createdBranch ?? false,
      keep: marker?.keep ?? false,
      markerPath,
    };
    await cleanupWorktree(cleanupRecord);
    await removeActiveMarker(markerPath);
  }
}

// Semantic validation for worktree isolation lives here. workflow.ts's optionalIsolation
// only shape-checks untrusted script input and should not duplicate these rules.
export function normalizeWorktreeIsolation(
  isolation: WorktreeIsolation | undefined,
): NormalizedWorktreeIsolation | undefined {
  if (!isolation || isolation === "none") return undefined;
  if (isolation === "worktree") {
    return { mode: "worktree", baseRef: "HEAD", keep: false, dirty: "fail", merge: "none" };
  }
  if (isolation.mode !== "worktree") throw new Error("agent isolation mode must be 'worktree'");
  if (isolation.merge && isolation.merge !== "none") {
    throw new Error("workflow worktree isolation currently supports only merge: 'none'");
  }
  const baseRef = isolation.baseRef ?? "HEAD";
  const dirty = isolation.dirty ?? "fail";
  if (dirty === "patch" && baseRef !== "HEAD") {
    throw new Error("workflow worktree isolation dirty: 'patch' requires baseRef: 'HEAD'");
  }
  return {
    mode: "worktree",
    baseRef,
    rootDir: isolation.rootDir,
    branch: isolation.branch,
    keep: isolation.keep ?? false,
    dirty,
    merge: isolation.merge ?? "none",
  };
}

async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  options: NormalizedWorktreeIsolation,
): Promise<{ createdBranch: boolean }> {
  const args = ["worktree", "add"];
  if (options.branch) args.push("-b", options.branch);
  else args.push("--detach");
  args.push(worktreePath, options.baseRef);
  await execFileAsync("git", args, { cwd: repoRoot });
  return { createdBranch: Boolean(options.branch) };
}

async function createWorktreePath(rootDir: string | undefined): Promise<string> {
  const root = resolve(rootDir ?? defaultWorktreeRoot());
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, WORKTREE_PREFIX));
}

async function applyParentPatch(repoRoot: string, worktreePath: string): Promise<void> {
  const diff = await gitRawOutput(repoRoot, ["diff", "--binary", "HEAD"]);
  if (!diff.trim()) return;
  try {
    await execWithInput("git", ["apply", "--whitespace=nowarn"], diff, worktreePath);
  } catch {
    await execWithInput("git", ["apply", "--3way", "--whitespace=nowarn"], diff, worktreePath);
  }
}

async function copyUntrackedFiles(repoRoot: string, worktreePath: string): Promise<void> {
  const output = await gitOutput(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  // Submodule contents are not mirrored; this copies only untracked paths reported by the parent repository.
  for (const file of output.split("\0").filter(Boolean)) {
    try {
      const from = join(repoRoot, file);
      const to = join(worktreePath, file);
      const sourceStat = await lstat(from);
      await mkdir(dirname(to), { recursive: true });
      if (sourceStat.isSymbolicLink()) {
        await rm(to, { force: true });
        await symlink(await readlink(from), to);
      } else if (sourceStat.isFile()) {
        await copyFile(from, to);
      }
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      throw error;
    }
  }
}

async function cleanupWorktree(record: WorktreeCleanupRecord | undefined): Promise<string | undefined> {
  if (!record) return undefined;
  const errors: string[] = [];
  let removed = false;

  if (record.repoRoot) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", record.path], { cwd: record.repoRoot });
      removed = true;
    } catch (error) {
      errors.push(`git worktree remove failed: ${errorMessage(error)}`);
      try {
        await rm(record.path, { recursive: true, force: true });
        removed = true;
      } catch (rmError) {
        errors.push(`rm fallback failed: ${errorMessage(rmError)}`);
      }
    }
  } else {
    try {
      await rm(record.path, { recursive: true, force: true });
      removed = true;
    } catch (error) {
      errors.push(`rm failed: ${errorMessage(error)}`);
    }
  }

  if (record.repoRoot && removed && record.createdBranch && record.branch) {
    try {
      await execFileAsync("git", ["branch", "-D", record.branch], { cwd: record.repoRoot });
    } catch (error) {
      errors.push(`git branch -D ${record.branch} failed: ${errorMessage(error)}`);
    }
  }

  return errors.length > 0 ? `cleanup failed: ${errors.join("; ")}` : undefined;
}

async function registerActiveWorktree(record: WorktreeCleanupRecord): Promise<void> {
  activeWorktrees.add(record);
  installProcessCleanupHooks();
  if (!record.markerPath || !record.repoRoot) return;
  const marker: ActiveWorktreeMarker = {
    pid: process.pid,
    repoRoot: record.repoRoot,
    path: record.path,
    branch: record.branch,
    createdBranch: record.createdBranch,
    keep: record.keep,
    startedAt: Date.now(),
  };
  try {
    await mkdir(dirname(record.markerPath), { recursive: true });
    await writeFile(record.markerPath, JSON.stringify(marker), "utf8");
  } catch {
    // Marker files are best-effort; process hooks still protect this process.
  }
}

async function unregisterActiveWorktree(record: WorktreeCleanupRecord | undefined): Promise<void> {
  if (!record) return;
  activeWorktrees.delete(record);
  await removeActiveMarker(record.markerPath);
}

async function removeActiveMarker(markerPath: string | undefined): Promise<void> {
  if (!markerPath) return;
  try {
    await unlink(markerPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function readActiveMarker(markerPath: string): Promise<ActiveWorktreeMarker | undefined> {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Partial<ActiveWorktreeMarker>;
    if (typeof marker.pid !== "number" || typeof marker.repoRoot !== "string") return undefined;
    return {
      pid: marker.pid,
      repoRoot: marker.repoRoot,
      path: typeof marker.path === "string" ? marker.path : dirname(markerPath),
      branch: typeof marker.branch === "string" ? marker.branch : undefined,
      createdBranch: marker.createdBranch === true,
      keep: marker.keep === true || marker.keep === "onError" ? marker.keep : false,
      startedAt: typeof marker.startedAt === "number" ? marker.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function installProcessCleanupHooks(): void {
  if (processCleanupHooksInstalled) return;
  processCleanupHooksInstalled = true;
  process.once("SIGINT", () => {
    cleanupActiveWorktreesSync();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanupActiveWorktreesSync();
    process.exit(143);
  });
  process.once("exit", () => {
    cleanupActiveWorktreesSync();
  });
}

function cleanupActiveWorktreesSync(): void {
  for (const record of [...activeWorktrees]) {
    activeWorktrees.delete(record);
    if (record.keep !== false) {
      removeActiveMarkerSync(record.markerPath);
      continue;
    }
    cleanupWorktreeSync(record);
    removeActiveMarkerSync(record.markerPath);
  }
}

function cleanupWorktreeSync(record: WorktreeCleanupRecord): void {
  let removed = false;
  if (record.repoRoot) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", record.path], { cwd: record.repoRoot, stdio: "ignore" });
      removed = true;
    } catch {
      try {
        rmSync(record.path, { recursive: true, force: true });
        removed = true;
      } catch {
        // Best-effort cleanup during process teardown.
      }
    }
  } else {
    try {
      rmSync(record.path, { recursive: true, force: true });
      removed = true;
    } catch {
      // Best-effort cleanup during process teardown.
    }
  }

  if (record.repoRoot && removed && record.createdBranch && record.branch) {
    try {
      execFileSync("git", ["branch", "-D", record.branch], { cwd: record.repoRoot, stdio: "ignore" });
    } catch {
      // Best-effort cleanup during process teardown.
    }
  }
}

function removeActiveMarkerSync(markerPath: string | undefined): void {
  if (!markerPath) return;
  try {
    unlinkSync(markerPath);
  } catch {
    // Best-effort cleanup during process teardown.
  }
}

function activeMarkerPath(worktreePath: string): string | undefined {
  const root = defaultWorktreeRoot();
  const relativePath = relative(root, worktreePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || dirname(relativePath) !== ".") {
    return undefined;
  }
  return join(root, ACTIVE_MARKER_DIR, `${basename(worktreePath)}.json`);
}

function isActiveWorktreePath(worktreePath: string): boolean {
  for (const record of activeWorktrees) {
    if (record.path === worktreePath) return true;
  }
  return false;
}

function defaultWorktreeRoot(): string {
  return resolve(join(tmpdir(), WORKTREE_TMP_ROOT));
}

async function repoRootFromWorktree(worktreePath: string): Promise<string | undefined> {
  try {
    const dotGit = await readFile(join(worktreePath, ".git"), "utf8");
    const gitdir = dotGit.match(/^gitdir: (.+)$/m)?.[1];
    if (!gitdir) return undefined;
    const absoluteGitdir = resolve(worktreePath, gitdir);
    return dirname(dirname(dirname(absoluteGitdir)));
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await gitRawOutput(cwd, args)).trimEnd();
}

async function gitRawOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  return stdout;
}

async function safeGitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    return await gitOutput(cwd, args);
  } catch (error) {
    return `git ${args.join(" ")} failed: ${errorMessage(error)}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function execWithInput(command: string, args: string[], input: string, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}
