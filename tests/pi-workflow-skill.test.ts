import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = join(repoRoot, "skills", "pi-workflow-creator");
const validator = join(skillRoot, "scripts", "validate-workflow.mjs");

test("pi workflow creator examples and templates pass the bundled validator", async () => {
  const files = [
    ...(await jsFiles(join(skillRoot, "assets", "examples"))),
    ...(await jsFiles(join(skillRoot, "assets", "templates"))),
  ];

  assert.ok(files.length > 0, "expected workflow examples or templates");
  for (const file of files) {
    const { stdout } = await execFileAsync(process.execPath, [validator, file], { encoding: "utf8" });
    assert.match(stdout, /ok - /, `${file} did not pass validator`);
  }
});

test("pi workflow creator skill keeps broad model-selection guidance", async () => {
  const body = await readFile(join(skillRoot, "SKILL.md"), "utf8");

  assert.match(body, /opencode-go\/deepseek-v4-flash/);
  assert.match(body, /opencode-go\/kimi-k2\.7-code/);
  assert.match(body, /opencode-go\/minimax-m3/);
  assert.match(body, /opencode-go\/glm-5\.2/);
  assert.match(body, /anthropic\/claude-opus-4-8/);
  assert.match(body, /openai-codex\/gpt-5\.5/);
});

async function jsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js")).map((entry) => join(dir, entry.name));
}
