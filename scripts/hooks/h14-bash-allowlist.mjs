// H14 — Bash allowlist (spec §6 H14, §7.1). PreToolUse Bash, blocking exit-2.
// Deny-by-default: only (1) the toolchain adapters' declared run commands
// (baked into config at init) and (2) the contract-checked fs helpers
// (fs-remove / fs-move) are allowed. Frontmatter grants the tool; this hook is
// the restriction.
import { readStdin, deny, allow, loadConfig } from './lib/common.mjs';

const input = readStdin();
const config = loadConfig(input.cwd);
if (!config?.toolchains?.length) {
  deny('H14: no toolchains in .sterling/config.json — the Bash allowlist cannot resolve run commands; failing closed (P5)');
}

const command = String(input.tool_input?.command ?? '').trim();

// Shell control operators would let an allowed prefix smuggle a second command
// ('node --test && …'). The declared run commands never need them.
if (/[;&|`\n]|\$\(/.test(command)) {
  deny(`H14: shell control operators are not allowed in agent commands: '${command}'`);
}

const runCommandPrefixes = config.toolchains.flatMap((tc) => Object.values(tc.run_commands ?? {}));
const firstArg = command.match(/^node\s+(?:"([^"]+)"|(\S+))/);
const helperArg = firstArg ? (firstArg[1] ?? firstArg[2]) : undefined;
const isFsHelper = !!helperArg && /(^|\/)fs-(remove|move)\.mjs$/.test(helperArg.replace(/\\/g, '/'));

const allowed = runCommandPrefixes.some((p) => command === p || command.startsWith(p + ' ')) || isFsHelper;

if (!allowed) {
  deny(
    `H14: command not on the allowlist: '${command}'. Allowed: ${runCommandPrefixes.map((p) => `'${p} …'`).join(', ')}, and the fs helpers (node …/fs-remove.mjs, node …/fs-move.mjs). All other file access flows through Edit/Write/Read/Grep/Glob.`
  );
}
allow();
