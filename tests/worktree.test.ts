import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { normalizeWorktreeIsolation, pruneStale, WorkflowWorktreeManager } from "../src/worktree.js";

const execFileAsync = promisify(execFile);

test("WorkflowWorktreeManager creates, captures, and removes a clean worktree", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    const active = await new WorkflowWorktreeManager(repo).create({ mode: "worktree", rootDir });
    assert.ok(active);
    assert.ok(existsSync(active.path));

    await writeFile(join(active.path, "README.md"), "changed\n");
    const metadata = await active.finish(true);

    assert.equal(metadata.kept, false);
    assert.match(metadata.status, /M README\.md/);
    assert.match(metadata.diff, /changed/);
    assert.equal(existsSync(active.path), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager rejects dirty parents by default", async () => {
  const repo = await createRepo();
  try {
    await writeFile(join(repo, "README.md"), "dirty\n");
    await assert.rejects(
      () => new WorkflowWorktreeManager(repo).create({ mode: "worktree" }),
      /requires a clean parent repository/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager applies dirty patch state when requested", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    await writeFile(join(repo, "README.md"), "dirty tracked\n");
    await writeFile(join(repo, "notes.txt"), "untracked\n");

    const active = await new WorkflowWorktreeManager(repo).create({
      mode: "worktree",
      rootDir,
      dirty: "patch",
    });
    assert.ok(active);

    assert.equal(await readFile(join(active.path, "README.md"), "utf8"), "dirty tracked\n");
    assert.equal(await readFile(join(active.path, "notes.txt"), "utf8"), "untracked\n");

    const metadata = await active.finish(true);
    assert.match(metadata.status, /M README\.md/);
    assert.match(metadata.status, /\?\? notes\.txt/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager keeps worktrees on error when requested", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    const active = await new WorkflowWorktreeManager(repo).create({
      mode: "worktree",
      rootDir,
      keep: "onError",
    });
    assert.ok(active);

    const metadata = await active.finish(false);

    assert.equal(metadata.kept, true);
    assert.equal(existsSync(active.path), true);
    await execFileAsync("git", ["worktree", "remove", "--force", active.path], { cwd: repo });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager removes the worktree on a failing run by default", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    const active = await new WorkflowWorktreeManager(repo).create({ mode: "worktree", rootDir });
    assert.ok(active);
    assert.ok(existsSync(active.path));

    // A failing/aborted run still calls finish(false); default keep must remove.
    const metadata = await active.finish(false);

    assert.equal(metadata.kept, false);
    assert.equal(metadata.error, undefined);
    assert.equal(existsSync(active.path), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager keeps worktrees only for keep: 'onError' on success", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    const active = await new WorkflowWorktreeManager(repo).create({
      mode: "worktree",
      rootDir,
      keep: "onError",
    });
    assert.ok(active);

    // On success, keep: 'onError' must not retain the worktree.
    const metadata = await active.finish(true);

    assert.equal(metadata.kept, false);
    assert.equal(existsSync(active.path), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager deletes the created branch on cleanup with no dangling ref", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    const branch = "workflow-feature-x";
    const active = await new WorkflowWorktreeManager(repo).create({
      mode: "worktree",
      rootDir,
      branch,
    });
    assert.ok(active);
    assert.equal(await branchExists(repo, branch), true);

    const metadata = await active.finish(true);
    assert.equal(metadata.kept, false);
    assert.equal(existsSync(active.path), false);

    // No dangling ref remains after removal.
    assert.equal(await branchExists(repo, branch), false);
    const worktrees = await listWorktreePaths(repo);
    assert.equal(worktrees.includes(active.path), false, `worktree admin entry lingered: ${worktrees.join(", ")}`);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager reports cleanup failures via metadata.error", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    const active = await new WorkflowWorktreeManager(repo).create({ mode: "worktree", rootDir });
    assert.ok(active);

    // Make the parent dir read-only so both `git worktree remove` and the rm
    // fallback fail; the manager must surface that error rather than throw.
    await chmod(rootDir, 0o500);
    let metadata: Awaited<ReturnType<typeof active.finish>>;
    try {
      metadata = await active.finish(true);
    } finally {
      await chmod(rootDir, 0o700);
    }

    assert.equal(metadata.kept, false);
    assert.ok(metadata.error, "expected a cleanup error to be reported");
    assert.match(metadata.error ?? "", /cleanup failed/);
  } finally {
    await chmod(rootDir, 0o700).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("WorkflowWorktreeManager dirty: 'patch' reproduces the parent working tree across dirty states", async () => {
  const repo = await createRepo();
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-worktrees-"));

  try {
    // Seed extra tracked files that we will delete and rename in the dirty state.
    await writeFile(join(repo, "delete-me.txt"), "delete me\n");
    await writeFile(join(repo, "rename-me.txt"), "rename me\n");
    await execFileAsync("git", ["add", "delete-me.txt", "rename-me.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "add extra tracked files"], { cwd: repo });

    // Build a dirty-state matrix in the parent working tree.
    await writeFile(join(repo, "README.md"), "modified content\n"); // modified tracked
    await rm(join(repo, "delete-me.txt")); // deleted tracked
    await writeFile(join(repo, "staged.txt"), "staged content\n"); // staged new
    await execFileAsync("git", ["add", "staged.txt"], { cwd: repo });
    await writeFile(join(repo, "untracked.txt"), "untracked content\n"); // untracked
    await symlink("README.md", join(repo, "link")); // untracked symlink
    await execFileAsync("git", ["mv", "rename-me.txt", "renamed.txt"], { cwd: repo }); // renamed (staged)

    const active = await new WorkflowWorktreeManager(repo).create({
      mode: "worktree",
      rootDir,
      dirty: "patch",
    });
    assert.ok(active);

    // Working-tree content matches the parent for every supported dirty state.
    assert.equal(await readFile(join(active.path, "README.md"), "utf8"), "modified content\n");
    assert.equal(existsSync(join(active.path, "delete-me.txt")), false, "deletion should be reproduced");
    assert.equal(await readFile(join(active.path, "staged.txt"), "utf8"), "staged content\n");
    assert.equal(await readFile(join(active.path, "untracked.txt"), "utf8"), "untracked content\n");
    assert.equal(await readFile(join(active.path, "renamed.txt"), "utf8"), "rename me\n");
    assert.equal(existsSync(join(active.path, "rename-me.txt")), false, "rename source should be gone");

    // The untracked symlink is preserved as a symlink (not dereferenced).
    const linkStat = await lstat(join(active.path, "link"));
    assert.equal(linkStat.isSymbolicLink(), true);
    assert.equal(await readlink(join(active.path, "link")), "README.md");

    await active.finish(true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("normalizeWorktreeIsolation rejects dirty: 'patch' with a non-HEAD baseRef", () => {
  assert.throws(
    () =>
      normalizeWorktreeIsolation({
        mode: "worktree",
        dirty: "patch",
        baseRef: "main",
      }),
    /dirty: 'patch' requires baseRef: 'HEAD'/,
  );

  // HEAD baseRef (explicit or default) is accepted.
  assert.ok(normalizeWorktreeIsolation({ mode: "worktree", dirty: "patch" }));
  assert.ok(normalizeWorktreeIsolation({ mode: "worktree", dirty: "patch", baseRef: "HEAD" }));
});

test("pruneStale reaps orphaned workflow-* directories in the default root", async () => {
  const defaultRoot = resolve(join(tmpdir(), "pi-dynamic-workflows"));
  const unique = Math.random().toString(36).slice(2);

  // Orphan with no marker: eligible for reaping.
  const orphan = join(defaultRoot, `workflow-orphan-${unique}`);
  // Non-matching directory: must be left untouched.
  const unrelated = join(defaultRoot, `keepme-${unique}`);
  // Active-looking marker referencing this live process: must be preserved.
  const alive = join(defaultRoot, `workflow-alive-${unique}`);
  const aliveMarker = join(defaultRoot, ".active", `workflow-alive-${unique}.json`);

  try {
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "file.txt"), "orphan\n");
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, "file.txt"), "unrelated\n");
    await mkdir(alive, { recursive: true });
    await mkdir(join(defaultRoot, ".active"), { recursive: true });
    await writeFile(
      aliveMarker,
      JSON.stringify({
        pid: process.pid,
        repoRoot: defaultRoot,
        path: alive,
        createdBranch: false,
        keep: false,
        startedAt: Date.now(),
      }),
      "utf8",
    );

    assert.equal(existsSync(orphan), true);

    await pruneStale();

    assert.equal(existsSync(orphan), false, "orphaned workflow-* dir should be reaped");
    assert.equal(existsSync(unrelated), true, "non-workflow dirs must be left untouched");
    assert.equal(existsSync(alive), true, "worktrees for live processes must be preserved");
  } finally {
    await rm(orphan, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
    await rm(alive, { recursive: true, force: true });
    await rm(aliveMarker, { force: true });
  }
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "workflow-repo-"));
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Workflow Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["branch", "--list", branch], {
    cwd: repo,
    encoding: "utf8",
  });
  return stdout.trim().length > 0;
}

async function listWorktreePaths(repo: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}
