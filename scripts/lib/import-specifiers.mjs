import { parse } from "@babel/parser";

/** Parse actual syntax: comments, strings, JSX and multiline imports must not
 * change whether a dependency is checked. Syntax errors fail the check closed.
 * @param {string} source
 * @returns {{ specifier: string, line: number }[]}
 */
export function collectImportSpecifiers(source) {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    createImportExpressions: true,
  });
  const imports = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    let sourceNode;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type)
    ) {
      sourceNode = node.source;
    } else if (node.type === "TSImportType") {
      sourceNode = node.argument;
    } else if (node.type === "TSExternalModuleReference") {
      sourceNode = node.expression;
    } else if (
      node.type === "CallExpression" &&
      node.callee?.name === "require"
    ) {
      sourceNode = node.arguments[0];
    }
    if (sourceNode?.type === "StringLiteral") {
      imports.push({ specifier: sourceNode.value, line: node.loc.start.line });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && "type" in value)
        visit(value);
    }
  };
  visit(ast);
  return imports;
}
