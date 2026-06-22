import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkflowWorktreeManager } from "../src/worktree.js";

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
