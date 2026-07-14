import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("validator rejects agent() calls missing model and job", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-workflow-skill-test-"));
  const invalidWorkflow = join(tmpDir, "missing-model-or-job.workflow.js");
  await writeFile(
    invalidWorkflow,
    `export const meta = { name: "missing_model_or_job", description: "invalid test workflow" };
await agent("Do something with no options.");
`,
    "utf8",
  );

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(process.execPath, [validator, invalidWorkflow], { encoding: "utf8" });
    stdout = result.stdout;
  } catch (err) {
    assert.ok(err instanceof Error, "expected an Error");
    // execFile sets code, stdout, stderr as properties on the error object.
    const execErr = err as Error & { code?: number; stdout?: string; stderr?: string };
    exitCode = execErr.code ?? -1;
    stdout = execErr.stdout ?? "";
    stderr = execErr.stderr ?? "";
  }

  assert.notEqual(exitCode, 0, `validator should exit non-zero; stdout=${stdout} stderr=${stderr}`);
  const output = `${stdout}\n${stderr}`;
  assert.match(output, /agent\(\) at line \d+ must pass an options object with model or job/);
});

test("validator rejects an undeclared agent options identifier", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "unknown_options", description: "invalid test workflow" };
await agent("x", someUndeclaredIdentifier);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator accepts a referenced options object with model", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "referenced_options", description: "valid test workflow" };
const options = { label: "worker", model: "provider/model" };
await agent("x", options);
`);

  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /ok - /);
});

test("validator rejects a referenced options object missing model and job", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "invalid_referenced_options", description: "invalid test workflow" };
const options = { label: "worker" };
await agent("x", options);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ must include model or job/);
});

test("validator rejects a let-declared agent options identifier", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "let_options", description: "invalid test workflow" };
let opts = { model: "x/y" };
await agent("x", opts);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator rejects a const options object mutated after declaration", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "mutated_options", description: "invalid test workflow" };
const opts = { model: "x/y" };
opts.model = undefined;
await agent("x", opts);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator rejects a shadowed const options declaration", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "shadowed_options", description: "invalid test workflow" };
{
  const opts = { model: "x/y" };
  void opts;
}
{
  const opts = { label: "worker" };
  await agent("x", opts);
}
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator accepts a single const options object with job", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "const_job_options", description: "valid test workflow" };
const opts = { job: "review" };
await agent("x", opts);
`);

  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /ok - /);
});

test("validator rejects options shadowed by a function parameter", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "param_shadow", description: "invalid test workflow" };
const opts = { model: "provider/model" };
function run(opts) {
  agent("x", opts);
}
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator rejects options shadowed by a function declaration name", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "function_decl_shadow", description: "invalid test workflow" };
const opts = { model: "x/y" };
function run() {
  function opts() {}
}
await agent("x", opts);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator rejects options shadowed by a class declaration name", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "class_decl_shadow", description: "invalid test workflow" };
const opts = { model: "x/y" };
function run() {
  class opts {}
}
await agent("x", opts);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator rejects options mutated by optional-chain delete", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "optional_delete", description: "invalid test workflow" };
const opts = { job: "review" };
delete opts?.job;
await agent("x", opts);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator rejects options mutated by destructuring assignment", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "destructure_assign", description: "invalid test workflow" };
const opts = { job: "review" };
({ job: opts.job } = {});
await agent("x", opts);
`);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /agent\(\) options at line \d+ cannot be statically verified to include model or job/);
});

test("validator accepts a valid options object when a destructuring declaration exists elsewhere", async () => {
  const result = await validateTemporaryWorkflow(`
export const meta = { name: "destructure_decl_elsewhere", description: "valid test workflow" };
const { a, b } = args;
const opts = { model: "provider/model" };
await agent("x", opts);
`);

  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /ok - /);
});

async function validateTemporaryWorkflow(source: string): Promise<{ exitCode: number; output: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-workflow-skill-test-"));
  const workflow = join(tmpDir, "options.workflow.js");
  await writeFile(workflow, source, "utf8");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [validator, workflow], { encoding: "utf8" });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (err) {
    assert.ok(err instanceof Error, "expected an Error");
    const execErr = err as Error & { code?: number; stdout?: string; stderr?: string };
    return { exitCode: execErr.code ?? -1, output: `${execErr.stdout ?? ""}\n${execErr.stderr ?? ""}` };
  }
}

async function jsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js")).map((entry) => join(dir, entry.name));
}
