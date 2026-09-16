#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rootArg = process.argv.indexOf("--root");
const root =
  rootArg < 0 ? defaultRoot : path.resolve(process.argv[rootArg + 1]);
const failures = [];

function syntax(source) {
  return parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
}

function catalog(file) {
  const ast = syntax(readFileSync(file, "utf8"), file);
  const declaration = ast.program.body.find(
    (node) =>
      node.type === "VariableDeclaration" &&
      node.declarations.some(
        (item) => item.id.type === "Identifier" && item.id.name === "messages",
      ),
  );
  const init = declaration?.declarations.find(
    (item) => item.id.type === "Identifier" && item.id.name === "messages",
  )?.init;
  if (!init || init.type !== "ObjectExpression")
    throw new Error(`${file}: messages must be an object literal`);
  const result = new Map();
  function visit(object, prefix) {
    for (const property of object.properties) {
      if (property.type !== "ObjectProperty")
        throw new Error(`${file}: catalog spreads and methods are not allowed`);
      const key =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.value;
      const full = prefix ? `${prefix}.${key}` : `${key}`;
      if (property.value.type === "ObjectExpression")
        visit(property.value, full);
      else if (property.value.type === "StringLiteral")
        result.set(full, property.value.value);
      else throw new Error(`${file}: ${full} must be a string or object`);
    }
  }
  visit(init, "");
  return result;
}

const english = catalog(path.join(root, "app/i18n/en-US.ts"));
const norwegian = catalog(path.join(root, "app/i18n/nb-NO.ts"));
// The framework substitutes `{{name}}` only (`template.replace(/\{\{(\w+)\}\}/g, …)`
// in dist/client/i18n.js), so a single-brace placeholder reaches the screen
// verbatim, parameters and all. Both forms are collected here and the
// single-brace form is reported, or the parity check would happily accept two
// catalogs that are equally broken.
const placeholders = (value) =>
  [...(value ?? "").matchAll(/\{\{?([\w]+)\}?\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");
const singleBracePlaceholders = (value) =>
  [...(value ?? "").matchAll(/(?<!\{)\{([\w]+)\}(?!\})/g)].map(
    (match) => match[1],
  );
for (const key of new Set([...english.keys(), ...norwegian.keys()])) {
  if (!english.has(key)) failures.push(`en-US missing ${key}`);
  if (!norwegian.has(key)) failures.push(`nb-NO missing ${key}`);
  if (placeholders(english.get(key)) !== placeholders(norwegian.get(key)))
    failures.push(`placeholder mismatch for ${key}`);
  for (const [locale, value] of [
    ["en-US", english.get(key)],
    ["nb-NO", norwegian.get(key)],
  ]) {
    for (const name of singleBracePlaceholders(value)) {
      failures.push(
        `${locale} ${key}: {${name}} is never substituted, use {{${name}}}`,
      );
    }
  }
}

const dynamicFamilies = {
  "activity.actions.": [
    "archive-customer",
    "archive-job",
    "complete-job",
    "create-customer",
    "create-job",
    "redo-operation",
    "reschedule-job",
    "send-job-to-accounting",
    "start-job",
    "undo-operation",
  ],
  "activity.kinds.": ["forward", "redo", "undo"],
  // One key per `AppErrorCode` (src/application/errors.ts) plus the UNKNOWN
  // fallback `translatedActionError` uses for a failure that carries no code.
  "errors.": [
    "AUTHENTICATION",
    "AUTHORIZATION",
    "CONFLICT",
    "EXTERNAL",
    "INTERNAL",
    "INVARIANT",
    "NOT_FOUND",
    "UNKNOWN",
    "VALIDATION",
  ],
  "status.": [
    "active",
    "all",
    "archived",
    "completed",
    "in_progress",
    "scheduled",
  ],
};

function isTranslationCall(node) {
  return (
    node.type === "CallExpression" &&
    ((node.callee.type === "Identifier" && node.callee.name === "t") ||
      (node.callee.type === "CallExpression" &&
        node.callee.callee.type === "Identifier" &&
        node.callee.callee.name === "useT"))
  );
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else walk(value, visit);
  }
}
for (const file of readdirSync(path.join(root, "app"), {
  recursive: true,
}).filter((name) => /\.(ts|tsx)$/.test(name) && !name.startsWith("i18n/"))) {
  const ast = syntax(readFileSync(path.join(root, "app", file), "utf8"), file);
  walk(ast.program, (node) => {
    if (!isTranslationCall(node)) return;
    const argument = node.arguments[0];
    if (argument?.type === "StringLiteral" && !english.has(argument.value))
      failures.push(`${file}: missing en-US key ${argument.value}`);
    if (
      argument?.type === "TemplateLiteral" &&
      argument.expressions.length > 0
    ) {
      const prefix = argument.quasis[0]?.value.cooked ?? "";
      const family = dynamicFamilies[prefix];
      if (!family)
        failures.push(
          `${file}: unchecked dynamic translation family ${prefix}*`,
        );
      else
        for (const suffix of family)
          if (!english.has(`${prefix}${suffix}`))
            failures.push(
              `${file}: missing dynamic en-US key ${prefix}${suffix}`,
            );
    }
  });
}
if (failures.length) {
  for (const failure of new Set(failures)) console.error(`i18n: ${failure}`);
  process.exit(1);
}
console.log(
  `i18n: ${english.size} keys; usage, parity and placeholders verified`,
);
