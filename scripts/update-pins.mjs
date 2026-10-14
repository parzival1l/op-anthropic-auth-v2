// Updates the OpenCode 2 plugin API pin and the fallback Claude Code version
// to the latest published releases. Prints a summary line per changed pin.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

function npmView(spec, field) {
  return execFileSync("npm", ["view", spec, field], { encoding: "utf8" }).trim();
}

function edit(file, pattern, replacement) {
  const url = new URL(file, root);
  const before = readFileSync(url, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) throw new Error(`${file}: pattern ${pattern} did not match`);
  writeFileSync(url, after);
}

const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const currentPlugin = pkg.devDependencies["@opencode-ai/plugin"];
const latestPlugin = npmView("@opencode-ai/plugin@beta", "version");

const indexSource = readFileSync(new URL("index.js", root), "utf8");
const currentClaude = indexSource.match(/FALLBACK_CLAUDE_CODE_VERSION = "([^"]+)"/)?.[1];
if (!currentClaude) throw new Error("index.js: FALLBACK_CLAUDE_CODE_VERSION not found");
const latestClaude = npmView("@anthropic-ai/claude-code", "version");

if (!/^0\.0\.0-beta-\d+$/.test(latestPlugin)) {
  throw new Error(`Unexpected @opencode-ai/plugin beta version: ${latestPlugin}`);
}
if (!/^\d+\.\d+\.\d+$/.test(latestClaude)) {
  throw new Error(`Unexpected @anthropic-ai/claude-code version: ${latestClaude}`);
}

if (latestPlugin !== currentPlugin) {
  edit("package.json", `"@opencode-ai/plugin": "${currentPlugin}"`, `"@opencode-ai/plugin": "${latestPlugin}"`);
  edit("README.md", `\`opencode2\` \`${currentPlugin}\``, `\`opencode2\` \`${latestPlugin}\``);
  console.log(`@opencode-ai/plugin: ${currentPlugin} -> ${latestPlugin}`);
}

if (latestClaude !== currentClaude) {
  edit("index.js", `FALLBACK_CLAUDE_CODE_VERSION = "${currentClaude}"`, `FALLBACK_CLAUDE_CODE_VERSION = "${latestClaude}"`);
  edit("test/plugin.test.js", `FALLBACK_VERSION = "${currentClaude}"`, `FALLBACK_VERSION = "${latestClaude}"`);
  edit("README.md", `4. \`${currentClaude}\`, if no install is found`, `4. \`${latestClaude}\`, if no install is found`);
  console.log(`Fallback Claude Code version: ${currentClaude} -> ${latestClaude}`);
}
