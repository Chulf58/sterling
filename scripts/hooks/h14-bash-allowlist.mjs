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
//     That road is for PROBES, not for reaching undeclared project commands:
//     since 2026-08-10 (board 6c4d9659) a repo whose briefs say "npm run build"
//     DECLARES build/check run_commands in its toolchain — driving them through
//     a node-driver file instead is the 3261fd4f smuggling shape even when
//     disclosed. If a needed command is missing here, the fix is declaring it
//     in config, never routing around the allowlist.
// What H14 DOES buy, and why it stays: agents stay on the project's declared
// toolchain commands instead of inventing shell; chaining and redirection are
// denied so an allowed prefix cannot smuggle a second command or redirect into an
// arbitrary path; find/sed/awk stay denied. Containment lives elsewhere — H3
// (write contract), H5 (frozen tests), H17 (bash write sweep) — and in Sterling
// running agents that are already trusted to write code.
import { relative, resolve, sep } from 'node:path';
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

  // Read-only git verb allowance (board 4c7b84d3, AC3): VERB-SHAPED, never
  // "git anything" — each pattern is an EXACT shape (a ref token is the only
  // free variable), so a lookalike ('git logger') or an unlisted verb ('git
  // stash') never matches, and mutating verbs (commit/push/checkout/rebase/
  // reset/status) stay denied exactly as before. Chaining/redirection off an
  // allowed verb is already caught by the control-operator gate above this
  // point, so it never reaches this check at all.
  const READONLY_GIT_PATTERNS = [/^git log$/, /^git show \S+ --stat$/, /^git diff --name-only$/, /^git branch --list$/];
  const isReadOnlyGit = READONLY_GIT_PATTERNS.some((re) => re.test(command));

  // Quote-strip the FIRST whitespace-separated token, for MATCH PURPOSES ONLY
  // (board f49466f5, decision 398adceb): the executed command, the operator
  // gate above, and the fs-helper quoted-path branch are all untouched — this
  // ONLY widens what the run-command prefix match accepts. Stripping applies
  // ONLY when the quoted content itself contains no whitespace: a single quoted
  // token — '"node" --test …' — becomes 'node --test …' and is matched
  // normally. A quoted MULTI-WORD span — '"node --test" x' — is NOT a single
  // executable token; matching it would let quoting smuggle a whole prefix (and
  // anything after it) past the allowlist as one opaque blob, so the content
  // class here (\S without quote/space chars) refuses to consume the internal
  // space and the whole match fails, leaving the literal (quoted) string to be
  // tested as-is — which cannot match, and stays denied. Mismatched quotes
  // ("node' …) fail the same way: the backreference requires the SAME quote
  // character to close, so there is nothing to strip.
  const strictQuote = command.match(/^(["'])([^\s"']*)\1(?=\s|$)/);
  const strictUnquoted = strictQuote ? strictQuote[2] + command.slice(strictQuote[0].length) : null;

  const matchesPrefix = (candidate) => runCommandPrefixes.some((p) => candidate === p || candidate.startsWith(p + ' '));
  const matchedPrefixOf = (candidate) => runCommandPrefixes.find((p) => candidate === p || candidate.startsWith(p + ' '));

  // AC2 boundary (board 4c7b84d3): cwd robustness must never become a
  // path-scope bypass. readStdin() already normalizes input.cwd to the
  // project root (never the raw shell cwd), so that root is the ONE
  // resolution base regardless of which subdirectory the platform actually
  // invoked the hook from. For a candidate that matches a declared run-command
  // prefix, resolve every remaining non-flag argument against that root; a
  // command whose argument climbs (via '../') to a path outside the root is
  // denied even though its textual prefix matches — a genuinely different
  // command (AC1 boundary) is unaffected because it never reaches this check.
  const pathArgEscapesRoot = (tok) => {
    if (tok.startsWith('-')) return false; // a flag, not a path
    const quoted = tok.match(/^(["'])([^\s"']*)\1$/);
    const clean = quoted ? quoted[2] : tok;
    if (!clean) return false;
    const rel = relative(input.cwd, resolve(input.cwd, clean));
    return rel === '..' || rel.startsWith('..' + sep);
  };
  const prefixMatchEscapes = (candidate) => {
    const prefix = matchedPrefixOf(candidate);
    if (!prefix) return false;
    const remainder = candidate.slice(prefix.length).trim();
    if (!remainder) return false;
    return remainder.split(/\s+/).filter(Boolean).some(pathArgEscapesRoot);
  };

  const runCommandMatch =
    matchesPrefix(command) ? command : strictUnquoted !== null && matchesPrefix(strictUnquoted) ? strictUnquoted : null;
  const runCommandAllowed = runCommandMatch !== null && !prefixMatchEscapes(runCommandMatch);

  const allowed = runCommandAllowed || isFsHelper || isReadOnlySearch || isReadOnlyGit;

  if (!allowed) {
    // QUOTING DIAGNOSTIC (reported from a consuming project 2026-07-30, decision
    // 398adceb; matching now strips a single-word quoted first token above, so a
    // command reaching this deny branch was NOT fixed by that — quoting can only
    // still be "the cause" here for a quoted span that is GENUINELY unmatchable:
    // a multi-word quoted token ('"node --test" x') or mismatched quotes
    // ("node' …). Diagnose with a LOOSE strip (content may contain whitespace,
    // but not a quote char, and the same quote character must close it) purely
    // to explain WHY — this never feeds back into the allow decision above.
    const looseQuote = command.match(/^(["'])([^"']*)\1/);
    const looseUnquoted = looseQuote ? looseQuote[2] + command.slice(looseQuote[0].length) : null;
    const matchedPrefix = looseUnquoted !== null ? runCommandPrefixes.find((p) => looseUnquoted === p || looseUnquoted.startsWith(p + ' ')) : undefined;
    // Only a MULTI-WORD quoted span reaches here as a quoting story — a
    // single-word quoted token that matches was already accepted above, so it
    // never denies. quotingIsTheCause therefore means "the quoted-as-one-token
    // form can never match; here is the unquoted equivalent that can."
    const quotingIsTheCause = !!matchedPrefix && /\s/.test(looseQuote[2]);
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
          ? ` THE QUOTED FORM IS GENUINELY UNMATCHABLE: quoting the whole command as ONE token cannot match the allowlist (a single-word quoted first token — e.g. a quoted exe path — is already accepted; a multi-word quoted span is not, so it cannot smuggle a prefix past this gate). Re-run it unquoted: '${looseUnquoted}'.${
              prefixHasSpace
                ? ` CAVEAT before you retry: '${matchedPrefix}' contains a space. If that space is inside the EXECUTABLE PATH rather than separating arguments, the unquoted form passes this allowlist and is then word-split by the shell — meaning this command has NO working spelling here, so report it as unrunnable instead of retrying further (Sterling board f49466f5 tracks whether quoted forms should be accepted).`
                : ''
            }`
          : ''
      } Allowed: ${runCommandPrefixes.map((p) => `'${p} …'`).join(', ')}, the fs helpers (node …/fs-remove.mjs, node …/fs-move.mjs), standalone read-only search: grep …, ls … (no pipes, no redirection; find stays denied), and read-only git: git log, git show <ref> --stat, git diff --name-only, git branch --list. All other file access flows through Edit/Write/Read — and the Grep/Glob tools when the platform serves them.`
    );
  }
  allow();
} catch (e) {
  deny(`H14: allowlist evaluation failed (${(e && e.message) || e}) — failing closed (P5)`);
}
