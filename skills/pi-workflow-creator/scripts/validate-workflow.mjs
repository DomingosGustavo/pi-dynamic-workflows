#!/usr/bin/env node
import { readFileSync } from "node:fs";

const MAX_REVIEWABLE_BYTES = 524_288;

let parse;
try {
  ({ parse } = await import("acorn"));
} catch (error) {
  console.error("cannot load the 'acorn' parser required by this validator.");
  console.error("install it first, e.g. `npm install` in the pi-dynamic-workflows package.");
  console.error(`details: ${messageOf(error)}`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node validate-workflow.mjs <workflow-file.js>");
  process.exit(1);
}

let source = "";
try {
  source = readFileSync(file, "utf8");
} catch (error) {
  console.error(`cannot read ${file}: ${messageOf(error)}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const INVALID_LITERAL = Symbol("invalid literal");

let ast;
try {
  ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  });
} catch (error) {
  errors.push(`JavaScript parse failed: ${messageOf(error)}`);
}

if (Buffer.byteLength(source, "utf8") > MAX_REVIEWABLE_BYTES) {
  warnings.push("script is over 512 KB; keep workflow scripts small enough for human review");
}

if (ast) validateAst(ast);

for (const warning of warnings) console.log(`warn  ${warning}`);
for (const error of errors) console.log(`ERROR ${error}`);

if (errors.length > 0) {
  console.log(`${errors.length} error(s) in ${file}`);
  process.exit(1);
}

console.log(`ok - ${file} passes${warnings.length ? ` with ${warnings.length} warning(s)` : ""}`);

function validateAst(program) {
  // Conservative, non-scope-aware resolution: this is a lint, not an interpreter.
  // Only `const` declarations bound to an object literal are resolvable, and only
  // when the name is declared exactly once and never reassigned/mutated/deleted.
  const constObjects = new Map();
  const declarationCounts = new Map();
  const mutatedNames = new Set();

  function recordNamedFunctionOrClass(node) {
    if (node.id?.type === "Identifier") {
      declarationCounts.set(node.id.name, (declarationCounts.get(node.id.name) ?? 0) + 1);
    }
  }

  function recordFunctionParams(node) {
    for (const param of node.params) {
      for (const name of boundIdentifiers(param)) {
        declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
      }
    }
  }

  walk(program, {
    VariableDeclarator(node, parent) {
      for (const name of boundIdentifiers(node.id)) {
        declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
      }
      if (parent?.kind === "const" && node.init?.type === "ObjectExpression" && node.id?.type === "Identifier") {
        constObjects.set(node.id.name, node.init);
      }
    },
    FunctionDeclaration(node) {
      recordNamedFunctionOrClass(node);
      recordFunctionParams(node);
    },
    FunctionExpression(node) {
      recordNamedFunctionOrClass(node);
      recordFunctionParams(node);
    },
    ClassDeclaration: recordNamedFunctionOrClass,
    ClassExpression: recordNamedFunctionOrClass,
    ArrowFunctionExpression: recordFunctionParams,
    CatchClause(node) {
      if (node.param) {
        for (const name of boundIdentifiers(node.param)) {
          declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
        }
      }
    },
    AssignmentExpression(node) {
      const name = rootIdentifierName(node.left);
      if (name) {
        mutatedNames.add(name);
      } else {
        for (const bound of mutatedRootNamesInPattern(node.left)) {
          if (bound) mutatedNames.add(bound);
        }
      }
    },
    UpdateExpression(node) {
      const name = rootIdentifierName(node.argument);
      if (name) mutatedNames.add(name);
    },
    UnaryExpression(node) {
      if (node.operator === "delete") {
        const name = rootIdentifierName(node.argument);
        if (name) mutatedNames.add(name);
      }
    },
  });

  const optionObjects = {
    resolve(name) {
      if (mutatedNames.has(name)) return undefined;
      if ((declarationCounts.get(name) ?? 0) !== 1) return undefined;
      return constObjects.get(name);
    },
  };

  const first = program.body[0];
  if (first?.type !== "ExportNamedDeclaration") {
    errors.push("first statement must be `export const meta = { ... }`");
  } else {
    validateMetaExport(first);
  }

  let agentCalls = 0;
  walk(program, {
    ImportDeclaration(node) {
      errors.push(`static imports are not part of the workflow surface at line ${line(node)}`);
    },
    ImportExpression(node) {
      warnings.push(`dynamic import at line ${line(node)} should usually be moved into an agent prompt`);
    },
    CallExpression(node) {
      const calleeName = callName(node.callee);
      if (calleeName === "agent") {
        agentCalls += 1;
        validateAgentCall(node, optionObjects);
      }
      if (calleeName === "require") {
        warnings.push(`require() at line ${line(node)} is not available in the workflow orchestrator`);
      }
      if (calleeName === "parallel") validateParallelCall(node);
      if (calleeName === "Date.now" || calleeName === "Math.random") {
        warnings.push(`${calleeName} at line ${line(node)} makes review/retry behavior less repeatable`);
      }
    },
    NewExpression(node) {
      if (callName(node.callee) === "Date" && node.arguments.length === 0) {
        warnings.push(`argless new Date() at line ${line(node)} makes review/retry behavior less repeatable`);
      }
    },
    MemberExpression(node) {
      const name = memberName(node);
      if (name?.startsWith("process.") && name !== "process.cwd") {
        warnings.push(`${name} at line ${line(node)} is outside the safe process.cwd() shim`);
      }
    },
  });

  if (agentCalls === 0) errors.push("workflow must call agent() at least once");
}

function validateMetaExport(node) {
  const declaration = node.declaration;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    errors.push("meta export must be `export const meta = { ... }`");
    return;
  }
  if (declaration.declarations.length !== 1) {
    errors.push("meta export must declare only `meta`");
    return;
  }

  const declarator = declaration.declarations[0];
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    errors.push("meta export must declare the identifier `meta`");
    return;
  }
  if (declarator.init?.type !== "ObjectExpression") {
    errors.push("meta must be an object literal");
    return;
  }

  const meta = literalObject(declarator.init, "meta");
  if (!meta) return;
  if (typeof meta.name !== "string" || !meta.name.trim()) errors.push("meta.name must be a non-empty string");
  if (typeof meta.description !== "string" || !meta.description.trim()) {
    errors.push("meta.description must be a non-empty string");
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") {
    errors.push("meta.whenToUse must be a string when present");
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) {
      errors.push("meta.phases must be an array when present");
    } else {
      for (const [index, phase] of meta.phases.entries()) {
        if (!phase || typeof phase !== "object" || typeof phase.title !== "string") {
          errors.push(`meta.phases[${index}] must have a title string`);
        }
      }
    }
  }
}

function literalObject(node, path) {
  const object = {};
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      errors.push(`spread is not allowed in ${path}`);
      return null;
    }
    if (property.type !== "Property" || property.computed || property.kind !== "init" || property.method) {
      errors.push(`only plain literal properties are allowed in ${path}`);
      return null;
    }
    const key = literalKey(property.key);
    if (!key) {
      errors.push(`unsupported key in ${path} at line ${line(property)}`);
      return null;
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      errors.push(`reserved key ${key} is not allowed in ${path}`);
      return null;
    }
    const value = literalValue(property.value, `${path}.${key}`);
    if (value === INVALID_LITERAL) return null;
    object[key] = value;
  }
  return object;
}

function literalValue(node, path) {
  if (node.type === "Literal") return node.value;
  if (node.type === "ObjectExpression") return literalObject(node, path);
  if (node.type === "ArrayExpression") {
    const values = [];
    for (const [index, element] of node.elements.entries()) {
      if (!element || element.type === "SpreadElement") {
        errors.push(`sparse arrays and spreads are not allowed in ${path}`);
        return INVALID_LITERAL;
      }
      const value = literalValue(element, `${path}[${index}]`);
      if (value === INVALID_LITERAL) return INVALID_LITERAL;
      values.push(value);
    }
    return values;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal") {
    return -node.argument.value;
  }
  errors.push(`non-literal value in ${path} at line ${line(node)}`);
  return INVALID_LITERAL;
}

function literalKey(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  return null;
}

function validateAgentCall(node, optionObjects) {
  const optsArg = node.arguments[1];

  if (node.arguments.length < 2) {
    errors.push(`agent() at line ${line(node)} must pass an options object with model or job`);
    return;
  }

  // Data-driven fan-outs commonly pass `item.options`. The member's value cannot
  // be proven here, but rejecting it would make bundled/runtime-validated inputs unusable.
  if (optsArg?.type === "MemberExpression") {
    warnings.push(
      `agent() options at line ${line(node)} cannot be statically verified; the runtime requires model or job`,
    );
    return;
  }

  const status = optionStatus(optsArg, optionObjects, new Set());
  if (status === "present") return;
  if (status === "spread-verified") {
    warnings.push(
      `agent() options at line ${line(node)} cannot be statically verified; the runtime requires model or job`,
    );
    return;
  }
  if (status === "missing") {
    errors.push(`agent() options at line ${line(node)} must include model or job`);
    return;
  }
  errors.push(`agent() options at line ${line(node)} cannot be statically verified to include model or job`);
}

function optionStatus(node, optionObjects, resolving) {
  if (node?.type === "Identifier") {
    if (resolving.has(node.name)) return "indeterminate";
    const resolved = optionObjects.resolve(node.name);
    if (!resolved) return "indeterminate";
    resolving.add(node.name);
    const status = optionStatus(resolved, optionObjects, resolving);
    resolving.delete(node.name);
    return status;
  }
  if (node?.type !== "ObjectExpression") return "indeterminate";

  const hasModelOrJob = node.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      !property.shorthand &&
      property.kind === "init" &&
      (literalKey(property.key) === "model" || literalKey(property.key) === "job"),
  );
  if (hasModelOrJob) return "present";

  const spreads = node.properties.filter((property) => property.type === "SpreadElement");
  if (spreads.length === 0) return "missing";
  const verifiedSpread = spreads.some((spread) => {
    const status = optionStatus(spread.argument, optionObjects, resolving);
    return status === "present" || status === "spread-verified";
  });
  return verifiedSpread ? "spread-verified" : "indeterminate";
}

function validateParallelCall(node) {
  const firstArg = node.arguments[0];
  if (!firstArg) return;

  // parallel([ agent(...), agent(...) ]) — literal array of bare agent() calls.
  if (firstArg.type === "ArrayExpression") {
    for (const element of firstArg.elements) {
      if (!element) continue;
      if (element.type === "CallExpression" && callName(element.callee) === "agent") {
        warnings.push(`parallel() at line ${line(node)} appears to contain bare agent() calls; pass thunks`);
      }
    }
    return;
  }

  // parallel(items.map(item => agent(...))) — the classic antipattern. The .map()
  // callback must RETURN a thunk (() => agent(...)), not a started agent() promise.
  if (firstArg.type === "CallExpression" && memberName(firstArg.callee)?.endsWith(".map")) {
    const callback = firstArg.arguments[0];
    if (callbackReturnsBareAgent(callback)) {
      warnings.push(
        `parallel() at line ${line(node)} maps to bare agent() calls; return a thunk instead: items.map(item => () => agent(...))`,
      );
    }
  }
}

function callbackReturnsBareAgent(node) {
  if (!node || (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression")) {
    return false;
  }
  const returned = returnedExpression(node);
  return returned?.type === "CallExpression" && callName(returned.callee) === "agent";
}

function returnedExpression(fn) {
  // Arrow with an expression body: item => <expr>
  if (fn.type === "ArrowFunctionExpression" && fn.body?.type !== "BlockStatement") {
    return fn.body;
  }
  // Block body: find a single top-level `return <expr>`.
  const body = fn.body?.type === "BlockStatement" ? (fn.body.body ?? []) : [];
  for (const statement of body) {
    if (statement.type === "ReturnStatement") return statement.argument ?? null;
  }
  return null;
}

function walk(node, visitors) {
  const visit = (current, parent) => {
    visitors[current.type]?.(current, parent);
    for (const value of Object.values(current)) {
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") visit(child, current);
        }
      } else if (value && typeof value.type === "string") {
        visit(value, current);
      }
    }
  };
  visit(node, null);
}

function callName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return memberName(node);
  return null;
}

function rootIdentifierName(node) {
  // Walk down member expressions and optional chains to the base identifier:
  // `opts`, `opts.model`, `opts.a.b`, `opts[x]`, `opts?.a` all root at `opts`.
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ChainExpression") return rootIdentifierName(node.expression);
  if (node.type === "MemberExpression") return rootIdentifierName(node.object);
  return null;
}

function boundIdentifiers(pattern) {
  const names = [];
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        names.push(node.name);
        break;
      case "ObjectPattern":
        for (const property of node.properties) {
          if (property.type === "Property") visit(property.value);
          else if (property.type === "RestElement") visit(property.argument);
        }
        break;
      case "ArrayPattern":
        for (const element of node.elements) visit(element);
        break;
      case "AssignmentPattern":
        visit(node.left);
        break;
      case "RestElement":
        visit(node.argument);
        break;
    }
  };
  visit(pattern);
  return names;
}

function mutatedRootNamesInPattern(pattern) {
  const names = [];
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
      case "MemberExpression":
        names.push(rootIdentifierName(node));
        break;
      case "ObjectPattern":
        for (const property of node.properties) {
          if (property.type === "Property") visit(property.value);
          else if (property.type === "RestElement") visit(property.argument);
        }
        break;
      case "ArrayPattern":
        for (const element of node.elements) visit(element);
        break;
      case "AssignmentPattern":
        visit(node.left);
        break;
      case "RestElement":
        visit(node.argument);
        break;
    }
  };
  visit(pattern);
  return names;
}

function memberName(node) {
  const object = callName(node.object);
  const property =
    node.property?.type === "Identifier"
      ? node.property.name
      : node.property?.type === "Literal"
        ? String(node.property.value)
        : null;
  return object && property ? `${object}.${property}` : null;
}

function line(node) {
  return node.loc?.start?.line ?? "?";
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
