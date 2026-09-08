// H15 — store write-path guard (spec §6 H15). PreToolUse
// Bash|PowerShell AND Edit|Write|MultiEdit|NotebookEdit,
// BLOCKING. The store is written through the §10 MCP tool surface ONLY; the
// deny message teaches the right path. Patterns grow incident-by-incident via
// config, never speculatively (adjudicated 2026-06-12 after a live conductor
// bypass). Deliberately store-free: the guard must run even when the store is
// exactly what is being protected.
//
// WRITE-PRECISION (decision 0b4d3c8c, 2026-08-20, superseding 7c0bf504's
// deny-any-mention breadth): the gate now judges each fragment of a compound
// command by what it actually DOES to the store, not by whether it merely
// NAMES a store path.
//   (1) a read-only command on a non-DB store file (config.json, transient/*)
//       is ALLOWED — git log/grep/ls/cat naming such a path is a read, not an
//       out-of-band write.
//   (2) .sterling/sterling.db is SEALED for EVERY verb, reads included — DB
//       access is the MCP surface's job, never raw shell (cat/sqlite3 SELECT
//       stay denied).
//   (3) writes, redirections, and moves/copies INTO .sterling/ stay denied
//       exactly as before.
//   (4) a compound command is denied only when a fragment writes; the denial
//       NAMES the offending fragment (refusal-quality rule d0b88e27).
//   (5) fail-closed on an unparseable config is unchanged — the gate cannot
//       safely evaluate the read/write split without it.
// When a verb's mutability is unclear, the gate errs CLOSED (deny) — the
// allow surface only grows for verbs this file explicitly recognizes as
// read-only, exactly the "grow incident-by-incident" posture above.
//
// PRECISION HARDENING (board 6051f202-fafd-4ef8-8360-74fa0cd8153d): two
// false-positive classes fixed without moving the allow surface.
//   (A) `git` global flags (-C <path>, -c <k=v>, --git-dir/--work-tree/
//       --namespace, --no-pager, -p/-P/--paginate, --no-optional-locks) are
//       skipped before extracting the sub-verb, so `git -C <path> log ...`
//       reads sub-verb "log" instead of falling through to the substring
//       fallback on an unrelated store mention.
//   (B) a redirection is a store write only when its TARGET names a store
//       path — (3) above means "INTO .sterling/", not "any '>' on a line
//       that also names a store path"; an outward redirect on a store READ
//       (`grep foo .sterling/x.json > /tmp/out`, `cat ... 2>/dev/null`) is
//       still a read.
//
// ADVERSARIAL REVIEW ROUND 1 (scripts/tests/h15-precision-adversarial.test.mjs
// ADV-1/2/3): a skipped git global-flag VALUE naming the store now denies
// regardless of the subverb (config-injection / redirected-git-dir gadgets);
// a redirect target must be ONE statically-parseable plain word
// ([A-Za-z0-9_./~+-]) or the gate fails closed (command substitution,
// ${VAR} expansion, backticks); a quote-concatenated redirect target
// (`.st''erling/x`) is checked against the quote-stripped text so splicing
// two unquoted runs across an empty quote cannot dodge the store pattern.
//
// ADVERSARIAL REVIEW ROUND 2 (ADV-4/5/6, same file): a LONE `&` is now a
// fragment separator like `;`/`&&` (was previously swallowed into the
// current fragment, letting a read-only first word launder a later
// `&`-backgrounded write — CLOSED); `sed`'s in-place detector now also
// matches the GNU long form `--in-place`/`--in-place=SUFFIX`, not just `-i`
// clusters (CLOSED); `awk` was REMOVED from the unconditional-read-only verb
// set because its own `print > "path"` redirection and `system(...)` call
// are invisible to the shell-level redirect scan — a store-mentioning awk
// fragment now fails closed by default, including a legitimate awk READ of
// a store file (ACCEPTED COST, not a bug — grep/cat are the sanctioned shell
// read path for store files; see ADV-6c).
//
// DISCLOSED, ACCEPTED GAP (not closed — scope-discipline posture, decision
// d53fc7ba: state a known limitation honestly rather than chase it past the
// point of diminishing return): the whitespace-token flag/value tokenizer
// used for git global flags (skipGitGlobalFlags) splits on bare `\s+` and
// does not understand shell quoting WITHIN a flag's value — a value crafted
// as `git -c key="a value"` or `-c key='.sterling/x'` is not re-parsed as a
// single quoted token before the STORE_MENTION_RE check, so a quoted,
// space-containing -c/-C/--git-dir/--work-tree value is a residual blind
// spot the fixes above do not cover. Named here rather than silently
// carried, per the same "disclose limitations, don't bury them" rule that
// produced d53fc7ba for H14.
//
// ── THE STRUCTURED-WRITE ARM (2026-09-06) ───────────────────────────────────
// Everything above judges a SHELL COMMAND. Until this arm landed, that was the
// ONLY channel H15 guarded, and hooks.json registered it on Bash|PowerShell
// alone — so an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` straight into
// `.sterling/` was denied by NO hook at all. Of the hooks that DO fire on
// Edit/Write, h3 never denies store writes, h7/h13 only record the path, and
// h19 allows `.sterling/` through BY DESIGN. Measured in a consuming project:
// an identical in-place edit denied via Bash SUCCEEDED via the Edit tool,
// which put `.sterling/review-ledger.json` — the file the merge gate reads to
// refuse unreviewed commits — inside every writing agent's reach.
//
// This arm is the SAME BOUNDARY through additional tool channels, not a new
// enforcement program, and it does not reopen decision ccc44a8e: that ruling
// is terminal for the BASH-CHANNEL DENY METHOD (it rejects resolve-then-
// classify redesigns of the command-text classifier), not for which tool names
// H15 is registered against. The command-text classifier below is untouched.
//
// THE ARM ITSELF — its invariant, its four numbered steps, its non-guarantees,
// and the measurements behind them — is documented AT THE CODE, below the cwd
// probe and above the not-in-project allow. That placement is deliberate and it
// is the round-3 lesson: this file previously carried the arm's rationale HERE
// and its logic in three separate containment systems up to 300 lines apart, so
// a reader needed the git history to tell which paragraph governed which check
// (decision `h15-structured-write-arm-rebuilt-from-blank-third-round-trigger`).
// ONE arm, ONE place, ONE invariant — do not re-document it here.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readStdin, deny, allow, loadConfig, environmentDefectDenial } from './lib/common.mjs';
import { parseConfig } from '@sterling/schemas';
// THE shipped sanctioned list, imported rather than copied — decision 77c5b85a
// makes SANCTIONED_SCRIPTS and the config.ts `allow_scripts` default
// element-identical and holds that with a bidirectional drift pin in
// scripts/tests/store-remediation.test.mjs. A second literal here would be a
// third copy with no pin holding it. The module is dependency-free by contract
// (node builtins only), so it costs this bundle nothing.
import { appendMissingSanctioned } from '../lib/store-remediation.mjs';
// ACTIVE-PLUGIN-ROOT PROVENANCE (decision 5b82e94f, adopting 1434cd54 Ruling 3).
// The exemption compares FILE IDENTITY, never spelling — see the invariant
// paragraph at the head of that module, which is the authority for this file's
// sanctioned-script branch.
// R3: resolveActivePluginRoot moved to plugin-root.mjs as the ONE canonical
// module (decision r3-plugin-root-resolver-canonical-module-win32-forward-
// slash-drive-word-backslash-provisional) — sanctioned-provenance.mjs no
// longer re-exports it.
import { resolveActivePluginRoot } from './lib/plugin-root.mjs';
import { sanctionedProvenance } from './lib/sanctioned-provenance.mjs';

// THE INPUT BOUNDARY IS ITSELF A GATE — same F5 class as the preprocessing
// wrap below (board 01afa03e; the fix H17 already carries for its own
// readStdin). readStdin() reads fd 0 and JSON.parses it, both unguarded:
// called bare at the top level, a truncated or non-JSON stdin threw OUT of the
// hook, Node exited 1, and exit 1 is the platform's NON-BLOCKING code — the
// runner reads it as ALLOW and the command runs unexamined. A gate that cannot
// read its own input has verified NOTHING and must fail CLOSED (P5).
//
// EXPLICITLY ACCEPTED AVAILABILITY TRADEOFF (outside-family review 2026-08-26,
// conductor-accepted): H15 is GLOBALLY registered, so this denial reaches the
// conductor's own Bash too. A persistent runner/input fault therefore blocks
// the repair commands as well, and the session can wedge until restart. That
// is accepted deliberately — under broken infrastructure the alternative is a
// store guard that silently passes every command it never read — but it is an
// availability cost, not a free win, and it is recorded here rather than
// discovered later.
//
// AND THE COST IS WIDER THAN "THIS PROJECT" (roster review 2026-08-27): this
// catch sits ABOVE the `if (!inSterlingProject) allow()` branch below, because
// the project is unknowable before the input parses. So a broken runner denies
// Bash in EVERY project on the machine, not only Sterling ones. That ordering
// is forced — the probe needs `input.cwd` — but the blast radius is the whole
// machine, and stating it as "the conductor's own Bash" would understate it.
//
// AUDIENCE IS UNKNOWABLE ON THIS PATH, which is why the wording carries BOTH
// resolutions: the field that names the audience (`agent_id`) rides in the very
// input that failed to parse. `agentId: undefined` selects the repair-facing
// instruction (correct for the conductor, who has no one above to escalate to)
// and the detail states the agent-facing half explicitly, so a spawned agent is
// never told to "let the conductor fix it" when it may BE the conductor reading.
let input;
try {
  input = readStdin();
} catch (e) {
  deny(
    environmentDefectDenial(
      'H15',
      `[stdin] hook input could not be read or parsed (${(e && e.message) || e}) — a gate that cannot read its own input has verified nothing, so it fails CLOSED (P5). ` +
        `An uncaught throw here would exit non-2, which the hook runner treats as NON-BLOCKING (the command would be ALLOWED unexamined). ` +
        `IF YOU ARE A SPAWNED AGENT: do not diagnose, repair, or retry H15 yourself — exit \`blocked\`, citing this message VERBATIM. Otherwise:`,
      { agentId: undefined }
    )
  );
}

// The project probe is INSIDE the boundary too (outside-family review finding,
// same F5 class as the wraps above and below). `join()` throws a TypeError on a
// non-string cwd — parsed JSON carrying `cwd: ["/x"]` survives readStdin's
// normalization unchanged and reaches here — and that throw would exit non-2,
// allowing the command unexamined. Ordinary platform input always carries a
// string cwd, so this is an invariant repair rather than a demonstrated
// command-controlled bypass: the rule this file's own roster sweep established
// is that EVERY statement before the deny decision sits inside the boundary,
// and the hook that established it must not be the one violating it.
let inSterlingProject;
try {
  inSterlingProject = Boolean(input.cwd) && existsSync(join(input.cwd, '.sterling'));
} catch (e) {
  deny(
    environmentDefectDenial(
      'H15',
      `[cwd] the hook input's cwd could not be resolved to a project path (${(e && e.message) || e}); the gate fails closed rather than risk a silent void.`,
      // OPTIONAL CHAIN, not decoration: a fail-closed HANDLER that can itself
      // throw exits non-2 and voids the gate (the F5 class this file exists to
      // avoid). MEASURED 2026-08-27: no reachable input lands here with a
      // non-object `input` — stdin `null` throws inside readStdin's own
      // `projectRoot(input.cwd)` and is caught above, and a primitive/array
      // input yields `undefined` cwd, which takes the not-a-Sterling-project
      // allow branch without ever throwing. So this is belt-and-braces on an
      // unreachable path, kept because the cost is one character and the
      // failure mode it forecloses is a silently voided blocking gate.
      { agentId: input?.agent_id }
    )
  );
}
// ── STRUCTURED-WRITE ARM ─────────────────────────────────────────────────────
// THE INVARIANT, in one paragraph, and this arm answers to nothing else
// (decision `h15-structured-write-arm-rebuilt-from-blank-third-round-trigger`;
// the frozen pins are scripts/tests/h15-structured-write.test.mjs). For a tool
// call that writes a file through the platform's STRUCTURED surface — Edit,
// Write, MultiEdit, NotebookEdit — H15 DENIES when the call's RESOLVED
// destination lies inside any `.sterling` directory, and ALLOWS otherwise.
// RESOLVED means normalized per the applicable path grammar BEFORE any verdict
// is reached: `..` collapsed, separators canonical FOR THE HOST, and case
// compared so that a case-insensitive filesystem cannot alias a differing
// spelling past the check. THE DESTINATION DECIDES, NEVER THE CALLER'S CWD — a
// call launched anywhere may not write any Sterling store. Anything that leaves
// the destination genuinely undecidable — an absent, empty, non-string or
// unresolvable path, an unrecognized tool name, or a canonicalization failure
// needed to reach a verdict — DENIES (P5).
//
// THE ORDER, which is the mechanism and not a style choice:
//   1. EXTRACT the destination per tool_name — Edit/Write/MultiEdit ->
//      tool_input.file_path, NotebookEdit -> tool_input.notebook_path.
//      MultiEdit's `edits[]` carries MUTATIONS, never additional destinations,
//      so the single top-level file_path is the whole write set. The table is
//      written out rather than copied from a neighbouring hook on purpose:
//      h3/h7/h13/h19 all read `file_path` and NONE of them knows about
//      NotebookEdit, so copying any of them would inherit that blind spot into
//      a blocking gate. Bash/PowerShell carry their destination in the command
//      TEXT and fall through to the classifier below; any OTHER tool name is a
//      destination this arm cannot locate, and that denies, naming the tool.
//   2. NORMALIZE, then decide — never on the submitted spelling. This is the
//      round-3 repair: the previous version compared the SUBMITTED components,
//      so it denied `<anywhere>/.sterling/../ordinary.txt` although that
//      destination is `<anywhere>/ordinary.txt` and is in no store at all — a
//      machine-wide FALSE DENIAL of ordinary work, reproduced by an
//      outside-family review against both this source and the shipped bundle.
//      `path.resolve` collapses `..`, `.` and doubled separators under the
//      HOST's grammar, which is also why a literal backslash stays an ordinary
//      filename character on POSIX and IS a separator on win32.
//   3. LEXICAL COMPONENT RULE, cwd-independent: a destination carrying a path
//      COMPONENT spelled `.sterling` (case-folded, and on win32 with the
//      component's TRAILING dots/spaces dropped first) is inside a store,
//      whosever store it is. WHOLE COMPONENT, never a prefix and never a
//      substring — `.sterlingish`, `.sterling.bak` and `STERLING-notes.md` are
//      not stores. The comparison is normalized to the HOST's name rules, not
//      just to case, because this is the ONLY layer that runs cross-project: a
//      bare case fold left `.sterling.` and `.sterling ` — both of which Win32
//      opens as the real `.sterling` directory — matching nothing here, and step
//      4 is scoped to the caller's own project, so a call from another checkout
//      was ALLOWED onto a foreign store. Deny-only, and NOT applied on POSIX,
//      where `.sterling.` is a distinct directory and allowing it is correct.
//      Deliberately LEXICAL, with no realpath: this rule runs for EVERY
//      structured write on the machine, and calling realpath on all of them
//      would let one unreadable or pathological path wedge unrelated projects
//      (the alternative the decision rejects, on an outside review's reasoning).
//   4. CANONICAL LAYER, scoped to the caller's own project: a symlink sitting
//      outside the store but pointing into it is lexically invisible. Walk up to
//      the nearest EXISTING ancestor — a Write may create several missing
//      components at once and a symlink can sit above all of them, so resolving
//      only the immediate parent is not enough — realpath THAT, re-append the
//      unresolved suffix, and apply the SAME component rule to the result.
//      "EXISTING" is decided by a stat that REPORTS ITS ERROR: only a genuine
//      absence (ENOENT/ENOTDIR) is walked past, because that is the ordinary
//      not-yet-created case; a component that cannot be EXAMINED at all
//      (EACCES/EPERM/…) DENIES, since unreadable is not absent — a same-user
//      writer may traverse a path this process cannot stat (Windows ACLs, some
//      SMB/drop-box shares), and walking past it would retreat above the very
//      symlink this layer exists to resolve. It
//      runs only when the destination lies within the caller's project root, so
//      the realpath cost and the wedge risk stay inside the project that asked
//      for it, which is exactly what makes step 3 safe to run everywhere.
//
// WHAT THIS ARM DOES NOT GUARANTEE — stated flat, because a guard that
// overstates its reach is its own defect and this file has shipped that mistake:
//   (a) IT GATES THE AGENT/CONDUCTOR TOOL CHANNEL ONLY. It is NOT filesystem
//       integrity enforcement. An allowlisted script, the TUI, the MCP server,
//       an external editor, another terminal, a cron job or any same-user
//       process writes `.sterling/review-ledger.json` with this arm fully green
//       and completely unaware.
//   (b) HARD LINKS ARE INVISIBLE. Every test here reasons about NAMES: realpath
//       resolves symlinks but cannot reveal a second name for the same INODE, so
//       a pre-existing hard link outside the store to a store file is "outside"
//       by every test this arm can perform. Whether that reaches the store's
//       bytes depends on the writing tool's truncate-vs-rename semantics. Not
//       closed deliberately — detecting it needs a whole-filesystem inode scan.
//   (c) TOCTOU. The check and the write are two SEPARATE resolutions of the same
//       string: a symlink swapped into any component AFTER this verdict reroutes
//       the write, and a PreToolUse hook cannot be descriptor-bound.
//   (d) A SYMLINK INTO ANOTHER PROJECT'S STORE IS NOT COVERED. That is a RULED
//       design choice, not a gap to close: step 3 is lexical on purpose (see the
//       rejected alternative above) and step 4 is scoped to the caller's own
//       project.
//   (e) THE CASE FOLD IS A SIMPLE FOLD, not the filesystem's table. `toLowerCase`
//       is not NTFS's or APFS's case table; U+017F LATIN SMALL LETTER LONG S is
//       the known residual shape, MEASURED NOT to alias to the store directory on
//       this machine's /mnt/c mount. The fold is UNIONED with the exact
//       comparison, so it can only ever ADD denials, never permit one — and the
//       cost of that direction is stated rather than hidden: on a genuinely
//       case-SENSITIVE filesystem a real, distinct `.STERLING/` directory would
//       be refused although it is not a store. No Sterling checkout has one, and
//       refusing it is the safe direction. Runtime DETECTION of the destination
//       filesystem's case-sensitivity was REJECTED as the alternative: it cannot
//       be answered without writing a probe file (the one thing a PreToolUse gate
//       must not do), it is a second thing that can fail, and a failed detection
//       would have to assume case-INSENSITIVE to stay safe — which is what the
//       union already does, with none of the moving parts.
// The fold exists because the exact comparison is BYPASSABLE, not because it is
// untidy: measured on /mnt/c under WSL, writing `.Foo/f.json` OVERWROTE
// `.foo/f.json`, realpathSync PRESERVED the submitted casing (it does not
// case-correct) and path.relative therefore reported OUTSIDE — so
// `.STERLING/config.json` reached the review ledger at exit 0 on both source and
// bundle (research_finding
// `mnt-c-case-insensitive-defeats-case-sensitive-path-containment`). Note the
// parity inversion: on native win32 path.relative compares case-INSENSITIVELY,
// so WSL-on-/mnt/c is the WEAK surface, not Windows.
//
// THERE IS NO SANCTIONED-SCRIPT EXEMPTION ON THIS ARM, and that is not an
// oversight: `store_guard.allow_scripts` authenticates an EXECUTABLE by resolved
// file identity, and a structured edit call has no executable provenance to
// authenticate. The writers it protects are unaffected — the TUI writeback
// (packages/tui/src/config-writeback.ts) and the review-ledger CLI
// (scripts/review-ledger.mjs) are direct PROCESS writes, never Edit-tool calls.
//
// POSITION IS PART OF THE MECHANISM, twice over. The arm sits ABOVE the
// `if (!inSterlingProject) allow();` below, because the DESTINATION decides and
// not the caller's project — `{"cwd":"/tmp","file_path":"<checkout>/.sterling/
// enforcement-baseline.json"}` walked straight through that early allow, a
// CONFIRMED bypass reproduced by execution 2026-09-06. And it sits above the
// `command` handling further down, because a structured call carries no command
// text: below that point every Edit reads as an EMPTY Bash command, mentions no
// store path, and exits ALLOWED.
//
// The `if (!inSterlingProject) allow();` statement below is left BYTE-IDENTICAL
// on purpose: it carries a fail-closed-boundary baseline identity keyed by its
// own text (scripts/check-failclosed-boundary.mjs), so folding this arm into it
// would re-mint that entry for no behavioural gain.
//
// The helpers are function DECLARATIONS so they sit in the fail-closed checker's
// safe list and the verdict below can stay ONE guarded island.

/**
 * The tool_input FIELD carrying this tool's write destination, or null when the
 * tool is not a structured writer.
 */
function structuredWriteDestinationField(toolName) {
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit': // one top-level file_path; `edits[]` are mutations, not destinations
      return 'file_path';
    case 'NotebookEdit':
      return 'notebook_path';
    default:
      return null;
  }
}

/**
 * The shell channel. Kept separate from the null above so that "I know this tool
 * and its destination lives in the command text" and "I have never heard of this
 * tool" are DIFFERENT verdicts — the second one fails closed.
 */
function isCommandChannelTool(toolName) {
  return toolName === 'Bash' || toolName === 'PowerShell';
}

/**
 * Does an ALREADY-NORMALIZED absolute path carry a component spelled `.sterling`?
 * Case-folded, in EVERY position and not only the last; a WHOLE component, never
 * a prefix. Separators are the HOST's: on POSIX a backslash is an ordinary
 * filename character, so `notes\.sterling\x.txt` is ONE component and is not a
 * store path — on win32 that same string is three components and is one.
 *
 * ON WIN32 THE FOLD ALSO DROPS EACH COMPONENT'S TRAILING DOTS AND SPACES, for the
 * same reason the case fold exists: the Win32 layer strips them during name
 * normalization, so `.sterling.` and `.sterling ` OPEN THE REAL `.sterling`
 * DIRECTORY while case-folding to neither. Without this the lexical rule missed
 * both spellings and a cross-project write reached another checkout's store
 * (step 4's canonical layer is scoped to the caller's own project and never ran).
 * Deny-only and host-conditioned: stripping can only make MORE strings equal
 * `.sterling`, never fewer, and it is NOT applied on POSIX, where `.sterling.` is
 * a genuinely distinct directory that must keep being allowed. Only TRAILING
 * runs go, so `.sterling.bak` and `.sterlingish` remain non-stores.
 *
 * KNOWN OVER-DENIAL, accepted: a `\\?\` VERBATIM path suppresses Win32 name
 * normalization, so `\\?\C:\p\.sterling.\x` can name a literally distinct
 * directory that this fold nevertheless denies. That is the fail-safe direction
 * (a false deny, never a false allow) and is why the strip is described as the
 * host's ORDINARY name rules, not as a complete model of Win32 path semantics.
 */
function namesStoreComponent(normalizedAbs) {
  const win32 = sep === '\\';
  const components = normalizedAbs.split(win32 ? /[\\/]+/ : /\/+/);
  return components.some(
    (component) => (win32 ? component.replace(/[. ]+$/, '') : component).toLowerCase() === '.sterling'
  );
}

/**
 * Is `childAbs` the directory `parentAbs` ITSELF, or something beneath it?
 * path.relative, never a string prefix: '/x/.sterlingish' shares nine characters
 * with '/x/.sterling' and is emphatically not inside it. An absolute result means
 * a different root/drive (win32); '..' means the child climbs out.
 */
function pathIsInside(parentAbs, childAbs) {
  const rel = relative(parentAbs, childAbs);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
}

/**
 * The same question under the DESTINATION FILESYSTEM's case rules rather than
 * this process's POSIX string semantics: inside if EITHER the exact OR the
 * case-folded comparison says so. Both sides fold identically, so component
 * structure is untouched and '/x/.sterlingish' still relativizes OUT of
 * '/x/.sterling'. Used only to SCOPE the canonical layer, and being a union it
 * can only ever widen that scope — the fail-closed direction.
 */
function pathIsInsideEitherCase(parentAbs, childAbs) {
  if (pathIsInside(parentAbs, childAbs)) return true;
  return pathIsInside(parentAbs.toLowerCase(), childAbs.toLowerCase());
}

/**
 * Is `p` GENUINELY ABSENT, or merely UNEXAMINABLE? `existsSync` cannot tell the
 * two apart — it collapses every stat failure into `false` — and the walk below
 * needs the distinction, so this reports it.
 *
 *   ENOENT / ENOTDIR -> the component genuinely is not there (`false`). That is
 *                       the ordinary case the walk exists to serve: a Write may
 *                       create several missing components at once, and denying
 *                       "not created yet" would be a machine-wide false denial
 *                       of ordinary work (pins S3/S4).
 *   anything else     -> THROWS, naming the component and the errno. A metadata
 *                       failure is NOT proof of absence: Windows ACLs and some
 *                       SMB/drop-box configurations permit opening or CREATING a
 *                       known path while DENYING metadata lookup or listing, so
 *                       a same-user writer can traverse a component this process
 *                       cannot stat. Walking PAST such a component and
 *                       re-appending the suffix lexically would retreat ABOVE a
 *                       symlink and resolve the wrong ancestor — the canonical
 *                       layer's whole purpose — and ALLOW. Canonicalization
 *                       needed to reach a verdict failed, so the verdict is
 *                       CLOSED (P5; contract pin C5). Same ENOENT-vs-EACCES
 *                       distinction, for the same reason, as `storePresence` in
 *                       scripts/domain-doctor.mjs: a read that could not happen
 *                       is not an absence.
 *
 * `statSync`, not `lstatSync`, so a DANGLING symlink still reports ENOENT and is
 * walked past exactly as before — nothing can be written through it either.
 */
function ancestorExists(p) {
  try {
    statSync(p);
    return true;
  } catch (e) {
    const code = (e && e.code) || 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new Error(
      `[canonical-layer] the path component ${p} could not be examined (${code}); an unreadable component is not an absent one — a same-user writer may still traverse it (Windows ACLs, some SMB/drop-box shares), so walking past it could resolve the wrong ancestor and miss a symlink into the store`
    );
  }
}

/**
 * The canonical form of `absPath` when part of it does not exist yet: walk UP to
 * the nearest ancestor that EXISTS, realpath THAT, and re-append the unresolved
 * suffix lexically.
 *
 * Returns null when no ancestor is usable, and THROWS when a component cannot be
 * EXAMINED (see ancestorExists) or when realpath fails on an ancestor the walk
 * accepted (EACCES, ELOOP, …). The caller treats all three as INCONCLUSIVE and
 * denies: a containment question that cannot be answered must not be answered
 * with "outside".
 */
function canonicalViaNearestAncestor(absPath) {
  let anchor = absPath;
  while (!ancestorExists(anchor)) {
    const parent = dirname(anchor);
    if (parent === anchor) return null; // reached the filesystem root, nothing resolved
    anchor = parent;
  }
  const suffix = relative(anchor, absPath);
  const real = realpathSync(anchor);
  return suffix === '' ? real : join(real, suffix);
}

/** The denial for a destination that RESOLVES inside a `.sterling` directory. */
function storeDestinationDenial(toolName, field, submitted, evidence) {
  return (
    `H15: this ${toolName} call targets a Sterling store and is denied — a store is read and written through the §10 MCP tool surface ONLY, never by a direct file edit.\n` +
    `Submitted tool_input.${field}: ${JSON.stringify(submitted)} — ${evidence}.\n` +
    'THE DESTINATION DECIDES, NOT THE CALLER\'S CWD: every `.sterling` directory this call can name is protected, whichever project owns it. A session launched in another project (or with any other cwd) could otherwise write a different checkout\'s review-ledger.json — the file the merge gate reads to refuse unreviewed commits — its enforcement-baseline.json, or its config.json. That was a CONFIRMED bypass, reproduced by execution 2026-09-06.\n' +
    'PROTECTED SCOPE is the WHOLE .sterling namespace, the directory itself included: sterling.db and its backups, review-ledger.json, config.json, transient/, delivery-audit/, enforcement-baseline.json. Containment is decided by comparing the RESOLVED destination\'s path COMPONENTS under the HOST\'s name rules (case-folded, and on Windows with each component\'s trailing dots and spaces dropped, since Win32 opens `.sterling.` and `.sterling ` as the real directory), never by a per-file allowlist and never by a string prefix.\n' +
    'NO sanctioned-script exemption exists on this path: store_guard.allow_scripts authenticates an EXECUTABLE by resolved file identity, and a structured edit call has no executable provenance to authenticate.\n' +
    'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / run_signal / agent_exit.\n' +
    "REMEDY for config.json specifically: use the config_set MCP tool (an allowlisted, schema-validated key write) or the TUI System tab — never a raw edit of the file. CONDUCTOR-RUN: config_set is not granted to roster agents by design, so a subagent hitting this denial has no config_set of its own to fall back on — surface the need to the conductor instead.\n" +
    'WHAT THIS DENIAL DOES NOT CLAIM, so the guard is not trusted past its reach: it gates the agent/conductor TOOL CHANNEL only — a process writing the file directly (an allowlisted script, the TUI, an external editor) is unaffected; a pre-existing HARD LINK to a store file is "outside" every test performed here; check and write are separate resolutions of the same string (TOCTOU); and a symlink into ANOTHER project\'s store is not covered, deliberately.\n' +
    'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
  );
}

/** The denial for a destination this arm cannot even locate (fail-closed). */
function unusableDestinationDenial(toolName, field, submitted) {
  const seen =
    submitted === undefined
      ? 'absent'
      : submitted === null
        ? 'null'
        : typeof submitted === 'string'
          ? 'an empty/whitespace-only string'
          : Array.isArray(submitted)
            ? "a value of type 'array'"
            : `a value of type '${typeof submitted}'`;
  return (
    `H15: this ${toolName} call carries no usable destination path, so it is denied.\n` +
    `Required field: tool_input.${field} — received: ${seen}.\n` +
    'The TYPE is checked before any path helper on purpose: a String() coercion would launder an array or an object into a plausible-looking path, and this gate would then decide containment on the laundered value.\n' +
    'Without a destination H15 cannot establish that the Sterling store (.sterling/) is untouched, and a gate that cannot decide fails CLOSED (P5).\n' +
    'Re-issue the call with an explicit path. If the tool genuinely sends its destination under another field, that is a platform change and it must be added to this gate — never worked around.'
  );
}

/** The denial for a destination whose containment could not be decided at all. */
function undecidableDestinationDenial(toolName, field, submitted, reason) {
  return (
    `H15: the destination of this ${toolName} call could not be resolved, so it is denied.\n` +
    `Submitted tool_input.${field}: ${JSON.stringify(submitted)} — ${reason}.\n` +
    'A containment question this gate cannot answer is answered CLOSED (P5): H15 cannot establish that the Sterling store (.sterling/) is untouched, and answering "outside" on an unresolvable path is how a guard is walked past.'
  );
}

/** The denial for a tool whose destination field this arm does not know. */
function unrecognizedToolDenial(toolName) {
  return (
    `H15: this call names a tool H15 does not recognize (${JSON.stringify(toolName)}), so it is denied.\n` +
    'H15 judges exactly two channels: the shell channel (Bash, PowerShell), whose destination lives in the command text, and the structured-write channel (Edit, Write, MultiEdit, NotebookEdit), whose destination is an explicit tool_input field. A tool outside both has no known destination field, so this gate cannot establish that the Sterling store (.sterling/) is untouched — and a gate that cannot decide fails CLOSED (P5).\n' +
    'No such call is agent-reachable today — hooks/hooks.json routes only those six names here — so this branch is DEFENCE IN DEPTH against a platform RENAME silently retiring the whole arm, not a demonstrated exploit.\n' +
    'If a platform change renamed or added a writing tool, ADD IT TO THIS GATE (structuredWriteDestinationField, or isCommandChannelTool for a new shell) — never route the write around the gate, and never widen hooks/hooks.json without widening this file.'
  );
}

// The whole arm is ONE fail-closed island: an unexpected throw here would exit
// non-2, which the hook runner reads as NON-BLOCKING (the F5 voided-gate class,
// anti_pattern e13f0fb5).
try {
  const destinationField = structuredWriteDestinationField(input.tool_name);
  if (destinationField === null) {
    // Bash/PowerShell fall through to the command classifier below. Anything
    // else is a destination this arm cannot locate, and that fails closed.
    if (!isCommandChannelTool(input.tool_name)) deny(unrecognizedToolDenial(input.tool_name));
  } else {
    const submitted = input.tool_input?.[destinationField];
    // TYPE FIRST, and deliberately not through repoRel(): that helper coerces a
    // truthy non-string with String(), which would hand this gate a laundered
    // value and let it decide containment on the laundering.
    if (typeof submitted !== 'string' || submitted.trim() === '') {
      deny(unusableDestinationDenial(input.tool_name, destinationField, submitted));
    }

    // STEP 2 — NORMALIZE BEFORE ANY VERDICT. A relative destination needs a cwd
    // to resolve at all; without one the destination is undecidable, and
    // undecidable denies rather than guessing.
    const base = typeof input.cwd === 'string' ? input.cwd : '';
    if (!isAbsolute(submitted) && base === '') {
      deny(
        undecidableDestinationDenial(
          input.tool_name,
          destinationField,
          submitted,
          'it is a relative path and this call carries no usable cwd to resolve it against'
        )
      );
    }
    const destination = isAbsolute(submitted) ? resolve(submitted) : resolve(base, submitted);

    // STEP 3 — the lexical component rule, for every project on the machine.
    if (namesStoreComponent(destination)) {
      deny(
        storeDestinationDenial(
          input.tool_name,
          destinationField,
          submitted,
          `it resolves to ${destination}, which carries a '.sterling' directory component (compared under the host's name rules: case-folded, and on win32 with each component's trailing dots and spaces dropped)`
        )
      );
    }

    // STEP 4 — the canonical layer, scoped to the caller's OWN project so that
    // no realpath is ever performed on behalf of a destination elsewhere on the
    // machine. A throw from either call is caught below and DENIES.
    if (inSterlingProject && pathIsInsideEitherCase(base, destination)) {
      const canonical = canonicalViaNearestAncestor(destination);
      if (canonical === null) {
        deny(
          undecidableDestinationDenial(
            input.tool_name,
            destinationField,
            submitted,
            `no existing ancestor of ${destination} could be resolved, so a symlink leading into the store cannot be ruled out`
          )
        );
      }
      if (namesStoreComponent(canonical)) {
        deny(
          storeDestinationDenial(
            input.tool_name,
            destinationField,
            submitted,
            `it canonicalizes, via its nearest existing ancestor, to ${canonical}, which carries a '.sterling' directory component — the submitted spelling reaches the store through a symlink`
          )
        );
      }
    }

    // Outside every store this arm can see: no further business of H15 on this
    // channel. Exiting 0 says only "this hook does not block"; every other hook
    // on this matcher renders its own verdict independently.
    allow();
  }
} catch (e) {
  // Same F5 rule as every other island in this file — and the message is built
  // from literals plus a guarded read of the error, so the HANDLER itself cannot
  // throw on the way to exit 2. Audience is unknowable here (this hook is
  // globally registered), so both resolutions are stated, as the [stdin] catch
  // above does.
  deny(
    '⚠ ENVIRONMENT DEFECT (H15): this denial is about BROKEN STATE, not your conduct. ' +
      `[structured-write] the store-destination check for this tool call could not be completed (${(e && e.message) || e}); ` +
      'the gate fails CLOSED rather than risk a silent void (P5). ' +
      'IF YOU ARE A SPAWNED AGENT: do not diagnose, repair, or retry H15 yourself — exit `blocked`, citing this message VERBATIM. ' +
      'Otherwise this is broken state, and there is no conductor above you to exit `blocked` to — repair it (or restart the session) before proceeding.'
  );
}
if (!inSterlingProject) allow(); // not a Sterling project — no ceremony (P1)

const command = String(input.tool_input?.command ?? '');

// Bare `.sterling` (rm -rf/mv/tar of the whole store dir) must trip this gate
// too; the lookahead keeps suffixed names (.sterling-backups, .sterling2) out
// of it.
const STORE_MENTION_RE = /\.sterling(?![\w.-])|sterling\.db/i;

// DB_MENTION_RE seals sterling.db to shell for every verb (AC5). Kept
// DELIBERATELY UNANCHORED. An anchored variant (board 3edfb9fd, to stop the
// `notsterling.db`/`mysterling.db` false-POSITIVE) was built and REVERTED
// 2026-08-25: two independent reviewers (roster-security + Codex outside-
// family) showed a boundary-char whitelist opens a false-ALLOW read-exfil —
// `cat *sterling.db`, `grep --file=sterling.db`, `${unused:-sterling.db}` —
// because the char preceding the mention in raw text need not be its runtime
// path delimiter (shell expansion). No raw-text regex closes that; it is the
// shell-tokenizer wall the store guard has parked twice (decision
// h15-shell-tokenizer-attempt-parked-again). Over-sealing an unrelated
// `notsterling.db` is accepted friction until the tokenizer question is
// solved; a read-exfil hole is not. See board 3edfb9fd.
const DB_MENTION_RE = /sterling\.db/i;

// A quote-concatenated store path (`.st''erling/config.json`) never contains
// the bare substring ".sterling" in the raw text, so it must also be checked
// against the quote-stripped (unquotedText) form before bailing early — a
// false "no mention anywhere" here would silently void every check below
// (adversarial regression 3 / FIX C). unquotedText is a hoisted function
// declaration, safe to call ahead of its textual definition.
//
// PREPROCESSING IS INSIDE THE FAIL-CLOSED BOUNDARY (board 01afa03e, the F5
// class anti_pattern e13f0fb5). unquotedText compiles a RegExp built from the
// command's own heredoc DELIMITER, and a throw there exits non-2 — which the
// hook runner reads as ALLOW, voiding this blocking gate entirely. REPRODUCED
// 2026-08-26 against HEAD: `rm -rf .st''erling <<AAA…(70k A's)…` threw
// "Regular expression too large" out of the hook (exit 1, command ALLOWED) —
// the metachar escaping upstream makes the pattern VALID but not SMALL, and
// V8 raises the size error when the pattern is COMPILED by .match(), not when
// it is constructed. The wrap is deliberately around the whole mention test,
// not just the call: the boundary must cover every statement between process
// start and the deny decision, never only the config/store read.
let mentionsStore;
try {
  mentionsStore = STORE_MENTION_RE.test(command) || STORE_MENTION_RE.test(unquotedText(command));
} catch (e) {
  deny(
    environmentDefectDenial(
      'H15',
      `Internal error while preprocessing the command text for the store-mention check (${(e && e.message) || e}); the gate fails closed rather than risk a silent void.`,
      { agentId: input?.agent_id } // same handler-cannot-throw rule as the [cwd] catch above
    )
  );
}
if (!mentionsStore) allow(); // no store path anywhere in the command — irrelevant

// ── THE EFFECTIVE ALLOWLIST: a project's array EXTENDS the shipped list ──────
// (decision `allow-scripts-unions-empty-array-is-lockdown`, 00867be9, user-ruled
// 2026-08-29; board 94d6368a.) A zod `.default([...])` applies ONLY when the key
// is ABSENT, so an explicit `store_guard.allow_scripts` used to SHADOW the
// shipped sanctioned list entirely: a project that named one script of its own
// silently lost all ten shipped entries, and every script Sterling sanctioned
// afterwards stayed unreachable there — silently, and indistinguishably from
// "never allowlisted". Measured casualties: packages/tui/bundle/sterling-tui.mjs
// in every consuming project (77c5b85a), and — the trap that must never spring —
// scripts/migrate-stores.mjs, the ONLY exit from a refuse-until-migrated store
// (bc0f81e3). Decision 77c5b85a already fixes this in CONFIG SPACE (init/update
// append the shipped entries into a consumer's array), but that reaches only a
// project that RUNS update; the GUARD itself must not read a list as a
// replacement in the meantime. The union is ADDITIVE-ONLY: naming some shipped
// entries never subtracts the unnamed ones, because "they wrote a list, honour
// exactly that list" is the very reading that produced this defect.
//
// ABSENT IS NOT PRESENT-AND-EMPTY, AND THAT DISTINCTION IS THE SECURITY QUESTION
// HERE. This change makes an allowlist STRICTLY LARGER, and the naive shape —
// `[...SANCTIONED_SCRIPTS, ...(allow_scripts ?? [])]` — satisfies every other
// requirement above while SILENTLY RE-OPENING a project that deliberately
// revoked shell write access to its store. `allow_scripts: []` is a policy
// statement — TRUST NOTHING — and an upgrade must never undo it. So PRESENCE is
// read off the RAW config before the parsed value is unioned:
//   key ABSENT            -> the shipped default applies, project entries union
//                            on top (there are none — that is what absent means);
//   key PRESENT, NON-EMPTY -> the project's entries UNION with the shipped list;
//   key PRESENT AND EMPTY  -> deliberate lockdown: no union, nothing sanctioned.
// Under that lockdown the migration scripts are denied WITH everything else
// (00867be9 part 3 — HEAD's behaviour, preserved deliberately): recovery is one
// config line, whereas the hardcoded remediation floor that would have rescued
// them was BUILT and REVERTED before commit after three outside-family review
// rounds each found a distinct bypass. A permanently-allowed script path is the
// surface those bypasses exploited; it is not reinstated here.
//
// a malformed config must fail CLOSED on the protected branch — an uncaught
// throw exits non-2, which the platform treats as non-blocking (a voided gate)
let allowScripts;
try {
  const raw = loadConfig(input.cwd) ?? {};
  // The RAW value answers PRESENCE, which the parsed value cannot: after
  // parseConfig an absent key and an explicit `[]` are indistinguishable from
  // the shipped default and an empty list respectively — the default has already
  // been substituted, and collapsing the two cases is the bug described above.
  const declared = raw?.store_guard?.allow_scripts;
  // parseConfig still owns VALIDATION (a non-array `declared` throws here and
  // fails closed) and still supplies the shipped default when the key is absent.
  const configured = parseConfig(raw).store_guard.allow_scripts;
  allowScripts =
    Array.isArray(declared) && declared.length === 0
      ? [] // explicit lockdown — no union, no shipped defaults, no exemptions
      : appendMissingSanctioned(configured).next; // additive: listing never subtracts
} catch (e) {
  deny(
    environmentDefectDenial('H15', `Store access denied — .sterling/config.json is unreadable (${e.message}); fix the config, the gate fails closed.`, {
      agentId: input?.agent_id, // same handler-cannot-throw rule as the [cwd] catch above
    })
  );
}

// Split on shell control operators so each fragment is judged independently
// (AC3). Quote-aware so an operator character inside a quoted argument (a SQL
// string, a commit message) never fractures the command wrongly.
function splitFragments(cmd) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inSingle) {
      current += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += c;
      if (c === '"' && cmd[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      current += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      current += c;
      continue;
    }
    // A heredoc body is DATA, not commands: on an unquoted '<<DELIM', consume
    // everything through the terminator line into the SAME fragment, so a body
    // line mentioning the store is judged as part of its command (a git commit
    // message), never as a fragment whose first word is prose.
    if (c === '<' && cmd[i + 1] === '<') {
      const m = cmd.slice(i + 2).match(/^[-~]?\s*(?:"([^"]+)"|'([^']+)'|(\w+))/);
      const delim = m ? (m[1] ?? m[2] ?? m[3]) : null;
      if (delim) {
        // The delimiter is untrusted command text: escape regex metachars
        // before interpolating it into `new RegExp` (a delimiter like "A(B"
        // otherwise throws, which — uncaught — exits non-2 and silently
        // VOIDS this blocking gate; see the outer try/catch below).
        const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rest = cmd.slice(i);
        const end = rest.match(new RegExp(`\\n\\s*${escapedDelim}(?=\\n|$)`));
        const span = end ? end.index + end[0].length : rest.length;
        current += rest.slice(0, span);
        i += span - 1;
        continue;
      }
    }
    // Unquoted newlines separate commands exactly like ';' — caught live
    // 2026-08-20 minutes after this gate shipped: a multiline commit batch was
    // judged as ONE fragment whose first word was 'set', denying the whole
    // batch over a store mention inside a later fragment's quoted message.
    if (c === '\n' || c === '\r') {
      parts.push(current);
      current = '';
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    // FIX D: a LONE `&` backgrounds the preceding command and is a fragment
    // separator exactly like `;` — `ls /tmp/x & rm -rf .sterling` must not
    // ride the whole line through as one fragment keyed off `ls`. Two
    // redirect shapes use `&` without separating anything and must NOT
    // split: `&>`/`&>>` (combined stdout+stderr redirect) and `>&N`/`N>&N`
    // (fd duplication, e.g. `2>&1`) — recognized by looking at the next
    // char and the last char already appended to `current`, respectively.
    if (c === '&') {
      const prevChar = current.length ? current[current.length - 1] : '';
      if (cmd[i + 1] === '>' || prevChar === '>') {
        current += c;
        continue;
      }
      parts.push(current);
      current = '';
      continue;
    }
    if (c === '|' && cmd[i + 1] === '|') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Blanket "mutating verbs" set is DEAD CODE: every verb it named (rm, mv, cp,
// tee, truncate, dd, chmod, chown, rsync, ln, unlink, patch, shred, install,
// mkfifo, …) is already absent from READONLY_VERBS below, so the default-deny
// "unknown verb mentioning the store: err CLOSED" branch already denies every
// one of them without a separate list to maintain in sync. Intent preserved
// here rather than in a set: those verbs mutate their target and must never
// be added to READONLY_VERBS.

// Verbs known to be read-only against whatever path they are given,
// UNCONDITIONALLY. `git` and `find` are deliberately NOT here — both are only
// CONDITIONALLY read-only (see classifyGit/classifyFind below); folding them
// into this blanket set is exactly the hole an independent review found (a
// git checkout/clean/restore or a find -delete previously passed as "git"/
// "find" being on this list, with no sub-verb/flag check at all).
//
// FIX F: `awk` REMOVED (was here) — it is only CONDITIONALLY read-only, same
// class of hole as git/find above, but the redirect scan cannot see inside
// it: `awk '{print > ".sterling/x"}'` writes via the awk program's OWN `>`,
// entirely inside a quoted argument the shell-level redirect check never
// evaluates, and `awk 'BEGIN{system("rm ...")}'` shells out directly. A
// store-mentioning awk fragment now falls to the default "unknown verb: err
// CLOSED" branch below — see the accepted-cost note at ADV-6c in
// scripts/tests/h15-precision-adversarial.test.mjs: this also fail-closes a
// legitimate awk READ of a store file, deliberately; grep/cat remain the
// sanctioned shell read path for store files.
const READONLY_VERBS = new Set([
  'grep', 'egrep', 'fgrep', 'zgrep', 'rgrep',
  'ls', 'cat', 'head', 'tail', 'wc',
  'diff', 'file', 'stat', 'less', 'more', 'tree', 'du', 'od', 'xxd', 'hexdump',
]);

// git sub-verbs that only inspect state.
const GIT_READONLY_SUBVERBS = new Set([
  'log', 'show', 'diff', 'grep', 'ls-files', 'branch', 'cat-file', 'status', 'rev-parse',
]);

// git sub-verbs that rewrite/delete working-tree files — always a write when
// the fragment names a store path, regardless of quoting.
// `mv` renames/moves a tracked file (board 682ce7fc): `git mv .sterling/x
// elsewhere` (or the reverse) moves a store path exactly like a raw shell
// `mv`, and without it here the fragment fell through to the "unrecognized
// git sub-verb" branch, which only denies when the store path is a genuine
// UNQUOTED argument to the git invocation itself — the escape a git-mv gap
// would otherwise open.
const GIT_WRITE_SUBVERBS = new Set(['checkout', 'restore', 'clean', 'rm', 'stash', 'mv']);

// git GLOBAL flags precede the sub-verb and must be skipped before extracting
// it — `git -C <path> log ...` reads sub-verb "log", not "-C". Without this,
// a global flag hides the real sub-verb from classifyGit, which falls to the
// substring fallback below and can deny a read-only invocation over an
// unrelated store mention elsewhere in the command (e.g. a `sterling/*`
// branch name in a log/diff range: "main..sterling/foo" contains the literal
// substring ".sterling/" purely from the ".." before the branch name).
// Value-taking: -C <path>, -c <k=v>, --git-dir/--work-tree/--namespace
// (space form or "=value"). Bare (no value): --no-pager, -p/-P/--paginate,
// --no-optional-locks.
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GIT_GLOBAL_BARE_FLAGS = new Set(['--no-pager', '-p', '-P', '--paginate', '--no-optional-locks']);

// FIX A (adversarial regressions 1-2): skipping past a global flag's VALUE
// to find the real sub-verb must not also skip past what that VALUE names.
// `git -c core.fsmonitor=.sterling/writer status` and `git -C <path>/.sterling
// status` both use a read-only-looking subverb to smuggle a store path
// through in a flag VALUE (a git-config-injection / redirected-git-dir
// gadget) — every skipped value is tested against STORE_MENTION_RE, and the
// first one that matches is returned so the caller can deny regardless of
// the subverb behind it. Benign values (an ordinary git config key, a
// project-root path) still fall through to normal subverb classification.
function skipGitGlobalFlags(argsText) {
  let s = argsText;
  let flaggedStoreValue = null;
  for (;;) {
    const m = s.match(/^\s*(\S+)/);
    if (!m) break;
    const token = m[1];
    const eq = token.indexOf('=');
    const flagName = eq >= 0 ? token.slice(0, eq) : token;
    if (GIT_GLOBAL_VALUE_FLAGS.has(flagName)) {
      s = s.slice(m[0].length);
      let value;
      if (eq >= 0) {
        // "=value" form: --git-dir=.sterling/repo, --work-tree=.sterling/x
        value = token.slice(eq + 1);
      } else {
        // space form: the value is the NEXT token (-C <path>, -c k=v).
        const v = s.match(/^\s*(\S+)/);
        value = v ? v[1] : '';
        if (v) s = s.slice(v[0].length);
      }
      if (!flaggedStoreValue && STORE_MENTION_RE.test(value)) flaggedStoreValue = value;
      continue;
    }
    if (GIT_GLOBAL_BARE_FLAGS.has(flagName)) {
      s = s.slice(m[0].length);
      continue;
    }
    break; // first non-global-flag token is the sub-verb
  }
  return { rest: s, flaggedStoreValue };
}

function classifyGit(trimmed) {
  const m = trimmed.match(/^git\s+(.*)$/i);
  const { rest, flaggedStoreValue } = m ? skipGitGlobalFlags(m[1]) : { rest: '', flaggedStoreValue: null };
  // A skipped global-flag VALUE naming the store is a write regardless of
  // how read-only the subverb behind it looks (FIX A).
  if (flaggedStoreValue) return true;
  const sm = rest.match(/^\s*(\S+)/);
  const subverb = sm ? sm[1].toLowerCase() : '';
  if (GIT_READONLY_SUBVERBS.has(subverb)) return false;
  if (GIT_WRITE_SUBVERBS.has(subverb)) return true;
  // An unrecognized sub-verb (commit, add, push, merge, …) is a write ONLY
  // when it carries the store path as a genuine (unquoted) argument — a
  // store mention inside quoted prose (e.g. a commit message body) is not an
  // out-of-band write against the store; err CLOSED only on a real argument.
  return STORE_MENTION_RE.test(unquotedText(trimmed));
}

// find is only read-only WITHOUT a flag that lets it act on matches directly;
// -delete/-exec/-execdir/-ok/-fdelete all mutate the store in place.
const FIND_MUTATING_FLAGS_RE = /(^|\s)-(delete|fdelete|execdir|exec|ok)\b/;

function classifyFind(trimmed) {
  return FIND_MUTATING_FLAGS_RE.test(trimmed); // write only when a mutating flag is present
}

function firstWord(fragment) {
  const m = fragment.match(/^\s*(\S+)/);
  return m ? m[1].toLowerCase() : '';
}

// Concatenation of a fragment's UNQUOTED, NON-HEREDOC-BODY characters only —
// a single- or double-quoted span (a commit message, a SQL string) AND a
// heredoc body (`git commit -F - <<EOF` … `EOF`) are DATA, not shell syntax
// or a genuine path argument, and must never be read as either.
function unquotedText(str) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && str[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '<' && str[i + 1] === '<') {
      const m = str.slice(i + 2).match(/^[-~]?\s*(?:"([^"]+)"|'([^']+)'|(\w+))/);
      const delim = m ? (m[1] ?? m[2] ?? m[3]) : null;
      if (delim) {
        const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rest = str.slice(i);
        const end = rest.match(new RegExp(`\\n\\s*${escapedDelim}(?=\\n|$)`));
        const span = end ? end.index + end[0].length : rest.length;
        i += span - 1; // skip the whole heredoc (marker + body + terminator) — DATA
        continue;
      }
    }
    out += c;
  }
  return out;
}

// ── ANCHORED allow_scripts EXEMPTION ─────────────────────────────────────
// A sanctioned name exempts a fragment ONLY when it is that fragment's
// EXECUTABLE argument (anti_pattern `unanchored-substring-allowlist-in-
// command-guard`, severity BLOCK). The previous test — `frag.includes(entry)`
// over the RAW fragment text, evaluated BEFORE classification — was a
// CONFIRMED, REPRODUCED bypass: splitFragments is quote/heredoc-aware but has
// no `#` handling, so a comment tail stays inside its fragment and appending
// `# scripts/init.mjs` exempted ANY command. Measured 2026-08-26 as ALLOW:
// `rm -f .sterling/sterling.db # scripts/init.mjs`, `rm -rf .sterling # …`,
// a quoted flag value (`--label "scripts/init.mjs"`) and an unrelated path
// token (`/tmp/scripts/init.mjs`). The agent-reachable one is
// `grep -c . .sterling/sterling.db # scripts/init.mjs` — store
// read-exfiltration straight through the seal decision fd9e96e0 keeps broad.
//
// SCOPE, DELIBERATELY: this narrows an over-broad EXEMPTION and nothing else,
// so it does not reopen decision ccc44a8e (the broad command-TEXT classifier
// is the accepted terminal design) — it closes a false-ALLOW, which is the
// class ccc44a8e keeps closed. Comment stripping happens HERE and NOWHERE
// ELSE: classifyFragment still sees the whole fragment INCLUDING its comment
// text, because stripping comments before classification would silently
// narrow the deny surface decisions ccc44a8e/a8bec43f keep broad on purpose
// (`ls /tmp # .sterling/sterling.db` must keep denying).

// Shell WORDS of a fragment, for the exemption test only. Quotes DELIMIT but
// never SPLIT — `"rm" -f x` is still the word `rm`, so a quoted verb can
// never be dissolved to promote a later sanctioned token into executable
// position (which is what tokenizing over unquotedText would do). A heredoc
// marker + body + terminator is DATA and yields no words (same span logic as
// unquotedText). An unquoted `#` that STARTS a word ends the line as a
// comment, exactly as bash reads it (`foo#bar` keeps its literal `#`).
function executableWords(str) {
  const words = [];
  let current = '';
  let started = false; // a word is in progress (possibly empty, via `''`)
  let inSingle = false;
  let inDouble = false;
  const push = () => {
    if (started) {
      words.push(current);
      current = '';
      started = false;
    }
  };
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else current += c;
      continue;
    }
    if (inDouble) {
      if (c === '"' && str[i - 1] !== '\\') inDouble = false;
      else current += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (c === '<' && str[i + 1] === '<') {
      const m = str.slice(i + 2).match(/^[-~]?\s*(?:"([^"]+)"|'([^']+)'|(\w+))/);
      const delim = m ? (m[1] ?? m[2] ?? m[3]) : null;
      if (delim) {
        const escapedDelim = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rest = str.slice(i);
        const end = rest.match(new RegExp(`\\n\\s*${escapedDelim}(?=\\n|$)`));
        const span = end ? end.index + end[0].length : rest.length;
        i += span - 1;
        push();
        continue;
      }
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === '#' && !started) break; // unquoted `#` at word start — comment tail
    started = true;
    current += c;
  }
  push();
  return words;
}

// Interpreters whose script argument is the file they execute, when invoked
// PLAINLY (`<interpreter> <script> <args>`). Matched by EXACT word, not
// basename: `/tmp/evil/node scripts/init.mjs` must not inherit the exemption
// (fail-closed, this file's standing posture — a missed exemption only ever
// costs a deny).
const INTERPRETER_WORDS = new Set(['node', 'nodejs', 'bash', 'sh', 'zsh', 'python', 'python3']);

// THE PLAIN-INVOCATION INVARIANT (decision 95c2c109 F1, as TIGHTENED by the
// independent correctness + security reviews of 2026-09-05): a sanctioned
// script is run as plain `<interpreter> <script> <args>` — NOTHING between the
// interpreter and the script. So the candidate is words[1] and nothing else,
// and if words[1] begins with `-` the fragment carries an interpreter option
// and gets NO exemption, whatever the option is.
//
// WHY POSITIONAL AND NOT A LIST. The first cut of F1 enumerated code-execution
// options (-e, --import, -r, …) and fell to review within the hour, on both
// sides: glued short forms (`python3 -c'code' <script>`, `-m<mod>`), stdin-
// program options (`bash -s <script> <<EOF`, `python3 - <script>`), node's
// underscore spellings (`--experimental_loader=`) and file-loading options
// (`--env-file`, `--test-reporter`) all escaped the list while a GENUINE clone
// file sat in candidate position — and the list's whole-fragment scan denied
// the repo's own sanctioned commit path, `commit-reviewed.mjs -m "<msg>"`,
// whenever the message named the store. Every interpreter in INTERPRETER_WORDS
// stops option parsing at the script path, so a `-` word AFTER the script is
// the script's own argument and can never inject code; a `-` word BEFORE it
// is an interpreter option and the invariant is already broken. The positional
// rule closes the whole class without naming a single flag (rebuild-over-
// patch: remove the cause, do not add handlers for its effects). Cost: an
// interpreter option before a sanctioned script (`node --no-warnings <script>`)
// is a false deny, recoverable by dropping the option — no shipped launcher,
// H1/H10 remedy or CLAUDE.md invocation prints one.
//
// The fragment's EXECUTABLE CANDIDATE: the word whose FILE IDENTITY decides the
// exemption. Either the fragment's own executable word, or — for an interpreter
// form — words[1]. `interpreterOption` is the offending `-` word when the
// invariant is broken (the candidate is then the first later non-`-` word,
// carried ONLY so the denial can name what would have run). `viaInterpreter`
// is carried because the DENIAL WORDING keys on it (see the provenance-line
// gate at the denial bodies below), never the verdict.
function fragmentExecutableCandidate(fragment) {
  const words = executableWords(fragment);
  if (!words.length) return { word: null, viaInterpreter: false, interpreterOption: null };
  if (!INTERPRETER_WORDS.has(words[0])) return { word: words[0], viaInterpreter: false, interpreterOption: null };
  if (words.length < 2) return { word: null, viaInterpreter: true, interpreterOption: null };
  // `+` is an option prefix too for bash/sh/zsh (`+o`, `+x`); a `+`-led words[1]
  // is never a script path in any sanctioned entry, so treating it as an option
  // keeps the invariant literally true rather than accidentally fail-closed.
  if (words[1].startsWith('-') || words[1].startsWith('+')) {
    const later = words.slice(2).find((w) => !w.startsWith('-') && !w.startsWith('+')) ?? null;
    return { word: later, viaInterpreter: true, interpreterOption: words[1] };
  }
  return { word: words[1], viaInterpreter: true, interpreterOption: null };
}

// WHOLE-WORD STRING EQUALITY IS GONE (decision 5b82e94f, superseding a206a529's
// spelling-bound check). `isSanctionedScript` compared TEXT, and text says
// nothing about which file the OS opens: research_finding cc35e43c EXECUTED the
// bypass — a project-local symlink plus a lexically-normalized `..` validated
// the genuine in-clone file while the planted one ran, straight past the
// database seal. The exemption now binds the FILE, via
// scripts/hooks/lib/sanctioned-provenance.mjs. Read that module's invariant
// paragraph before changing anything here; in particular there is NO bare-name
// fallback, because the fallback IS the bypass (anti_pattern caecf8a6, BLOCK).
// A PREDECESSOR FRAGMENT OUTSIDE A SMALL KNOWN-SAFE LIST DISQUALIFIES EVERY
// LATER EXEMPTION IN THE SAME COMMAND (Codex rounds 2-3, 2026-09-05). The
// positional rule judges one fragment, but the ENVIRONMENT and CWD are per
// command: `export NODE_OPTIONS='--require=/tmp/evil.cjs' && node <sanctioned>`
// puts the code-loading option into the environment one fragment earlier, and
// fragment 2 is then a textbook plain invocation that would be exempt while
// node preloads attacker code. A first cut enumerated MUTATORS (export,
// declare, assignments, …) and fell the same hour: `command export`, `builtin
// export`, `{ export X; node …; }`, `( export X; node … )` and a function
// definition `node() { … }` all begin with a word the list did not name. So the
// list is inverted: a predecessor is SAFE only when its first word is one of a
// handful of verbs that can neither mutate the shell's environment nor its
// cwd AND the fragment carries no shell expansion at all, or when it was
// itself granted the sanctioned exemption — the FINAL verdict, rider check
// included (a child process cannot touch the parent shell, but a rider on the
// same fragment can). Both refinements are Codex round 4: `printf -v PATH %s 0`
// assigns through a builtin option, and `echo "$((PATH=0))"` assigns through
// arithmetic expansion BEFORE echo runs, so neither the verb nor the word list
// is sufficient on its own — `printf` is dropped outright and any `$` or
// backtick in the raw fragment makes it unsafe. Everything else — `cd`
// included, which closes the compound-`cd` mis-resolution the CWD clause used
// to disclose — withholds the exemption from every later fragment; those
// fragments are then classified like any other, so a store-naming one is
// denied. Cost: a sanctioned script chained after anything but a literal echo
// needs its own command line, which is how every shipped remedy prints it.
function fragmentIsSafePredecessor(fragment) {
  const SAFE_PREDECESSOR_WORDS = new Set(['echo', 'true', ':', 'pwd']);
  const words = executableWords(fragment);
  if (!words.length) return true; // an empty fragment (`;;`, trailing separator) is nothing
  if (!SAFE_PREDECESSOR_WORDS.has(words[0])) return false;
  // No expansion of any kind and NO redirect: `echo payload > scripts/init.mjs
  // && node scripts/init.mjs …` overwrites the sanctioned file one fragment
  // before running it (final security pass, 2026-09-05 — inside Ruling 4's
  // disclaimed same-UID class, closed anyway because a safe verb has no
  // legitimate reason to redirect ahead of a sanctioned run).
  return !/[$`<>]/.test(String(fragment)); // a literal echo only
}

function fragmentSanctionedProvenance(fragment, entries, ctx) {
  const { word, viaInterpreter, interpreterOption } = fragmentExecutableCandidate(fragment);
  // UNCONDITIONAL ON THE PREDECESSOR (board fb7c43fb N-1, 2026-09-05). The gate
  // used to require `viaInterpreter || word.includes('/')`, which let a
  // SLASH-FREE bare-basename candidate past it — and a bare name is still
  // resolved against the cwd an unsafe predecessor may have moved (`cd` is
  // exactly what the predecessor list refuses to assume away), so the one shape
  // the condition excluded was not a safe one. Dropping it only REMOVES allow
  // surface: a fragment that would have been exempt now falls through to
  // ordinary classification, which denies it iff it names the store.
  if (ctx?.unsafePredecessor) {
    return {
      allow: false,
      word,
      viaInterpreter,
      detail: {
        allow: false,
        candidate: null,
        reason:
          `an EARLIER fragment of this command (${JSON.stringify(ctx.unsafePredecessor)}) is not on the known-safe predecessor list (a literal echo, true, :, pwd — no expansion — ` +
          `or a sanctioned invocation), so the interpreter's environment and cwd can no longer be assumed to be the ones the platform launched — an exported ` +
          `NODE_OPTIONS/BASH_ENV/PYTHONPATH makes the interpreter load code before the script it was handed, a \`cd\` moves what a relative path names, and a ` +
          `function definition can shadow the interpreter word itself (decision 95c2c109 F1, Codex rounds 2-3). Run the sanctioned script on its own command line.`,
      },
    };
  }
  if (interpreterOption !== null) {
    // F1 (95c2c109): decided BEFORE provenance is even consulted — the later
    // word may well be a genuine clone file, and that is exactly what the
    // exploit relies on. `word` is kept so the denial's provenance line prints
    // (it keys on viaInterpreter + a non-null word).
    return {
      allow: false,
      word: word ?? interpreterOption,
      viaInterpreter,
      detail: {
        allow: false,
        candidate: null,
        reason:
          `the fragment carries the interpreter option ${interpreterOption} between the interpreter and the script, so it is not a plain ` +
          `\`<interpreter> <script> <args>\` run and NO sanctioned-script exemption is available — an interpreter option can load or evaluate ` +
          `code (node -r/--import/-e, bash -c/-s, python -c/-m/-, …), so the first non-option word (${word ?? 'none'}) is not necessarily the ` +
          `file that executes (decision 95c2c109 F1). Run the sanctioned script plainly, options AFTER the script path belong to the script and are fine.`,
      },
    };
  }
  if (word === null) {
    return { allow: false, word: null, viaInterpreter, detail: null };
  }
  const detail = sanctionedProvenance(word, entries, ctx);
  return { allow: detail.allow, word, viaInterpreter, detail };
}

// Decision 0b4d3c8c denies redirections INTO the store, not every redirection
// that merely appears on a line naming a store path — a store READ with an
// outward redirect (`grep foo .sterling/x.json > /tmp/out`, `cat
// .sterling/config.json 2>/dev/null`) is a read, not a write. So this checks
// each UNQUOTED output-redirect operator's TARGET, not just whether a '>'
// exists. A '>' inside quotes or a heredoc body is prose/data, never a shell
// redirect (unquotedText already strips both).
//
// Operator forms recognized: >, >>, and fd-prefixed/combined forms (2>,
// 2>>, &>, &>>). A target of the form `&<digits>` (>&2, 2>&1) is an fd
// DUPLICATION, not a filesystem path, and is never a store write. Any other
// target is checked against STORE_MENTION_RE.
//
// Conservative on ambiguity (fail-closed, per this file's own posture): a
// trailing redirect operator with no following token cannot be tokenized as
// a target, so it is treated as a write.
//
// FIX B (adversarial regression 3): the target must be ONE statically-
// parseable plain word — [A-Za-z0-9_./~+-], after quote-stripping (which
// unquotedText already applied to `str` above, so a quote-concatenated
// target has already been reassembled here; see FIX C). Anything else — a
// command substitution ($(...) or `...`), an unresolved shell variable
// expansion (${VAR}), or any other shell metacharacter in the token — is a
// target the gate cannot evaluate without actually running the shell, so it
// FAILS CLOSED (deny) rather than default-allowing just because the literal
// text lacks a recognizable ".sterling/" plain-word substring.
const PLAIN_WORD_RE = /^[A-Za-z0-9_./~+-]+$/;

function redirectsIntoStore(str) {
  const text = unquotedText(str);
  const RE = /(?:[0-9]+|&)?(>>|>)(\s*)(\S+)?/g;
  let m;
  while ((m = RE.exec(text))) {
    const target = m[3];
    if (target === undefined) return true; // unparseable target — fail closed
    if (/^&[0-9]+$/.test(target)) continue; // fd duplication, not a path
    if (!PLAIN_WORD_RE.test(target)) return true; // unparseable target — fail closed
    if (STORE_MENTION_RE.test(target)) return true;
  }
  return false;
}

// EXEMPTION ELIGIBILITY (board 98889ecd). Anchoring the allowlist to the
// fragment's EXECUTABLE argument fixed WHICH fragments are exempted; this
// fixes HOW MUCH of an exempted fragment is granted. A sanctioned executable
// used to grant the WHOLE fragment, so its command substitutions and
// redirections were never classified — and the attacker never needs control of
// the sanctioned script: `$(...)`, backticks and `<(...)`/`>(...)` execute in
// the SHELL before, or independently of, the sanctioned program, and a
// redirect can damage the store using the launcher's own output.
//
// So the exemption is retained ONLY for a RIDER-FREE sanctioned invocation.
// Deliberately CONSERVATIVE and deliberately COARSE: any command/process
// substitution syntax at all disqualifies the fragment, even a read-only one
// the plain classifier would allow, because `classifyFragment` returns a
// fragment-wide verdict with NO provenance saying which text produced a
// finding — per-finding provenance is the mini-shell-parser that decision
// 2c3e3136 parked twice. This only ever NARROWS an exemption (it removes allow
// surface, never adds deny surface), so it does not reopen ccc44a8e's terminal
// classify-by-static-text ruling.
//
// FALSE-DENY note: no checked-in invocation in scripts/ or skills/ combines an
// allowlisted launcher with substitution syntax or a store-directed redirect;
// every configured launcher shape (including the direct
// `--db .sterling/sterling.db` forms of the migration-preflight /
// migrate-stores remediation floor, decision bc0f81e3) stays allowed. Refine
// this ONLY from a real incident — the workaround for a newly-denied shape is
// to compute the substitution in a SEPARATE fragment.
//
// ACCEPTED NEW DENIAL, NAMED (outside review 2026-08-27, MEASURED not assumed):
// the test reads the RAW fragment, so a backtick or `$(` inside QUOTED DATA
// counts as a rider. The shape that bites is the repo's own commit path,
// `node scripts/commit-reviewed.mjs -m "…"` (commands/merge.md:13), when the
// message contains BOTH a backtick/`$(` AND a store mention — e.g.
// -m "fix(h15): narrow `allow_scripts` for .sterling/config.json" now denies.
// Measured scope, which is narrower than it first looks: a backtick message
// with NO store mention still ALLOWS (the mentionsStore early-out above never
// reaches this code), a store mention with NO backtick still ALLOWS, and bare
// parentheses are not riders. Single-quoting the message does NOT help — the
// test is on raw text. Workaround: drop the backticks, or omit the store path.
//
// THE OBVIOUS REMEDY IS UNSOUND AND WAS REJECTED ON MEASUREMENT: testing
// `unquotedText(fragment)` instead of the raw fragment. unquotedText DROPS the
// CONTENTS of quoted spans (see its definition below), but bash EXPANDS `$(…)`
// and backticks inside DOUBLE quotes — so that swap re-ALLOWS the exfiltration
// this check exists to stop. Measured against the frozen rider pins: RID-2
// (`"$(cat .sterling/sterling.db)"`), RID-3 and RID-4 all flipped deny -> ALLOW.
// A sound refinement would have to distinguish single-quoted and backslash-
// escaped (inert) from double-quoted (expanding) text, which is the shell-
// tokenizer decision 2c3e3136 parked twice. Left as accepted friction.
function sanctionedFragmentHasShellRider(fragment) {
  return redirectsIntoStore(fragment) || /(?:\$\(|`|[<>]\()/.test(fragment);
}

// Classify a single fragment: { write: boolean, fragment }. A fragment that
// never mentions the store is irrelevant (write: false) regardless of verb.
function classifyFragment(fragment) {
  const trimmed = fragment.trim();
  // Same quote-concatenation hazard as the top-level early-allow (FIX C): a
  // fragment retains its quotes, so ".st''erling/config.json" never contains
  // the bare substring ".sterling" in the raw text — check the quote-stripped
  // form too before declaring the fragment irrelevant.
  if (!trimmed || (!STORE_MENTION_RE.test(trimmed) && !STORE_MENTION_RE.test(unquotedText(trimmed)))) {
    return { write: false, fragment: trimmed };
  }

  // AC5: sterling.db is sealed to shell for EVERY verb, reads included.
  if (DB_MENTION_RE.test(trimmed)) return { write: true, fragment: trimmed, dbSeal: true };

  // (a) an unquoted output-redirect operator whose TARGET names a store path
  // — a redirect INTO the store — is a write regardless of verb. A redirect
  // present but targeting elsewhere (/dev/null, /tmp/out.txt, an fd
  // duplication) is not; the fragment falls through to verb classification.
  if (redirectsIntoStore(trimmed)) return { write: true, fragment: trimmed };

  const verb = firstWord(trimmed);

  // sed is only mutating in-place (-i / GNU long-form --in-place[=SUFFIX]);
  // otherwise it is a read filter that prints to stdout (FIX E).
  if (verb === 'sed') {
    if (/(^|\s)-\w*i\w*(\s|=|$)/.test(trimmed) || /(^|\s)--in-place(=\S*)?(\s|$)/.test(trimmed)) {
      return { write: true, fragment: trimmed };
    }
    return { write: false, fragment: trimmed };
  }

  if (verb === 'git') return { write: classifyGit(trimmed), fragment: trimmed };
  if (verb === 'find') return { write: classifyFind(trimmed), fragment: trimmed };

  if (READONLY_VERBS.has(verb)) return { write: false, fragment: trimmed };

  // Unknown verb mentioning the store: err CLOSED (in doubt, deny).
  // TAGGED so the denial can name THIS discriminator (board 31b2c872): reaching
  // here means the fragment mentions a store path AND its verb is absent from
  // READONLY_VERBS — nothing about the command was examined for writing, and a
  // reader who believes a write was detected goes looking for one that is not
  // there.
  return { write: true, fragment: trimmed, unknownVerb: true };
}

let offending = null;
let offendingIsDbSeal = false;
// Whether the offending fragment reached the closed-world fallback (unrecognised
// verb + store mention) rather than any of the positive write tests above.
// DECLARED BARE and initialized INSIDE the guarded body, exactly like
// `offendingProvenance` below: an initialized top-level `let` is a fail-closed
// boundary finding, and that ratchet only shrinks.
let offendingUnknownVerb;
// The provenance line for the OFFENDING fragment, or '' when it must not be
// printed. See the gate at the assignment below.
let offendingProvenance;
try {
  offendingProvenance = ''; // initialized INSIDE the guarded body (fail-closed baseline: a bare `let` is safe-listed, an initialized one is a finding)
  offendingUnknownVerb = false; // same rule, same reason
  // THE ACTIVE PLUGIN ROOT, derived ONCE per invocation, from THIS hook's own
  // location — the source file under scripts/hooks/ when a pin spawns it, the
  // esbuild bundle under hooks/ in production. Never CLAUDE_PLUGIN_ROOT, never
  // config (decision 5b82e94f step 1).
  const pluginRoot = resolveActivePluginRoot(import.meta.url, process.env);
  const provenanceCtx = { pluginRoot, cwd: input.cwd, unsafePredecessor: null };
  for (const frag of splitFragments(command)) {
    // The sanctioned-script escape is judged PER FRAGMENT (AC-E): a sanctioned
    // script elsewhere in a compound command must never launder a writing
    // fragment alongside it (`node scripts/x.mjs && rm .sterling/…` still
    // denies, naming the rm fragment). And ANCHORED to the fragment's
    // EXECUTABLE argument — mere presence of the name in the fragment's text
    // is never sufficient; see fragmentRunsSanctionedScript above.
    // And granted only when the sanctioned invocation is RIDER-FREE: a
    // substitution or store-directed redirect riding along is shell work the
    // sanctioned executable never sanctions (see
    // sanctionedFragmentHasShellRider above) — such a fragment falls through
    // to ordinary classification instead of being waved past.
    const sanctioned = fragmentSanctionedProvenance(frag, allowScripts, provenanceCtx);
    const exempt = sanctioned.allow && !sanctionedFragmentHasShellRider(frag);
    // Recorded AFTER this fragment is judged and BEFORE the next: the fragment
    // itself is classified normally; only its successors lose the exemption. A
    // fragment that was granted the exemption — the FINAL verdict, rider check
    // included — is a safe predecessor (a child process cannot mutate the
    // parent shell; a rider on the fragment could). Records the first unsafe
    // predecessor for the denial wording.
    if (provenanceCtx.unsafePredecessor === null && !exempt && !fragmentIsSafePredecessor(frag)) {
      provenanceCtx.unsafePredecessor = frag.trim().slice(0, 80);
    }
    if (exempt) continue;
    const result = classifyFragment(frag);
    if (result.write) {
      offending = result.fragment;
      offendingIsDbSeal = Boolean(result.dbSeal);
      offendingUnknownVerb = Boolean(result.unknownVerb);
      // PROVENANCE IS PRINTED SELECTIVELY, AND THAT IS A WORDING RULE, NOT A
      // VERDICT RULE — it never affects the allow decision (5b82e94f step 8
      // asks the denial to explain itself, nothing more). Most denials have
      // nothing to do with provenance: the executable candidate for
      // `grep -c . .sterling/sterling.db` is the word `grep`, and telling the
      // operator that `<project>/grep` does not exist would be noise that reads
      // as the reason for the refusal. So the line is printed only when the
      // candidate could plausibly have BEEN a sanctioned script — an
      // interpreter form (`node <path> …`) or a word carrying a path separator
      // — which is exactly the population that types a correct-looking command
      // and needs to learn WHICH FILE it actually resolved to.
      const d = sanctioned.detail;
      const looksLikeAScriptInvocation = Boolean(sanctioned.word) && (sanctioned.viaInterpreter || sanctioned.word.includes('/'));
      offendingProvenance = d && !d.allow && looksLikeAScriptInvocation ? `Sanctioned-script provenance: ${d.reason}\n` : '';
      break;
    }
  }
} catch (e) {
  // This gate BLOCKS by exit code; an uncaught throw here would exit non-2,
  // which the platform treats as non-blocking — a silently VOIDED gate (the
  // F5 fail-open class, anti_pattern e13f0fb5). Any unexpected internal error
  // during evaluation must deny, not disappear.
  deny(
    environmentDefectDenial(
      'H15',
      `Internal error while evaluating shell command safety (${e.message}); the gate fails closed rather than risk a silent void.`,
      { agentId: input?.agent_id } // same handler-cannot-throw rule as the [cwd] catch above
    )
  );
}
if (!offending) allow();

// DISCLOSURE-ONLY message for the raw command-text DB seal (decisions
// h15-broad-command-text-guard-is-terminal-accepted and
// h15-db-seal-residual-discharged-by-disclosure): the allow surface here is
// UNCHANGED from the generic deny below — only the wording differs, naming
// the exact matched substring, its offset, and the seal's discriminator, and
// dropping the generic message's false "only redirections INTO .sterling/"
// claim (a redirect whose target merely CONTAINS the literal while pointing
// OUTSIDE .sterling/ is denied too).
if (offendingIsDbSeal) {
  const match = DB_MENTION_RE.exec(command);
  const matchedText = match ? match[0] : 'sterling.db';
  const offset = match ? match.index : command.search(DB_MENTION_RE);
  deny(
    "H15: shell access to the Sterling store's database file is denied — DB access is the MCP tool surface's job, never raw shell.\n" +
      `Denied fragment: ${offending}\n` +
      `Matched substring: "${matchedText}" at offset ${offset} in the command text.\n` +
      'This is a raw command-text DB seal: it matches the literal text of the command, not a resolved path or write target, so syntactic role and verb are intentionally ignored — it fires the same whether the literal sits in a path, inside a quoted search pattern, or in a redirect target, and regardless of whether the verb is a write or a normally read-only one like grep.\n' +
      'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / run_signal / agent_exit.\n' +
      `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts) — an entry exempts a fragment ONLY when that fragment's EXECUTABLE argument RESOLVES, by realpath, to that exact file inside the active plugin root; the same name in a comment, a quoted flag value, an unrelated path, or a project-local file of the same name exempts nothing.\n` +
      offendingProvenance +
      'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
  );
}

deny(
  'H15: shell write access to the Sterling store is denied — the store is read and written through the §10 MCP tool surface ONLY.\n' +
    `Denied fragment: ${offending}\n` +
    'This is the closed-world store-write classifier: verbs not explicitly recognized as read-only are deliberately denied as potentially mutating (decision 0b4d3c8c) — the denial does not assert the command was proven to write.\n' +
    // THE DISCRIMINATOR THAT ACTUALLY FIRED, when it was the fallback (board
    // 31b2c872): every other deny path here has a positive finding behind it (a
    // redirect into the store, sed -i, a writing git subverb). This one has
    // none — it is a store-path MENTION under a verb the allowlist does not
    // recognise — and saying so is the difference between "add your verb to
    // READONLY_VERBS or use the tool surface" and hunting for a write that was
    // never detected.
    (offendingUnknownVerb
      ? `Discriminator: this fragment NAMES a store path and its verb ('${firstWord(offending)}') is not in the read-only verb allowlist — that combination alone is the denial. No write was detected in it.\n`
      : '') +
    'Reads: knowledge_query / knowledge_get / board_query / maintenance_query / run_state. Writes: knowledge_create / knowledge_update / knowledge_link / board_add / board_remove / run_signal / agent_exit.\n' +
    `Sanctioned scripts/launchers: ${allowScripts.join(', ')} (config store_guard.allow_scripts) — an entry exempts a fragment ONLY when that fragment's EXECUTABLE argument RESOLVES, by realpath, to that exact file inside the active plugin root.\n` +
    offendingProvenance +
    ".sterling/sterling.db is sealed to shell access for EVERY verb, reads included — DB access is the MCP tool surface's job, never raw shell.\n" +
    // THE FALSE CLAUSE IS DELETED (5b82e94f / pin PV-8b). It used to read "only
    // writes, redirections, and moves/copies INTO .sterling/ are denied", which
    // is not H15's surface: the raw command-text DB seal fires on ANY occurrence
    // of the literal for EVERY verb, reads included, and the sanctioned-script
    // branch denies on PROVENANCE having classified nothing at all. A denial
    // that misstates its own rule sends the operator to rewrite a command that
    // was never the problem.
    'Non-DB store files (config.json, transient/*) ARE shell-readable (decision 0b4d3c8c); the closed-world classifier above is what decides, and a verb it does not recognize as read-only is denied.\n' +
    'If the running MCP server predates the current code, RESTART THE SESSION — never write around the surface.'
);
