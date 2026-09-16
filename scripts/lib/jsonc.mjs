// The repository's one JSONC reader.
//
// `wrangler.jsonc` carries comments (explaining why each var exists) and, because
// `.oxfmtrc.json` sets `trailingComma: "all"`, a trailing comma on every object and array.
// Neither is valid JSON, so both have to come out before `JSON.parse`.
//
// Extracted from `scripts/check-config-hygiene.mjs` (T01/T02) so that
// `scripts/bootstrap.mjs`, which edits `wrangler.jsonc` as text, can re-parse its own edit
// with exactly the reader the hygiene check will use on it (T24 step 0.2).

/**
 * Replaces `//` and block comments with whitespace, preserving newlines so line numbers in a
 * parse error still point at the right line of the original file.
 * @param {string} source
 */
export function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        result += char;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * JSONC allows trailing commas and `oxfmt` (trailingComma: "all") writes them, so they have to
 * come out before `JSON.parse`. Commas are replaced by spaces, never deleted, so byte offsets
 * in a parse error still point at the right place in the original file.
 * @param {string} source
 */
export function stripTrailingCommas(source) {
  const characters = [...source];
  let inString = false;
  for (let index = 0; index < characters.length; index += 1) {
    const char = characters[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== ",") continue;
    let ahead = index + 1;
    while (ahead < characters.length && /\s/.test(characters[ahead] ?? "")) {
      ahead += 1;
    }
    if (characters[ahead] === "}" || characters[ahead] === "]") {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

/**
 * Parses JSONC. Throws the underlying `SyntaxError` on malformed input.
 * @param {string} source
 * @returns {unknown}
 */
export function parseJsonc(source) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(source)));
}
