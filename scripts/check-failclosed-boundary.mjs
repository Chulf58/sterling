// Fail-closed boundary check (board 4a66ba58) — the MECHANIZED replacement for the
// prose recipe in anti_pattern e13f0fb5 (the F5 fail-open class: a blocking gate
// that throws is silently VOIDED).
//
// THE INVARIANT, stated once:
//   A hook that throws uncaught exits 1. The hook runner treats ANY non-2 exit as
//   NON-BLOCKING. So when a BLOCKING gate — one that renders its verdict through
//   deny(), which exits 2 — throws before it decides, the gate is voided and the
//   guarded tool call runs UNEXAMINED. Therefore, in a blocking hook, every
//   top-level statement evaluated before the deny decision must sit inside a
//   fail-closed try whose catch calls deny().
//   THE DANGER IS POSITION, NOT THE IDENTITY OF THE CALL. `loadConfig()` is not a
//   dangerous function; `loadConfig()` at top level OUTSIDE a fail-closed try is a
//   dangerous POSITION. That is why this check is an AST walk over top-level
//   statements rather than a blocklist of calls.
//
// WHAT THIS CHECK PROVES, PRECISELY — and what it does NOT.
//   It proves that, AFTER a hook module has successfully initialized, every
//   top-level statement outside a fail-closed try/catch->deny island is one of the
//   few forms that cannot throw. It does NOT prove the hook is fail-closed "from
//   process start": static `import` linking happens BEFORE any of the hook's own
//   body runs, so no try inside the hook can catch a failing import (a missing
//   module, a syntax error in a dependency, a throwing module top-level). Such a
//   failure still exits 1 and still voids the gate, and nothing in this file
//   detects or prevents it. A dynamic-import launcher would close that gap; it is
//   deliberately out of scope here and no claim is made that it exists.
//   This paragraph is written flat on purpose: anti_pattern 586bccdc is a security
//   file whose comment asserted a protection nothing implemented, and an
//   over-claiming comment on an enforcement surface is worse than no comment.
//
// HOW IT DECIDES (the design settled with an outside-model review; do not
// re-litigate it here without a decision record):
//   1. Parse with the `typescript` package (createSourceFile, ScriptKind.JS) —
//      never a regex or line scanner. `typescript` is already a devDependency.
//   2. The boundary is EVERY top-level `try` whose catch UNCONDITIONALLY reaches
//      deny() — NOT "the first try in the file". h3-contract-gate.mjs and
//      h15-store-guard.mjs legitimately have SEVERAL guarded islands; a first-try
//      scanner would miss an unguarded statement sitting BETWEEN two of them,
//      which is exactly the hole this check exists to find.
//      UNCONDITIONALLY is load-bearing (outside review, 2026-08-27). A merely
//      SYNTACTIC "the catch contains a deny somewhere" test credits a hollow
//      boundary: `catch { if (false) deny('x'); }` never denies, yet a syntactic
//      scan sees the call and passes the island. So the catch body is walked in
//      EXECUTION ORDER and a deny counts only when nothing can skip it — not
//      nested in an `if` without an else that also denies, not in a switch, a
//      loop, an `&&`/`||`, or a ternary, and not sitting after a return/throw
//      that already left the block.
//   3. Outside those islands the SAFE LIST IS TINY: comments/whitespace, static
//      import declarations, function declarations, and UNINITIALIZED variable
//      declarations (`let input;`). EVERYTHING else is a finding — including any
//      `const` WITH an initializer (an initializer is arbitrary executable code),
//      class declarations, bare calls, `if`, and top-level `await`.
//   4. A try whose catch does NOT reach deny() is NOT a boundary. It is a sham,
//      and it is itself reported.
//   5. A THROWABLE DENIAL ARGUMENT is its own finding, reported with the
//      `deny-arg:` identity prefix. The handler exists precisely so that a throw
//      cannot void the gate — so a deny whose own ARGUMENT LIST must be evaluated
//      first (`deny(buildMessage(e))`, `deny(list.join(', '))`, `deny(a.b.c)`)
//      reintroduces the F5 class INSIDE the handler: the argument throws, the
//      catch never reaches exit 2, the process exits 1, and the gate is voided at
//      the exact moment it was about to deny. Safe argument forms are literals,
//      plain identifiers, template literals / `+` concatenations over those, and
//      the repo's own guarded-access idiom (`(e && e.message) || e`, `e?.message`)
//      which cannot throw. Anything else — a call, an unguarded property access,
//      an element access, `new`, a ternary — is reported.
//      This is DELIBERATELY a finding rather than a non-failing notice (P5: a
//      diagnostic that cannot fail holds no line, and the ratchet is the only
//      thing that stops a new one appearing), and it deliberately does NOT
//      disqualify the boundary: the island DOES deny, so voiding it would cascade
//      every following top-level statement into a finding and drown the specific
//      signal. Scope, stated exactly: deny calls written INSIDE the catch clause
//      of a top-level try. A deny reached through a helper function called from
//      that catch is NOT inspected (no interprocedural argument analysis).
//
// THE MANIFEST is the classification register (P5: nothing is silently skipped).
// A hook on disk but absent from it FAILS; a manifest entry naming a file that no
// longer exists FAILS; a hook declared `advisory` that calls the imported deny
// binding FAILS, because the label is then a lie about what the hook can do.
//
// THE EXEMPT CLASS IS CROSS-CHECKED TOO, and this is a correction (board
// 9f8d4c03): the mislabel check originally fired ONLY for `advisory`, so a hook
// classified `exempt` was skipped outright and MOVING a hook to `exempt` retired
// its fail-closed boundary requirement with NO complaint. A checker whose exempt
// list can quietly drop a requirement is worse than no checker, because it reports
// green over the hole. `exempt` is the one place this file is told "this gate may
// fail open" — and being told to ignore something is precisely what has to be
// loud (P5). So an exempt hook THAT DENIES must be named in the EXEMPTIONS
// register, and that entry must carry:
//   • `decision` — the governing record (slug or id). A justification citing
//     nothing is not a justification; it is an assertion.
//   • `reason`   — why failing closed is WRONG for this specific gate. Required
//     because a ruling stripped of its justification reproduces, at the reading
//     surface, the gap it was written to close.
//   • `denials`  — the EXACT deny-call identities the exemption covers, compared
//     as a multiset in BOTH directions, exactly as the baseline ratchet is. An
//     exemption is granted to a named deny SET, never to a file forever: an
//     unlisted deny FAILS (the exemption did not cover it) and a listed deny that
//     is gone FAILS as stale. A COUNT would let one denial be swapped for another
//     invisibly, which is the same defect the statement-identity ratchet exists to
//     prevent, one register over.
// An exempt hook with ZERO deny calls needs no entry: it cannot block anything, so
// there is no boundary requirement to retire. That is the ONLY thing zero denies
// excuses, and the distinction is load-bearing: an entry that EXISTS is validated
// and compared REGARDLESS of how many denies are observed, so an exempt hook whose
// sole deny() was DELETED with its entry left behind reports every listed denial as
// STALE rather than passing green. Skipping the cross-check on an empty deny set
// was a fail-open inside this fail-closed checker, and it is now impossible by
// construction — the register's own emptiness check happens after the lookup.
// An EXEMPTIONS entry naming a hook that is not classified exempt FAILS as a stale
// register — a leftover justification must never sit ready to excuse a future move.
// SCOPE, stated exactly: like the advisory cross-check beside it, the deny set is
// the calls to the IMPORTED deny binding (see denyBindingNames' residual note). A
// deny reached only through a local helper is not enumerated, and no claim is made
// that it is.
//
// THE BASELINE is an EXACT-FINDING RATCHET, keyed by STATEMENT TEXT rather than by
// line number so a finding's identity survives unrelated line shifts. Both
// directions fail:
//   • an observed finding with no baseline entry  -> FAIL (a new hole);
//   • a baseline entry with no observed finding   -> FAIL (a stale entry: delete it).
// A pure subset therefore does NOT silently pass. That is deliberate — whoever
// fixes a hook prunes its baseline entry in the SAME change, which is what makes
// the baseline only ever shrink instead of rotting into a list nobody trusts.
//
// THE GROWTH LOCK — because the baseline is STRUCTURALLY A SUPPRESSION LIST
// (board 9f8d4c03). The two rules above stop a hole being suppressed by ACCIDENT:
// a new finding fails, a fixed one must be pruned. What they do NOT do is
// distinguish "one entry pruned because it was fixed" from "one entry APPENDED
// because it was inconvenient" — both leave a list of accepted fail-opens, and a
// human editing this file can do the second as easily as the first. The defect was
// never the 107 entries; it was that a 108th would look exactly like a fix.
// So growth must go through one of exactly two doors, and neither is quiet:
//   • FOUNDING_BASELINE_TOTAL locks the count of UNJUSTIFIED entries, and the
//     comparison is EXACT — too many fails as an unjustified append, too few fails
//     demanding the number be lowered in the same change that fixed the entry.
//     Exactness is the whole point: a CEILING would leave headroom behind every
//     fix, and headroom is the silent-append space this lock exists to close.
//     The constant is itself pinned by a test, so raising it to admit a 108th
//     entry cannot happen without also editing a test file — which is gated and
//     reviewed. Stated flat rather than flatteringly: this does not make an append
//     IMPOSSIBLE, it makes it impossible to do SILENTLY. Anyone may still do it
//     deliberately, in the open, across two files and a review.
//   • An entry may instead carry `admitted: '<why, and what admitted it>'`. Such an
//     entry does not count toward the founding total — and it is REPRINTED on
//     EVERY run, passing or failing, for as long as it exists. A sanctioned
//     append is therefore permanently visible rather than a line nobody reads
//     again. A blank `admitted` FAILS: the escape hatch does not open on an empty
//     string.
//
// STATEMENT IDENTITY is the statement's WHOLE source text (leading comments
// excluded) with every whitespace run collapsed to one space, trimmed. For a
// single-line statement that is the trimmed line verbatim; for a multi-line one
// it is the whole statement flattened, elided past 100 characters with a short
// digest of the full flattened text appended (`… #a1b2c3d4`).
//   WHY NOT THE FIRST LINE (the original design, corrected by outside review
//   2026-08-27): a first-line key is line-shift-stable but NOT UNIQUE. The
//   shipped baseline held two h27 findings whose identity was the bare string
//   `try {`, so fixing one guard while introducing a different unguarded `try {`
//   left the multiset IDENTICAL and PASSED — the exact same-identity swap the
//   ratchet exists to catch (and interior changes to any multiline statement were
//   invisible for the same reason).
//   WHY NOT THE LINE NUMBER: it rots on every unrelated edit above it, which is
//   what the text key was chosen to avoid; AC5c pins that.
//   WHY NOT A KIND/ORDINAL DISCRIMINATOR: an ordinal among same-kind statements
//   shifts whenever an unrelated statement of that kind is added ABOVE — the
//   line-number rot again, one step coarser.
//   The flattened whole text satisfies BOTH properties: it is independent of
//   where the statement sits (stable under unrelated shifts) and it distinguishes
//   two statements that merely start alike (unique per distinct statement). Its
//   accepted cost is that editing a baselined statement's INTERIOR changes its
//   identity and demands a baseline update — correct, since the statement being
//   ratcheted did change.
// Identities are compared as a MULTISET per hook, so two byte-identical
// statements are counted, not collapsed. Every failure prints the exact identity
// string to paste.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCAN_DIR = join(HERE, 'hooks'); // scripts/hooks — sources, not the hooks/ bundles

// ---------------------------------------------------------------------------
// MANIFEST — every scripts/hooks/*.mjs file, classified on MEASURED evidence
// (does it call the imported deny() binding?), not on its name or its intent.
//   blocking — renders a verdict via deny() (exit 2). The boundary rule applies.
//   advisory — contains NO deny() call, so it cannot block anything; a throw
//              costs its advice, never a guarded tool call. Boundary rule N/A.
//   exempt   — blocking, but deliberately excused by a decision record.
// ---------------------------------------------------------------------------
const MANIFEST = {
  'h1-session-start.mjs': 'advisory',
  'h2-selection-inject.mjs': 'advisory',
  'h3-contract-gate.mjs': 'blocking',
  'h4-read-wall.mjs': 'blocking',
  'h5-frozen-tests.mjs': 'blocking',
  'h6-context-watch.mjs': 'blocking',
  'h6-selfcheck.mjs': 'advisory',
  'h7-file-touch.mjs': 'advisory',
  'h8-dispatch-cap.mjs': 'blocking',
  'h9-stop-backstop.mjs': 'blocking',
  'h10-direct-capture.mjs': 'blocking',
  'h13-clear-conductor.mjs': 'advisory',
  'h13-reads-ledger.mjs': 'advisory',
  'h14-bash-allowlist.mjs': 'blocking',
  'h15-store-guard.mjs': 'blocking',
  'h16-event-register.mjs': 'advisory',
  'h17-bash-write-sweep.mjs': 'blocking',
  'h18-test-write-wall.mjs': 'blocking',
  'h19-bash-delivery.mjs': 'advisory',
  'h19-clear-session.mjs': 'advisory',
  'h19-delivery-drain.mjs': 'advisory',
  'h19-dispatch-staging.mjs': 'advisory',
  'h19-knowledge-delivery.mjs': 'advisory',
  'h20-mechanism-axis.mjs': 'blocking',
  'h21-delegation-live.mjs': 'advisory',
  'h22-dispatch-register.mjs': 'advisory',
  'h23-output-axis.mjs': 'advisory',
  // THE ONE GENUINE EXEMPTION. Decision gate-exit-lint-h24-masked-exit-codes
  // deliberately REJECTED failing closed on a corrupt config for this gate: a
  // parse error in .sterling/config.json would otherwise deny every Bash command
  // machine-wide — a Bash-wide wedge — so H24 fails OPEN by design and says so in
  // its own header. Its catch calls allow(), and that is the ruling, not a defect.
  'h24-gate-exit-lint.mjs': 'exempt',
  'h25-dispatch-capability.mjs': 'advisory',
  'h26-dispatch-overlap.mjs': 'advisory',
  'h27-dispatch-signatures.mjs': 'blocking',
  'h28-return-contract.mjs': 'advisory',
  'h29-codex-consult-failure.mjs': 'advisory',
};

// ---------------------------------------------------------------------------
// EXEMPTIONS — the JUSTIFICATION register for the `exempt` class. See the header:
// every exempt hook that DENIES must appear here with the governing decision, the
// reason failing closed is wrong for that specific gate, and the exact deny-call
// identities the exemption covers. Anything else about an exempt hook — its
// unguarded top-level statements, its sham catch — is deliberately NOT reported;
// the exemption is precisely a ruling that those do not have to be fixed.
//
// COMPANION OF THE SHIPPED MANIFEST, not of an arbitrary one. `--manifest`
// without `--exemptions` therefore yields an EMPTY register rather than this one:
// justifications written for real hooks cannot govern a fixture's hooks, and
// carrying them over would report every entry here as stale against a scan
// directory that has never heard of h24.
// ---------------------------------------------------------------------------
const EXEMPTIONS = {
  'h24-gate-exit-lint.mjs': {
    decision: 'gate-exit-lint-h24-masked-exit-codes',
    reason:
      "H24 gates EVERY Bash command. Decision gate-exit-lint-h24-masked-exit-codes explicitly REJECTED failing closed on a corrupt config for this one gate: a parse error in .sterling/config.json would otherwise deny every Bash command machine-wide — a Bash-wide wedge, which is a worse outcome than losing one lint. So its catch calls allow(), by ruling, and the hook says so in its own header. The exemption covers the FAIL-OPEN POSTURE only; it is not a licence for the hook to grow new verdicts unexamined, which is what the `denials` list below pins.",
    // H24's ONE verdict (h24-gate-exit-lint.mjs:214), under the same
    // whole-flattened-statement identity the baseline uses. Measured by running
    // this check, never hand-typed.
    denials: [
      "deny( `H24: gate invocation masked — '${gate}' is followed at top level by '${sep}', which swallows … #95f20af2",
    ],
  },
};

// ---------------------------------------------------------------------------
// BASELINE — the KNOWN-OPEN debt at the time this check landed, measured by
// running this checker, never hand-guessed. It may only ever SHRINK: adding an
// entry here is admitting a new hole, and the review that lets one in should say
// why in the commit. Delete an entry in the same change that fixes its statement.
//
// REMEASURED 2026-08-27 after the outside review that made the catch rule
// UNCONDITIONAL, added the `deny-arg:` class, and replaced first-line identities
// with whole-flattened-statement ones. What moved, exactly:
//   • 21 entries were RESPELLED, not added: the same multi-line statements under
//     the new identity. No statement entered or left the finding set from the
//     reachability change — every top-level try credited as a boundary before is
//     still credited, because every real catch denies on its first statement.
//   • 13 entries are NEW and all one shape: `deny(environmentDefectDenial(…))`,
//     a CALL in the denial's argument list (h3 ×2, h4, h5, h14, h15 ×5, h17 ×2,
//     h18). They are real, not pedantic — h3-contract-gate.mjs:214 already
//     carries a comment about exactly this hazard and calls its `input?.agent_id`
//     spelling "DEFENCE IN DEPTH". Closing them means precomputing the denial
//     text inside the guarded body, which is a change to thirteen live gates and
//     belongs in its own reviewed slice, not in the change that first detects it.
//     The rule is not weakened to hide them: h8/h9-style denials over templates
//     and guarded reads are NOT flagged, so the class discriminates.
// ---------------------------------------------------------------------------
const BASELINE = {
  'h3-contract-gate.mjs': [
    { statement: "deny-arg: deny( environmentDefectDenial( 'H3', `[stdin] hook input could not be read or parsed (${(e && e.mess … #3c24039a" },
    { statement: "deny-arg: deny( environmentDefectDenial('H3', `Contract evaluation failed (${(e && e.message) || e}) — failing … #5be35c64" },
  ],
  'h4-read-wall.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: 'let target = input.tool_input?.file_path;' },
    // HASH ROTATED 2026-08-27 (#ba7e44c7 -> #7715b6d0), NOT a new hole and NOT a
    // shrink: the SAME founding statement, whose interior changed when its
    // case-folding was corrected to the drive-aware samePath rule (board
    // c1c53267 — unconditional toLowerCase is right on NTFS and wrong on a
    // case-sensitive filesystem). The header's accepted cost at the identity
    // section is exactly this, and its instruction to RE-EXAMINE on edit was
    // followed: the underlying debt is that this block runs before the deny
    // decision outside a denying try. Fixing it means restructuring a BLOCKING
    // hook's fail-closed boundary, which is its own slice with its own review,
    // not a drive-by inside a path-predicate change. Count stays 107.
    { statement: "if (input.tool_name === 'Grep') { const mode = input.tool_input?.output_mode; if (mode === undefined … #7715b6d0" },
    { statement: 'const rel = repoRel(target, input.cwd);' },
    { statement: 'if (!rel) allow();' },
    { statement: 'const DOC_RE = /\\.(md|txt|rst|adoc)$/i;' },
    { statement: "if (DOC_RE.test(rel) || rel.startsWith('docs/')) allow();" },
    { statement: "deny-arg: deny(environmentDefectDenial('H4', `Read-wall evaluation failed (${(e && e.message) || e}) — failing … #a003412a" },
  ],
  'h5-frozen-tests.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: "deny-arg: deny(environmentDefectDenial('H5', `Frozen-test evaluation failed (${(e && e.message) || e}) — faili … #675bf8f9" },
  ],
  'h6-context-watch.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: "if (!input.agent_id) { const s = openStore(input.cwd); if (s) { try { s.recordCheckSkipped('context- … #b7cb2775" },
    { statement: 'const config = loadConfig(input.cwd);' },
    { statement: "const cw = { warn_pct: 60, block_pct: 95, mode: 'observe', windows: { default: 200_000 }, ...(config … #a75af701" },
    { statement: 'const store = openStore(input.cwd);' },
    { statement: 'const run = store ? store.getRun() : undefined;' },
    { statement: 'const now = new Date().toISOString();' },
    { statement: 'try { const transcript = deriveAgentTranscript(input.transcript_path, input.agent_id); const { usage … #749551c0' },
  ],
  'h8-dispatch-cap.mjs': [
    { statement: 'const SLICE_MARKER_RE = /^STERLING-SLICE /m;' },
    { statement: 'const SLICE_WAIVER_RE = /^SLICE-WAIVED: .+/m;' },
    { statement: 'const BREADTH_MARKER_RE = /^STERLING-SLICE run=\\S+ phase=(\\S+) role=\\S+ staged=\\S+$/m;' },
    { statement: 'const input = readStdin();' },
    { statement: 'const agentType = input.tool_input?.subagent_type;' },
    { statement: 'if (!agentType) allow();' },
  ],
  'h9-stop-backstop.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: 'if (input.stop_hook_active) allow();' },
  ],
  'h10-direct-capture.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: 'const residueLines = await (async () => { try { return await computeDeadDispatchResidue(input.cwd, i … #f5de6cfe' },
    { statement: 'const store = openStore(input.cwd);' },
    { statement: "if (!store) { if (residueLines.length) process.stderr.write(residueLines.join('\\n\\n')); allow(); }" },
    { statement: "const touchesPath = join(input.cwd, '.sterling', 'transient', 'touches.json');" },
    { statement: "const eventsPath = join(input.cwd, '.sterling', 'transient', 'session-events.json');" },
    { statement: "const nagMarker = join(input.cwd, '.sterling', 'transient', 'capture-nagged.json');" },
    { statement: "try { if (store.getRun()) allow(); // pipeline runs are H9's territory; do NOT clear registers const … #e0daca4c" },
  ],
  'h14-bash-allowlist.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: "deny-arg: deny(environmentDefectDenial('H14', `Allowlist evaluation failed (${(e && e.message) || e}) — failin … #5a513cb1" },
  ],
  'h15-store-guard.mjs': [
    { statement: 'if (!inSterlingProject) allow();' },
    { statement: "const command = String(input.tool_input?.command ?? '');" },
    { statement: 'const STORE_MENTION_RE = /\\.sterling(?![\\w.-])|sterling\\.db/i;' },
    { statement: 'const DB_MENTION_RE = /sterling\\.db/i;' },
    { statement: 'if (!mentionsStore) allow();' },
    { statement: "const READONLY_VERBS = new Set([ 'grep', 'egrep', 'fgrep', 'zgrep', 'rgrep', 'ls', 'cat', 'head', 't … #9a862709" },
    { statement: "const GIT_READONLY_SUBVERBS = new Set([ 'log', 'show', 'diff', 'grep', 'ls-files', 'branch', 'cat-fi … #cdd414b4" },
    { statement: "const GIT_WRITE_SUBVERBS = new Set(['checkout', 'restore', 'clean', 'rm', 'stash', 'mv']);" },
    { statement: "const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);" },
    { statement: "const GIT_GLOBAL_BARE_FLAGS = new Set(['--no-pager', '-p', '-P', '--paginate', '--no-optional-locks' … #ad00178d" },
    { statement: 'const FIND_MUTATING_FLAGS_RE = /(^|\\s)-(delete|fdelete|execdir|exec|ok)\\b/;' },
    { statement: "const INTERPRETER_WORDS = new Set(['node', 'nodejs', 'bash', 'sh', 'zsh', 'python', 'python3']);" },
    { statement: 'const PLAIN_WORD_RE = /^[A-Za-z0-9_./~+-]+$/;' },
    { statement: 'let offending = null;' },
    { statement: 'let offendingIsDbSeal = false;' },
    { statement: 'if (!offending) allow();' },
    // RE-MINTED 2026-08-27, not appended: board 2ca5d977 added one PROVENANCE
    // line to each of these two denials, which changed the statements' TEXT and
    // therefore their identity digests. REVERTED 2026-08-27 when the H15 lane was
    // PARKED (finding cc35e43c: the clone-provenance check binds the SPELLING, not
    // the file bash executes — an executed symlink bypass). The digests below are
    // the HEAD 0e01c42 originals; if that lane is unparked, swap them back to
    // #1b7829a6 / #729c93fa in the same change. Nothing about their fail-closed status moved and no statement
    // entered or left the finding set, so this was a DELETE-AND-ADD of two
    // identities and FOUNDING_BASELINE_TOTAL stays 107. This is the detector
    // re-mint loop board 92f7e826 (identity schema v3) exists to address — a
    // text edit to a baselined statement looks exactly like new debt.
    { statement: 'if (offendingIsDbSeal) { const match = DB_MENTION_RE.exec(command); const matchedText = match ? matc … #d2276435' },
    // The terminal verdict itself. Its argument list is executable code
    // (`allowScripts.join(', ')`), so a throw there voids the gate at the very
    // moment it was about to deny — hence a finding like any other. (It is a
    // top-level statement, so it is caught by the statement rule; the deny-arg
    // entries below are the same hazard inside the CATCH handlers.)
    { statement: "deny( 'H15: shell write access to the Sterling store is denied — the store is read and written throu … #208cc889" },
    { statement: "deny-arg: deny( environmentDefectDenial( 'H15', `[stdin] hook input could not be read or parsed (${(e && e.mes … #5ae443d6" },
    { statement: "deny-arg: deny( environmentDefectDenial( 'H15', `[cwd] the hook input's cwd could not be resolved to a project … #11a2e619" },
    { statement: "deny-arg: deny( environmentDefectDenial( 'H15', `Internal error while preprocessing the command text for the s … #25d119c3" },
    { statement: "deny-arg: deny( environmentDefectDenial('H15', `Store access denied — .sterling/config.json is unreadable (${e … #76426f50" },
    { statement: "deny-arg: deny( environmentDefectDenial( 'H15', `Internal error while evaluating shell command safety (${e.mes … #64590735" },
  ],
  'h17-bash-write-sweep.mjs': [
    { statement: "const BASELINE_GLOBS = ['.claude/agents/**', '.sterling/config.json', '.claude/settings*.json'];" },
    { statement: "const NO_RUN = 'no-run';" },
    { statement: "const PROCFS_FD_DIR = process.env.STERLING_H17_PROCFS_FD_DIR || '/proc/self/fd';" },
    { statement: "const IS_WIN32 = process.platform === 'win32';" },
    { statement: "const UNATTESTABLE_SYMLINK = 'symlink-target';" },
    { statement: "const UNATTESTABLE_FILE_BYTES = 'file-bytes-unstable';" },
    { statement: 'const PROC_SUPER_MAGIC = 0x9fa0n;' },
    { statement: 'let rootAnchorFd = null;' },
    { statement: 'let rootAnchorDir = null;' },
    { statement: 'let rootAnchorCwd = null;' },
    { statement: 'const HASH_CHUNK_BYTES = 64 * 1024;' },
    { statement: 'const HASH_STABILITY_ATTEMPTS = 3;' },
    { statement: 'const MAX_WALK_NODES = 10_000;' },
    { statement: 'const MAX_WALK_DEPTH = 64;' },
    { statement: 'const MAX_RECORD_BYTES = 16 * 1024 * 1024;' },
    { statement: 'const MAX_STAMP_BYTES = 8 * 1024 * 1024;' },
    { statement: "class WalkBudgetError extends Error { constructor(message, budget) { super(message); this.name = 'Wa … #00df15c1" },
    { statement: "class FileUnstableError extends Error { constructor(message) { super(message); this.name = 'FileUnst … #8bb9e374" },
    { statement: 'const WALK_BUDGET = newWalkBudget();' },
    { statement: "const STATE_FIELDS = { absent: ['exists', 'index'], file: ['exists', 'type', 'mode', 'index', 'sha25 … #c1107843" },
    { statement: 'const cwd = input.cwd;' },
    { statement: 'if (!input.agent_id) allow();' },
    { statement: 'const secureIoReason = secureIoUnavailableReason(cwd);' },
    { statement: "if (secureIoReason) { deny( environmentDefectDenial( 'H17', `${secureIoReason} — this hook's descrip … #25b0f89d" },
    { statement: 'const event = input.hook_event_name;' },
    { statement: "if (event === 'PreToolUse') { try { const store = openStore(cwd); let runId = NO_RUN; try { const ru … #10429a2d" },
    { statement: "deny-arg: deny( environmentDefectDenial( 'H17', `[stdin] hook input could not be read or parsed (${(e && e.mes … #9c89b8db" },
    { statement: "deny-arg: deny( environmentDefectDenial('H17', `Enforcement verification failed (${(e && e.message) || e}) — f … #3c876005" },
  ],
  'h18-test-write-wall.mjs': [
    { statement: 'const input = readStdin();' },
    { statement: 'const toolPath = input.tool_input?.file_path;' },
    { statement: 'if (!toolPath) allow();' },
    { statement: "deny-arg: deny(environmentDefectDenial('H18', `Write-gate evaluation failed (${(e && e.message) || e}) — faili … #870ecba0" },
  ],
  'h20-mechanism-axis.mjs': [
    { statement: 'const MAX_DECISIONS = 5;' },
    { statement: 'const NARROW_CLIP = 700;' },
    { statement: 'const QUESTION_WORDS_RE = /\\b(where|what|which|who|whom|whose|when|why|how|does|do|did|is|are|was|we … #e6205657' },
    { statement: 'const input = readStdin();' },
    { statement: 'const outgoing = outgoingProposalText(input.tool_input);' },
    { statement: 'if (!outgoing) allow();' },
    { statement: 'const isQuestion = Array.isArray(input.tool_input?.questions);' },
    { statement: "const isConsult = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__codex__');" },
    { statement: 'const store = openStore(input.cwd);' },
    { statement: 'if (!store) allow();' },
    { statement: 'try { const terms = extractAxisTerms(outgoing, MAX_RANK_TERMS); if (terms.length < AXIS_MIN_HITS) al … #0ed98769' },
  ],
  // The two entries the outside review named: under the old first-line identity
  // BOTH were the bare string 'try {', so the multiset could not tell them apart
  // and a same-identity swap passed. They are distinct now.
  'h27-dispatch-signatures.mjs': [
    { statement: "const MARKER = 'STERLING-SIGNATURES';" },
    { statement: 'try { input = readStdin(); } catch (e) { // Internal failure — the stdin contract itself is broken, … #f6a361d6' },
    { statement: "try { // Not a Sterling project — no ceremony (P1), same DB-file marker every // other hook in this … #70e17b43" },
  ],
};

// THE GROWTH LOCK (see the header). The number of baseline entries above that do
// NOT carry an `admitted` justification. Compared EXACTLY: fix a hook, prune its
// entry, and LOWER this number in the same change — the diff then shows the
// ratchet turning the only direction it is allowed to turn. A number going UP in a
// diff is an append, and it is meant to be as conspicuous as that sounds.
const FOUNDING_BASELINE_TOTAL = 107;

const CLASSES = new Set(['blocking', 'advisory', 'exempt']);
const LABEL = 'fail-closed boundary';

function fail(message) {
  console.error(`${LABEL} FAILED: ${message}`);
  process.exit(1);
}

const FLAGS = new Set(['--scan-dir', '--manifest', '--baseline', '--exemptions', '--founding-total']);

function parseArgs(argv) {
  const out = { scanDir: null, manifest: null, baseline: null, exemptions: null, foundingTotal: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.has(flag)) {
      fail(`unrecognized argument '${flag}'. Usage: node scripts/check-failclosed-boundary.mjs [--scan-dir <dir>] [--manifest <file>] [--baseline <file>] [--exemptions <file>] [--founding-total <n>]`);
    }
    if (value === undefined) fail(`'${flag}' needs a value.`);
    if (flag === '--scan-dir') out.scanDir = value;
    if (flag === '--manifest') out.manifest = value;
    if (flag === '--baseline') out.baseline = value;
    if (flag === '--exemptions') out.exemptions = value;
    if (flag === '--founding-total') {
      if (!/^\d+$/.test(value)) fail(`'--founding-total' needs a non-negative integer, got '${value}'.`);
      out.foundingTotal = Number(value);
    }
    i += 1;
  }
  return out;
}

function readJson(path, what) {
  const abs = resolvePath(process.cwd(), path);
  if (!existsSync(abs)) fail(`--${what} file '${path}' does not exist.`);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    fail(`--${what} file '${path}' could not be read: ${(e && e.message) || e}`);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`--${what} file '${path}' must contain a JSON object.`);
    }
    return parsed;
  } catch (e) {
    fail(`--${what} file '${path}' is not valid JSON: ${(e && e.message) || e}`);
  }
  return null; // unreachable; fail() exits
}

// --- AST helpers -----------------------------------------------------------

function eachNode(node, visit) {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

// The CALL SPELLINGS through which the imported deny binding is reachable in this
// file. Two import shapes are recognized, and each contributes the spelling a
// call site would actually use:
//   • named import   — `import { deny }` / `import { deny as denyStore }`
//                      -> the LOCAL name ('deny', 'denyStore'), matched against a
//                         bare call `deny(...)`.
//   • namespace import — `import * as common from './lib/common.mjs'`
//                      -> the QUALIFIED spelling 'common.deny', matched against
//                         `common.deny(...)`.
// The namespace arm was a documentation-only claim until 2026-08-27: the comment
// here said namespace imports were handled by calleeName's property arm, but that
// arm returned the bare property name against a set seeded ONLY from named
// imports, so `common.deny('blocked')` matched NOTHING — an advisory-labelled hook
// that denies through a namespace import passed the manifest cross-check. The
// same property arm made the converse error: with any named `deny` in scope, an
// unrelated `whatever.deny()` was credited as the imported binding.
//
// RESIDUAL — stated flat, because overclaiming on an enforcement surface is
// anti_pattern 586bccdc. Matching is by NAME SPELLING, not scope resolution:
//   • a local variable or parameter that SHADOWS an imported `deny` is still
//     credited, and a re-aliased binding (`const d = deny; d(...)`) is not;
//   • only ONE level of namespace access is recognized — `ns.deny(...)` yes,
//     `ns.sub.deny(...)` no;
//   • a method call on an object that merely SHARES a namespace import's name is
//     indistinguishable from the import and is credited;
//   • no module specifier is checked: `import * as x from 'node:fs'` would make
//     `x.deny(...)` count. No hook imports a namespace today (measured), so this
//     is a latent imprecision, not a live one.
// Full scope resolution would need a type checker over the whole program; it is
// deliberately out of scope and is NOT claimed anywhere in this file.
function denyBindingNames(sourceFile) {
  const names = new Set();
  for (const st of sourceFile.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const bindings = st.importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === 'deny') names.add(el.name.text);
      }
    } else if (ts.isNamespaceImport(bindings)) {
      names.add(`${bindings.name.text}.deny`);
    }
  }
  return names;
}

// The spelling of a call's callee: 'deny' for `deny(...)`, 'common.deny' for
// `common.deny(...)`. Anything deeper (`a.b.deny(...)`, `arr[i](...)`) is null and
// is never credited — see the residual note above.
function calleeName(call) {
  const target = call.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && ts.isIdentifier(target.name)) {
    return `${target.expression.text}.${target.name.text}`;
  }
  return null;
}

function callsAnyOf(node, names) {
  let hit = false;
  eachNode(node, (n) => {
    if (hit || !ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (name && names.has(name)) hit = true;
  });
  return hit;
}

// --- unconditional reachability ---------------------------------------------
// "Does executing this run a call to one of `names`, on EVERY path?" This is what
// separates a real fail-closed handler from a hollow one; callsAnyOf above answers
// only "does the text contain such a call anywhere", which `if (false) deny()`
// satisfies.

function unwrap(expr) {
  let e = expr;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e))) e = e.expression;
  return e;
}

// The expression is A CALL to one of `names`, evaluated unconditionally — not a
// call buried inside a ternary, a `&&`, or another call's arguments.
function isDirectCallTo(expr, names) {
  const e = unwrap(expr);
  if (!e || !ts.isCallExpression(e)) return false;
  const name = calleeName(e);
  return name !== null && names.has(name);
}

function alwaysCalls(st, names) {
  if (!st) return false;
  if (ts.isExpressionStatement(st)) return isDirectCallTo(st.expression, names);
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.some((d) => d.initializer && isDirectCallTo(d.initializer, names));
  }
  if (ts.isReturnStatement(st)) return !!st.expression && isDirectCallTo(st.expression, names);
  if (ts.isBlock(st)) return blockAlwaysCalls(st, names);
  if (ts.isLabeledStatement(st)) return alwaysCalls(st.statement, names);
  // An `if` counts ONLY when BOTH arms deny — that is what makes it unconditional.
  if (ts.isIfStatement(st)) {
    return !!st.elseStatement && alwaysCalls(st.thenStatement, names) && alwaysCalls(st.elseStatement, names);
  }
  // A nested try counts only when no path through it can skip the call: either the
  // finally always calls, or the try body does AND its own catch does too (a catch
  // that swallows is precisely how a nested try loses the guarantee).
  if (ts.isTryStatement(st)) {
    if (st.finallyBlock && blockAlwaysCalls(st.finallyBlock, names)) return true;
    if (!blockAlwaysCalls(st.tryBlock, names)) return false;
    return !st.catchClause || blockAlwaysCalls(st.catchClause.block, names);
  }
  // switch / loops / everything else: not guaranteed. A `switch` with a default
  // arm could be proven, but no hook uses that shape and an unproven credit is
  // exactly the hollow-boundary defect this function exists to close.
  return false;
}

function blockAlwaysCalls(block, names) {
  for (const st of block.statements) {
    if (alwaysCalls(st, names)) return true;
    // Control left the block before anything below could run, so a call further
    // down is unreachable on this path.
    if (
      ts.isReturnStatement(st) ||
      ts.isThrowStatement(st) ||
      ts.isBreakStatement(st) ||
      ts.isContinueStatement(st)
    ) {
      return false;
    }
  }
  return false;
}

// A function body (block, or an arrow's expression body) that always denies when
// called.
function bodyAlwaysCalls(body, names) {
  if (!body) return false;
  if (ts.isBlock(body)) return blockAlwaysCalls(body, names);
  return isDirectCallTo(body, names); // concise arrow body
}

// --- throwable denial arguments ---------------------------------------------
// An argument expression that CANNOT throw while being evaluated. Deliberately a
// tiny allow-list, for the same reason the safe-statement list is tiny.

function isGuardedAccess(expr) {
  // The repo's own idiom: `e && e.message` — the property access is short-circuited
  // by the very identifier it reads from, so it cannot throw.
  const e = unwrap(expr);
  if (!e || !ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
  const left = unwrap(e.left);
  const right = unwrap(e.right);
  if (!left || !right || !ts.isIdentifier(left)) return false;
  if (!ts.isPropertyAccessExpression(right) || !ts.isIdentifier(right.expression)) return false;
  return right.expression.text === left.text;
}

function isNonThrowingArg(expr) {
  const e = unwrap(expr);
  if (!e) return false;
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isRegularExpressionLiteral(e) || ts.isBigIntLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e)) return true; // includes `undefined`
  if (ts.isTypeOfExpression(e)) return true; // `typeof x` never throws
  if (isGuardedAccess(e)) return true;
  // `a?.b` — optional chaining is the other form that cannot throw on a nullish base.
  if (ts.isPropertyAccessExpression(e)) {
    return !!e.questionDotToken && ts.isIdentifier(e.expression);
  }
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((span) => isNonThrowingArg(span.expression));
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    const composable =
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken;
    return composable && isNonThrowingArg(e.left) && isNonThrowingArg(e.right);
  }
  return false; // calls, element access, unguarded property access, `new`, ternaries, object/array literals
}

// Every deny call written directly inside `block`, paired with whether its
// argument list is evaluable without throwing.
function denyCallsIn(block, names) {
  const calls = [];
  eachNode(block, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (name === null || !names.has(name)) return;
    calls.push({ call: n, throwable: n.arguments.some((a) => !isNonThrowingArg(a)) });
  });
  return calls;
}

// A catch that calls a LOCAL helper which itself denies is still fail-closed —
// h-hooks wrap their denial text in helpers. Fixpoint over the file's own
// functions; cross-file helpers are not resolvable and are not credited. A helper
// is credited only when calling it ALWAYS denies (bodyAlwaysCalls): a helper that
// denies on one branch is exactly the hollow guarantee the catch rule rejects, and
// crediting it there would just move the hole one call deep.
function denyReachingNames(sourceFile) {
  const reaching = denyBindingNames(sourceFile);
  const functions = new Map();
  for (const st of sourceFile.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      functions.set(st.name.text, st.body);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!d.initializer || !ts.isIdentifier(d.name)) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
          functions.set(d.name.text, d.initializer.body);
        }
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of functions) {
      if (reaching.has(name)) continue;
      if (bodyAlwaysCalls(body, reaching)) {
        reaching.add(name);
        changed = true;
      }
    }
  }
  return reaching;
}

function isFailClosedBoundary(st, reaching) {
  return ts.isTryStatement(st) && !!st.catchClause && blockAlwaysCalls(st.catchClause.block, reaching);
}

// THE TINY SAFE LIST. Anything not named here is a finding when it sits outside a
// fail-closed boundary in a blocking hook.
function isSafeOutsideBoundary(st) {
  if (ts.isImportDeclaration(st)) return true; // static import: linked before the body runs (see the header's limitation note)
  if (ts.isFunctionDeclaration(st)) return true; // hoisted declaration; its BODY only runs when called
  if (ts.isVariableStatement(st)) {
    // `let input;` binds nothing and cannot throw. One initializer anywhere in the
    // declaration list is arbitrary executable code, so the whole statement counts.
    return st.declarationList.declarations.every((d) => d.initializer === undefined);
  }
  return false;
}

// See the STATEMENT IDENTITY paragraph in the header for why this is the whole
// flattened statement rather than its first line or its line number. The elision
// keeps a baseline entry readable; the digest keeps two statements that share
// their first 100 characters distinguishable.
const IDENTITY_MAX_CHARS = 100;

function flattenIdentity(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= IDENTITY_MAX_CHARS) return flat;
  const digest = createHash('sha256').update(flat).digest('hex').slice(0, 8);
  // trimEnd so the elision point can never depend on whether the 100th character
  // happened to be a space — an identity nobody can retype is an identity nobody
  // can baseline.
  return `${flat.slice(0, IDENTITY_MAX_CHARS).trimEnd()} … #${digest}`;
}

function statementIdentity(st, sourceFile) {
  return flattenIdentity(st.getText(sourceFile));
}

// A throwable denial argument is a finding about an EXPRESSION, not a top-level
// statement, so it carries its own identity namespace. The prefix also keeps the
// two finding classes from ever colliding inside one hook's multiset.
function denyArgIdentity(call, sourceFile) {
  return `deny-arg: ${flattenIdentity(call.getText(sourceFile))}`;
}

function lineOf(st, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(st.getStart(sourceFile)).line + 1;
}

// Syntax errors, loudly. `parseDiagnostics` is where createSourceFile records
// them; transpileModule is the public-API fallback if a future typescript stops
// exposing it. If NEITHER is available we fail rather than assume the file parsed
// (P5) — silently trusting an unverified parse is how a malformed gate would slip
// through the very check meant to catch it.
function syntaxErrorOf(sourceFile, name, text) {
  const direct = sourceFile.parseDiagnostics;
  let diagnostics;
  if (Array.isArray(direct)) {
    diagnostics = direct;
  } else {
    const transpiled = ts.transpileModule(text, {
      fileName: name,
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.Latest },
    });
    if (!Array.isArray(transpiled.diagnostics)) {
      fail(`this typescript build exposes neither sourceFile.parseDiagnostics nor transpileModule diagnostics, so '${name}' cannot be checked for syntax errors. Refusing to pass an unverified parse.`);
    }
    diagnostics = transpiled.diagnostics;
  }
  if (diagnostics.length === 0) return null;
  const first = diagnostics[0];
  const message = ts.flattenDiagnosticMessageText(first.messageText, ' ');
  const at = typeof first.start === 'number' ? ` (line ${sourceFile.getLineAndCharacterOfPosition(first.start).line + 1})` : '';
  return `${message}${at}`;
}

// --- the check -------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const scanDir = args.scanDir ? resolvePath(process.cwd(), args.scanDir) : DEFAULT_SCAN_DIR;
const manifest = args.manifest ? readJson(args.manifest, 'manifest') : MANIFEST;
// See the EXEMPTIONS header: the shipped register governs the SHIPPED manifest, so
// overriding the manifest without also overriding the exemptions gives an empty
// register — never the shipped one.
const exemptions = args.exemptions ? readJson(args.exemptions, 'exemptions') : args.manifest ? {} : EXEMPTIONS;
const baseline = args.baseline ? readJson(args.baseline, 'baseline') : BASELINE;
// The growth lock governs the SHIPPED baseline — the only list a human can append
// to, and the thing `npm run check` actually reads. A `--baseline` fixture with no
// explicit `--founding-total` is not that list, so the lock stands down for it
// rather than failing every fixture against a constant measured on real hooks.
const foundingTotalDeclared = args.foundingTotal ?? (args.baseline ? null : FOUNDING_BASELINE_TOTAL);

let entries;
try {
  entries = readdirSync(scanDir, { withFileTypes: true });
} catch (e) {
  fail(`scan directory '${scanDir}' could not be read: ${(e && e.message) || e}`);
}
// Direct children only — lib/ holds shared modules, not hooks, and a hook is the
// file the runner executes.
const files = entries
  .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
  .map((e) => e.name)
  .sort();

const unclassified = [];
const badClass = [];
const parseErrors = [];
const mislabeled = [];
const noBoundary = [];
const observed = new Map(); // basename -> [{ line, statement }]
const exemptOnDisk = new Set(); // basenames the manifest classifies exempt, present on disk
const exemptDenials = new Map(); // basename -> [deny-call identity] observed in an exempt hook
const counts = { blocking: 0, advisory: 0, exempt: 0 };

for (const name of files) {
  const cls = manifest[name];
  if (cls === undefined) {
    unclassified.push(name);
    continue;
  }
  if (!CLASSES.has(cls)) {
    badClass.push({ name, cls });
    continue;
  }
  counts[cls] += 1;
  // Recorded BEFORE the read/parse, so an exempt hook that fails to parse is still
  // known to exist and its register entry is not additionally reported as a ghost.
  if (cls === 'exempt') exemptOnDisk.add(name);

  let text;
  try {
    text = readFileSync(join(scanDir, name), 'utf8');
  } catch (e) {
    parseErrors.push({ name, detail: `could not be read: ${(e && e.message) || e}` });
    continue;
  }

  // Never crash on a malformed file: a parse failure is a LOUD failure of this
  // check, not an exception out of the process (and never a silent pass).
  let sourceFile;
  let syntaxError;
  try {
    sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    syntaxError = syntaxErrorOf(sourceFile, name, text);
  } catch (e) {
    parseErrors.push({ name, detail: `could not be parsed: ${(e && e.message) || e}` });
    continue;
  }
  if (syntaxError) {
    parseErrors.push({ name, detail: `could not be parsed: ${syntaxError}` });
    continue;
  }

  const reaching = denyReachingNames(sourceFile);
  const denies = callsAnyOf(sourceFile, denyBindingNames(sourceFile));

  // A label that lies about what the hook can do is itself the defect: an
  // 'advisory' hook that denies IS a blocking gate, and the boundary rule was
  // skipped for it on the strength of the wrong label.
  if (cls === 'advisory' && denies) {
    mislabeled.push(name);
    continue;
  }
  // The exempt class is CROSS-CHECKED, not skipped (board 9f8d4c03). Its boundary
  // rule is excused by ruling; its DENY SET is not — enumerate it and let the
  // EXEMPTIONS register be held to it below. Same binding-name basis as the
  // advisory cross-check directly above, so the two agree on what "can deny" means.
  if (cls === 'exempt') {
    exemptDenials.set(
      name,
      denyCallsIn(sourceFile, denyBindingNames(sourceFile)).map(({ call }) => flattenIdentity(call.getText(sourceFile)))
    );
    continue;
  }
  if (cls !== 'blocking') continue;

  const found = [];
  let boundaries = 0;
  for (const st of sourceFile.statements) {
    if (isSafeOutsideBoundary(st)) continue;
    if (isFailClosedBoundary(st, reaching)) {
      boundaries += 1;
      // The island denies — but a denial whose ARGUMENTS must be computed first
      // can throw before exit 2 is ever reached, voiding the gate from inside the
      // handler built to prevent that. Reported as its own finding (see HOW IT
      // DECIDES step 5); the island keeps its boundary credit.
      for (const { call, throwable } of denyCallsIn(st.catchClause.block, reaching)) {
        if (throwable) found.push({ line: lineOf(call, sourceFile), statement: denyArgIdentity(call, sourceFile) });
      }
      continue;
    }
    found.push({ line: lineOf(st, sourceFile), statement: statementIdentity(st, sourceFile) });
  }
  if (boundaries === 0 && found.length > 0) noBoundary.push(name);
  if (found.length > 0) observed.set(name, found);
}

// --- the exempt-class cross-check ------------------------------------------

const unjustifiedExemptions = []; // exempt + denies, but nothing in the register
const malformedExemptions = []; // register entry that does not carry a real justification
const ghostExemptions = []; // register entry for a hook that is not exempt on disk
const unlistedDenials = []; // a deny in an exempt hook the exemption does not cover
const staleDenials = []; // a listed denial that is no longer in the file

// A justification that cites nothing, or explains nothing, is not a justification.
// Every problem is collected so one run reports the whole entry, not its first flaw.
function exemptionProblems(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return ["must be an object { decision, reason, denials: [ … ] }"];
  }
  const problems = [];
  if (typeof entry.decision !== 'string' || entry.decision.trim() === '') {
    problems.push("needs a non-empty 'decision' naming the governing record (slug or id) that granted this exemption");
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    problems.push("needs a non-empty 'reason' stating why failing CLOSED is wrong for this specific gate");
  }
  if (!Array.isArray(entry.denials) || entry.denials.some((d) => typeof d !== 'string')) {
    problems.push("needs a 'denials' array of the exact deny-call identities this exemption covers");
  }
  return problems;
}

for (const [name, identities] of exemptDenials) {
  const entry = exemptions[name];
  if (entry === undefined) {
    // No deny call means no blocking behaviour, so there is no boundary
    // requirement to retire and nothing to excuse: an exempt hook with ZERO
    // denies legitimately needs NO entry. Not requiring one is the ONLY thing a
    // zero-deny hook is excused from — see directly below.
    if (identities.length === 0) continue;
    unjustifiedExemptions.push({ name, identities });
    continue;
  }
  // AN ENTRY THAT EXISTS IS ALWAYS CHECKED, INCLUDING WHEN THE HOOK NOW DENIES
  // NOTHING. This was a FAIL-OPEN INSIDE A FAIL-CLOSED CHECKER (found by two
  // independent reviewers, one outside-family): a bare `if (identities.length
  // === 0) continue;` used to sit ABOVE the lookup and skip the WHOLE
  // cross-check — shape validation and the stale arm included. So deleting an
  // exempt hook's sole deny() while leaving its EXEMPTIONS entry intact passed
  // GREEN: the entry was not a ghost (the ghost check only asks whether the hook
  // is still classified exempt), nothing was unlisted, and the listed denials
  // were never compared against anything. A later deny whose flattened identity
  // happened to match the stale string would then be auto-covered with NO
  // review, and a malformed entry was never validated at all. It contradicted
  // this file's own header both ways ("a listed deny that is gone FAILS as
  // stale"; "a leftover justification must never sit ready to excuse a future
  // move"). Zero observed identities is not "nothing to check": it is the
  // STRONGEST stale signal there is, because EVERY listed denial is gone.
  const problems = exemptionProblems(entry);
  if (problems.length > 0) {
    malformedExemptions.push({ name, problems });
    continue;
  }
  // Multiset by identity, both directions — the same rule and the same reason as
  // the baseline ratchet: a count would let one denial be swapped for another.
  const remaining = entry.denials.map((d) => d.trim());
  for (const identity of identities) {
    const at = remaining.indexOf(identity);
    if (at === -1) unlistedDenials.push({ name, identity });
    else remaining.splice(at, 1);
  }
  for (const identity of remaining) staleDenials.push({ name, identity });
}

for (const name of Object.keys(exemptions).sort()) {
  if (!exemptOnDisk.has(name)) ghostExemptions.push(name);
}

// --- the exact-finding ratchet ---------------------------------------------

const newFindings = [];
const staleBaseline = [];
const admittedEntries = [];
let foundingTotal = 0;
const hookNames = new Set([...observed.keys(), ...Object.keys(baseline)]);
let baselinedCount = 0;
let baselinedHooks = 0;

for (const name of [...hookNames].sort()) {
  const found = observed.get(name) ?? [];
  const rawEntries = baseline[name];
  if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
    fail(`baseline entry for '${name}' must be an array of { "statement": "…" } objects.`);
  }
  const expected = (rawEntries ?? []).map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.statement !== 'string') {
      fail(`baseline entry for '${name}' must be an object with a string "statement" field.`);
    }
    // THE GROWTH LOCK's two doors (see the header). No `admitted` field means the
    // entry is one of the founding, measured set and counts toward the locked
    // total. An `admitted` entry is a deliberate, justified append: it does NOT
    // count, and it is reprinted on every run for as long as it exists.
    if (entry.admitted === undefined) {
      foundingTotal += 1;
    } else if (typeof entry.admitted !== 'string' || entry.admitted.trim() === '') {
      fail(
        `baseline entry for '${name}' has an "admitted" field that is not a non-empty string. An admitted fail-open must name what admitted it — the escape hatch does not open on a blank.`
      );
    } else {
      admittedEntries.push({ name, statement: entry.statement.trim(), admitted: entry.admitted.trim() });
    }
    return entry.statement.trim();
  });
  if (expected.length > 0) {
    baselinedCount += expected.length;
    baselinedHooks += 1;
  }

  // Multiset match by statement identity: two BYTE-IDENTICAL statements (which
  // therefore flatten to the same identity) are counted, never collapsed. Two
  // statements that merely SHARE A FIRST LINE now flatten to different
  // identities — that is the whole point of the whole-statement key.
  const remaining = [...expected];
  for (const finding of found) {
    const at = remaining.indexOf(finding.statement);
    if (at === -1) newFindings.push({ name, ...finding });
    else remaining.splice(at, 1);
  }
  for (const statement of remaining) staleBaseline.push({ name, statement });
}

const manifestGhosts = Object.keys(manifest)
  .filter((name) => !files.includes(name))
  .sort();

// EXACT, never a ceiling: headroom left behind a fix is the silent-append space
// this lock exists to close.
const foundingLockBroken = foundingTotalDeclared !== null && foundingTotal !== foundingTotalDeclared;

// --- report ----------------------------------------------------------------

const failed =
  unclassified.length > 0 ||
  badClass.length > 0 ||
  parseErrors.length > 0 ||
  mislabeled.length > 0 ||
  manifestGhosts.length > 0 ||
  unjustifiedExemptions.length > 0 ||
  malformedExemptions.length > 0 ||
  ghostExemptions.length > 0 ||
  unlistedDenials.length > 0 ||
  staleDenials.length > 0 ||
  foundingLockBroken ||
  newFindings.length > 0 ||
  staleBaseline.length > 0;

// Printed on every run, pass or fail: a blocking hook with no fail-closed island
// at all has nothing guarding it, and that fact should not wait for a finding to
// surface it.
for (const name of noBoundary) {
  console.log(`${LABEL}: NOTICE — ${name} is classified 'blocking' but has no fail-closed boundary (no top-level try whose catch reaches deny()).`);
}

// Likewise on every run, pass or fail: an ADMITTED fail-open is a deliberate
// append to the suppression list, and the price of that door being open at all is
// that it is never quiet again.
for (const a of admittedEntries) {
  console.log(`${LABEL}: ADMITTED FAIL-OPEN — ${a.name}: "${a.statement}" — admitted by: ${a.admitted}`);
}

if (failed) {
  // ALL violations, ONE failure: the check never dies on the first file.
  console.error(`${LABEL} FAILED:`);

  for (const name of unclassified) {
    console.error(`  ${name} — present in ${scanDir} but ABSENT from the manifest. Classify it (blocking / advisory / exempt); a new hook is never silently skipped.`);
  }
  for (const { name, cls } of badClass) {
    console.error(`  ${name} — manifest classification '${cls}' is not one of blocking / advisory / exempt.`);
  }
  for (const name of manifestGhosts) {
    console.error(`  ${name} — named in the manifest but NOT present on disk. The manifest is stale; delete the entry (or restore the file).`);
  }
  for (const { name, detail } of parseErrors) {
    console.error(`  ${name} — ${detail}. A file this check cannot read is a FAILURE, never a pass.`);
  }
  for (const name of mislabeled) {
    console.error(`  ${name} — classified 'advisory' in the manifest, but it CALLS the imported deny() binding. deny() exits 2, so this hook blocks: reclassify it 'blocking' and satisfy the boundary rule, or remove the deny() call.`);
  }
  for (const { name, identities } of unjustifiedExemptions) {
    console.error(`  ${name} — classified 'exempt' and it DENIES (${identities.length} deny call(s)), but NO entry justifies it in the exemption register. 'exempt' retires this hook's fail-closed boundary requirement, so it may not be granted silently: add an entry carrying the governing 'decision', a 'reason' stating why failing closed is wrong for THIS gate, and 'denials' listing exactly:`);
    for (const identity of identities) console.error(`      ${identity}`);
  }
  for (const { name, problems } of malformedExemptions) {
    for (const problem of problems) console.error(`  ${name} — exemption entry ${problem}.`);
  }
  for (const name of ghostExemptions) {
    console.error(`  ${name} — named in the exemption register but NOT classified 'exempt' on disk. The register is stale; delete the entry. A leftover justification must never sit ready to excuse a future move to 'exempt'.`);
  }
  for (const { name, identity } of unlistedDenials) {
    console.error(`  ${name} — an exempt hook's deny is NOT covered by its exemption: ${identity}`);
  }
  if (unlistedDenials.length > 0) {
    console.error("    An exemption is granted to a NAMED DENY SET, never to a file forever. A new verdict in an exempt gate is a new fail-open path, and it has to be ruled on: extend 'denials' deliberately, or move the hook back to 'blocking'.");
  }
  for (const { name, identity } of staleDenials) {
    console.error(`  ${name} — exemption lists a denial that is no longer in the file. DELETE it: ${identity}`);
  }
  if (foundingLockBroken) {
    if (foundingTotal > foundingTotalDeclared) {
      console.error(`  BASELINE APPEND REFUSED — ${foundingTotal} unjustified baseline entry(ies) against a declared founding total of ${foundingTotalDeclared}. The baseline is a list of ACCEPTED FAIL-OPENS and it may only shrink. If a statement genuinely must be admitted, give that entry an "admitted": "<why, and what admitted it>" field — it will then be reprinted on every run instead of blending into the list. Raising the founding total is the other door, and it is deliberately not a quiet one.`);
    } else {
      console.error(`  FOUNDING TOTAL IS STALE — ${foundingTotal} unjustified baseline entry(ies) against a declared founding total of ${foundingTotalDeclared}. An entry was pruned without lowering the number: lower it in the SAME change. The comparison is exact on purpose — a ceiling would leave headroom behind every fix, and headroom is exactly the silent-append space the lock exists to close.`);
    }
  }
  if (newFindings.length > 0) {
    console.error(`  ${newFindings.length} fail-closed finding(s) with no baseline entry:`);
    for (const f of newFindings) {
      console.error(`    ${f.name}:${f.line}  ${f.statement}`);
    }
    console.error('    A plain statement finding runs BEFORE the deny decision and outside any try whose catch unconditionally denies. If it throws, the hook exits 1, the runner reads non-2 as NON-BLOCKING, and the gate is voided — the guarded tool call proceeds unexamined. Move the statement inside a try whose catch calls deny().');
    console.error("    A 'deny-arg:' finding is the same void from INSIDE the handler: evaluating that denial's arguments can throw before deny() ever exits 2. Precompute the message inside the guarded body, or reduce the argument to literals, plain identifiers and guarded reads ((e && e.message) || e).");
  }
  if (staleBaseline.length > 0) {
    console.error(`  ${staleBaseline.length} stale baseline entry(ies) — no matching finding is observed any more. DELETE them; the ratchet only shrinks:`);
    for (const s of staleBaseline) {
      console.error(`    ${s.name} — "${s.statement}"`);
    }
  }
  process.exit(1);
}

const debt =
  baselinedCount > 0
    ? `; ${baselinedCount} known-open statement(s) across ${baselinedHooks} hook(s) remain baselined as DEBT (${foundingTotal} founding, ${admittedEntries.length} admitted) — the ratchet only shrinks`
    : '; no baselined debt remains';
console.log(
  `${LABEL}: ok (${files.length} hook(s) in ${scanDir}: ${counts.blocking} blocking, ${counts.advisory} advisory, ${counts.exempt} exempt${debt})`
);
