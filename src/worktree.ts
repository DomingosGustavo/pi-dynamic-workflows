import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkflowWorktreeMetadata, WorktreeIsolation } from "./options.js";

const execFileAsync = promisify(execFile);

interface NormalizedWorktreeIsolation {
  mode: "worktree";
  baseRef: string;
  rootDir?: string;
  branch?: string;
  keep: boolean | "onError";
  dirty: "fail" | "ignore" | "patch";
  merge: "none";
}

export interface ActiveWorkflowWorktree {
  path: string;
  cwd: string;
  finish(success: boolean): Promise<WorkflowWorktreeMetadata>;
}

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
    try {
      await addWorktree(repoRoot, worktreePath, options);
      if (dirtyStatus && options.dirty === "patch") {
        await applyParentPatch(repoRoot, worktreePath);
        await copyUntrackedFiles(repoRoot, worktreePath);
      }
    } catch (error) {
      await rm(worktreePath, { recursive: true, force: true });
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
          try {
            await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
          } catch (error) {
            metadata.error = `cleanup failed: ${errorMessage(error)}`;
            await rm(worktreePath, { recursive: true, force: true });
          }
        }

        return metadata;
      },
    };
  }
}

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
  return {
    mode: "worktree",
    baseRef: isolation.baseRef ?? "HEAD",
    rootDir: isolation.rootDir,
    branch: isolation.branch,
    keep: isolation.keep ?? false,
    dirty: isolation.dirty ?? "fail",
    merge: isolation.merge ?? "none",
  };
}

async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  options: NormalizedWorktreeIsolation,
): Promise<void> {
  const args = ["worktree", "add"];
  if (options.branch) args.push("-b", options.branch);
  else args.push("--detach");
  args.push(worktreePath, options.baseRef);
  await execFileAsync("git", args, { cwd: repoRoot });
}

async function createWorktreePath(rootDir: string | undefined): Promise<string> {
  const root = resolve(rootDir ?? join(tmpdir(), "pi-dynamic-workflows"));
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "workflow-"));
}

async function applyParentPatch(repoRoot: string, worktreePath: string): Promise<void> {
  const diff = await gitRawOutput(repoRoot, ["diff", "--binary", "HEAD"]);
  if (!diff.trim()) return;
  await execWithInput("git", ["apply", "--whitespace=nowarn"], diff, worktreePath);
}

async function copyUntrackedFiles(repoRoot: string, worktreePath: string): Promise<void> {
  const output = await gitOutput(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of output.split("\0").filter(Boolean)) {
    const from = join(repoRoot, file);
    const to = join(worktreePath, file);
    const sourceStat = await stat(from);
    if (!sourceStat.isFile()) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
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
