import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowModelCatalog, selectWorkflowModel, workflowJobTypes } from "../src/model-selection.js";

const catalog = parseWorkflowModelCatalog({
  version: 2,
  work: {
    review: [
      { model: "vendor/first", thinkingLevel: "high" },
      { model: "vendor/second", thinkingLevel: "low" },
    ],
    inspection: [{ model: "vendor/fast" }],
  },
});

test("parses v2 work catalogs and sorts job types", () => {
  assert.deepEqual(workflowJobTypes(catalog), ["inspection", "review"]);
});

test("rejects invalid catalog shapes", () => {
  assert.throws(() => parseWorkflowModelCatalog({ version: 1, work: {} }), /unsupported model catalog version 1/);
  assert.throws(() => parseWorkflowModelCatalog({ version: 2, work: {} }), /at least one work type/);
  assert.throws(() => parseWorkflowModelCatalog({ version: 2, work: { x: [] } }), /at least one candidate/);
  assert.throws(() => parseWorkflowModelCatalog({ version: 2, work: { x: [{ model: "invalid" }] } }), /provider\/id/);
  assert.throws(
    () => parseWorkflowModelCatalog({ version: 2, work: { x: [{ model: "a/b", thinkingLevel: "huge" }] } }),
    /invalid thinkingLevel/,
  );
  assert.throws(
    () => parseWorkflowModelCatalog({ version: 2, work: { x: [{ model: "a/b" }, { model: "a/b" }] } }),
    /duplicate model/,
  );
});

test("selects the first available candidate and reports considered models", () => {
  const selected = selectWorkflowModel(catalog, "review", [{ provider: "vendor", id: "second" }]);
  assert.deepEqual(selected, {
    model: "vendor/second",
    thinkingLevel: "low",
    job: "review",
    considered: ["vendor/first", "vendor/second"],
    reason: "job review; first available candidate",
  });
});

test("rejects unknown and unavailable work types clearly", () => {
  assert.throws(
    () => selectWorkflowModel(catalog, "missing", []),
    /Unknown workflow job type "missing"\. Known types: inspection, review/,
  );
  assert.throws(
    () => selectWorkflowModel(catalog, "constructor", []),
    /Unknown workflow job type "constructor"\. Known types: inspection, review/,
  );
  assert.throws(() => selectWorkflowModel(catalog, "review", []), /considered: vendor\/first, vendor\/second/);
  assert.throws(() => selectWorkflowModel(catalog, "", []), /non-empty string/);
});
