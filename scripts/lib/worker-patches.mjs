const FS_SAFE =
  "{existsSync:()=>false,readdirSync:()=>[],realpathSync:(v)=>v,mkdirSync:()=>undefined,rmSync:()=>undefined,constants:{},promises:{}}";
const OS_SAFE =
  '{homedir:()=>"/",tmpdir:()=>"/tmp",platform:()=>"linux",hostname:()=>"worker",EOL:"\\n",cpus:()=>[],totalmem:()=>0,freemem:()=>0,release:()=>"",type:()=>"Linux",arch:()=>"x64",userInfo:()=>({username:"worker"})}';

// The regexes are verified against docs/plan/02-framework-facts.md F9. Capture groups:
// 1 = proxy target, 2 = requested property, 3 = the "unavailable" thrower, 4 = the property
// again inside the thrower's message.
export const PATCHES = [
  {
    id: "fs-default-proxy",
    pattern:
      /get\(([\w$]+),([\w$]+)\)\{return ([\w$]+)\("fs\."\+String\(([\w$]+)\)\)\}/,
    safe: FS_SAFE,
    module: "fs",
  },
  {
    id: "os-default-proxy",
    pattern:
      /get\(([\w$]+),([\w$]+)\)\{return ([\w$]+)\("os\."\+String\(([\w$]+)\)\)\}/,
    safe: OS_SAFE,
    module: "os",
  },
];

/** @param {(typeof PATCHES)[number]} patch */
function replacement(patch) {
  return (
    /** @type {(...groups: string[]) => string} */
    (_match, target, property, thrower, messageProperty) =>
      `get(${target},${property}){const __safe=${patch.safe};` +
      `if(Object.prototype.hasOwnProperty.call(__safe,${property}))return __safe[${property}];` +
      `return ${thrower}("${patch.module}."+String(${messageProperty}))}`
  );
}

export function patchWorkerSource(source) {
  for (const patch of PATCHES) {
    const matches = source.match(new RegExp(patch.pattern.source, "g")) ?? [];
    if (matches.length !== 1)
      throw new Error(
        `patch ${patch.id}: expected 1 match, found ${matches.length}`,
      );
    source = source.replace(patch.pattern, replacement(patch));
  }
  return source;
}
