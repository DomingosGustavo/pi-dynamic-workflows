#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parse } from "acorn";

const MAX_REVIEWABLE_BYTES = 524_288;

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
      if (calleeName === "agent") agentCalls += 1;
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
  if (meta.phases !== undefined && !Array.isArray(meta.phases)) {
    errors.push("meta.phases must be an array when present");
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

function validateParallelCall(node) {
  const firstArg = node.arguments[0];
  if (firstArg?.type !== "ArrayExpression") return;
  for (const element of firstArg.elements) {
    if (!element) continue;
    if (element.type === "CallExpression" && callName(element.callee) === "agent") {
      warnings.push(`parallel() at line ${line(node)} appears to contain bare agent() calls; pass thunks`);
    }
  }
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
