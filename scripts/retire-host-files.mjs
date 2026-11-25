// retire-host-files [S] — the last step of an update for one project (decision
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer, GitHub #329):
// once every AGENTS.md writer of the caller's sequence has run without a refusal, verify the
// Sterling layer in AGENTS.md on disk and remove a CLAUDE.md or GEMINI.md that holds only
// Sterling's current render. Any other one is kept, with a warning line. /sterling:update and
// the post-update sync run it after stamp-contract; they relay the "Sterling layer" lines.
//   node scripts/retire-host-files.mjs --target <project dir>
// Exit 0 whatever was kept; 1 when a file it would remove could not be removed (every receipt is
// printed first); 2 on a usage error or a target that is missing or not a directory.
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retireAfterWriters } from './lib/sterling-layer.mjs';
import { agyMcpRoot } from './lib/agy-setup.mjs';

const USAGE = 'usage: node scripts/retire-host-files.mjs --target <project dir>';
const usageError = (why) => {
  console.error(`retire-host-files: ${why}\n${USAGE}`);
  process.exit(2);
};
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--target') usageError('exactly one --target <project dir> is required');
if (!argv[1] || argv[1].startsWith('-')) usageError(`'${argv[1]}' is an option, not a project directory`);
const target = resolve(argv[1]);
let st;
try {
  st = statSync(target);
} catch (err) {
  usageError(`${target} does not exist (${err?.code ?? err?.message ?? err})`);
}
if (!st.isDirectory()) usageError(`${target} is not a directory`);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { lines, failed } = retireAfterWriters({ projectDir: target, pluginRoot, roots: [agyMcpRoot({ pluginRoot }).root] });
for (const line of lines) console.log(line);
// Every receipt is printed first, so a file removed before a later unlink failed is still named.
if (failed) process.exit(1);
