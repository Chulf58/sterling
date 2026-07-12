// H14 — Bash allowlist (spec §6 H14, §7.1). PreToolUse Bash, blocking exit-2.
// Deny-by-default: only (1) the toolchain adapters' declared run commands
// (baked into config at init) and (2) the contract-checked fs helpers
// (fs-remove / fs-move) are allowed. Frontmatter grants the tool; this hook is
// the restriction.
import { readStdin, deny, allow, loadConfig } from './lib/common.mjs';

const input = readStdin();

// A BLOCKING gate that cannot evaluate must DENY, not void itself: loadConfig's
// JSON.parse throws on a corrupt .sterling/config.json, and an uncaught throw
// exits 1 — non-blocking — which would run the coder's Bash with NO allowlist
// at all (arbitrary command execution). Any unexpected error → fail-closed deny
// (the F5 class; deny()/allow() process.exit before reaching the catch, so
// control flow is unaffected).
try {
  const config = loadConfig(input.cwd);
  if (!config?.toolchains?.length) {
    deny('H14: no toolchains in .sterling/config.json — the Bash allowlist cannot resolve run commands; failing closed (P5)');
  }

  const command = String(input.tool_input?.command ?? '').trim();

  // Shell control operators would let an allowed prefix smuggle a second command
  // ('node --test && …') OR redirect an allowed command's output to write an
  // arbitrary path ('node --test > src/x.ts'). The declared run commands and the
  // read-only search commands never need chaining OR redirection, so both are
  // denied outright here — one place, before any allow path is considered.
  if (/[;&|`\n<>]|\$\(/.test(command)) {
    deny(`H14: shell control operators (chaining or redirection) are not allowed in agent commands: '${command}'`);
  }

  const runCommandPrefixes = config.toolchains.flatMap((tc) => Object.values(tc.run_commands ?? {}));
  const firstArg = command.match(/^node\s+(?:"([^"]+)"|(\S+))/);
  const helperArg = firstArg ? (firstArg[1] ?? firstArg[2]) : undefined;
  const isFsHelper = !!helperArg && /(^|\/)fs-(remove|move)\.mjs$/.test(helperArg.replace(/\\/g, '/'));

  // Read-only search allowance (decision 4a09ce2a lineage, user-adjudicated
  // 2026-07-04): the platform silently drops the dedicated Grep/Glob tools from
  // the coder's served grant (research_finding 12b5b741), leaving it searchless.
  // grep and ls are the standalone substitutes: neither has an execute or write
  // flag, and chaining/redirection are already denied above (the operator gate),
  // so a bare grep/ls cannot become a writer. find/sed/awk remain denied
  // (-exec / e / system() execute). RETIRE this allowance when a probe shows
  // Grep/Glob served again.
  const isReadOnlySearch = /^(grep|ls)(\s|$)/.test(command);

  const allowed =
    runCommandPrefixes.some((p) => command === p || command.startsWith(p + ' ')) || isFsHelper || isReadOnlySearch;

  if (!allowed) {
    deny(
      `H14: command not on the allowlist: '${command}'. Allowed: ${runCommandPrefixes.map((p) => `'${p} …'`).join(', ')}, the fs helpers (node …/fs-remove.mjs, node …/fs-move.mjs), and standalone read-only search: grep …, ls … (no pipes, no redirection; find stays denied). All other file access flows through Edit/Write/Read — and the Grep/Glob tools when the platform serves them.`
    );
  }
  allow();
} catch (e) {
  deny(`H14: allowlist evaluation failed (${(e && e.message) || e}) — failing closed (P5)`);
}
