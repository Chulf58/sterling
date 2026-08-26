// H1 — conventions + banner (spec §6 H1). SessionStart, non-blocking.
// Conventions go to Claude as additionalContext; board/maintenance counts go
// to the human as systemMessage — the queue is event-drained and otherwise
// invisible; this is its visibility pressure. Banner art goes to stderr
// (adjudicated 2026-06-12): a SessionStart hook sees no CLI flags or pipe
// state, so suppression is env-only (STERLING_NO_BANNER=1).
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, allow, openStore, loadConfig } from './lib/common.mjs';
import { probeDirtyPaths, formatResidueLine } from './lib/dispatch-residue.mjs';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { buildIdPath, runtimeMarkerPath, runtimeMarkerSchema, stalenessVerdict } from '@sterling/schemas';
import { parseInstalledHeader, extractBakedCommandPaths } from '../lib/agent-distribution.mjs';

// Concurrent-subagent ceiling (decision d7a0289f, board 18a22b56): the
// delegation bullet below states config.delegation.max_concurrent, never a
// hardcoded literal — a same-day ruling on this machine (5 → 15) was
// re-injected as the stale "FIVE" the next session, which is exactly the
// drift a config-driven number closes. Absent config → shipped default 5.
function conventions(maxConcurrent) {
  return [
    'Sterling conventions (injected by H1):',
    '- Anti-speculation: never invent an API, field, flag, or behavior; cite tool-call evidence from this turn or say "I don\'t know, checking" and check.',
    '- No false action claims: never imply something was saved, run, or recorded unless it was actually performed this turn.',
    '- Canonical naming: one name per concept, from the registries; phase execution, intake, steps — kill synonyms on sight.',
    // Injected here, not in CLAUDE.md: H1 ships from the shared plugin clone, so these
    // reach every project at its next session start with no per-project copy and no
    // stamp-contract propagation — the same reason the todo/queue routing lines live on
    // the commands. Stated because the user was otherwise re-declaring them per project.
    // Delegation: the anti-quota half leads DELIBERATELY. An earlier revision of this
    // rule read "3-5 active at all times" in a consuming project and the user withdrew it
    // within a day — "i am afraid that a session will feel force to spend up subagents even
    // if they see necessary" — and the same concern was raised again here on 2026-07-29:
    // "i am afraid that the conductor feel force to dispatch subagents without any value,
    // for the sake of just doing it to keep the claude.md happy". Leading with "up to N"
    // reads as a target; leading with the ceiling reads as a limit. Both halves of the
    // watchdog conditional bind, and over-dispatch is named a DEFECT rather than waste,
    // because a rule that only pushes one way is the rule that produced the fear.
    `- Delegation: ${maxConcurrent} concurrent subagents is a CEILING, not a target — there is no floor, no quota and no expectation. This convention is NEVER satisfied by dispatching: an idle slot is not a finding, and a session that delegated nothing and did the work itself has violated nothing. Dispatch where it buys something real — speed on genuinely independent work, an independent pair of eyes on quality, or protecting the conductor context window. THE CONTEXT WINDOW IS THE PRIMARY VALUE (user-stated 2026-08-10, decision 9042abeb): the conductor typically runs on a premium model, so hand-work costs twice — it fills the session's scarcest context AND spends the most expensive tokens, while a subagent (opus for judgment, sonnet for mechanical) returns only the conclusion at a fraction of the price. Weigh dispatch-vs-hand-work in conductor tokens spent on intermediate reading, not just wall-clock. Dispatching without value is a DEFECT, not a neutral choice: it loses twice, burning tokens AND returning a report the conductor must read and verify, spending the very context the delegation was meant to protect.`,
    '- The count is a trigger to CHECK, never a level to maintain: "fewer than 3 agents running AND work available? dispatch". Both halves bind — being below three prompts one question, is there parallel work, and "no" is a complete and correct answer that ends the matter. Dispatch several independent things in ONE message so they actually overlap; when there is one thing to do, do the one thing. The real failure is never "too few agents" — it is the conductor reading files by hand that an agent should have read for it.',
    // Named moments (decision 677f1639, 2026-08-10): measured miss — the conductor sat at
    // 1/5 seats with three delegable analyses boarded and the watchdog verbatim in context.
    // Diagnosis: the rule bound to no event (an always-rule fires never) and the wording's
    // fear was one-sided. Trigger moments added; the anti-quota lead above is unchanged.
    '- THE WATCHDOG CHECK HAS THREE NAMED MOMENTS — an always-rule fires never, so ask it exactly here: (1) an agent RETURNS: a freed seat is a dispatch decision, not background noise — adjudicate the report, then re-ask "is there parallel work?"; (2) a work unit lands (slice committed, design adjudicated, drain finished): before choosing the next unit, ask what can run beside it; (3) BEFORE starting any multi-file read, sweep, probe, repro, or bulk analysis by hand: if you only need the CONCLUSION, it is a dispatch — hand-work needs a positive reason (live diagnosis with the user, design needing exact semantics held in your own context, verifying a subagent\'s claim). Under-delegation and over-dispatch are the SAME defect with the same cost: the conductor\'s attention spent where it should not be (decision 677f1639).',
    // Slice ordering (decision slice-ordering-is-unblock-first, user-ruled 2026-08-22): the
    // stable-identity campaign ran its critical path single-file for hours with free seats while
    // later slices' independent pieces were already dispatchable — the user had to interrupt
    // to demand the frontier be widened. This states WHAT TO PICK; 677f1639 above states WHEN
    // to check. Sharpened by an external-model (Codex) consult, adjudicated: pure unlock-count
    // starved risky-but-low-unlock proof slices and mandatory low-unlock slices, and re-picking
    // on every freed seat could interrupt coherent in-flight work for no reason.
    '- SLICE ORDERING IS UNBLOCK-FIRST (decision slice-ordering-is-unblock-first, user-ruled 2026-08-22; sharpened by external-model consult): order every slice list by UNBLOCKING POWER weighed WITH risk-retirement — a risky integration proof may deserve first position even when it unlocks little, and low-unlock but mandatory slices get a latest-start bound so they cannot starve. Re-pick what most widens the frontier on MATERIAL EVENTS (slice completion, dependency change, newly discovered work) — never disturb coherent in-flight work just because a seat freed. The frontier — ready work across the board, the maintenance queue, and future slices\' independent pieces (read-only hunts, pins authorable from a settled design, scoped artifacts that cannot contaminate the current slice\'s commit boundary) — must GROW while an objective\'s slice list is still expanding; convergence to single-file near the end is healthy when EXPLAINED, a defect when unexamined. Librarian dispatches are store maintenance, not parallel WORK. TURN-END RULE: a turn may not end in a wait-state with free seats unless the report names the READY, POSITIVE-VALUE, SAFELY-DISPATCHABLE work on the frontier and why none qualifies — a free seat alone never implies dispatch (the quota pathology stays forbidden).',
    // Article application (decision dac3d2c6, 2026-08-10): measured miss — the conductor
    // drafted correctly but hand-ran ~10 article writes and absorbed the ~50KB full-record
    // echo each store write then returned. Board 7ddf13a7 has since slimmed the echo (write
    // results default to a digest receipt), but the dispatch shape stands: drafting a
    // slice's reconciles still spends conductor attention per write, and the librarian
    // batches them off the critical path. Drafting stays with the conductor.
    '- ARTICLE APPLICATION IS DISPATCH-SHAPED: the conductor DRAFTS all reconcile text — the librarian never authors knowledge — then BATCHES the slice\'s drafted updates into ONE librarian dispatch (drafts + target ids + apply order) that returns only new record ids + versions and closes the reconcile_needed items its writes clear. (Write echoes default to a slim digest receipt since board 7ddf13a7 — the old ~50KB full-record echo is opt-in via projection:\'full\' — so the dispatch now buys parallelism and attention, not just tokens.) The dispatch is FIRE-AND-CONTINUE: a librarian ALWAYS runs in parallel with the conductor\'s next work — never await it, never hold it for something to run beside (user-decided 2026-08-10); the only follow-ups are re-checking projection freshness after it reports, and never aiming two concurrent writers at the SAME record. Hand-run store writes only for small authored creates, a write needing live adjudication, or a single small-record touch (decision dac3d2c6).',
    '- The Workflow tool stays OPT-IN and needs the user\'s explicit per-prompt ask ("use a workflow" / "ultracode") or the session setting — its fan-out is an order of magnitude larger, so that cost stays theirs to authorize. Dispatches the brain returns during an active run, and the conductor_direct agents (librarian/debugger) on a task already stated, are authorized work either way.',
    // Slice-flow + mode intent (user-decided 2026-08-10, decision aac19532): per-slice
    // stops were rejected verbatim ("demands attention all the time"); the three subagent
    // purposes are the user's own words. Ships here so every project gets it next session.
    '- CONDUCTOR MODE FLOWS THROUGH SLICE BOUNDARIES: commit each slice at its boundary, reconcile, and CONTINUE to the next unattended — never end the turn to ask "shall I continue?". The user is engaged at exactly two points: the merge-to-main gate, and a genuine blocker (an adjudication only they can make, an ambiguity the store cannot resolve, hard context pressure → rotation). Subagents are intrinsic to the mode, for three things: PARALLEL speed on independent work; subagents DO the work while the conductor REVIEWS; and protecting the conductor\'s context window (decision aac19532).',
    // Explorer is SONNET (user, 2026-07-29). The convention states the PIN, not the reasoning:
    // the rationale lives in the store (decision + the paired-exploration research_finding), and
    // conventions injected on every session stay short to stay read.
    '- Every spawned agent carries an EXPLICIT pinned model: opus for judgment, sonnet for authoring, exploration and mechanical work. NEVER haiku for a spawned agent, and NEVER Fable without the user\'s prior agreement for that specific spawn — and never a silent inherit of the session model.',
    '- A SUBAGENT RESULT IS EVIDENCE, NOT A VERDICT. Treat every exhaustiveness claim in an agent report ("all N files", "every hook", "ruled out none") as unverified until you have the count yourself — measured 2026-07-29, explorers at two different tiers BOTH asserted "all N" from a partial sweep. One grep -c is cheaper than a conclusion built on one.',
    '- CODEX (sparring partner) IS THE DEFAULT for repo-grounded read-only work AND code review: the DEFAULT independent reviewer on every significant code-touching diff, beside the mandatory roster reviewer (an outside model family catches shared-blind-spot defects a same-family reviewer cannot); and the DEFAULT ENGINE for repo-grounded read-only investigation (diagnosis, subsystem reading, bypass hunting) since it reads the repo itself in its own sandbox at zero marginal cost. THE DIVIDING LINE: repo-grounded READ-ONLY work goes to Codex; implementation and writes NEVER do (Codex runs outside the entire hook enforcement surface); store/KB-context work stays on Claude agents (Codex has no knowledge tools). On a plan-cap hit, fall back to a Claude dispatch and say so. ADVISORY, NEVER GATING — it never writes and disagreement never blocks work (decision codex-preferred-for-read-shaped-analysis).',
    '- QUESTION DISCIPLINE: every decision put to the user goes through the AskUserQuestion tool form — a question asked in prose (even a numbered section) reads as rhetorical and gets missed (user-stated 2026-08-11). Ask ONE highest-leverage question through that form; consolidate the CONSIDERATIONS into that single question, never several questions into one form. When a prompt may time out unanswered, prefer the safe default and proceed unattended, disclosing the assumption — but ONLY for a REVERSIBLE choice needing no user authorization, and NEVER for a gate/grill decision, which is re-asked or waited out instead (user, 2026-07-02).',
    '- SOLVE, DON\'T BOARD: for findings INSIDE the current task\'s scope or an already-selected board item, evaluate and fix in-session; board only what genuinely cannot be done now, saying why — many smells dissolve on two minutes of checking (user-stated 2026-07-27). UNRELATED findings are surfaced for the user\'s disposition, never fixed inline (surface smells, don\'t fix them). Small board items get NO per-item slice ceremony: fix directly, one commit per task, one review pass (user-decided 2026-08-21).',
  ].join('\n');
}

// swappable art slot (§6 H1): fixed-width ≤40 cols, fits the 35% split pane
const BANNER_ROWS = [
  '▄▀▀ ▀█▀ █▀▀ █▀▄ █   ▀█▀ █▄ █ ▄▀▀▄',
  '▀▀▄  █  █▀▀ █▀▄ █    █  █ ▀█ █ ▄▄',
  '▀▀▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀  ▀ ▀▀▀▀',
];

// sterling-silver gradient, lerped per column: white → silver → steel blue
const GRADIENT = [
  [255, 255, 255],
  [192, 192, 200],
  [70, 100, 130],
];

function colorAt(t) {
  const [from, to, u] = t <= 0.5 ? [GRADIENT[0], GRADIENT[1], t * 2] : [GRADIENT[1], GRADIENT[2], (t - 0.5) * 2];
  return from.map((v, i) => Math.round(v + (to[i] - v) * u));
}

function paint(rows) {
  if (process.env.NO_COLOR) return rows.join('\n');
  const width = Math.max(...rows.map((r) => r.length));
  return rows
    .map(
      (row) =>
        [...row]
          .map((ch, x) => {
            if (ch === ' ') return ch;
            const [r, g, b] = colorAt(width <= 1 ? 0 : x / (width - 1));
            return `\x1b[38;2;${r};${g};${b}m${ch}`;
          })
          .join('') + '\x1b[0m'
    )
    .join('\n');
}

/** The plugin root — the dir holding .claude-plugin/plugin.json — by a bounded
 *  walk-up that works from scripts/hooks/ (source, tests) and hooks/ (bundle).
 *  STERLING_PLUGIN_ROOT overrides for tests (mirrors STERLING_SERVER_DIST
 *  below): the real walk always resolves to the one clone the test process
 *  runs from, so a test cannot otherwise put cwd AT the plugin root without
 *  faking fixtures inside that live clone's own .sterling/. */
function pluginRoot() {
  if (process.env.STERLING_PLUGIN_ROOT) return process.env.STERLING_PLUGIN_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** POSIX-ish path equality for the self-hosted-clone check below: strips a
 *  trailing slash and normalizes backslashes, but does NOT resolve symlinks —
 *  both sides already come from path.resolve/dirname/join in this process. */
function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** Plugin version, fail-open (no version, no line). */
function pluginVersion() {
  try {
    const root = pluginRoot();
    if (!root) return null;
    const v = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v.length ? v : null;
  } catch {
    // fail-open — the banner prints without a version line
  }
  return null;
}

/**
 * DEAD-DISPATCH RESIDUE AT THE SESSION BOUNDARY (SPEC A items 2/3b, boards
 * 03ed9d35/31565253; shared lib scripts/hooks/lib/dispatch-residue.mjs). A
 * pure filesystem+git fact about the H22 register — computed BEFORE the
 * `if (!store) allow()` bail below so it still fires for a cwd carrying a
 * register + config but no initialized knowledge store yet (mirrors H10's
 * same store-independent placement). Age-independent by design: at H1 the
 * register belongs to a DEAD session by construction (its SubagentStop never
 * fired), so no TTL wait is needed, unlike H10's Stop-time check. Only on
 * source startup|clear — resume/compact continue the same logical session and
 * keep their registers, same gating as the residue-conversion block further
 * down. Read-side print-once only (a truthy residue_reported_at, however it
 * got there — H10's Stop-side stamp included — suppresses); H1 never needs to
 * write the stamp itself since the register is deleted unconditionally right
 * after this runs.
 */
function computeH1DeadDispatchResidue(cwd, source) {
  if (source !== 'startup' && source !== 'clear') return [];
  const registerPath = join(cwd, '.sterling', 'transient', 'dispatch-register.json');
  let raw = [];
  try {
    if (existsSync(registerPath)) {
      const parsed = JSON.parse(readFileSync(registerPath, 'utf8'));
      if (Array.isArray(parsed)) raw = parsed;
    }
  } catch {
    raw = [];
  }
  if (!raw.length) return [];
  const lines = [];
  for (const entry of raw) {
    if (!entry || entry.residue_reported_at) continue; // print-once, cross-surface with H10
    const probe = probeDirtyPaths(cwd, entry.files);
    const dirty = Array.isArray(probe.dirty) ? probe.dirty : [];
    if (probe.verified && dirty.length === 0) continue; // clean — nothing to report
    lines.push(formatResidueLine(entry, dirty, { verified: probe.verified, reason: probe.reason }));
  }
  return lines;
}

/**
 * SURVIVING REVIEW RECEIPTS (decision review-ledger-receipt-expiry, 0408b295;
 * board 09e03d76). A receipt still sitting in .sterling/review-ledger.json at
 * SessionStart is one that OUTLIVED the session that earned it — the exact
 * shape scripts/commit-reviewed.mjs now refuses to stamp (foreign session_id
 * or branch: disclosed, never silently spent). Withholding the stamp without
 * this report would just move the leak: the receipt would sit there unspendable
 * and invisible. This is the surface that names it.
 *
 * READ-ONLY, deliberately: H1 wipes the transient registers but NEVER the
 * ledger. A receipt is real reviewer evidence, and deciding it is worthless is
 * a human judgement — the ledger's survival across the session boundary is the
 * whole point of it living at the store root (decision review-receipt-ledger).
 * Age-independent for the same reason the dead-dispatch residue above is: at a
 * session boundary EVERY receipt present is by construction from an earlier
 * session, so there is no TTL to wait out. Pure filesystem, fail-open.
 */
/** Sanitize ONE receipt-derived value before it is interpolated into
 *  additionalContext (Codex review, MEDIUM). A ledger entry is JSON on disk and
 *  every field in it is arbitrary: a newline-bearing agent_type, session_id,
 *  branch or file path would inject VERBATIM LINES into a block the model reads
 *  as H1's own prose — a value forging the surface that reports it. Control
 *  characters (newlines included) collapse to a space and the result is clamped,
 *  so one hostile or corrupt field can neither counterfeit a line nor flood the
 *  injection. Callers have already narrowed to a non-empty string, so this never
 *  calls String() on an arbitrary value (the {toString:null} throw class). */
const RECEIPT_FIELD_CLAMP = 120;
function safeReceiptField(v) {
  if (typeof v !== 'string') return '';
  // Code-point filter rather than a control-character regex class: it states
  // the ranges as numbers (no escape sequence to get subtly wrong, and no
  // literal control character in the source), and it covers C0 — LF and CR
  // included, which is the whole point, a newline is what forges a line — plus
  // DEL and the C1 block some terminals still act on.
  const cleaned = [...v]
    .map((ch) => {
      const c = ch.codePointAt(0);
      return c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) ? ' ' : ch;
    })
    .join('')
    .trim();
  return cleaned.length > RECEIPT_FIELD_CLAMP ? `${cleaned.slice(0, RECEIPT_FIELD_CLAMP)}…(truncated)` : cleaned;
}

function reviewReceiptLines(cwd) {
  const ledgerPath = join(cwd, '.sterling', 'review-ledger.json');
  if (!existsSync(ledgerPath)) return [];
  let entries = [];
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    return []; // malformed ledger degrades to silence here (same posture as every H1 read); commit-reviewed reports it at spend time
  }
  return entries
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const parsedAt = typeof e.at === 'string' ? Date.parse(e.at) : NaN;
      // Same 'X.Xh' convention as commit-reviewed's staleness advisory, so one
      // receipt reads identically on both surfaces.
      const age = Number.isNaN(parsedAt) ? 'age unknown (no usable timestamp)' : `${((Date.now() - parsedAt) / 3_600_000).toFixed(1)}h old`;
      // EVERY receipt-derived string below goes through safeReceiptField before
      // it reaches the injected block — agent_type, session_id, branch and file
      // paths alike. A field that sanitizes down to empty is treated as absent,
      // so a control-character-only value cannot smuggle in a blank label
      // either.
      const type = safeReceiptField(e.agent_type) || 'unknown reviewer';
      const session = safeReceiptField(e.session_id);
      const branch = safeReceiptField(e.branch);
      const origin = [session ? `session ${session}` : null, branch ? `branch ${branch}` : null].filter(Boolean).join(', ');
      const files = Array.isArray(e.files) ? e.files.map((f) => safeReceiptField(f)).filter(Boolean) : [];
      return `- ${type} — ${age}${origin ? ` (earned in ${origin})` : ' (no recorded session/branch — a pre-expiry receipt)'}${files.length ? `; files: ${files.slice(0, 5).join(', ')}` : ''}`;
    });
}

const input = readStdin();

// CURRENT-SESSION MARKER (decision review-ledger-receipt-expiry, 0408b295).
// SessionStart is the ONE moment the platform hands Sterling a session_id at a
// known point in a session's life. scripts/commit-reviewed.mjs is a bare CLI —
// no hook stdin, no injected env — so without this cell it cannot tell whether
// a review receipt was earned in THIS session or an earlier one, and receipt
// expiry has nothing to compare against. A latest-value cell keyed by session
// and superseded by the next SessionStart (the shape H10's pressure/gauge/
// delegation markers already use): P4 by supersession, never by a remembered
// cleanup step. Gated on .sterling/config.json's EXISTENCE, the same gate H22
// uses, so H1 never creates a store directory in a non-Sterling project (P1).
// Fail-open: a failed write costs only expiry precision — commit-reviewed then
// reads no marker, cannot judge session identity, and treats every receipt as
// unjudgeable-hence-eligible, i.e. exactly the pre-expiry behavior.
//
// PUBLISHED ATOMICALLY (tmp + rename, the primitive both ledger writers already
// use — Codex review, MEDIUM). A bare writeFileSync can be read TORN by a
// concurrent scripts/commit-reviewed.mjs; its JSON.parse then fails, the
// identity channel goes dark, and a PRESENT-FOREIGN receipt stamps — the exact
// outcome receipt expiry exists to prevent, reached through a race rather than
// through a missing field. rename() on the same filesystem is atomic, so a
// reader sees either the previous marker or this one, never half of one. The
// pid in the staging name keeps two concurrent SessionStarts from clobbering
// each other's tmp file.
const sessionMarkerPath = join(input.cwd, '.sterling', 'transient', 'session.json');
const sessionMarkerTmp = join(input.cwd, '.sterling', 'transient', `session.json.tmp-${process.pid}`);
try {
  if (existsSync(join(input.cwd, '.sterling', 'config.json'))) {
    mkdirSync(join(input.cwd, '.sterling', 'transient'), { recursive: true });
    writeFileSync(
      sessionMarkerTmp,
      JSON.stringify({ session_id: input.session_id ?? null, source: input.source ?? null, at: new Date().toISOString() })
    );
    renameSync(sessionMarkerTmp, sessionMarkerPath);
  }
} catch {
  // fail-open — never break SessionStart for a marker (P1). But a PREVIOUS
  // session's marker surviving a failed write is stale positive evidence: it
  // would make every receipt promoted THIS session read as foreign and hard-
  // refuse the commit gate on a false premise. Absence is the honest state —
  // commit-reviewed then cannot judge session identity and stays eligible.
  // recursive AS WELL AS force: `force` suppresses ENOENT only, so a marker
  // path occupied by a non-empty DIRECTORY (a corrupted tree, a botched manual
  // fix) would survive every cleanup AND block every future write — permanently
  // stale evidence, which is the precise state this catch exists to prevent.
  // The path is Sterling-owned transient state, so removing whatever shape sits
  // there is unambiguous: nothing else can legitimately own
  // .sterling/transient/session.json.
  try {
    rmSync(sessionMarkerPath, { recursive: true, force: true });
    // A staging file orphaned between write and rename dies with the attempt
    // that created it (P4) — no later sweep is relied on to notice it.
    rmSync(sessionMarkerTmp, { recursive: true, force: true });
  } catch {
    // even the removal is best-effort — never break SessionStart (P1)
  }
}

const dispatchResidueLines = (() => {
  try {
    return computeH1DeadDispatchResidue(input.cwd, input.source);
  } catch {
    return [];
  }
})();
const receiptLines = (() => {
  try {
    return reviewReceiptLines(input.cwd);
  } catch {
    return [];
  }
})();
const receiptContext = receiptLines.length
  ? `\n\nSURVIVING REVIEW RECEIPTS (H1): ${receiptLines.length} un-consumed review receipt(s) sit in .sterling/review-ledger.json — earned by a reviewer dispatch that ended, but never stamped into a commit.\n` +
    receiptLines.join('\n') +
    `\nA receipt from an earlier session or another branch is NO LONGER SPENDABLE: scripts/commit-reviewed.mjs discloses it and refuses to stamp it (decision review-ledger-receipt-expiry) — its life is bound to the session and branch that earned it, so stamping it here would claim a review that never saw this work. Nothing was deleted. Usual cause: a code-touching commit made with bare 'git commit' instead of commit-reviewed, so the review it earned was never consumed. Judge each one and remove it by hand, or re-dispatch a reviewer for the work it covered.`
  : '';
const store = openStore(input.cwd);
if (!store) {
  // The receipt report rides this early exit too: H22's ledger gate is
  // .sterling/config.json (not sterling.db), so a project with a config but no
  // initialized store CAN accumulate receipts — reporting them only on the
  // store-present path below would leave exactly those projects silent.
  if (dispatchResidueLines.length || receiptContext) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: dispatchResidueLines.join('\n\n') + receiptContext },
      })
    );
  }
  // FIXER ADDENDUM A (2026-08-25): the register wipe below is pure
  // filesystem — it needs no open store — so a project with .sterling/
  // (config.json present, per H22's widened gate) but no sterling.db yet
  // must still get it HERE, on this early exit, or its register accumulates
  // forever and every startup re-reports the same residue without ever
  // wiping. Gated to startup|clear only, mirroring
  // computeH1DeadDispatchResidue's own gate above — resume/compact stay
  // untouched on this branch too, same as the store-present path below.
  if (input.source === 'startup' || input.source === 'clear') {
    try {
      const transientDir = join(input.cwd, '.sterling', 'transient');
      rmSync(join(transientDir, 'dispatch-register.json'), { force: true });
      for (const f of readdirSync(transientDir)) {
        if (f.startsWith('dispatch-register.json.tmp-')) rmSync(join(transientDir, f), { force: true });
      }
    } catch {
      // fail-open — a failed delete costs deferral precision, never this early exit
    }
  }
  allow(); // not a Sterling project — no further ceremony (P1)
}

// H1 is SOFT (banner + conventions + counts): a malformed config must cost the
// deep-queue threshold, never the conventions injection, so this read is guarded
// and falls back to the schema default rather than throwing. Contrast the gates
// (H3/H5/H14/H15), which fail CLOSED on exactly this input — a hook that cannot
// evaluate must deny only where denying is its job (anti_pattern e13f0fb5).
let config = null;
try {
  config = loadConfig(input.cwd);
} catch {
  config = null;
}

// MACHINE ROLE (todo cabbc10f, decision a9b98b7d): stated ONLY when this
// session's project IS a Sterling clone itself — comparing the normalized
// input.cwd to pluginRoot(). Every OTHER Sterling project (a consumer of the
// plugin, not a clone of it) never sees this line; it exists because the
// committed CLAUDE.md's "this machine authors" prose travels with every
// clone and misleads a session opened inside one. Guarded exactly like the
// config read above — H1 is soft, so a malformed config costs this line, never
// the conventions injection.
let roleContext = '';
try {
  const root = pluginRoot();
  if (root && samePath(input.cwd, root)) {
    const role = config?.machine_role;
    if (role === 'authoring') {
      roleContext =
        '\n\nMACHINE ROLE: AUTHORING (declared in .sterling/config.json machine_role) — Sterling work lands and merges here; CLAUDE.md\'s authoring contract applies.';
    } else if (role === 'consumer') {
      roleContext =
        '\n\nMACHINE ROLE: CONSUMER — this clone consumes via /sterling:update. The committed CLAUDE.md\'s "this machine authors" language does NOT apply on this machine: never commit here, never hand-reconcile drift; a dirty generated file is discarded (git checkout -- <path>); currency comes only from /sterling:update.';
    } else {
      roleContext =
        '\n\nMACHINE ROLE: UNDECLARED — treat as CONSUMER (the safe posture) until declared. The authoring machine declares machine_role:"authoring" in .sterling/config.json once; a successful /sterling:update stamps "consumer" automatically.';
    }
  }
} catch {
  // fail-open — a malformed config or unresolved plugin root costs only this line
}

// CLONE-CURRENCY SIGNAL (closes the gap decision be9168e8 surfaced and parked:
// "a machine that never runs /sterling:update has no passive signal that it is
// behind"). Probes the CLONE at pluginRoot() — not this project — so every
// session on the machine states whether Sterling is current. Throttle: the one
// networked step (git fetch) runs at most once per TTL (default 24h), stamped
// in .git/sterling-update-check.json; the behind-count is computed LOCALLY
// against the last-fetched ref on every session start, so an applied update
// goes silent immediately without waiting out the TTL. checked_at is stamped
// even when the fetch fails — an offline machine must not pay the timeout on
// every session start. Skipped entirely on a declared-authoring clone (it
// lives on branches and ahead-of-origin states, where "behind" is noise) and
// off the default branch. Fail-open and silent on any error (P1); the
// definitive probe stays /sterling:update --check.
// STERLING_CURRENCY_DISABLE=1 skips the probe entirely (test hermeticity: the
// hook test battery must never fetch — it RUNS during /sterling:update itself).
let currencyWarning = '';
let currencyContext = '';
try {
  const root = process.env.STERLING_CURRENCY_DISABLE === '1' ? null : pluginRoot();
  const gitDir = root ? join(root, '.git') : null;
  // .git as a FILE is a worktree — an authoring-machine shape; skip (fail-open).
  if (gitDir && existsSync(gitDir) && statSync(gitDir).isDirectory()) {
    let role = null;
    try {
      role = JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8')).machine_role;
    } catch {
      // no config or malformed — the safe posture is consumer (mirrors the role line above)
    }
    if (role !== 'authoring') {
      const git = (args, timeout = 5_000) => {
        const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout });
        return r.status === 0 ? (r.stdout ?? '').trim() : null;
      };
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const hasOrigin = (git(['remote']) ?? '').split('\n').includes('origin');
      const defaultBranch = hasOrigin
        ? (git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) ?? '').replace(/^origin\//, '') || 'main'
        : null;
      if (hasOrigin && branch && branch === defaultBranch) {
        const cachePath = join(gitDir, 'sterling-update-check.json');
        const ttl = Number(process.env.STERLING_CURRENCY_TTL_MS ?? 24 * 60 * 60 * 1000);
        let fresh = false;
        try {
          fresh = Date.now() - Date.parse(JSON.parse(readFileSync(cachePath, 'utf8')).checked_at) < ttl;
        } catch {
          // no cache yet — probe
        }
        if (!fresh) {
          // GIT_TERMINAL_PROMPT=0: a fetch that would prompt for credentials
          // must fail immediately, not hang SessionStart until the timeout.
          spawnSync('git', ['fetch', 'origin', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
          try {
            writeFileSync(cachePath, JSON.stringify({ checked_at: new Date().toISOString() }) + '\n');
          } catch {
            // unwritable cache costs only the throttle, never the signal
          }
        }
        const behind = Number.parseInt(git(['rev-list', '--count', `HEAD..origin/${defaultBranch}`]) ?? '', 10);
        if (Number.isFinite(behind) && behind > 0) {
          currencyWarning = `⚠ Sterling is ${behind} update(s) behind — double-click sterling-update.bat (or run /sterling:update), then restart the session. A /clear is NOT enough — MCP servers survive it, so EXIT AND RELAUNCH the Claude Code CLI. `;
          currencyContext =
            `\n\nSTERLING CLONE IS BEHIND (H1): the Sterling clone at ${root} is ${behind} commit(s) behind origin's default branch. ` +
            `Tell the user; on their word run /sterling:update (never hand-reconcile or git-pull around it — fast-forward-or-refuse, decision e6240afe), ` +
            `and remind them a session RESTART follows a successful update — that means EXIT AND RELAUNCH the Claude Code CLI, since a /clear alone does not reload the server/hook code.`;
        }
      }
    }
  }
} catch {
  // fail-open — the currency probe must never break or delay SessionStart beyond its timeouts
}

// ROTATION RESTORE (context-rotation slice 3): a rotation note written by
// scripts/rotation-note.mjs before a /clear is injected into the FRESH session
// and CONSUMED by that injection — source=clear ONLY (startup/resume have their
// own truths and must not eat a note prepared for a rotation that hasn't
// happened). Single-shot by deletion-before-build (P4): even a later failure in
// this block cannot leave a note that re-injects forever. Disclosures over
// refusals: a moved HEAD or an old note still injects, loudly qualified — the
// store/board stay the authorities; the note is only the non-reconstructable
// residue. Fail-open like every H1 read.
let rotationContext = '';
try {
  if (input.source === 'clear') {
    const notePath = join(input.cwd, '.sterling', 'transient', 'rotation-note.json');
    if (existsSync(notePath)) {
      const note = JSON.parse(readFileSync(notePath, 'utf8'));
      rmSync(notePath, { force: true }); // consume FIRST — a note serves exactly one restore
      const head = (() => {
        try {
          const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: input.cwd, encoding: 'utf8', timeout: 5_000 });
          return r.status === 0 ? (r.stdout ?? '').trim() : null;
        } catch {
          return null;
        }
      })();
      const cautions = [];
      if (note.head_sha && head && head !== note.head_sha) {
        cautions.push(`HEAD has MOVED since the note (${String(note.head_sha).slice(0, 8)} → ${head.slice(0, 8)}) — re-verify repository state before acting on it`);
      }
      // COMMITS-AHEAD DRIFT (N15, docs/feedback/sterling-plugin-*2026-08-24*):
      // the note's commits_ahead is a number the writer computed, not prose —
      // recompute it the same way at restore time and disclose any mismatch
      // exactly like the head_sha check above, rather than trusting a stamp
      // that may already be stale (a note written, then more commits landed
      // before the /clear actually happened). UNVERIFIABLE IS ITS OWN STATE
      // (Codex P2-B), distinct from both "matches" and "drifted": when the
      // base is missing or the recount itself fails (e.g. a --base ref that
      // no longer resolves), the stamped count is printed with an explicit
      // "(unverified — base unavailable)" marker rather than silently
      // presented as though it had been confirmed — and, just as important,
      // never asserted as DRIFT either, since a failed recount is not
      // evidence the number is wrong.
      let commitsAheadUnverified = false;
      if (typeof note.commits_ahead === 'number') {
        if (!note.base_branch) {
          commitsAheadUnverified = true;
        } else {
          try {
            const countR = spawnSync('git', ['rev-list', '--count', `${note.base_branch}..HEAD`], { cwd: input.cwd, encoding: 'utf8', timeout: 5_000 });
            const actual = countR.status === 0 ? Number((countR.stdout ?? '').trim()) : null;
            if (Number.isFinite(actual)) {
              if (actual !== note.commits_ahead) {
                cautions.push(`commits_ahead drift — note says ${note.commits_ahead}, actual is ${actual} (vs ${note.base_branch})`);
              }
            } else {
              commitsAheadUnverified = true;
            }
          } catch {
            commitsAheadUnverified = true; // fail-open — a failed recount costs only the verification, never the restore
          }
        }
      }
      const ageMs = Date.now() - Date.parse(note.at ?? '');
      if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
        cautions.push(`the note is ~${Math.round(ageMs / 3_600_000)}h old`);
      }
      const fields = ['objective', 'next_slice', 'risks', 'pointers', 'branch', 'head_sha', 'at']
        .filter((k) => note[k])
        .map((k) => `- ${k}: ${note[k]}`)
        .concat(
          typeof note.commits_ahead === 'number'
            ? [`- commits_ahead: ${note.commits_ahead} (vs ${note.base_branch ?? 'unknown base'})${commitsAheadUnverified ? ' (unverified — base unavailable)' : ''}`]
            : []
        )
        .join('\n');
      rotationContext =
        `\n\nROTATION RESTORE (H1, source=clear): a rotation note was prepared before this /clear; this injection CONSUMES it (single-shot).` +
        (cautions.length ? ` CAUTION: ${cautions.join('; ')}.` : '') +
        `\n${fields}\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. ` +
        (note.reason === 'code-reload'
          ? `CODE RELOAD WAS REQUIRED (note reason: code-reload) — the correct sequence was: 1. exit and relaunch the Claude Code CLI, 2. THEN this /clear. If step 1 was skipped, this session's MCP server/hooks may still be stale: exit and relaunch the CLI now, then /clear again.`
          : `If next_slice depends on a server/hook code change (migration, update, rebuild), that requires having EXITED AND RELAUNCHED the Claude Code CLI BEFORE this /clear — a /clear alone never reloads code, so relaunch now if that didn't happen yet.`);
    }
  }
} catch {
  // fail-open — a malformed note costs the restore, never the conventions injection
}

// READ-EVIDENCE DOES NOT SURVIVE A SESSION BOUNDARY OR COMPACTION (board
// 776d2b65): the conductor ledger's entries now expire by FILE CONTENT HASH
// rather than per prompt, so the two cases a hash cannot vouch for get an
// explicit clear here. (1) source=compact — compaction can drop a read from
// the model's window while the file's bytes are unchanged; the old per-prompt
// clear never covered this either, since compaction does not fire
// UserPromptSubmit. (2) source=startup|clear — a genuinely NEW session has
// read nothing, and a dead session's hashed entries would otherwise vouch for
// unchanged files this model never saw. resume continues the same logical
// session and keeps its ledger. Fail-open like every H1 read.
try {
  if (input.source === 'compact' || input.source === 'startup' || input.source === 'clear') {
    const conductorLedger = join(input.cwd, '.sterling', 'transient', 'conductor-reads.json');
    rmSync(conductorLedger, { force: true });
  }
} catch {
  // fail-open — a failed clear costs freshness, never the conventions injection
}

// DEAD-DISPATCH RESIDUE AT THE SESSION BOUNDARY (SPEC A items 2/3b): the lines
// were already computed store-independently, above the `if (!store) allow()`
// bail (computeH1DeadDispatchResidue) — folded into additionalContext here for
// the normal (store-present) path.
const dispatchResidueContext = dispatchResidueLines.length
  ? `\n\nDEAD-DISPATCH RESIDUE (H1, source=${input.source}): the in-flight dispatch register survived to this session boundary — its SubagentStop(s) never fired, so the register is about to be wiped (P4).\n` +
    dispatchResidueLines.join('\n')
  : '';

// IN-FLIGHT DISPATCH REGISTER (decision ec9eacaa): deleted UNCONDITIONALLY —
// every source, resume included. Unlike H10's other three registers there is no
// debt to verify and no source to gate on: an entry names a subagent process
// that cannot survive a session boundary, so at ANY SessionStart every entry is
// dead by definition (P4). Leaving one would defer a real duty on behalf of an
// agent that no longer exists, which is exactly the silent duty hole the
// staleness TTL exists to bound. Fail-open like every H1 read.
try {
  const transientDir = join(input.cwd, '.sterling', 'transient');
  rmSync(join(transientDir, 'dispatch-register.json'), { force: true });
  // Orphaned atomic-write staging files (a crash between write and rename in
  // H22) die at the same boundary (P4; review LOW, 2026-08-21).
  for (const f of readdirSync(transientDir)) {
    if (f.startsWith('dispatch-register.json.tmp-')) rmSync(join(transientDir, f), { force: true });
  }
} catch {
  // fail-open — a failed delete costs deferral precision, never the injection
}

// CONDUCTOR-ATTESTED ENFORCEMENT STAMP (decision h17-enforcement-stamp-
// conductor-attested-dirt, 6e132e19): deleted UNCONDITIONALLY — every source,
// resume included, mirroring the dispatch register above. It carries no
// capture debt of its own (never a residue register, never a capture_owed
// trigger) and it is only ever correct for the bundle bytes it attested at
// stamp time: a new session's conductor re-attests deliberately via
// scripts/enforcement-stamp.mjs, which is cheap to re-run (P4). Fail-open like
// every H1 read.
try {
  rmSync(join(input.cwd, '.sterling', 'transient', 'enforcement-stamp.json'), { force: true });
} catch {
  // fail-open — a failed delete costs re-attestation precision, never the injection
}

// LEAKED H17 PER-CALL TMPDIR RECLAMATION (board 2d4cf493). H17's Bash sweep
// writes per-call transient records into os.tmpdir() — the (A) STATE record
// `sterling-enforce-<tag>-<runId>-call-<key>.json`, the (B) content baseline
// `…-call-<key>.baseline.json`, and the (A) attribution record `…-call-<key>.dirty.json`
// — each consumed and unlinked by its OWN PostToolUse (P4). A Bash call whose
// PostToolUse never fires (the subagent process was killed, the session died
// mid-command) LEAKS its per-call file; and unlike H17's other transient state
// these live OUTSIDE .sterling/ in the shared os.tmpdir(), so no .sterling sweep
// above ever reaches them.
//
// WHY RECLAMATION LIVES HERE, NOT IN H17 (Codex approach C, outside-family
// design review): H17 is the VERDICT-PRODUCING deny process, and it must do
// ZERO extra work on the audited path — verdict isolation. An H17 exit-handler
// sweep was built and REVERTED for exactly that reason (it made every audited
// Bash call pay for cleanup of unrelated leaks, on the hottest enforcement
// path). H1 produces no allow/deny verdict and is lifecycle-bound to the
// SessionStart boundary (P4), so a bounded, best-effort sweep here costs an
// enforcement decision nothing.
//
// SCOPED to THIS project's tag (H17's projectTag, matched verbatim); AGE-GATED
// by a 1h TTL so a concurrent same-project session's in-flight Pre→Post files
// (which are seconds apart) are NEVER reclaimed; CAPPED per run — the next
// SessionStart continues. Best-effort: it never throws, never blocks, never
// writes to stdout (H1's stdout is JSON-only), and never changes H1's exit —
// failing open is correct here (cleanup, not enforcement).
const PERCALL_TMP_TTL_MS = 60 * 60 * 1000; // 1 hour
const PERCALL_TMP_SWEEP_CAP = 500;
try {
  // projectTag computed EXACTLY as H17's projectTag() (scripts/hooks/
  // h17-bash-write-sweep.mjs) — sha256 of the realpath'd cwd, first 16 hex — so
  // the tag matched here is byte-identical to the one H17 embedded in the leaked
  // filenames. realpath so WSL/symlink aliasing cannot split the writer's tag
  // from the sweeper's; a raw-path fallback exactly mirrors H17's own catch.
  let tagRoot = input.cwd;
  try {
    tagRoot = realpathSync(input.cwd);
  } catch {
    // cwd unreadable — fall back to the raw path, exactly as H17's projectTag does
  }
  const projectTag = createHash('sha256').update(tagRoot).digest('hex').slice(0, 16);
  // Anchored BOTH ends; `[\s\S]` (never `.`) for the arbitrary <runId> so a
  // newline in a runId cannot escape the end anchor. The optional
  // `.dirty`/`.baseline` token covers all THREE per-call shapes, and the 32-hex
  // key pins the per-call record precisely — a shorter, non-hex, no-`-call-`, or
  // non-`.json` near-miss is deliberately NOT matched (it is not a per-call
  // record and may be unrelated tmpdir content). projectTag is 16 hex chars, so
  // it is regex-inert and needs no escaping.
  const percallRe = new RegExp(`^sterling-enforce-${projectTag}-[\\s\\S]+-call-[0-9a-f]{32}(?:\\.dirty|\\.baseline)?\\.json$`);
  const tmp = tmpdir();
  const cutoff = Date.now() - PERCALL_TMP_TTL_MS;
  let removed = 0;
  for (const name of readdirSync(tmp)) {
    if (removed >= PERCALL_TMP_SWEEP_CAP) break;
    if (!percallRe.test(name)) continue;
    const p = join(tmp, name);
    try {
      if (statSync(p).mtimeMs >= cutoff) continue; // younger than the TTL — may belong to a live concurrent session
      rmSync(p, { force: true });
      removed++;
    } catch {
      // one un-statable/un-removable entry (e.g. a concurrent Post consumed it) never aborts the sweep (P1)
    }
  }
} catch {
  // fail-open — the tmpdir janitor must never break, block, or delay SessionStart (P1)
}

// SESSION-BOUNDARY REGISTER RESIDUE (board f474df56): H10's transient registers
// (touches / session-events / capture-nagged) are cleared by H10's terminal Stop
// paths — but a session that dies without one (kill, deny-then-close, or the
// capture-pending deferral's deliberate allow-without-clear, decision bd594c03)
// leaks them into the NEXT session: a stale nag marker silently downgrades every
// duty's soft-block to queue items, a stale capture_pending suppresses the capture
// nag for unrelated new work, and stale touches backdate `earliest` and pollute
// item file_keys and the unowned set. At a NEW session (source startup|clear ONLY —
// resume/compact continue the same logical session and keep their registers) the
// residue belongs to a DEAD session: verify its debt against the store (the same
// captured-set query H10 runs) and either clear silently (paid) or convert to ONE
// deduped capture_owed item, then clear (P5: dead-session debt lands on the queue
// or is verified paid — it never evaporates and never pollutes the new session's
// duty cycle). A malformed register is UNVERIFIABLE debt and converts regardless —
// conservative and loud, never silently trusted. Fail-open like every H1 read.
let residueContext = '';
try {
  if (input.source === 'startup' || input.source === 'clear') {
    const transient = join(input.cwd, '.sterling', 'transient');
    const regPaths = [join(transient, 'touches.json'), join(transient, 'session-events.json'), join(transient, 'capture-nagged.json')];
    const [touchesPath, eventsPath] = regPaths;
    if (regPaths.some((p) => existsSync(p))) {
      let touches = [];
      let events = [];
      let malformed = false;
      try {
        if (existsSync(touchesPath)) {
          const raw = JSON.parse(readFileSync(touchesPath, 'utf8'));
          if (Array.isArray(raw)) touches = raw;
          else malformed = true;
        }
      } catch {
        malformed = true;
      }
      try {
        if (existsSync(eventsPath)) {
          const raw = JSON.parse(readFileSync(eventsPath, 'utf8'));
          if (Array.isArray(raw)) events = raw;
          else malformed = true;
        }
      } catch {
        malformed = true;
      }
      // A lone nag marker with no work evidence is not debt — deleted silently below.
      if (touches.length || events.length || malformed) {
        const stamps = [...touches.map((t) => t?.at), ...events.map((e) => e?.at)].filter(Boolean).sort();
        const earliest = stamps.length ? stamps[0] : null;
        // Same captured-set semantics as H10's duty check: any durable record at or
        // after the residue's earliest timestamp means the dead session paid its debt.
        const paid =
          !malformed &&
          earliest !== null &&
          store
            .query({
              types: ['decision', 'anti_pattern', 'feature_article', 'research_finding', 'disconfirmed_hypothesis'],
              cap: 1000,
            })
            .some((r) => r.created_at >= earliest || r.updated_at >= earliest);
        if (!paid) {
          const paths = [...new Set(touches.map((t) => t?.path).filter(Boolean))];
          const pending = events
            .filter((e) => e?.kind === 'capture_pending' && e?.detail)
            .map((e) => e.detail)
            .at(-1);
          // "any capture_owed open" gates more than the choke's exact-key match
          // (its file_keys vary with the residue's paths) — kept deliberately;
          // only the write itself routes through enqueueSystemTodo (decision
          // 194f43e4).
          const open = store
            .query({ types: ['todo'], cap: 1000 })
            .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
          if (!open) {
            const now = new Date().toISOString();
            store.enqueueSystemTodo({
              id: randomUUID(),
              type: 'todo',
              created_at: now,
              updated_at: now,
              author: 'system',
              status: 'active',
              superseded_by: null,
              links: [],
              scope: 'project',
              stack_tags: [],
              text:
                `capture owed (session-boundary residue): a previous session ended without settling its transient registers — ` +
                (malformed
                  ? `register content was malformed, so the debt is unverifiable and stays loud` +
                    (paths.length ? `; ${paths.length} touched file(s) were recoverable` : '') +
                    ` — `
                  : `${paths.length} touched file(s), ${events.length} session event(s)` +
                    (pending ? `, declared pending (${pending})` : '') +
                    ` and no durable record since ${earliest} — `) +
                `verify the work landed its capture against HEAD, then close`,
              source: 'system',
              system_reason: 'capture_owed',
              file_keys: paths.slice(0, 20),
            });
            residueContext =
              `\n\nSESSION-BOUNDARY RESIDUE (H1): a previous session left unsettled transient registers` +
              (pending ? ` (including a capture_pending declaration: ${pending})` : '') +
              `; no durable capture covers this session-boundary residue, so ONE capture_owed item now carries the debt — verify it against HEAD when draining. The registers were cleared so they cannot pollute this session's duty cycle.`;
          }
        }
      }
      for (const p of regPaths) rmSync(p, { force: true });
    }
  }
} catch {
  // fail-open — residue conversion must never break SessionStart
}

let counts = { todos: 0, maintenance: 0, groupedTodos: 0, objectives: 0 };
let queueReasons = [];
let queueReasonEntries = [];
let drainable = 0;
let parked = 0;
try {
  // TRUE totals (AC1): store.count() runs the same §3.4 base filter as
  // query() with no rank/cap applied — it is the count-capable surface, never
  // a capped read (a fixed query cap, however generous, silently truncates a
  // queue that outgrows it; the historical instance under-reported 60 against
  // a true 102). The per-lane/objective breakdown still needs the actual
  // records (system_reason/objective aren't count()-filterable), so each
  // query below is capped at its own already-known true total — it can never
  // truncate, because the cap IS the count.
  const userTotal = store.count({ types: ['todo'], source: 'user' });
  counts.todos = userTotal;
  const userTodos = userTotal > 0 ? store.query({ types: ['todo'], source: 'user', cap: userTotal }) : [];
  // Objective grouping (decision a8d2ce6c): the banner discloses how many of
  // the open tasks are slices of larger objectives, so a sliced board reads
  // as N objectives to the human too — not only in the TUI's grouped view.
  const grouped = userTodos.filter((t) => t.objective);
  counts.groupedTodos = grouped.length;
  counts.objectives = new Set(grouped.map((t) => t.objective)).size;

  const systemTotal = store.count({ types: ['todo'], source: 'system' });
  counts.maintenance = systemTotal;
  const system = systemTotal > 0 ? store.query({ types: ['todo'], source: 'system', cap: systemTotal }) : [];
  // file_parked closes at branch merge (direct-merge sweeps it), never by
  // draining — counting it toward the deep-queue threshold makes H1 cry wolf
  // about items no drain can touch, and a standing warning about undrainable
  // items trains the operator to ignore the warning (2026-08-09 consuming
  // project: 15 by-design-open file_parked items tripped this every session
  // start). It stays in counts.maintenance (the human's banner shows the true
  // total); only the DRAIN signal excludes it.
  const drainableItems = system.filter((t) => t.system_reason !== 'file_parked');
  drainable = drainableItems.length;
  parked = system.length - drainable;
  // Lane breakdown for the deep-queue signal below: a bare total says "drain",
  // a per-lane split says WHAT is owed, which is what decides how to drain it.
  // Phrased as "N item(s) in lane <reason>" (not "<reason> ×N"): a lane
  // legitimately landing on a round number (e.g. 100) must read unambiguously
  // as a per-lane count, never as evidence of a silent truncation to some
  // common cap literal.
  const byReason = new Map();
  for (const t of drainableItems) byReason.set(t.system_reason, (byReason.get(t.system_reason) ?? 0) + 1);
  queueReasonEntries = [...byReason.entries()].sort((a, b) => b[1] - a[1]);
  queueReasons = queueReasonEntries.map(([r, n]) => `${n} item${n === 1 ? '' : 's'} in lane ${r}`);
} finally {
  store.close();
}

// DEEP-QUEUE SIGNAL TO THE CONDUCTOR (config.maintenance_queue.deep_threshold).
// The counts above go to the human as a systemMessage, which the MODEL never
// sees — correct while the queue is shallow and event-drained, wrong once it is
// deep, because the human is not the one who drains it. A consuming project
// reached 63 items, most of them work finished days earlier and never closed,
// with nothing anywhere prompting a drain (reported 2026-07-29). Silent below the
// threshold (P1); above it, states the depth, the lanes, and the remedy.
//
// TWO TIERS (board 91fc3d6f): "drain it before taking new work" is an honest ask
// at a few dozen items, but not at hundreds — a consuming project measured 247
// drainable items against 5 closed in one drain pass, i.e. an instruction whose
// only honest response was to ignore it ("is not a drain, it is evaporation").
// TOO_DEEP_MULTIPLIER anchors the second tier off the SAME deep_threshold that
// gates the first: at 10x threshold (default 150), naming every lane is no
// longer readable and a blanket "drain it" is no longer actionable, so the
// message switches to naming the top few lanes by count with a BOUNDED ask
// (drain the biggest lane, or board a dedicated drain slice for the rest)
// instead of repeating the same unattainable instruction at a larger number.
const TOO_DEEP_MULTIPLIER = 10;
let queueContext = '';
// Clamped to >= 1 (reviewer F1): a corrupt/hostile deep_threshold <= 0 would
// otherwise make BOTH tier conditions true even on an EMPTY drainable queue —
// queueReasonEntries[0] would then be undefined and the destructure below
// would throw OUTSIDE this try/finally, crashing H1 non-zero and losing the
// whole injection (including an already-consumed rotation note — unrecoverable).
const deepThreshold = Math.max(1, config?.maintenance_queue?.deep_threshold ?? 15);
if (drainable >= deepThreshold) {
  const parkedNote =
    parked > 0 ? ` plus ${parked} file_parked (close at branch merge, not by drain — excluded from this count)` : '';
  // Second guard (reviewer F1, belt-and-suspenders alongside the clamp above):
  // never take the very-deep branch with an empty lane breakdown — fall back
  // to the modest-tier wording instead of destructuring an undefined entry.
  if (drainable >= deepThreshold * TOO_DEEP_MULTIPLIER && queueReasonEntries.length) {
    // Every count named below stays in the "N item(s) in lane X" shape (never a
    // bare number) — the same phrasing the moderate tier already uses — so a
    // lane count can never be misread as a truncated/capped total.
    const topLanes = queueReasons.slice(0, 3);
    const [topReason, topCount] = queueReasonEntries[0];
    const topPhrase = `${topCount} item${topCount === 1 ? '' : 's'} in lane ${topReason}`;
    // "too many to name in full" is only true past the top-3 we actually show
    // (reviewer cosmetic note: it read as false with exactly 2 lanes).
    const laneLead =
      queueReasonEntries.length > topLanes.length
        ? `Too many lanes to name in full, and "drain it all before new work" is not a workable ask at this size. The biggest lanes: ${topLanes.join(', ')}. `
        : `"Drain it all before new work" is not a workable ask at this size. The lane split: ${topLanes.join(', ')}. `;
    queueContext =
      `\n\nMAINTENANCE QUEUE IS VERY DEEP — ${drainable} drainable items across ${queueReasonEntries.length} lane(s)${parkedNote}.\n` +
      laneLead +
      `Drain the biggest lane now (${topPhrase}), or board a dedicated drain slice for the rest — don't try to clear the whole queue in one pass. ` +
      `Expect much of it to be ALREADY DONE work never closed, so verify each item against HEAD before writing anything back ` +
      `(an already-paid item closes with board_remove and NO knowledge_update). ` +
      `A queue this deep is itself a signal: items are arriving faster than anyone is closing them.`;
  } else {
    queueContext =
      `\n\nMAINTENANCE QUEUE IS DEEP — ${drainable} drainable items (${queueReasons.join(', ')})${parkedNote}.\n` +
      `Drain it with /sterling:drain before taking new work, and expect much of it to be ALREADY DONE: ` +
      `the queue records debt the mechanism detected, not debt that is necessarily still owed, so each item is verified against HEAD first ` +
      `(an already-paid item closes with board_remove and NO knowledge_update — a version bump claiming a reconcile that added nothing is itself drift). ` +
      `A deep queue is also a signal in its own right: items that keep arriving faster than they close mean either the drain is being skipped or a hook is over-firing.`;
  }
  // The maintenance-item COUNT itself (in the systemMessage banner above) is a
  // persistent visibility count by design: items close only at their
  // lane-specific events (e.g. file_parked only at merge), so a stable count
  // is not a failed drain — that attribution belongs here, on the surface
  // that carries prose, not on the banner's pinned counts-only contract.
  queueContext +=
    ' This is a persistent visibility count by design — items close only at their lane-specific events, e.g. file_parked only at merge, so a stable count is not a failed drain.';
}

// shared project registry (decision 8f9e6db2): touch THIS project's last_seen
// for the session, and make the CONDUCTOR aware of sibling projects via
// additionalContext (NOT systemMessage — this is conductor awareness, not a
// human banner). Only if the registry exists (init creates it) — H1 never
// creates it, and touchLastSeen no-ops for a project that was never registered.
// Missing (stale) siblings are excluded — irrelevant to the conductor; the
// /sterling:projects peek surfaces them for human pruning.
let registryContext = '';
if (existsSync(registryPath())) {
  const cwdPosix = input.cwd.replace(/\\/g, '/');
  const registry = new ProjectRegistry(registryPath());
  try {
    registry.touchLastSeen(cwdPosix, new Date().toISOString());
    const siblings = registry.list().filter((p) => p.repo_path !== cwdPosix && existsSync(p.repo_path));
    if (siblings.length) {
      registryContext =
        '\n\nSibling Sterling projects on this machine (shared project registry) — other initialized projects; ' +
        'knowledge in any domain you both declare (stack_tags) is shared through the per-user domain stores:\n' +
        siblings.map((p) => `- ${p.name}: ${p.stack_tags.join(', ') || '(no domains)'}`).join('\n');
    }
  } finally {
    registry.close();
  }
}

/** Is the process that wrote the marker still alive — and actually the WRITER?
 *  signal 0 probes existence without delivering a signal: success or EPERM
 *  (exists, not ours to signal) = a live process; ESRCH = confirmed dead; any
 *  other error = null (indeterminate — caller must not suppress a real warning
 *  on it). Existence alone over-warns: pid numbering resets on reboot (WSL
 *  restarts routinely), so an orphan marker's pid is often REUSED by an
 *  unrelated process and the dead-writer suppression (decision 132177d2) fails
 *  — observed 2026-07-02. On Linux, confirm identity via /proc/<pid>/cmdline:
 *  the writer is always the MCP server, launched from .../packages/mcp-server/
 *  dist, so a live cmdline WITHOUT 'mcp-server' is a reused pid = confirmed
 *  not-the-writer = dead. An empty/unreadable cmdline or a non-Linux platform
 *  keeps the existence verdict (err loud: a missed real warning is worse than
 *  a rare false one). */
function markerWriterAlive(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code !== 'EPERM') return null;
  }
  if (process.platform !== 'linux') return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    if (cmdline && !cmdline.includes('mcp-server')) return false; // reused pid — not the writer
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ESRCH') return false; // exited between probe and read
    // other read errors: identity indeterminate — keep the existence verdict
  }
  return true;
}

// stale-server guard (P5/P7): a running MCP server older than the current built
// server silently serves OLD behavior (the domain-stores incident). Compare the
// build-id the server recorded at boot to the current built id; warn the human
// loudly to restart. Fail-open: a missing marker or build-id is 'unknown', never
// a false alarm (P1). STERLING_SERVER_DIST overrides the dist lookup for tests.
let staleWarning = '';
try {
  const root = pluginRoot();
  const serverDist = process.env.STERLING_SERVER_DIST ?? (root ? join(root, 'packages', 'mcp-server', 'dist') : null);
  const currentBuildId = serverDist && existsSync(buildIdPath(serverDist)) ? readFileSync(buildIdPath(serverDist), 'utf8').trim() || null : null;
  let marker = null;
  const markerPath = runtimeMarkerPath(join(input.cwd, '.sterling', 'sterling.db'));
  if (existsSync(markerPath)) {
    const parsed = runtimeMarkerSchema.safeParse(JSON.parse(readFileSync(markerPath, 'utf8')));
    if (parsed.success) marker = parsed.data;
  }
  // Is the process that wrote the marker still alive AND the writer? A confirmed-
  // dead (or confirmed-reused-pid) writer is an ORPHANED marker from a server we
  // have since replaced (the restart-after-rebuild race — no platform ordering
  // guarantee between this hook and the new server's boot write). Dead → suppress;
  // indeterminate (null) → still warn.
  const verdict = stalenessVerdict(currentBuildId, marker, marker ? markerWriterAlive(marker.pid) : null);
  if (verdict.state === 'stale') {
    staleWarning = `⚠ Sterling MCP server is STALE — running build ${verdict.running}, current ${verdict.current}. RESTART THE SESSION to load the current server (a stale server silently mis-stores domain writes) — that means EXIT AND RELAUNCH the Claude Code CLI; a /clear is NOT enough, the MCP server survives it. `;
  }
} catch {
  // fail-open — the staleness guard must never break SessionStart
}

// Machine-activation guard (todo 8789eccf, anti_pattern 60e8463d): installed
// agents bake node paths per machine context (d53dc92c); a WSL↔Windows context
// flip leaves every agent hook failing non-blocking — the enforcement floor is
// silently absent while sync-agents' hash bookkeeping reads up_to_date. Probe
// the baked node paths of Sterling-generated installs at session start and
// warn BOTH surfaces: the human (systemMessage) and the conductor
// (additionalContext, with the recovery duty). Fail-open — the probe must
// never break SessionStart.
let machineWarning = '';
let machineContext = '';
try {
  const agentsDir = join(input.cwd, '.claude', 'agents');
  if (existsSync(agentsDir)) {
    const dead = [];
    for (const f of readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
      const content = readFileSync(join(agentsDir, f), 'utf8');
      if (!parseInstalledHeader(content)) continue; // foreign/hand-made — not ours to judge
      const unresolved = extractBakedCommandPaths(content).find((p) => !existsSync(p));
      if (unresolved) dead.push({ agent: f, node: unresolved });
    }
    if (dead.length) {
      machineWarning =
        `⚠ ${dead.length} installed agent(s) carry hook commands baked for ANOTHER machine context ` +
        `(e.g. ${dead[0].agent} → ${dead[0].node}) — their hooks fail silently. ` +
        `Run /sterling:sync-agents from this context, then restart. `;
      machineContext =
        `\n\nMACHINE-CONTEXT DRIFT (H1, anti_pattern 60e8463d): ${dead.length} installed agent(s) in ` +
        `.claude/agents/ carry hook node paths that do not resolve on this machine ` +
        `(${dead.map((d) => d.agent).join(', ')}). Every hook of those agents fails non-blocking — ` +
        `the enforcement floor (H3/H4/H5/H6/H14/H17) is ABSENT for them. Before dispatching any ` +
        `subagent: run scripts/sync-agents.mjs --target <project> from this context (re-bakes as ` +
        `machine_rebaked), tell the user a RESTART is required, and do not start pipeline work ` +
        `until scripts/check-agents-visible.mjs passes.`;
    }
  }
} catch {
  // fail-open — never break SessionStart (P1); the check-agents-visible gate
  // still blocks pipeline dispatch on the same condition.
}

if (process.env.STERLING_NO_BANNER !== '1') {
  const width = Math.max(...BANNER_ROWS.map((r) => r.length));
  const version = pluginVersion();
  const versionLine = version ? `v${version}`.padStart(width) + '\n' : '';
  process.stderr.write(`${paint(BANNER_ROWS)}\n${versionLine}`);
}

// Concurrent-subagent ceiling (decision d7a0289f): read from config, never a
// literal. Guarded like every other H1 config read — a malformed config
// costs only this number, never the conventions injection (H1 is soft); the
// fallback is the schema default (5), not a value invented here.
let maxConcurrent = 5;
try {
  maxConcurrent = config?.delegation?.max_concurrent ?? 5;
} catch {
  maxConcurrent = 5;
}

// PAYLOAD TRIM ON /clear (board eeb8ee53): a rotation restore already sits in a
// context that just read the whole committed CLAUDE.md to get at the note —
// re-injecting the conventions block (which mirrors CLAUDE.md almost verbatim)
// on EVERY /clear was ~70% duplicate payload in the one injection a fresh
// session must read most carefully. A genuinely fresh start (source=startup)
// has no committed-CLAUDE.md context to fall back on yet, so it keeps the full
// conventions injection; only source=clear trims it. Everything else here
// (machine role, sibling projects, the deep-queue banner, the rotation note
// itself) are per-machine/per-session facts CLAUDE.md does not carry, so they
// are unaffected. INTENTIONAL (reviewer F2 confirm): the trim keys on
// source==='clear' alone, not on whether a rotation note is staged — a /clear
// with NO note reloads the committed CLAUDE.md exactly the same way, so the
// duplication this closes is present either way.
const conventionsBlock = input.source === 'clear' ? '' : conventions(maxConcurrent);

const output = {
  systemMessage: `${staleWarning}${machineWarning}${currencyWarning}${counts.todos} task${counts.todos === 1 ? '' : 's'}${counts.objectives > 0 ? ` (${counts.groupedTodos} in ${counts.objectives} objective${counts.objectives === 1 ? '' : 's'})` : ''} · ${counts.maintenance} maintenance item${counts.maintenance === 1 ? '' : 's'} pending`,
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: conventionsBlock + rotationContext + dispatchResidueContext + receiptContext + residueContext + roleContext + currencyContext + registryContext + machineContext + queueContext },
};
process.stdout.write(JSON.stringify(output));
allow();
