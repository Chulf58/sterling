// retire-host-files [S] — the last step of an update for one project (decision
// project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer, GitHub #329):
// once every AGENTS.md writer of the caller's sequence has run without a refusal, verify the
// Sterling layer in AGENTS.md on disk and remove a CLAUDE.md or GEMINI.md that holds only
// Sterling's current render. Any other one is kept, with a warning line. /sterling:update and
// the post-update sync run it after stamp-contract; they relay the "Sterling layer" lines.
//   node scripts/retire-host-files.mjs --target <project dir>
// Exit 0 whatever was kept; 1 on an error; 2 on a usage error.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retireAfterWriters } from './lib/sterling-layer.mjs';
import { agyMcpRoot } from './lib/agy-setup.mjs';

const USAGE = 'usage: node scripts/retire-host-files.mjs --target <project dir>';
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--target' || !argv[1]) {
  console.error(USAGE);
  process.exit(2);
}
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = retireAfterWriters({ projectDir: resolve(argv[1]), pluginRoot, roots: [agyMcpRoot({ pluginRoot }).root] });
for (const line of lines) console.log(line);
