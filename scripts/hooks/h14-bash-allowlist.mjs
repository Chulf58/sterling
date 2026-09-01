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
//
// dangerouslyDisableSandbox DISCLOSURE (board f46f09a2) — NOT LIVE-PROBED: a
// Bash tool_input carrying dangerouslyDisableSandbox bypasses the PLATFORM's
// OS-level command sandboxing, a separate mechanism from this hook. PreToolUse
// hooks are registered per tool matcher and fire on the tool call itself, so
// there is no documented or probed reason this flag would suppress H14's own
// invocation — but that is architectural reasoning, not a measurement, and
// this codebase's standing rule is to verify platform behavior rather than
// assume it (decision 19678617). If a future probe finds H14 is skipped
// entirely when this flag is set, the disclosure below never runs and this
// comment is the loud flag that it was never verified either way.
import { relative, resolve, sep, join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStdin, deny, allow, loadConfig, environmentDefectDenial } from './lib/common.mjs';

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
    deny(environmentDefectDenial('H14', 'No toolchains in .sterling/config.json — the Bash allowlist cannot resolve run commands; failing closed (P5).'));
  }

  const command = String(input.tool_input?.command ?? '').trim();

  // BOARD f46f09a2 — dangerouslyDisableSandbox IS AN UNTRACED ESCAPE HATCH,
  // AND IT WAS USED (self-reported bypass of a command restriction). It
  // bypasses the platform's OS-level command sandboxing, NOT this allowlist —
  // the command below is still evaluated by every check that follows. Its use
  // is disclosed loudly (session stderr + a durable register entry) whenever
  // set truthy; it never denies on its own, and a failure disclosing it must
  // never escalate into denying the command — hence the OWN try/catch here,
  // nested inside the outer one whose catch below fails CLOSED (exactly wrong
  // for a logging failure that has nothing to do with allowlist evaluation).
  if (input.tool_input?.dangerouslyDisableSandbox) {
    try {
      const commandHead = command.slice(0, 80) + (command.length > 80 ? '…' : '');
      process.stderr.write(
        `⚠ H14 ADVISORY: dangerouslyDisableSandbox=true on this Bash call — sandbox is bypassed for '${commandHead}'. ` +
          `This does NOT bypass the allowlist below; logged to .sterling/transient/sandbox-bypass-log.json.\n`
      );
      const transient = join(input.cwd, '.sterling', 'transient');
      mkdirSync(transient, { recursive: true });
      const logPath = join(transient, 'sandbox-bypass-log.json');
      let entries = [];
      try {
        if (existsSync(logPath)) {
          const raw = JSON.parse(readFileSync(logPath, 'utf8'));
          if (Array.isArray(raw)) entries = raw;
        }
      } catch (parseErr) {
        // A corrupt register must not silently DISCARD the prior bypass
        // entries it held — that defeats the point of an audit trail. Loud
        // stderr note, and the corrupt bytes are preserved as a .corrupt
        // sidecar (never overwritten in place) before re-initializing empty.
        entries = [];
        try {
          process.stderr.write(
            `H14: sandbox-bypass-log.json is corrupt (${(parseErr && parseErr.message) || parseErr}) — prior entries are being TRUNCATED; preserving the corrupt file as '${logPath}.corrupt'.\n`
          );
          if (existsSync(logPath)) renameSync(logPath, `${logPath}.corrupt`);
        } catch {
          // best-effort disclosure/preservation only — must not escalate past
          // the outer disclosure catch below
        }
      }
      entries.push({ at: new Date().toISOString(), command_head: commandHead, cwd: input.cwd });
      const tmpPath = join(transient, `sandbox-bypass-log.json.tmp-${process.pid}`);
      writeFileSync(tmpPath, JSON.stringify(entries));
      renameSync(tmpPath, logPath);
    } catch (e) {
      // Disclosure is an aid, never a gate: loud on stderr, but must not
      // propagate into the outer catch's fail-closed deny (P5 without
      // costing an unrelated command a denial it never earned). The write
      // itself is guarded too — a broken stderr stream (e.g. EPIPE) must not
      // become the thing that finally reaches the fail-closed catch.
      try {
        process.stderr.write(`H14: sandbox-bypass disclosure failed (${(e && e.message) || e}) — the command is still evaluated normally below.\n`);
      } catch {
        // stderr itself is broken — nothing more can be done to disclose this
      }
    }
  }

  // Shell control operators would let an allowed prefix smuggle a second command
  // ('node --test && …') OR redirect an allowed command's output to write an
  // arbitrary path ('node --test > src/x.ts'). The declared run commands and the
  // read-only search commands never need chaining OR redirection, so both are
  // denied outright here — one place, before any allow path is considered.
  if (/[;&|`\n<>]|\$\(/.test(command)) {
    deny(
      `H14: shell control operators (chaining or redirection) are not allowed in agent commands: '${command}'. ` +
        `This is the single-command allowlist design: chaining/redirection are rejected BEFORE prefix matching, because an operator ` +
        `can extend an otherwise-allowed command into one that is not.`
    );
  }

  // A run-gate invocation joins the declared run_commands prefixes (decision
  // 98549344, slug toolchain-success-predicates-run-gate, board babf3a9e): it
  // is the sanctioned success-predicate runner, not a per-project declared
  // command, so it is allowlisted here directly rather than baked into any
  // project's config.toolchains[].run_commands. Matched by REGEX, not a
  // literal prefix (G4 review finding, same decision): the literal
  // 'node scripts/run-gate.mjs' never matches a CONSUMING project's
  // invocation ('node /path/to/clone/scripts/run-gate.mjs export'), so
  // isRunGateInvocation below recognizes it regardless of what precedes
  // 'scripts/run-gate.mjs'.
  const runCommandPrefixes = config.toolchains.flatMap((tc) => Object.values(tc.run_commands ?? {}));
  const RUN_GATE_RE = /^node\s+(?:\S*[\/\\])?scripts\/run-gate\.mjs(?:\s|$)/;
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

  // Read-only git rides the WRAPPER, never a direct git verb (decision
  // `git-ro-wrapper-fixed-recipes-no-caller-flags`, knowledge_get 1a7f3926).
  // The four direct read-only git verb prefixes this hook once carried (git log
  // / git show <ref> --stat / git diff --name-only / git branch --list, board
  // 4c7b84d3 AC3 lineage) are REMOVED. Keeping them beside the wrapper was
  // explicitly rejected — it "preserves a bypass around every guarantee the
  // wrapper adds" (fixed recipes, zero caller-controlled git flags, resolved
  // cardinality, a hardcoded executable roster, a positive-set child env,
  // bounded output).
  //
  // THE GRANT IS AN EXACT PLUGIN-OWNED FILE IDENTITY, NOT A TEXT PREFIX. The
  // old rule was the cwd-relative literal `node scripts/git-ro.mjs`, which no
  // CONSUMING project can satisfy — it has no such file, so the grant only ever
  // worked inside the Sterling clone (measured 2026-09-01: MODULE_NOT_FOUND).
  // The rule now is: token 1 must canonicalize to the RUNNING node binary and
  // token 2 must be an ABSOLUTE path canonicalizing to <pluginRoot>/scripts/
  // git-ro.mjs, where pluginRoot is walked up from THIS FILE. Consequences that
  // are deliberate, not incidental:
  //   * a consumer's own <project>/scripts/git-ro.mjs never matches — only the
  //     plugin's reviewed copy is trusted, and a lookalike
  //     ('…/git-ro-evil.mjs', '…/git-ro.mjs.bak') canonicalizes elsewhere;
  //   * a RELATIVE spelling is denied even when it would resolve to the right
  //     file: readStdin normalizes the payload cwd to the project root while
  //     the shell resolves against its own real cwd, so a relative path can be
  //     validated as one file and executed as another;
  //   * literal `node` is denied — a PATH-selected node shim is not the
  //     trusted interpreter the wrapper's guarantees assume;
  //   * NO env override on the plugin root (h1's pluginRoot() has one; H14 is a
  //     BLOCKING gate, where an env-settable root IS a bypass).
  // Chaining/redirection off the wrapper is already caught by the
  // control-operator gate above this point. H14 is NOT the wrapper's arity
  // gate: a malformed but correctly-identified invocation passes here and is
  // refused by the wrapper itself, which is where the recipe rules live.
  //
  // CHECK/USE RACE, ACCEPTED (S1.4): between this realpath and the shell's
  // exec, the expected file could in principle be swapped. That is accepted
  // under H14's documented SCOPE-DISCIPLINE model (research_finding bc00be84) —
  // the expected path is PLUGIN-owned, outside the consumer write scope the
  // agent operates in, and H14 has never been code-execution containment.
  const GIT_RO_WALK_LIMIT = 4;
  // fwdSlash is for DISPLAY only (message readability). Path COMPARISON uses
  // normSep, which rewrites separators ONLY on win32 — on POSIX a backslash is
  // a legal character IN a filename, so normalizing there would make two
  // genuinely different files compare equal.
  const fwdSlash = (p) => String(p).replace(/\\/g, '/');
  const normSep = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/') : String(p));
  const canonical = (p) => normSep(realpathSync(p));
  const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  // The expected identity. Any failure to establish it (walk-up, realpath, or
  // a non-regular file) leaves gitRoExpected null and records a defect string;
  // the whole derivation is wrapped so a throw can never escape into an allow
  // path — a git-ro-shaped command then denies as an ENVIRONMENT DEFECT below,
  // and nothing else is affected.
  let gitRoExpected = null;
  let gitRoDefect = null;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    let pluginRoot = null;
    for (let i = 0; i <= GIT_RO_WALK_LIMIT; i++) {
      if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
        pluginRoot = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!pluginRoot) {
      gitRoDefect = `no plugin root (a directory holding .claude-plugin/plugin.json) within ${GIT_RO_WALK_LIMIT} levels above this hook at '${fwdSlash(dirname(fileURLToPath(import.meta.url)))}'`;
    } else {
      const expectedPath = join(pluginRoot, 'scripts', 'git-ro.mjs');
      const resolved = canonical(expectedPath);
      if (!statSync(resolved).isFile()) gitRoDefect = `the plugin's wrapper path '${fwdSlash(expectedPath)}' is not a regular file`;
      else gitRoExpected = resolved;
    }
  } catch (e) {
    gitRoDefect = `the plugin's read-only git wrapper could not be canonicalized (${(e && e.message) || e})`;
  }

  // TWO-TOKEN LEXER over the command HEAD (S1.2). Returns exactly the first two
  // tokens, or null when the head is not two clean tokens. Each token may be
  // bare, "double-quoted" or 'single-quoted' (a quoted token may contain
  // spaces). NO-MATCH (never a silent acceptance) for: an unbalanced quote, a
  // quote glued to adjacent text, an empty token, or a `$`/backtick expansion —
  // the hook sees the PRE-expansion text, so an expansion means what is
  // validated is not what runs, and this lexer is explicitly NOT a shell.
  //
  // CHECK/USE: THE VERDICT RESTS ON realpath EQUALITY OF THE SPELLING THE SHELL
  // WILL EXECUTE — which is exactly why any spelling the SHELL reads
  // differently from this hook must be REFUSED, never normalized into a match.
  // Backslash is the case that bites (review round, both reviewers): on POSIX
  // bash treats '\' as an escape when unquoted and as a LITERAL character when
  // quoted — never as a separator. Normalizing it here would validate one file
  // and execute another: `"/…/Dataverse/\..\Sterling/scripts/git-ro.mjs"`
  // normalizes to the plugin's wrapper while bash execs a literal, attacker-
  // CREATABLE path, and unquoted `/home/cuj/Sterling\scripts/git-ro.mjs`
  // collapses to `/home/cuj/Sterlingscripts/…`. So on non-win32 ANY backslash in
  // either token is a NO-MATCH, checked BEFORE any normalization. Only on win32,
  // where '\' genuinely IS the separator and the shell reads it that way too, is
  // it normalized to '/' for the compare. Everything after token 2 is passed
  // through untouched: the wrapper's arity gate owns it.
  const lexTwoTokens = (str) => {
    const tokens = [];
    let i = 0;
    while (tokens.length < 2) {
      while (i < str.length && (str[i] === ' ' || str[i] === '\t')) i++;
      if (i >= str.length) return null;
      let tok = '';
      const quote = str[i] === '"' || str[i] === "'" ? str[i] : null;
      if (quote) {
        i++;
        let closed = false;
        while (i < str.length) {
          if (str[i] === quote) {
            closed = true;
            i++;
            break;
          }
          tok += str[i++];
        }
        if (!closed) return null; // unbalanced quote
        if (i < str.length && str[i] !== ' ' && str[i] !== '\t') return null; // quote glued to more text
      } else {
        while (i < str.length && str[i] !== ' ' && str[i] !== '\t') tok += str[i++];
      }
      if (tok === '') return null;
      if (/[`$"']/.test(tok)) return null; // expansions / embedded quotes
      // POSIX: a backslash is NEVER a separator — see the CHECK/USE rule above.
      // Refused BEFORE any normalization, so no normalized form is ever built
      // from a spelling the shell reads differently.
      if (process.platform !== 'win32' && tok.includes('\\')) return null;
      // An UNQUOTED token is still subject to brace, glob and tilde expansion,
      // which this hook never performs — the same check/use divergence one step
      // further out: `"/usr/bin/node" /project/{evil,good} log`, where the
      // literal `/project/{evil,good}` is a symlink to the plugin wrapper,
      // realpaths HERE to the trusted file while bash expands it into two words
      // and node executes `/project/evil`. Refused on every platform, before
      // normalization. Quoted tokens (either style) are exempt from THIS check
      // because quotes suppress brace/glob/tilde expansion; what double quotes
      // leave active is `$`/backtick, already refused above.
      if (!quote && /[*?[\]{}~]/.test(tok)) return null;
      tokens.push(tok);
    }
    return tokens;
  };

  const isAbsoluteToken = (tok) => {
    const norm = normSep(tok);
    return norm.startsWith('/') || /^[A-Za-z]:\//.test(norm);
  };

  const nodeCanonical = (() => {
    try {
      return canonical(process.execPath);
    } catch {
      return null;
    }
  })();

  const isGitRoWrapper = (() => {
    if (!gitRoExpected || !nodeCanonical) return false;
    const tokens = lexTwoTokens(command);
    if (!tokens) return false;
    const [exeTok, scriptTok] = tokens;
    if (scriptTok.startsWith('-')) return false; // a node FLAG between the two tokens
    if (!isAbsoluteToken(scriptTok)) return false; // a relative spelling never matches
    try {
      if (!samePath(canonical(exeTok), nodeCanonical)) return false;
      return samePath(canonical(scriptTok), gitRoExpected);
    } catch {
      return false; // an unresolvable token is not the expected file
    }
  })();

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
  // Quote-aware tokenizer for the REMAINDER only (never the executed command
  // itself, never the operator gate above) — a quoted span, however it
  // contains whitespace, is ONE token with its quote characters stripped, so a
  // traversal path riding inside "../../x y/evil.mjs" is boundary-checked as
  // the single path it is instead of being shredded on the interior space
  // (board 4c7b84d3 follow-up, AC-Z). No escape-sequence handling: this only
  // needs to reunite a quoted span, not fully emulate shell quoting.
  const tokenizeRemainder = (str) => {
    const tokens = [];
    let cur = '';
    let quote = null;
    let any = false;
    for (const ch of str) {
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        any = true;
        continue;
      }
      if (/\s/.test(ch)) {
        if (any) tokens.push(cur);
        cur = '';
        any = false;
        continue;
      }
      cur += ch;
      any = true;
    }
    if (any) tokens.push(cur);
    return tokens;
  };

  const valueEscapesRoot = (clean) => {
    if (!clean) return false;
    const rel = relative(input.cwd, resolve(input.cwd, clean));
    return rel === '..' || rel.startsWith('..' + sep);
  };
  // A flag token ('-x', '--import=path') is skipped for BARE flags (no path
  // value to check) but a '--flag=value' token's value is boundary-checked
  // the same as a bare positional path argument (board 4c7b84d3 follow-up,
  // AC-Y) — an escaping path does not stop being a path for riding inside a
  // flag's '=value' half.
  const pathArgEscapesRoot = (tok) => {
    if (tok.startsWith('-')) {
      const eq = tok.indexOf('=');
      if (eq === -1) return false; // a bare flag, no value to check
      return valueEscapesRoot(tok.slice(eq + 1));
    }
    return valueEscapesRoot(tok);
  };
  const prefixMatchEscapes = (candidate) => {
    const prefix = matchedPrefixOf(candidate);
    if (!prefix) return false;
    const remainder = candidate.slice(prefix.length).trim();
    if (!remainder) return false;
    return tokenizeRemainder(remainder).some(pathArgEscapesRoot);
  };

  const runCommandMatch =
    matchesPrefix(command) ? command : strictUnquoted !== null && matchesPrefix(strictUnquoted) ? strictUnquoted : null;
  const runCommandAllowed = runCommandMatch !== null && !prefixMatchEscapes(runCommandMatch);

  // Path-agnostic run-gate allowance (G4, decision 98549344 / slug
  // toolchain-success-predicates-run-gate): mirrors how matchesPrefix is
  // consulted above — the same command / strictUnquoted candidates — but
  // against RUN_GATE_RE instead of a literal prefix, so a consuming
  // project's absolute clone path still matches.
  const isRunGateInvocation = RUN_GATE_RE.test(command) || (strictUnquoted !== null && RUN_GATE_RE.test(strictUnquoted));

  const allowed = runCommandAllowed || isFsHelper || isReadOnlySearch || isGitRoWrapper || isRunGateInvocation;

  if (!allowed) {
    // GIT-RO DIAGNOSTIC (S1.3). A command that IS the two-token wrapper shape
    // but failed the IDENTITY check gets the exact accepted form plus the
    // specific reason, instead of the generic allowlist text — those shapes (a
    // relative path, bare `node`, a lookalike, a consumer's own copy) all look
    // correct to the caller, so naming the difference is the whole point.
    // SCOPE: only when the head lexes to two clean tokens AND token 2 names a
    // file called git-ro.mjs. A command that does not even lexically match the
    // two-token shape — a node flag between the tokens, an env-assignment
    // prefix, an unbalanced quote, a $-expansion — is not git-ro-shaped in
    // H14's eyes at all: S1.2 says it fails to MATCH, so ordinary allowlist
    // reasoning (and the generic denial below) applies. This runs only on the
    // DENY path; the allow decision above is untouched.
    const gitRoAttempt = (() => {
      const tokens = lexTwoTokens(command);
      if (!tokens) return null;
      const [exeTok, scriptTok] = tokens;
      if (scriptTok.startsWith('-')) return null;
      const norm = normSep(scriptTok);
      if (norm.slice(norm.lastIndexOf('/') + 1) !== 'git-ro.mjs') return null;
      return { exeTok, scriptTok };
    })();
    if (gitRoAttempt) {
      if (!gitRoExpected) {
        deny(
          environmentDefectDenial(
            'H14',
            `the read-only git wrapper's expected identity cannot be established — ${gitRoDefect}. A blocking gate that cannot verify the grant refuses it (P5).`
          )
        );
      }
      const reason = (() => {
        const { exeTok, scriptTok } = gitRoAttempt;
        if (!isAbsoluteToken(scriptTok)) {
          return `the wrapper path '${scriptTok}' is RELATIVE; only an absolute path is accepted, because this hook resolves against the normalized project root while the shell resolves against its own cwd — a relative spelling can validate one file and execute another`;
        }
        let exeResolved;
        try {
          exeResolved = canonical(exeTok);
        } catch {
          return `the node executable token '${exeTok}' cannot be canonicalized — name the RUNNING node binary by absolute path (bare 'node' is a PATH lookup and never matches)`;
        }
        if (!nodeCanonical) return `this hook cannot canonicalize its own node binary, so no invocation can be verified`;
        if (!samePath(exeResolved, nodeCanonical)) return `the node executable '${exeTok}' resolves to '${exeResolved}', which is not the running node binary '${nodeCanonical}'`;
        try {
          const scriptResolved = canonical(scriptTok);
          if (!samePath(scriptResolved, gitRoExpected)) {
            return `'${scriptTok}' resolves to '${scriptResolved}', which is not the PLUGIN's wrapper — a project-local copy, a renamed lookalike, or another clone never matches`;
          }
        } catch {
          return `the wrapper path '${scriptTok}' cannot be canonicalized — it does not exist on this machine`;
        }
        return `the invocation did not match the exact accepted form`;
      })();
      deny(
        `H14: this is not the sanctioned read-only git wrapper invocation: '${command}'. Reason: ${reason}. ` +
          `The EXACT accepted form is: ${nodeCanonical ?? fwdSlash(process.execPath)} "${gitRoExpected}" <verb> … ` +
          `(verbs: log, show, show-stat, diff-names — run from the repository root; the wrapper takes NO git flags).`
      );
    }
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
      } Allowed: ${runCommandPrefixes.map((p) => `'${p} …'`).join(', ')}, 'node …/scripts/run-gate.mjs …' (any path prefix), the fs helpers (node …/fs-remove.mjs, node …/fs-move.mjs), standalone read-only search: grep …, ls … (no pipes, no redirection; find stays denied), and read-only git through the PLUGIN'S WRAPPER only, named by ABSOLUTE path: ${
        gitRoExpected
          ? `'${nodeCanonical ?? fwdSlash(process.execPath)} "${gitRoExpected}" <verb> …'`
          : `(UNAVAILABLE on this machine — ${gitRoDefect})`
      } (verbs: log, show, show-stat, diff-names) — the direct git verbs (git log, git show <ref> --stat, git diff --name-only, git branch --list) were REMOVED in favour of it, so re-run history reads through that exact form. All other file access flows through Edit/Write/Read — and the Grep/Glob tools when the platform serves them.`
    );
  }
  allow();
} catch (e) {
  deny(environmentDefectDenial('H14', `Allowlist evaluation failed (${(e && e.message) || e}) — failing closed (P5).`));
}
