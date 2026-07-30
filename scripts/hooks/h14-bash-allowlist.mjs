// H14 — Bash allowlist (spec §6 H14, §7.1). PreToolUse Bash, blocking exit-2.
// Deny-by-default: only (1) the toolchain adapters' declared run commands
// (baked into config at init) and (2) the contract-checked fs helpers
// (fs-remove / fs-move) are allowed. Frontmatter grants the tool; this hook is
// the restriction.
//
// THREAT MODEL — READ THIS BEFORE TREATING H14 AS A SANDBOX (research_finding
// bc00be84). H14 enforces SCOPE DISCIPLINE, not code-execution containment. It
// cannot be the latter, and no tightening of this allowlist would make it so:
//   * a declared run command is an interpreter invocation. `node --test <file>`
//     EXECUTES that file's top-level code even when it registers no tests
//     (probed 2026-07-26, Node 24: a file containing only a console.log printed
//     it and was reported `tests 1 / pass 1`, exit 0). The shipped node adapter
//     declares `test: 'node --test'`, so arbitrary execution is reachable in
//     every Sterling node project by default.
//   * the agents holding Bash also hold Write. Anything that can author a file
//     and run a declared interpreter over it can run arbitrary code. Path-scoping
//     the argument does not change that — the debugger's legitimate probe road is
//     exactly "write a scratchpad file, run it through the declared command".
// What H14 DOES buy, and why it stays: agents stay on the project's declared
// toolchain commands instead of inventing shell; chaining and redirection are
// denied so an allowed prefix cannot smuggle a second command or redirect into an
// arbitrary path; find/sed/awk stay denied. Containment lives elsewhere — H3
// (write contract), H5 (frozen tests), H17 (bash write sweep) — and in Sterling
// running agents that are already trusted to write code.
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
    // QUOTING DIAGNOSTIC (reported from a consuming project 2026-07-30, decision
    // 398adceb). The prefix match above is literal, so quoting an allowlisted
    // absolute exe path — the instinct when it contains spaces — fails to match,
    // and the generic denial never named quoting as the discriminator. Two agents
    // hit it; one worked it out by trial. The trap was well hidden because the
    // fs-helper branch above DOES accept a quoted path, so quoting works in one
    // branch of this hook and silently fails in the other. The command stays
    // DENIED — the allow surface is unchanged deliberately, since loosening a
    // blocking gate is not a message fix — and the agent is pointed at the
    // unquoted form, which works even for paths containing spaces (a literal
    // prefix match does not care about spaces).
    // Both quoting instincts, not just double quotes: a single-quoted exe path
    // hits the identical literal-match failure, so diagnosing only one form
    // leaves the same trap open for the other (correctness review 2026-07-30).
    const unquoted = command.replace(/^(["'])([^"']+)\1/, '$2');
    const matchedPrefix = runCommandPrefixes.find((p) => unquoted === p || unquoted.startsWith(p + ' '));
    const quotingIsTheCause = unquoted !== command && !!matchedPrefix;
    // "Re-run it unquoted" is true about THIS matcher and can still be false
    // about the outcome: if the space sits inside the executable PATH rather than
    // separating arguments, the shell word-splits the unquoted form and the
    // command has no working spelling under this allowlist (correctness review
    // 2026-07-30). Which case a given prefix is CANNOT be decided from the config
    // string — 'node --test' and 'C:/Program Files/node.exe --test' are both
    // "a prefix containing a space" — so the caveat is stated as a condition the
    // caller can evaluate against its own toolchain instead of guessed at here.
    // Papering over it would hand out advice that passes the gate and then dies.
    const prefixHasSpace = quotingIsTheCause && matchedPrefix.includes(' ');
    deny(
      `H14: command not on the allowlist: '${command}'.${
        quotingIsTheCause
          ? ` THE QUOTES ARE THE CAUSE: the allowlist matches command prefixes LITERALLY, so a quoted executable path does not match. Re-run it unquoted: '${unquoted}'.${
              prefixHasSpace
                ? ` CAVEAT before you retry: '${matchedPrefix}' contains a space. If that space is inside the EXECUTABLE PATH rather than separating arguments, the unquoted form passes this allowlist and is then word-split by the shell — meaning this command has NO working spelling here, so report it as unrunnable instead of retrying further (Sterling board f49466f5 tracks whether quoted forms should be accepted).`
                : ''
            }`
          : ''
      } Allowed: ${runCommandPrefixes.map((p) => `'${p} …'`).join(', ')}, the fs helpers (node …/fs-remove.mjs, node …/fs-move.mjs), and standalone read-only search: grep …, ls … (no pipes, no redirection; find stays denied). All other file access flows through Edit/Write/Read — and the Grep/Glob tools when the platform serves them.`
    );
  }
  allow();
} catch (e) {
  deny(`H14: allowlist evaluation failed (${(e && e.message) || e}) — failing closed (P5)`);
}
