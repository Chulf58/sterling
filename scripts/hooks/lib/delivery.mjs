// H19 knowledge-delivery plumbing (decision 6dfbe675, concept family
// knowledge-delivery): guard ledger, pending queue, payload rendering.
// Transient, session-lifecycle-bound (P4): everything under
// .sterling/transient/delivery/ is cleared by h19-clear-session at SessionStart
// — the delivered-guard's TTL is the whole session by design (grill answer:
// whole session, no expiry; re-arm rides per-file/per-record keying).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, statSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export function deliveryDir(cwd) {
  return join(cwd, '.sterling', 'transient', 'delivery');
}

// ---------------------------------------------------------------------------
// MECHANISM-AXIS MATCHING (H20, board 62806222; relevance slices 2-4). The
// matcher/extractor CORE moved to @sterling/store (packages/store/src/axis.ts)
// so the MCP server's knowledge_preflight and the hooks import ONE definition
// (the f5638a84 one-mechanism constraint). Re-exported here so every hook
// consumer keeps its import path; esbuild resolves the workspace import at
// bundle time exactly as h20's MAX_RANK_TERMS import always has — the old
// "stays free of workspace imports" note predates that proof.
// ---------------------------------------------------------------------------
export {
  AXIS_MIN_TERM_LEN,
  AXIS_MIN_HITS,
  extractAxisTerms,
  axisNarrowText,
  axisHits,
  GENERIC_DEV_TERMS,
  hasDiscriminatingHit,
  AXIS_RECORD_TOP_K,
  AXIS_MIN_RECORD_TERMS,
  recordCentralityHits,
  hasRecordCentralityHit,
  hasFullNarrowCentralityCoverage,
} from '@sterling/store';

/** The OUTGOING text H20 scans, PER SURFACE — the two do not share an input
 *  shape, and assuming they do yields a hook that silently never fires.
 *  Task/Agent puts the whole brief in tool_input.prompt; AskUserQuestion has NO
 *  prompt field at all, only questions[{question, header, options[{label,
 *  description}]}]. Option text is included deliberately and is arguably the
 *  most important part: board 4e6eb510's incident was a MOCKUP inside an
 *  AskUserQuestion option which the user then picked, nearly overturning a
 *  ruling whose own alternatives_rejected already contained that exact
 *  proposal. Returns '' for any other tool, so an unrecognised surface is
 *  INERT rather than half-scanned. */
export function outgoingProposalText(toolInput) {
  const ti = toolInput ?? {};
  if (typeof ti.prompt === 'string' && ti.prompt.trim()) return ti.prompt;
  if (Array.isArray(ti.questions)) {
    return ti.questions
      .flatMap((q) => [
        q?.question,
        q?.header,
        ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : []),
      ])
      .filter((s) => typeof s === 'string' && s.trim())
      .join('\n');
  }
  return '';
}



/** Per-agent guard: which record ids / frontier files were already delivered
 *  this session. The conductor (no agent_id) and every subagent get their own
 *  file — delivery is per-context, mirroring H13's per-agent read ledgers. */
export function guardPath(cwd, agentId) {
  return join(deliveryDir(cwd), agentId ? `guard-agent-${agentId}.json` : 'guard-conductor.json');
}

/** Pending-injection queue for the 'prompt' rung: file-touch hooks enqueue,
 *  h19-delivery-drain injects at the next UserPromptSubmit (the platform-proven
 *  additionalContext surface — H2 precedent). */
export function pendingPath(cwd) {
  return join(deliveryDir(cwd), 'pending.json');
}

/** The guard's declared shape. `pointer_files` is a SEPARATE namespace from
 *  `records` on purpose: a Bash pointer must never consume the record's
 *  full-article guard entry, or pointing at a path would silently suppress the
 *  real delivery on a later Read of it — a pointer would then COST knowledge
 *  instead of adding it. Pointers dedupe per FILE; articles dedupe per RECORD. */
function emptyGuard() {
  return { records: [], frontier_files: [], pointer_files: [], slugs: [] };
}

/** The lineage key for a record: its slug when it has one (feature_article,
 *  reference_material — stable across a knowledge_update supersede, which
 *  mints a NEW id for the SAME slug), else its id (decision/anti_pattern have
 *  no slug, so id-churn IS lineage-churn for them — a genuinely different
 *  record, not a reconcile of the same one). */
export function lineageKey(record) {
  return record?.slug ?? record?.id;
}

/** Delivered if EITHER the exact id was guarded (today's behavior, still
 *  correct for slug-less types) OR the record's lineage was already delivered
 *  under a since-superseded id (board 5a807e68 — an edited record must not
 *  re-deliver as "fresh"). */
export function isDelivered(guard, record) {
  return guard.records.includes(record.id) || guard.slugs.includes(lineageKey(record));
}

/** Mark a batch of records delivered: both the exact id (today's key, kept for
 *  slug-less types and as a fast id-based check) and the lineage key (so a
 *  later supersede of the same slug is recognised as already-seen), each
 *  deduped against what is already guarded. */
export function markDelivered(guard, records) {
  for (const r of records) {
    if (!guard.records.includes(r.id)) guard.records.push(r.id);
    const key = lineageKey(r);
    if (!guard.slugs.includes(key)) guard.slugs.push(key);
  }
}

export function readGuard(path) {
  // Self-healing: a torn/corrupt guard resets to empty (worst case a duplicate
  // delivery) instead of disabling delivery for the rest of the session.
  try {
    if (!existsSync(path)) return emptyGuard();
    // Tolerate a guard written before a field existed (mid-session upgrade):
    // a missing array must read as empty, never as undefined.
    return { ...emptyGuard(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    process.stderr.write(`H19: corrupt delivery guard at ${path} — reset to empty\n`);
    return emptyGuard();
  }
}

export function writeGuard(path, guard) {
  mkdirSync(dirname(path), { recursive: true });
  // tmp+rename (torn-guard prevention, board 5e3d6ff4 fixer pass): NOT locked —
  // a lost update here costs at most one duplicate pointer/guard entry, and
  // readGuard already self-heals a torn file, so the cheaper fix is enough.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(guard));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// DENY-ONCE PRE-STEP (H20, decision 68332e4b). A first-attempt AskUserQuestion
// whose subject strongly matches a store RULING (decision/anti_pattern) is
// DENIED before it ever reaches the user — see h20-mechanism-axis.mjs for the
// orchestration. This section is only the mechanical plumbing: which record
// types count as a "ruling", the stricter floors that gate a deny (tuned
// tighter than the existing loose audit floors so the deny classifier, never
// retrieval recall, absorbs the tuning — decision amendment 4), the ledger
// that makes suppression/override STATEFUL across a retry, and the render.
//
// LEDGER, not the session delivery guard: the guard (above) answers "was this
// record already shown this session" and is irrelevant here — a denied
// question must stay denied on an identical re-ask even if the record was
// never delivered, and an overridden question must stay allowed on a further
// resubmission of the SAME still-open sub-question. Same transient directory,
// same P4 lifecycle (cleared at SessionStart), separate file so a corrupt
// ledger cannot also wipe the unrelated delivery guard.
// ---------------------------------------------------------------------------

/** Record types the deny-once floor treats as a "ruling" — decision is the
 *  measured case (recorded in the dome-farmer project's own store — that id is
 *  deliberately not cited here, where it cannot resolve), anti_pattern is included
 *  because it is equally prescriptive ("do not do X") and carries the same
 *  status/scope/supersession fields the denial must disclose. feature_article/
 *  research_finding/disconfirmed_hypothesis stay OUT: they describe or answer,
 *  they do not rule, so denying a question because it merely OVERLAPS one is
 *  not what this decision asks for. (Decision 68332e4b does not enumerate the
 *  type set explicitly — this scoping is this build's choice, flagged here.) */
export const DENY_RULING_TYPES = ['decision', 'anti_pattern'];

/** STRICT floors (deny eligibility) vs the existing LOOSE floors (AXIS_MIN_HITS
 *  / AXIS_MIN_RECORD_TERMS, unchanged, still driving the post-answer audit).
 *  Both draw from the SAME stage-1 candidate pool built with the canonical
 *  extractAxisTerms/query — amendment 4 tunes the classifier, never recall.
 *  HONEST NOTE, same caveat AXIS_MIN_HITS itself carries: chosen on the
 *  motivating case, not measured data — tune on observed deny/override rates. */
export const STRICT_MIN_HITS = 3;
/** The deny floor's centrality bar is `hasFullNarrowCentralityCoverage`
 *  (re-exported above), NOT hasRecordCentralityHit with a raised `minTerms`.
 *  It requires FULL coverage of the record's PRE-UNION narrow top-K — every one
 *  of the record's own dominant narrow terms present — rather than merely
 *  AXIS_MIN_RECORD_TERMS (>=2, the loose audit's bar). Raw distinct hit COUNT
 *  alone does not discriminate a genuinely governing ruling from a topically-
 *  adjacent one: a short decision record and a prompt built around it both tend
 *  to land in the same 5-8 hit range regardless of how thoroughly the prompt
 *  actually covers the ruling's own vocabulary — what discriminates is whether
 *  EVERY one of the record's own dominant terms is present, not just most of
 *  them. A terse record's smaller central set still demands full coverage of
 *  what it has, never a fixed count larger than the record can offer.
 *
 *  WHY A DEDICATED FUNCTION AND NOT A CONSTANT: this file used to export
 *  STRICT_MIN_RECORD_TERMS = AXIS_RECORD_TOP_K and pass it as `minTerms`,
 *  relying on `Math.min(minTerms, central.length)` collapsing to full coverage
 *  because central.length could never exceed topK. The title union (decision
 *  00b23915) broke that invariant — the central set can now reach 2*topK, so
 *  the same call silently became "ANY six of up to twelve". This rung EXITS 2
 *  and blocks a question from reaching the user, so a weaker per-term demand is
 *  fail-CLOSED toward the user: more false denials. The constant is gone rather
 *  than corrected, so no future caller can re-derive the trick. */

/** How many newly-introduced axis terms a retry must add over the FIRST
 *  denied attempt (same intent key) before its citation counts as stating an
 *  "unresolved delta" rather than a bare re-ask with an id pasted in. Set
 *  well above the ~2 incidental new words a bare citation itself contributes
 *  ("override(ing)", "decision") — a real stated delta (what is unresolved,
 *  and why) reads as substantially more new vocabulary than the citation
 *  phrasing alone, so the gap between "id pasted in" and "id + explanation"
 *  is wide enough that this floor does not need to be exact, only clearly
 *  above the citation's own incidental contribution. */
export const DELTA_MIN_NEW_TERMS = 5;

/** The text one AskUserQuestion sub-question contributes — mirrors
 *  outgoingProposalText's questions[] branch, but for exactly one entry, so
 *  per-sub-question scoring (amendment 2, form handling) can run independently
 *  of the combined multi-question blob. */
export function subQuestionText(q) {
  return [
    q?.question,
    q?.header,
    ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : []),
  ]
    .filter((s) => typeof s === 'string' && s.trim())
    .join('\n');
}

export function denyLedgerPath(cwd, agentId) {
  return join(deliveryDir(cwd), agentId ? `deny-ledger-agent-${agentId}.json` : 'deny-ledger-conductor.json');
}

function emptyDenyLedger() {
  return { entries: {}, overrides: [] };
}

/** Self-healing like readGuard: a torn ledger resets to empty (worst case one
 *  re-denied question) instead of wedging the pre-step for the rest of the
 *  session. */
export function readDenyLedger(path) {
  try {
    if (!existsSync(path)) return emptyDenyLedger();
    return { ...emptyDenyLedger(), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    process.stderr.write(`H20: corrupt deny-once ledger at ${path} — reset to empty\n`);
    return emptyDenyLedger();
  }
}

export function writeDenyLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(ledger));
  renameSync(tmp, path);
}

/** Suppression key: "normalized question intent + matched record ids", never
 *  exact text (decision 68332e4b). Keyed on the matched record ids ALONE —
 *  NOT on the prompt's own hit terms, even though those are the record's fixed
 *  vocabulary rather than raw prompt text. Tried hit-terms-in-the-key first and
 *  rejected it here: a retry's hit SET still shifts with paraphrase (a
 *  rephrased sub-question can pick up or drop a matched word — e.g. "shown"
 *  vs "displayed" — even while targeting the exact same ruling), so a key that
 *  includes the hit set can silently mint a NEW key on a legitimate retry and
 *  the override contract (which requires a PRIOR ledger entry under the SAME
 *  key) would never fire. The record ids a sub-question strongly matches are
 *  the stable signal: the same underlying question about the same ruling(s)
 *  matches the same records across a reasonable paraphrase, while a question
 *  that drifts far enough to match different records is arguably a different
 *  question anyway — so it is right for it to get its own key. */
export function denyIntentKey(recordIds) {
  return [...new Set(recordIds ?? [])].sort().join('|');
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `text` cites `id` — the full id, or its unambiguous 8-char prefix
 *  (the same prefix convention the id-resolution ladder already resolves
 *  through elsewhere in the store), case-insensitively, WORD-BOUNDARIED
 *  (post-commit follow-up review): a bare substring test let an 8-char prefix
 *  embedded inside a LARGER token count as a citation (e.g. a longer id or an
 *  unrelated alphanumeric string that merely happens to contain those 8
 *  characters) — the match must not be immediately preceded or followed by
 *  another alphanumeric character. */
export function idCitedIn(text, id) {
  if (!id) return false;
  const hay = String(text ?? '').toLowerCase();
  const full = String(id).toLowerCase();
  const boundaried = (needle) => new RegExp(`(?<![a-z0-9])${escapeForRegex(needle)}(?![a-z0-9])`, 'i').test(hay);
  if (boundaried(full)) return true;
  const prefix = full.split('-')[0];
  return prefix.length >= 8 && boundaried(prefix);
}

/** The denial payload, COMPACTED per decision 80d0ab62 (deny-once-message-
 *  compaction, amending PRESENTATION ONLY of decision 68332e4b — eligibility,
 *  the ledger/override mechanics and whole-form denial are untouched). One
 *  header line names the mechanism, decision 68332e4b, and instructs
 *  read-then-act, disclosing that the question was withheld from the user
 *  (the old second "lecture" line is gone). Each SETTLED sub-question renders
 *  as ONE row starting with an em-dash: label → kind + full ruling id +
 *  compact bracketed [status·scope] disclosure (", superseded_by: <id>"
 *  folded into the bracket only when the record carries one) + substance
 *  clipped to ~160 chars — still substance, never a bare sentence, so
 *  68332e4b's applicability-laundering guard is preserved. A multi-question
 *  form's preamble/OPEN block folds into ONE line (open sub-question labels
 *  inline, clipped). The override contract compresses to ONE line citing the
 *  matched ruling id(s), the unresolved-delta requirement, and the
 *  denied-again/logged consequence. `ruled` is `{index, label, decisions}[]`
 *  — `decisions` the matched ruling records themselves (status/superseded_by/
 *  scope disclosed, never just their title). `open` is `{index, label}[]` —
 *  the sub-questions that did NOT strongly match anything; naming them (not
 *  merely their count) is what lets the reader resubmit exactly the right
 *  slice of a form instead of re-deriving it. */
/** Resolved substance for one matched ruling, never silently empty (fix 1,
 *  dual-review HIGH finding): a decision with no statement, or an anti_pattern
 *  with neither trigger nor right_way, used to render as a bare/empty clip —
 *  indistinguishable from "nothing to disclose" and exactly the applicability-
 *  laundering shape 68332e4b's guard exists to prevent. Falls back to a loud
 *  explicit marker naming the record id as the read target instead.
 *
 *  Returns `{text, marker}` rather than one pre-joined string (fix 7,
 *  outside-family review MED finding): the marker is RENDERER CHROME, not
 *  record content, so it must survive clipping regardless of how long the
 *  present free-text half is. The old single-string return concatenated
 *  `presentText + marker` and let the CALLER's `clip(substance, 160)` cut the
 *  combined result — a 200+ char trigger with a missing right_way pushed the
 *  whole incompleteness marker (knowledge_get + id + which-half-missing) past
 *  the clip window, silently reproducing the applicability-laundering shape
 *  fix 1 exists to prevent, just triggered by length instead of absence. The
 *  caller now clips ONLY `text` and appends `marker` (never clipped) after. */
function substanceFor(d) {
  if (d.type === 'anti_pattern') {
    const trigger = typeof d.trigger === 'string' ? d.trigger.trim() : '';
    const rightWay = typeof d.right_way === 'string' ? d.right_way.trim() : '';
    // Both present: the original "trigger — right_way" pairing, all of it
    // clippable free text, no marker. Exactly ONE present (fix 6, dual-review
    // MED finding): the present half is the clippable text; the incompleteness
    // marker naming which half is missing and where to read it rides outside
    // the clip window. Neither present: no free text at all, only the marker.
    if (trigger && rightWay) return { text: `${trigger} — ${rightWay}`, marker: '' };
    if (trigger) return { text: trigger, marker: `⟨right_way missing — knowledge_get ${d.id}⟩` };
    if (rightWay) return { text: rightWay, marker: `⟨trigger missing — knowledge_get ${d.id}⟩` };
    return { text: '', marker: `⟨no substance recorded — knowledge_get ${d.id}⟩` };
  }
  const statement = typeof d.statement === 'string' ? d.statement.trim() : '';
  return statement ? { text: statement, marker: '' } : { text: '', marker: `⟨no substance recorded — knowledge_get ${d.id}⟩` };
}

/** The override line, ONE line regardless of matched-ruling count (fix 4,
 *  dual-review LOW finding): interpolating every matched id unconditionally
 *  can run past 220 chars once 3+ rulings match one sub-question. At most the
 *  first two ids render explicit; the rest fold into a "+N more" remainder.
 *  Carries no "OVERRIDE:" line-start token — nothing here is derived from
 *  caller-controlled text, so there is nothing for a spoofed label/substance
 *  to spoof by starting its own line. */
function renderOverrideLine(ids) {
  // Trivial guard (fix 4c): unreachable via renderDenyOnceMessage today (there
  // is always at least one matched ruling on the deny path), but a defensive
  // caller-facing function should never emit a double-space "Cite  +" for an
  // empty list — render the generic single-ruling phrasing instead.
  if (!ids.length) {
    return 'Cite the ruling id + the unresolved delta or it stays denied — a re-ask with no delta is denied again, and every override is logged.';
  }
  const EXPLICIT_CAP = 2;
  const shown = ids.slice(0, EXPLICIT_CAP);
  const rest = ids.length - shown.length;
  // "one of" whenever MORE THAN ONE ruling matched (fix 3c) — not gated at 3+:
  // at exactly two matches the gate still accepts citing either one, so the
  // phrasing must say so even though both ids fit explicit with no "+N more"
  // remainder. The single-ruling case (ids.length === 1) never says "one of".
  const idsText =
    ids.length > 1 ? `one of ${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}` : shown.join(', ');
  return `Cite ${idsText} + the unresolved delta or it stays denied — a re-ask with no delta is denied again, and every override is logged.`;
}

/** THE ONE LIFECYCLE-STATUS SPELLING (decision db3392db, part 1). The bracket
 *  CONTENT `status·scope[, superseded_by: <id>]` was born inline in
 *  renderDenyOnceMessage below and is now shared verbatim with every pointer
 *  surface, so a reader never has to learn a second spelling for the same fact.
 *  Absent status/scope render as 'unknown' rather than being dropped: a pointer
 *  that cannot say what a record's lifecycle is must say THAT, not stay silent
 *  (P5). Never conflate this with a feature_article's own `state` field —
 *  'built'/'active' there describes the TERRITORY's build state, this describes
 *  the RECORD's lifecycle, and renderArticle prints both. */
export function statusBracket(record) {
  const status = record?.status ?? 'unknown';
  const scope = record?.scope ?? 'unknown';
  return `${status}·${scope}${record?.superseded_by ? `, superseded_by: ${record.superseded_by}` : ''}`;
}

/** The same bracket as a POINTER-SURFACE suffix (leading space included, or ''):
 *  SUPPRESSED for status 'active' because an [active] tag on every pointer line
 *  is noise on the one channel that fires constantly (P1) — the deny-once
 *  renderer keeps annotating unconditionally, where scope is material to the
 *  denial itself. Anything NOT exactly 'active' annotates, including an absent
 *  or unrecognised status: suppressing an unknown lifecycle would hide exactly
 *  the case the annotation exists for. */
export function statusAnnotation(record) {
  return record?.status === 'active' ? '' : ` [${statusBracket(record)}]`;
}

export function renderDenyOnceMessage(ruled, totalQuestions, open = []) {
  const lines = [
    'STERLING DENY-ONCE (H20, decision 68332e4b) — this question was NOT shown to the user; read the settled ruling(s) below, then act on them before resubmitting.',
  ];
  if (totalQuestions > 1) {
    const openLabel = open.length
      ? open.map((o) => `"${clip(normalizeWs(o.label) || `Sub-question ${o.index + 1}`, 40)}"`).join(', ')
      : 'none — every sub-question is settled';
    lines.push(
      `${totalQuestions} sub-question(s) total, ${ruled.length} settled by the store below — resubmit only the open sub-question(s): ${openLabel}`
    );
  }
  const citedIds = [];
  for (const r of ruled) {
    // Normalize BEFORE clipping (fix 2): whitespace runs (incl. embedded
    // newlines) collapse to one space, so a spoofed "\n— fake row" or
    // "\nOVERRIDE: fake" cannot split off its own rendered line.
    const label = clip(normalizeWs(r.label) || `Sub-question ${r.index + 1}`, 80);
    for (const d of r.decisions) {
      citedIds.push(d.id);
      const kind = d.type === 'anti_pattern' ? 'anti_pattern' : 'decision';
      // Composition site for fix 7: clip the free TEXT alone, then append the
      // marker (renderer chrome) OUTSIDE the clip window — clipping the
      // already-joined text+marker string (the old shape) can cut the marker
      // off entirely when the free text alone exceeds the clip budget.
      const { text, marker } = substanceFor(d);
      const clippedText = clip(normalizeWs(text), 160);
      const normalizedMarker = normalizeWs(marker);
      const substance = normalizedMarker ? `${clippedText}${clippedText ? ' ' : ''}${normalizedMarker}` : clippedText;
      // UNCONDITIONAL here (decision db3392db part 1): the pointer surfaces
      // suppress the bracket for an active record, this one never does — scope
      // is material to the denial, and a denied question's reader must be able
      // to see the ruling's lifecycle without a second lookup.
      lines.push(`— "${label}" → ${kind} [${d.id}] [${statusBracket(d)}]: ${substance}`);
    }
  }
  const idList = [...new Set(citedIds)];
  lines.push(renderOverrideLine(idList));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// COOPERATING-WRITER LOCK (board 5e3d6ff4 fixer pass). hooks.json runs more
// than one PostToolUse hook per event (h19-knowledge-delivery + h23-output-
// axis on Read; h19-bash-delivery + h23-output-axis on Bash), and every one of
// them can call enqueuePending against the SAME pending.json in the SAME
// event. Measured precedent for what an unguarded read-modify-write does under
// that: ledger.mjs:27-34 — two concurrent PostToolUse:Read processes tore a
// JSON file on a DrvFs mount. A torn pending.json is worse than a torn ledger:
// drainPending's JSON.parse failure rmSyncs the WHOLE queue while the
// producers' guards already marked their records delivered — permanent silent
// loss, not "ask for a re-Read".
//
// mkdirSync is atomic (EEXIST on contention) on every platform Node supports,
// so it doubles as a lock with no extra dependency. Age-based staleness ONLY —
// a lock whose mtime is older than LOCK_STALE_MS is reclaimed as abandoned by
// a crashed holder; never PID-liveness (anti_pattern 8e603e23: a recycled PID
// gives a false lock identity).
//
// TWO CALLER SEMANTICS, deliberately different (fixer F2):
//   PRODUCERS (enqueuePending) keep the ORIGINAL degrade-to-unlocked behavior
//     (decision cdb50670 untouched): on deadline expiry they PROCEED WITHOUT THE
//     LOCK rather than blocking the hook forever — a lost append costs one
//     duplicate/late pointer, and delivery is an aid, never a gate.
//   THE DRAIN (drainPending) is LOCK-REQUIRED: it MUTATES the queue by claiming
//     it away, so proceeding unlocked can delete a producer's just-appended
//     entry whose guard already marked those records delivered — permanent
//     silent loss. Without the lock it SKIPS the drain entirely and leaves the
//     queue intact for the next prompt.
// A caller that never acquired the lock also never releases it, so a slow/
// expired waiter can't rip an active holder's lock out from under it.
// ---------------------------------------------------------------------------
const LOCK_DEADLINE_MS = 2000;
const LOCK_STALE_MS = 5000;
const LOCK_POLL_MS = 5;

/** Poll for the lock directory until the deadline. Returns whether it was taken
 *  — the ONE acquisition path both semantics above share, so they can never
 *  drift on staleness reclamation or poll behavior. */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue; // retake immediately — no need to sleep first
        }
      } catch {
        continue; // lock vanished between the EEXIST and the stat — retry now
      }
      // Bounded synchronous wait between attempts, never a busy CPU spin.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // best-effort release; a leftover lock self-heals via the staleness check
  }
}

/** PRODUCER semantics: runs `fn` whether or not the lock was taken. */
function withFileLock(targetPath, fn) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  const acquired = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    if (acquired) releaseLock(lockPath);
  }
}

/** DRAIN semantics: runs `fn` ONLY under the lock. Returns
 *  `{acquired, value}` so the caller can distinguish "did nothing because the
 *  queue was empty" from "did nothing because another writer held the lock". */
function withRequiredFileLock(targetPath, fn) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const lockPath = `${targetPath}.lock`;
  if (!acquireLock(lockPath)) return { acquired: false, value: undefined };
  try {
    return { acquired: true, value: fn() };
  } finally {
    releaseLock(lockPath);
  }
}

export function enqueuePending(path, entry) {
  withFileLock(path, () => {
    const entries = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    entries.push(entry);
    // tmp+rename: a crash mid-write can never leave a torn file behind.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(entries));
    renameSync(tmp, path);
  });
}

// ---------------------------------------------------------------------------
// RENAME-BASED CLAIM (fixer F2, tightening decision db3392db part 2). The drain
// no longer reads-then-deletes under the lock: it RENAMES pending.json to a
// uniquely-named claimed-*.json INSIDE the lock, releases immediately, and
// processes the claimed copy OUTSIDE it. Three properties that buys:
//
//   (a) THE LOCK IS HELD FOR A RENAME, not for the whole store re-resolve — the
//       drain now opens the store and re-reads every queued id, which is far too
//       long to hold a lock producers must take on every PostToolUse.
//   (b) A CRASH MID-PROCESSING RE-SERVES INSTEAD OF LOSING. The claimed file is
//       deleted only AFTER the payload has been rendered and written (the caller
//       calls release()). A drain that dies in between leaves claimed-*.json on
//       disk, and the NEXT drain picks leftovers up FIRST.
//       ACCEPTED DIRECTION OF FAILURE: that recovery can DUPLICATE a delivery
//       (the crash may have happened after stdout was written but before the
//       delete). Duplicating knowledge the reader already has costs context;
//       losing it is silent and undetectable, and the producer's guard has
//       already marked those records delivered so nothing else would ever retry.
//       Duplicate-and-loud beats lose-and-silent.
//   (c) NO UNLOCKED MUTATION EVER. If the lock is not granted by the deadline
//       the drain SKIPS this turn with a one-line stderr note and touches
//       nothing — it never proceeds unlocked and never deletes unlocked.
//
// Re-claiming a LEFTOVER needs no lock: renameSync is itself the exclusive
// claim (only one racing drain can move a given source name), and no producer
// ever touches a claimed-* file.
// ---------------------------------------------------------------------------
const CLAIM_PREFIX = 'claimed-';
const PARK_PREFIX = 'corrupt-';
let claimSeq = 0;

function claimByRename(src, dir) {
  claimSeq += 1;
  const target = join(
    dir,
    `${CLAIM_PREFIX}${process.pid}-${Date.now()}-${claimSeq}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  try {
    renameSync(src, target);
    return target;
  } catch {
    return null; // another drain claimed it first, or it vanished — not ours
  }
}

/** A batch whose JSON is unreadable (unparseable, or valid JSON that is NOT an
 *  array — fixer F6) is PARKED under a name the drain never picks up again, not
 *  deleted: the old behavior rmSync'd the whole queue, and the producers' guards
 *  had already marked those records delivered, so the content was gone with no
 *  detector. Parked files are still lifecycle-bound (P4) — h19-clear-session
 *  clears the whole delivery directory at SessionStart. Returns ONE synthetic
 *  entry so the reader is TOLD the batch was lost (the banner arm), rather than
 *  the drain silently injecting nothing.
 *
 *  RETURNS `{entry, retain}`. `retain: true` means the park RENAME FAILED, so the
 *  batch is still sitting at its CLAIMED name and must be excluded from
 *  release()'s delete list (fixer M2): otherwise the one recoverable copy of an
 *  unreadable batch is destroyed by the very path that exists to preserve it. The
 *  name carries a randomUUID segment because PID+millisecond alone collides — two
 *  parks inside one millisecond silently OVERWRITE on POSIX and throw EEXIST on
 *  Windows, and that Windows throw was precisely what reached the delete. */
function parkCorruptBatch(file, reason) {
  const parked = join(dirname(file), `${PARK_PREFIX}${process.pid}-${Date.now()}-${randomUUID()}.json`);
  let parkedAt = parked;
  try {
    renameSync(file, parked);
  } catch (e) {
    parkedAt = null;
    process.stderr.write(`H19: parking the corrupt queue at ${file} failed (${(e && e.message) || e})\n`);
  }
  process.stderr.write(
    `H19: corrupt pending-delivery queue at ${file} — ${reason}; ` +
      `${parkedAt ? `PARKED at ${parkedAt}` : `left CLAIMED at ${file} (could NOT be parked, and is NOT deleted)`} rather than discarded\n`
  );
  return {
    retain: !parkedAt,
    entry: {
      kind: 'corrupt_batch',
      payload: '(no entry from this queued delivery batch could be recovered)',
      unverified_reason:
        `a queued delivery batch could not be read (${reason})` +
        `${
          parkedAt
            ? `, so it was PARKED at ${parkedAt} instead of discarded`
            : `, and parking it failed — it is left in place at ${file}, undeleted`
        } — nothing from it was served, so any knowledge it carried must be re-queried`,
    },
  };
}

/** `{entries, retain}` — `retain` true keeps the source file out of release()'s
 *  delete list (see parkCorruptBatch). */
function readClaimedBatch(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    const { entry, retain } = parkCorruptBatch(file, 'its JSON could not be parsed');
    return { entries: [entry], retain };
  }
  // F6: a valid-JSON NON-ARRAY is treated exactly like a parse failure. Without
  // this, `for (const e of {…})` throws (or a string is iterated per character)
  // and the whole drain dies on a shape no producer can legally write.
  if (!Array.isArray(parsed)) {
    const shape = parsed === null ? 'null' : typeof parsed;
    const { entry, retain } = parkCorruptBatch(file, `its JSON parsed as ${shape}, not the expected array of entries`);
    return { entries: [entry], retain };
  }
  return { entries: parsed, retain: false };
}

/** Claim every pending batch and return `{entries, release}`. The queue is
 *  one-shot (P4) but the DELETE is deferred to `release()`, which the caller
 *  invokes only AFTER the drained payload has actually been written — process
 *  then delete, so a crash re-serves rather than loses (see (b) above). */
export function drainPending(path) {
  const dir = dirname(path);
  const claimed = [];

  // (1) LEFTOVERS FIRST — a claimed batch from a crashed prior drain, then the
  // live queue. What this ordering guarantees is exactly that: leftovers before
  // the live queue, stable within the directory listing (sorted for determinism).
  // It does NOT guarantee oldest-first ACROSS processes — the claim name leads
  // with the PID, so a lower-PID drain's newer batch sorts ahead of a higher-PID
  // drain's older one. Append order within any ONE batch is preserved regardless,
  // which is what AC9 pins.
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = []; // no delivery dir yet: nothing has ever been queued here
  }
  for (const name of names.filter((n) => n.startsWith(CLAIM_PREFIX) && n.endsWith('.json')).sort()) {
    const mine = claimByRename(join(dir, name), dir);
    if (mine) claimed.push(mine);
  }

  // (2) THE LIVE QUEUE — claimed under a REQUIRED lock, then released at once.
  if (existsSync(path)) {
    const { acquired, value } = withRequiredFileLock(path, () =>
      // Re-checked INSIDE the lock: another drain may have claimed the batch
      // between the existsSync above and the lock being granted.
      existsSync(path) ? claimByRename(path, dir) : null
    );
    if (!acquired) {
      process.stderr.write(
        `H19: pending-delivery queue lock at ${path}.lock not acquired within ${LOCK_DEADLINE_MS}ms — ` +
          'drain SKIPPED this turn (queue left intact; it drains at the next prompt)\n'
      );
    } else if (value) {
      claimed.push(value);
    }
  }

  const entries = [];
  // `disposable` is the subset release() may delete — a batch whose park rename
  // FAILED is deliberately excluded (fixer M2), so the unreadable file survives
  // for inspection instead of being destroyed by the recovery path.
  const disposable = [];
  for (const file of claimed) {
    const { entries: batch, retain } = readClaimedBatch(file);
    entries.push(...batch);
    if (!retain) disposable.push(file);
  }
  return {
    entries,
    release: () => {
      for (const file of disposable) {
        try {
          rmSync(file, { force: true }); // a parked batch is already gone — force makes that a no-op
        } catch {
          // a claimed file we cannot delete re-serves next prompt: duplicate, never lost
        }
      }
    },
  };
}

function clip(text, cap) {
  const s = String(text ?? '');
  // Code-point safe AND early-stopping (fix 5b, deny-once compaction round 2,
  // decision 80d0ab62): the old `Array.from(s)` splits by code point (so a
  // surrogate pair is never cut) but still MATERIALIZES THE ENTIRE INPUT as an
  // array before applying a small cap — shared consumers here pass unbounded
  // record fields (an oversized article body can be hundreds of KB), so that
  // allocation cost scaled with the full input, not the cap. This walks the
  // string by code point via the string iterator protocol (which yields whole
  // code points one at a time, same surrogate-pair safety as Array.from) and
  // stops the instant it has collected `cap` of them plus confirmed there is
  // at least one more — so it never reads past `cap + 1` code points in, no
  // matter how long `s` is. Cap semantics unchanged: cap counts code points;
  // ellipsis appended only when the input actually exceeds it.
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count === cap) return `${out}…`;
    out += ch;
    count++;
  }
  return out;
}

/** Collapse every whitespace run (space, tab, \r, \n, …) to a single space and
 *  trim (fix 2, dual-review finding). Applied to every interpolated free-text
 *  field BEFORE clipping, so embedded newlines in a sub-question label or a
 *  ruling's own statement/trigger/right_way can never fabricate a fake line start
 *  (e.g. a crafted "\n— fake →" prefix) inside renderDenyOnceMessage's
 *  otherwise-fixed 3-line shape. */
function normalizeWs(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** LINE-SAFE flatten (fixer F4): collapse every LINE BREAK and tab to a single
 *  space, WITHOUT trimming or collapsing ordinary space runs. Used on text that
 *  is already a whole rendered line (a pointer line replayed at drain), where
 *  normalizeWs would eat the leading indentation that line's own format carries,
 *  while the property we need is only "this can never become two lines".
 *  Interpolated FRAGMENTS (an id, a status bracket) use normalizeWs instead —
 *  trimming a fragment is correct, trimming a line is not.
 *
 *  The character class below is CR, LF, tab, form feed, vertical tab and the
 *  two Unicode separators U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR
 *  (a reader that splits on them sees a new line). Ordinary spaces are NOT in
 *  the class, which is what preserves a pointer line's own indentation.
 *
 *  It is built with `new RegExp(<string>)` rather than a regex literal because
 *  U+2028/U+2029 are LineTerminators in JS source. WHAT IS ACTUALLY IN THE
 *  STRING: backslash-u ESCAPE TEXT for both separators (the string parser
 *  resolves them to the real characters at load) — the source file is plain
 *  ASCII here, per anti-pattern d7e03137's posture. Verified 2026-08-31: a
 *  raw-control-byte grep over this file matches nothing. */
function flattenToOneLine(text) {
  return String(text ?? '').replace(new RegExp('[\\r\\n\\t\\f\\v\u2028\u2029]+', 'g'), ' ');
}

/** One-hop pointer line for a sibling slug: resolved from the store when the
 *  slug matches exactly, marked absent otherwise — never invented.
 *
 *  Resolution is a DETERMINISTIC store lookup, not a ranked query (decision
 *  3db7095f). It used to be query({rank_terms:[slug], cap:5}) plus an exact match
 *  among those five, which printed '(not in store)' for articles that were
 *  demonstrably live: bm25 ranks by term frequency, so a slug cited heavily in
 *  OTHER articles' prose loses its own top-5 to them (caught live against
 *  'hooks-suite' at v46). That mattered because these pointers are how a reader
 *  learns which siblings bear on the territory — a false '(not in store)' tells
 *  them the neighbour does not exist, so they neither read it nor reconcile it. */
function pointerLine(store, kind, slug) {
  let head = '(not in store)';
  let annotation = '';
  try {
    const match = store.articlesBySlug(slug).find((r) => !r.working_tree);
    if (match) {
      head = clip(match.what_it_does, 140);
      annotation = statusAnnotation(match);
    }
  } catch {
    head = '(lookup failed)';
  }
  return `  → ${kind} [[${slug}]]: ${head}${annotation}`;
}

/** Budget for the untestable_because reason clip, same class as
 *  DECISION_REJECTED_CLIP: a beneath-the-headline annotation, not the primary
 *  field — an unbounded reason would land uncapped in H19's injected payload
 *  (S4b fixer pass). */
export const UNTESTABLE_REASON_CLIP = 140;

/** Oversize-body guard (board 725299c8). Rendering a large what_it_does inline
 *  overflowed the RECEIVING agent's tool-result view: the real 'knowledge-
 *  delivery' article's own what_it_does is ~15k chars and its full block
 *  reached ~18.9KB, past the ~17KB view threshold — delivery degraded exactly
 *  at the surface it exists to serve. Past ARTICLE_BODY_FLOOR chars of body,
 *  renderArticle DIGESTS: a bounded head excerpt plus a knowledge_get pointer
 *  to the full record (its id, so the reader can fetch the withheld body),
 *  never the whole thing. Delivery degrades to a pointer, it NEVER denies
 *  (decision 9950dfff lineage / AC7 — this is not a gate). Below the floor,
 *  delivery is byte-identical to before, so small articles are untouched. */
export const ARTICLE_BODY_FLOOR = 4096;

/** Head-excerpt budget in the digest branch. Small enough that the excerpt plus
 *  the pointer line stays far under the 8192-byte delivery ceiling even when
 *  charCap is large; large enough to still orient the reader before they fetch. */
export const ARTICLE_DIGEST_EXCERPT = 1200;

/** Clip bound for slug/concept_family in the digest header — the only otherwise
 *  unbounded inputs to a digested block (board 725299c8, outside-family review).
 *  Generous vs real kebab slugs (which are far shorter), so normal rendering is
 *  unchanged while a pathological slug can no longer breach the delivery ceiling. */
export const ARTICLE_SLUG_CLIP = 256;

/** Render the delivery payload for one owning feature_article: its substance
 *  (what_it_does, intended_behavior, current ACs) plus one-hop POINTERS —
 *  slugs with one-liners, never full neighbor bodies (grill answer: article +
 *  one-hop pointers; P6 filter-first-capped). */
export function renderArticle(store, article, charCap) {
  // slug/concept_family are clipped (outside-family review, board 725299c8): they
  // are the only unbounded inputs to the digest block below, so without this a
  // pathological slug/family could push the digested block past the ~8192-byte
  // delivery ceiling that clipping the body alone otherwise guarantees. Real
  // kebab slugs sit far under this bound, so normal rendering is unchanged.
  // `state` is the ARTICLE's build state, the trailing bracket is the RECORD's
  // lifecycle status (decision db3392db part 1) — two different facts, printed
  // side by side rather than collapsed into one token.
  const header = `▸ article '${clip(article.slug, ARTICLE_SLUG_CLIP)}' (${article.state}${article.concept_family ? `, concept family '${clip(article.concept_family, ARTICLE_SLUG_CLIP)}'` : ''})${statusAnnotation(article)}`;
  const body = String(article.what_it_does ?? '');
  // OVERSIZE (board 725299c8): digest the body and POINT to the full record
  // instead of rendering the article whole. Withholding intended_behavior, the
  // AC list and one-hop pointers behind the knowledge_get pointer is what keeps
  // the block bounded no matter how large those fields grow — the measured
  // offender carried a ~5k intended_behavior and 12 ACs on top of a ~15k body.
  if (body.length > ARTICLE_BODY_FLOOR) {
    return [
      header,
      `WHAT IT DOES (digested — full body is ${body.length} chars, withheld to fit the reader's view): ${clip(body, ARTICLE_DIGEST_EXCERPT)}`,
      `▸ FULL RECORD (intended_behavior, acceptance criteria, one-hop dependencies withheld): knowledge_get ${article.id}` +
        ` — windowed: knowledge_get ${article.id} field:"what_it_does" offset:0 length:4000, then page by offset.`,
    ].join('\n');
  }
  const lines = [
    header,
    `WHAT IT DOES: ${clip(body, charCap)}`,
    `INTENDED BEHAVIOR: ${clip(article.intended_behavior, charCap)}`,
  ];
  if (article.current_ac?.length) {
    lines.push(
      `ACCEPTANCE CRITERIA: ${article.current_ac
        .map((a) => {
          const u = a.untestable_because;
          const suffix = u
            ? ` [untestable: ${clip(u.reason, UNTESTABLE_REASON_CLIP)} — blocking ${String(u.blocking_record_id).slice(0, 8)}]`
            : '';
          return `${a.ac_id}: ${a.text}${suffix}`;
        })
        .join(' | ')}`
    );
  }
  const relies = article.dependencies?.relies_on ?? [];
  const relied = article.dependencies?.relied_by ?? [];
  if (relies.length || relied.length) {
    lines.push('ONE-HOP (follow with knowledge_get/knowledge_query when it matters):');
    for (const slug of relies) lines.push(pointerLine(store, 'relies_on', slug));
    for (const slug of relied) lines.push(pointerLine(store, 'relied_by', slug));
  }
  return lines.join('\n');
}

/** Pointer-only line for a repo-located reference doc owner — its presence
 *  means the territory is OWNED (no frontier signal), but docs carry no
 *  article substance to render. */
export function renderReference(ref) {
  return `▸ reference '${ref.title}' (${ref.location}): ${clip(ref.summary ?? '', 200)} — refresh via knowledge_get ${ref.id}`;
}

// Severity ordering for hazard blocks: a 'block' hazard must not sit below an
// 'info' one just because it was written first. Absent severity reads as 'warn'
// (the schema leaves it optional, and most records omit it).
const HAZARD_RANK = { block: 0, warn: 1, info: 2 };

/** How many hazard blocks render before the rest are disclosed as dropped.
 *  ONE definition (invariant 1) — H20's dispatch ceiling reuses it. Added
 *  2026-08-09 (board a470046d slice 1): ca23c811's no-cap clause was premised on
 *  measured volume ('0-1 per file'); a hub file then delivered ~25 records for a
 *  one-block edit, falsifying the premise — capping now HONORS the ruling's own
 *  anti-flood reasoning (P1/P6). Distinct from payload_char_cap, which clips per
 *  FIELD and bounds no payload. */
export const HAZARD_CAP = 3;

/** The severity-sorted survivors the cap keeps — exported so callers guard
 *  exactly what RENDERED (AC8): a hazard capped out of a payload is never marked
 *  delivered, so it surfaces on a later touch instead of being lost silently. */
export function cappedHazards(hazards, cap = HAZARD_CAP) {
  return [...hazards]
    .sort((a, b) => (HAZARD_RANK[a.severity ?? 'warn'] ?? 1) - (HAZARD_RANK[b.severity ?? 'warn'] ?? 1))
    .slice(0, cap);
}

/** Hazard blocks for the anti_patterns whose file_keys name this path, most
 *  severe first, capped at HAZARD_CAP with the overflow STATED (never silent —
 *  a silent cap reads as 'that is all there is', the same failure the decision
 *  pointer cap discloses against). The cap applies AFTER the severity sort, so
 *  the dropped hazards are always the least severe.
 *
 *  WHY THIS EXISTS (defect reported from a consuming project 2026-07-30,
 *  decision ca23c811): delivery's owner query was articles-only, so an
 *  anti_pattern naming the EXACT file being edited was never delivered, while
 *  H10 asked at Stop whether a hazard had been RECORDED. The two directions were
 *  asymmetric, and anti_pattern is precisely the type whose whole value is being
 *  seen BEFORE the mistake is repeated — the reporting project shipped a
 *  one-way-latch bug in territory that had a stored one-way-latch anti_pattern.
 *  Substance (trigger + right_way), not a pointer: a pointer to a hazard the
 *  reader must choose to follow reproduces the skippable step delivery deletes. */
/** `total` / `suppressed` (fixer F3) exist for the DRAIN, which is handed only
 *  the ids that were SHOWN in the original payload (some of which may since have
 *  died) and must still replay the ORIGINAL '+N more' tail rather than deriving
 *  a new one from the survivors it happens to have left. Omitted, both fall back
 *  to today's derivation, so every producer call is byte-identical. */
export function renderHazards(hazards, charCap, { cap = HAZARD_CAP, fileKeys = [], remedy, total, suppressed } = {}) {
  const shown = cappedHazards(hazards, cap);
  const fullTotal = total ?? hazards.length;
  const dropped = suppressed ?? hazards.length - shown.length;
  const blocks = shown.map((ap) =>
    [
      `⚠ ANTI-PATTERN [${(ap.severity ?? 'warn').toUpperCase()}] for this path — '${ap.title}'${ap.slug ? ` [${ap.slug}]` : ''} (full record: knowledge_get ${ap.id})${statusAnnotation(ap)}`,
      `TRIGGER: ${clip(ap.trigger, charCap)}`,
      `RIGHT WAY: ${clip(ap.right_way, charCap)}`,
    ].join('\n')
  );
  if (dropped > 0) {
    // `remedy` overrides the widening query for callers whose match was not a
    // file_keys join (the subject channel has no file answer at all — a
    // file_keys:[] query would be unrunnable; review finding 4, 2026-08-10).
    const keys = fileKeys.map((k) => `"${k}"`).join(',');
    const widen = remedy ?? `knowledge_query types:["anti_pattern"] file_keys:[${keys}] cap:${fullTotal}`;
    blocks.push(`… ${dropped} more hazard(s) NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return blocks;
}

/** How many feature_article pointers render per dispatch (H20 subject-axis
 *  delivery, board 62806222 follow-up / consuming-project retro
 *  2026-08-17-2111). Tighter than DECISION_POINTER_CAP: a pointer is the
 *  cheapest unit this mechanism renders (one line, no body at all — see
 *  renderArticlePointers below), but the dispatch payload as a whole must
 *  still stay small (P1), so the cap is deliberately small and the overflow
 *  is DISCLOSED rather than silently dropped, matching renderHazards/
 *  renderDecisionPointers' own cap-and-disclose shape. */
export const ARTICLE_POINTER_CAP = 3;

/** feature_articles matching a dispatch's SUBJECT, as POINTER lines ONLY —
 *  slug, title, and a knowledge_get reference to the full record. NEVER the
 *  article's what_it_does/intended_behavior prose: unlike renderArticle
 *  (file-touch delivery, where the article IS the owning knowledge for a
 *  path the reader is about to edit), a subject match here is weaker
 *  evidence of relevance — the same reasoning that keeps decisions and
 *  hazards capped tighter on this channel than on H19's file-touch channel
 *  (see the MAX_DECISIONS comment in h20-mechanism-axis.mjs). The reader
 *  decides whether to spend a knowledge_get, not have the body pushed at
 *  them. */
export function renderArticlePointers(articles, cap = ARTICLE_POINTER_CAP, { remedy } = {}) {
  const shown = articles.slice(0, cap);
  const lines = [
    `▸ ARTICLES matching this prompt's SUBJECT (${articles.length}) — pointers only, follow knowledge_get before assuming the answer:`,
  ];
  for (const a of shown) {
    lines.push(`  → '${a.slug}': ${clip(a.title, 140)} (knowledge_get ${a.id})`);
  }
  if (articles.length > shown.length) {
    const widen = remedy ?? `knowledge_query types:["feature_article"] cap:${articles.length}`;
    lines.push(`  … ${articles.length - shown.length} more matched but NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return lines.join('\n');
}

/** How many decision pointers render before the rest are disclosed as dropped. */
export const DECISION_POINTER_CAP = 8;

/** Per-pointer clip budgets (decision 6a3b1a46). The statement ORIENTS — what was
 *  decided; the rejected options STOP — what you may be about to propose. */
export const DECISION_STATEMENT_CLIP = 120;
export const DECISION_REJECTED_CLIP = 140;

/** Decisions whose file_keys name this path, as POINTER lines — never bodies.
 *  Measured before choosing this shape (2026-07-30): packages/mcp-server/src/
 *  tools.ts carries 17 matching decisions against 0 anti-patterns, so inlining
 *  decision substance would flood the payload and train the reader to skip it —
 *  the flood half of P6 is as much a failure as starvation. The cap's overflow
 *  is STATED with the query that widens it: a silent cap reads as 'that is all
 *  there is', which is the failure mode knowledge_query's own capped envelope
 *  exists to prevent.
 *
 *  SECOND LINE ADDED 2026-08-03 (decision 6a3b1a46, board 82e2969a): the header
 *  below has promised 'and what was rejected' since 2026-07-30 while the body
 *  carried only the statement clip — delivery advertising a field it does not
 *  deliver, the same defect class as the frontier notice claiming 'there is no
 *  knowledge to deliver' above a hazard block. The rejected OPTION texts render
 *  beneath the statement (not their reasons — recognising the thing you were
 *  about to propose is what stops you; the id is there for the reasoning).
 *  This stays a POINTER change, so ca23c811's substance-vs-pointer asymmetry is
 *  untouched: it ruled on rendering decision BODIES, not on which field is
 *  clipped. alternatives_rejected needs no wider read — SterlingStore.query
 *  rehydrates whole bodies (packages/store/src/index.ts:289). */
export function renderDecisionPointers(rel, decisions, cap = DECISION_POINTER_CAP, { remedy, total, suppressed } = {}) {
  const shown = decisions.slice(0, cap);
  // `total` / `suppressed` (fixer F3) — see renderHazards' note: the drain holds
  // only the shown slice and replays the original count and tail.
  const fullTotal = total ?? decisions.length;
  const dropped = suppressed ?? decisions.length - shown.length;
  const lines = [
    `▸ DECISIONS for this path (${fullTotal}) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:`,
  ];
  for (const d of shown) {
    const authorityMarker = d.authority ? `[${d.authority}] ` : '';
    lines.push(`  → ${authorityMarker}${clip(d.statement, DECISION_STATEMENT_CLIP)}${d.slug ? ` [${d.slug}]` : ''} (knowledge_get ${d.id})${statusAnnotation(d)}`);
    const rejected = (Array.isArray(d.alternatives_rejected) ? d.alternatives_rejected : [])
      .map((a) => (typeof a?.option === 'string' ? a.option.trim() : ''))
      .filter(Boolean)
      .join('; ');
    if (rejected) lines.push(`    ✗ ALREADY REJECTED: ${clip(rejected, DECISION_REJECTED_CLIP)}`);
  }
  if (dropped > 0) {
    // Same remedy override as renderHazards: a subject match has no file_keys
    // answer, so the widening query must come from the caller there.
    const widen = remedy ?? `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${fullTotal}`;
    lines.push(`  … ${dropped} more NOT shown (cap ${cap}) — ${widen} for the full set`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LINE-SUSPECT ADVISORY (board 04ccecb1-a338-4b4e-91f0-c99588c1cdce). Warn-only
// (P1 advisory): this renderer only ever ADDS a trailing block to the payload,
// never changes what else renders or the hook's exit code. The SCAN (regex
// match against `rel`'s `<rel>:digits[-digits]` tokens, plus the record's
// updated_at vs the file's current mtime) lives at the hook's own assembly
// seam, beside freshOwners/freshHazards/freshDecisions — this is only the
// renderer, matching renderHazards/renderDecisionPointers' own shape.
// ---------------------------------------------------------------------------

/** How the payload already names a record's type: slug for an owning article
 *  or reference doc, title for a hazard anti_pattern, id for a decision
 *  (decisions carry no slug at all — renderDecisionPointers only ever shows
 *  one when a record happens to have it). Mirrors each render* function's own
 *  naming rather than inventing a new one for this block. */
function suspectLabel(record) {
  if (record.type === 'anti_pattern') return `anti-pattern '${record.title}'`;
  if (record.type === 'decision') return `decision ${record.id}`;
  if (record.slug) return `article '${record.slug}'`;
  return record.title ?? record.id;
}

/** The line-suspect block DECOMPOSED into `{header, lines: [{id, line}], footer}`
 *  — the same shape bashPointerBlock uses, and for the same reason (fixer M1).
 *
 *  Each advisory line is RECORD-DERIVED: suspectLabel interpolates the record's
 *  own title/slug/id. Replaying the block verbatim at drain therefore serves
 *  cached per-record text for a record that may have been superseded or deleted
 *  since enqueue — the exact leak the pointer channel was fixed for, arriving
 *  through the field the recipe called "advisory text about the FILE". Keyed by
 *  id, the drain can re-resolve each line instead. */
export function lineSuspectBlock(suspects, charCap) {
  return {
    header:
      "⚠ LINE-SUSPECT (H19 advisory) — cited line position(s) below may have rotted: the citing record predates this file's current version.",
    lines: (suspects ?? []).map(({ record, tokens }) => ({
      id: record.id,
      line: `  → ${suspectLabel(record)} cites ${clip(tokens.join(', '), charCap)} — this position may no longer be accurate.`,
    })),
    footer: '  Line numbers rot as a file changes — cite an anchor (function/slug/passage) instead where possible.',
  };
}

/** One trailing block naming every stale-citing record and the token(s) it
 *  cites. `suspects` is `{record, tokens}[]`, already filtered to the stale
 *  ones by the caller's scan — this only renders what it is handed. Returns
 *  `[]` (no block at all) when nothing is suspect, matching the other
 *  render* helpers' empty-array-means-nothing-to-add convention. */
export function renderLineSuspects(suspects, charCap) {
  if (!suspects?.length) return [];
  return [joinSuspectBlock(lineSuspectBlock(suspects, charCap))];
}

/** Join a decomposed suspect block. Returns '' when NO line survives: the header
 *  promises "cited line position(s) BELOW" and the footer advises about them, so
 *  a header+footer with nothing between them is an advisory about nothing. */
export function joinSuspectBlock({ header, lines = [], footer } = {}) {
  if (!lines.length) return '';
  return [header, ...lines.map((l) => l.line), footer].filter((s) => typeof s === 'string' && s).join('\n');
}

/** The delivery envelope. `unowned` swaps the header for the frontier signal:
 *  hazards and decisions can attach to territory NO article owns, and claiming
 *  'owning knowledge for X' above them would be false. With no blocks at all the
 *  unowned payload is exactly the frontier notice — the pre-hazard behavior.
 *
 *  `substantiveCount` (fixer F5) is how many of `blocks` are SUBSTANTIVE —
 *  hazards, owners, decision pointers, trailing advisories. It exists because
 *  renderFrontier's `hasOtherKnowledge` sentence promises "the store DOES hold
 *  the hazards and/or decisions below", and at the DRAIN a block list can consist
 *  entirely of DISCLOSURES about records that died since enqueue. Deriving the
 *  promise from blocks.length there prints the assurance above nothing but
 *  tombstones — precisely the false-assurance failure renderFrontier's own
 *  comment (decision ca23c811) exists to prevent, arriving from the other side.
 *  Omitted, it falls back to blocks.length, so producer calls are unchanged. */
export function renderPayload(rel, blocks, { unowned = false, substantiveCount } = {}) {
  const substantive = substantiveCount ?? blocks.length;
  return [
    unowned
      ? renderFrontier(rel, { hasOtherKnowledge: substantive > 0 })
      : `STERLING KNOWLEDGE DELIVERY (H19) — owning knowledge for '${rel}'. Consult before designing or editing in this territory; the store is current reality AND rationale, the code is only the implementation.`,
    ...blocks,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// BASH POINTER DELIVERY (board 841195b1). Delivery rode Edit|Write|MultiEdit
// and Read only, while the surveying that decides what to change happens
// through grep/wc/git log — so the safety net under retrieval-first had its
// hole exactly where the traffic is, and the hole is INVISIBLE: nothing tells
// you an injection did not happen. Four consuming-project reports named this
// independently; the fourth measured ~a dozen Bash investigations with zero
// deliveries.
//
// WHY A POINTER AND NOT THE ARTICLE. Measured on this machine 2026-08-03: real
// H19 payloads ran 13,010 and 17,078 bytes (payload_char_cap is applied PER
// FIELD, so one delivery has no total ceiling). A Bash-heavy pass issues far
// more calls than it does Reads — and issues them precisely to AVOID the cost
// of reading the file — so full-article delivery here could cost more context
// than the reads it exists to protect. One line per owned path is ~90% of the
// value at ~5% of the tokens, and being cheap is what lets the extractor below
// tolerate the occasional false positive instead of needing to be exact.
// ---------------------------------------------------------------------------

/** Max distinct owned paths a single command may deliver pointers for. A
 *  `git log --stat` or a wide grep can name dozens; the cap keeps one command's
 *  delivery bounded and is why precision below can stay cheap. */
export const BASH_POINTER_PATH_CAP = 8;

/** Tokens that are never a path but survive the shape tests below. */
const COMMAND_PATH_SKIP = new Set(['--', '-', '.', './', '..', '../']);

/**
 * Candidate file paths named in a shell/PowerShell command string. PURE and
 * deliberately SHAPE-ONLY: it does not touch the filesystem, so it is unit
 * testable, and the caller applies the real filter (exists + is a file +
 * governed). That split is the whole precision strategy — a search PATTERN
 * that looks like a path (`grep -rn "tools.ts" .`) is cheap to let through
 * here because it dies at the existence check, and a pattern that happens to
 * name a real file costs one pointer line, not an article.
 *
 * Globs are dropped rather than expanded: `*`/`?` cannot be resolved without
 * the filesystem, and a half-expanded glob would deliver for the wrong file.
 */
export function extractCommandPathCandidates(command) {
  const text = String(command ?? '');
  // Quote-aware split: a quoted argument is one token even with spaces in it.
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    let t = raw;
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
    // Shell punctuation that clings to an argument in real commands.
    t = t.replace(/^[(<]+/, '').replace(/[),;:'"]+$/, '');
    // `path:12` / `path:12:5` — grep -n output pasted back into a command.
    t = t.replace(/:\d+(:\d+)?$/, '');
    if (!t || COMMAND_PATH_SKIP.has(t)) continue;
    if (t.startsWith('-')) continue; // a flag, or a flag=value
    if (/[*?$`!]/.test(t)) continue; // glob or shell expansion — unresolvable here
    // Must LOOK like a path: contain a separator, or carry a file extension.
    if (!(t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * One line per governed path: what owns it, and the id to read it with. Kept to
 * a single line per record on purpose — this is a signpost telling the reader
 * an article EXISTS, not a substitute for reading it. Hazards lead each path's
 * list for the same reason they lead renderArticle's payload: "do not do this
 * here" outranks "here is what this is".
 */
/** The Bash pointer block, DECOMPOSED into `{header, lines}` where each line is
 *  keyed by the record id it describes (fixer F1). The drain needs per-record
 *  lines, not one pre-joined blob: to serve a still-active pointer verbatim while
 *  REPLACING a superseded one with a stub, it must know which line belongs to
 *  which id. `header` is producer chrome (two fixed sentences, no record field
 *  interpolated), which is why it can be replayed verbatim at drain. */
export function bashPointerBlock(entries) {
  const header = [
    'STERLING KNOWLEDGE POINTERS (H19) — governed paths named in a Bash command.',
    'This is a POINTER, not the article: the store owns these paths, so read the record before you design or edit here.',
  ].join('\n');
  const lines = [];
  for (const e of entries) {
    for (const h of e.hazards) {
      const hazardLabel = h.title && h.slug ? `${h.title} [${h.slug}]` : (h.title ?? h.slug ?? h.id);
      lines.push({
        id: h.id,
        line: `  • ${e.rel} — ⚠ HAZARD anti_pattern '${hazardLabel}' · knowledge_get ${h.id}${statusAnnotation(h)}`,
      });
    }
    for (const o of e.owners) {
      const kind = o.type === 'reference_material' ? 'reference' : 'article';
      const label = o.title && o.slug ? `${o.title} [${o.slug}]` : (o.slug ?? o.title ?? o.id);
      // `state` (article build state) and the status bracket are distinct facts
      // — see renderArticle's header comment.
      const state = o.state ? ` (${o.state})` : '';
      lines.push({
        id: o.id,
        line: `  • ${e.rel} — ${kind} '${label}'${state} · knowledge_get ${o.id}${statusAnnotation(o)}`,
      });
    }
  }
  return { header, lines };
}

/** Join a `{header, lines, tail}` pointer block into the payload text. ONE
 *  definition (invariant 1) shared by both pointer producers and by the payload
 *  they cache for the drain's fail-open arm. */
export function joinPointerBlock({ header, lines = [], tail } = {}) {
  return [header, ...lines.map((l) => l.line), ...(tail ? [tail] : [])].filter((s) => typeof s === 'string' && s).join('\n');
}

export function renderBashPointers(entries) {
  return joinPointerBlock(bashPointerBlock(entries));
}

// ---------------------------------------------------------------------------
// DRAIN RE-RESOLVE (decision db3392db part 2). The 'prompt' rung injects one
// turn AFTER the touch, so a queue entry's PRE-RENDERED payload can describe a
// ruling that has since been superseded, retired or deleted — the queue was the
// one delivery surface able to serve a dead ruling as live. Every producer now
// attaches a STRUCTURED RENDER RECIPE beside the payload; the drain re-reads the
// recipe's ids from ONE store snapshot and serves per verdict:
//
//   still-active  → RE-RENDERED from the current record for a substance entry;
//                   for a POINTER entry, the per-record line captured at enqueue
//                   is replayed verbatim (a flagged_stale record is SERVED,
//                   disclosed by statusAnnotation's bracket / a trailing line).
//   superseded    → the cached body is WITHHELD and replaced by a stub naming
//                   the QUEUED id and its successor. Never a silent redirect:
//                   rendering the successor's body as though it were the record
//                   the reader was queued is the laundering shape the decision
//                   rejects outright.
//   missing       → body dropped, one-line disclosure naming the id.
//   unverifiable  → the STORED payload plus a per-entry UNVERIFIED banner
//                   (store unavailable, no recipe, or a contained render
//                   failure). Fail-open: delivery is an aid, never a gate, so a
//                   broken store degrades to a disclosed cache read, never to
//                   silence and never to an indefinite requeue.
//
// The payload is RETAINED as the fallback precisely so the unverifiable arm has
// something honest to serve. Recipes are versioned: an entry from before this
// upgrade (or from a newer one) takes the unverifiable arm rather than being
// parsed on a guess.
//
// NO CACHED PER-RECORD TEXT IS EVER SERVED FOR A TERMINAL RECORD, on EITHER mode
// (fixer F1) — and that claim now holds for EVERY channel in a recipe, which is
// what it did not do when it was first written (fixer M1). The substance mode
// never replays cache for hazards/owners/decisions; the pointer mode is rebuilt
// line by line, and a superseded or missing record's line is REPLACED by its
// stub/disclosure rather than footnoted beneath a line that still asserts it; the
// line-suspect advisory is likewise keyed by id and its dead lines are DROPPED
// (warn-only, so no tombstone). The one field exempt from re-resolution is
// `trailing_blocks`, and it is exempt only because nothing record-derived may be
// put in it — a record-derived line placed there would reintroduce this leak,
// which is why the line-suspect block was moved OUT of it.
// ---------------------------------------------------------------------------

/** Bumped only when a recipe's SHAPE changes incompatibly. An entry whose
 *  version this drain does not recognise is served payload+banner, never
 *  interpreted optimistically.
 *
 *  VERSION 2 (fixer pass on decision db3392db part 2) changed BOTH modes:
 *   - pointer_verify now carries the per-record rendered LINE keyed by id, so
 *     the drain REBUILDS the pointer block instead of replaying the whole cached
 *     blob and appending footnotes beneath it (v1 replayed a superseded record's
 *     cached line as live text, which is the very defect the re-resolve exists to
 *     close — the appended disclosure sat under a line still asserting the
 *     record).
 *   - rerender now carries the SHOWN (post-cap) id sets plus the original
 *     suppressed-tail counts, instead of the uncapped fresh sets: re-capping an
 *     uncapped list against a changed store can PROMOTE a record the reader was
 *     never shown into the drained payload.
 *  A v1 entry therefore takes the payload+UNVERIFIED-banner arm: its shape cannot
 *  answer either question, and guessing is what this version field prevents. */
export const DELIVERY_RECIPE_VERSION = 2;

/** Recipe for a substance-bearing entry (H19 file-touch delivery + frontier):
 *  the drain rebuilds the WHOLE payload from current records, so no cached body
 *  survives re-resolution.
 *
 *  Ids are the SHOWN slice — exactly what the original payload rendered — and
 *  `tails` carries what the original payload SUPPRESSED, so the drain replays the
 *  same '… N more NOT shown' line without ever rendering a record the reader was
 *  not shown.
 *
 *  TWO DIFFERENT KINDS OF TRAILING TEXT, and conflating them was a leak (M1):
 *   - `suspects` is the line-suspect advisory, DECOMPOSED to {id, line} because
 *     every one of its lines names a RECORD (suspectLabel interpolates the
 *     record's title/slug/id). The drain re-resolves each id and DROPS the line
 *     of a record that died — warn-only advisory needs no tombstone, but it must
 *     not be replayed as though the record still said it.
 *   - `trailing_blocks` is for text that genuinely describes only the FILE, with
 *     no record id anywhere in it. Nothing populates it today; it is kept so a
 *     future file-only advisory has an honest home rather than being smuggled in
 *     beside record-derived lines. */
export function rerenderRecipe({
  rel,
  unowned,
  charCap,
  hazardIds,
  ownerIds,
  decisionIds,
  hazardTail,
  decisionTail,
  suspects,
  trailingBlocks,
}) {
  return {
    version: DELIVERY_RECIPE_VERSION,
    mode: 'rerender',
    rel,
    unowned: !!unowned,
    char_cap: charCap,
    hazard_ids: hazardIds ?? [],
    owner_ids: ownerIds ?? [],
    decision_ids: decisionIds ?? [],
    tails: { hazards: hazardTail ?? 0, decisions: decisionTail ?? 0 },
    suspects: suspects
      ? {
          header: suspects.header ?? '',
          entries: (suspects.lines ?? []).map((l) => ({ id: l?.id, line: l?.line })),
          footer: suspects.footer ?? '',
        }
      : null,
    trailing_blocks: trailingBlocks ?? [],
  };
}

/** Recipe for a POINTER-ONLY entry (Bash pointers, H23 output-axis). `entries`
 *  is `{id, line}[]` — the LINE THE PRODUCER RENDERED for that record, captured
 *  at enqueue — plus optional `header`/`tail` for the block's non-per-record
 *  chrome (the producer's fixed preamble; H23's '(+N more matched)' remainder).
 *
 *  Storing the line per id is what lets the drain REBUILD rather than annotate:
 *  a live record's line is replayed verbatim, a superseded one is REPLACED by the
 *  stub, a missing one by the disclosure. v1's shape (bare `record_ids` + the
 *  whole cached blob) could only APPEND beneath text that still asserted the dead
 *  record — a stale serve with a footnote. */
export function pointerVerifyRecipe({ header, entries, tail } = {}) {
  return {
    version: DELIVERY_RECIPE_VERSION,
    mode: 'pointer_verify',
    header: typeof header === 'string' ? header : '',
    entries: (entries ?? []).map((e) => ({ id: e?.id, line: e?.line })),
    tail: typeof tail === 'string' ? tail : '',
  };
}

// ---------------------------------------------------------------------------
// RECIPE VALIDATION (fixer F7). A recipe is JSON off disk: nothing guarantees
// its fields have the shape this drain iterates. The measured hazard is a STRING
// where an array was expected — `for (const id of "abc")` iterates PER CHARACTER
// and issues one store lookup per letter, each of which "resolves to nothing",
// producing a payload full of fabricated missing-record disclosures. Every v2
// field is therefore type-checked BEFORE use, and any malformation routes to the
// payload+banner arm — the same fail-open landing as an unknown version.
// ---------------------------------------------------------------------------
const isStr = (v) => typeof v === 'string';
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
/** SAFE INTEGER, not merely finite (fixer M3). A FRACTIONAL cap is not a
 *  harmless rounding question here: clip() stops only on `count === cap`, so
 *  char_cap: 0.5 is never reached and the field renders UNBOUNDED — the exact
 *  payload-flooding failure the cap exists to prevent, reachable from a JSON file.
 *  A non-integer tail count would likewise render '… 2.5 more hazard(s)'. */
const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function validateRerenderRecipe(r) {
  if (!isStr(r.rel)) return 'rel is not a string';
  if (typeof r.unowned !== 'boolean') return 'unowned is not a boolean';
  if (!isCount(r.char_cap)) return 'char_cap is not a non-negative safe integer';
  for (const key of ['hazard_ids', 'owner_ids', 'decision_ids']) {
    if (!isStrArray(r[key])) return `${key} is not an array of strings`;
  }
  if (!isStrArray(r.trailing_blocks)) return 'trailing_blocks is not an array of strings';
  // `suspects` is OPTIONAL (absent/null = no advisory block), but present means
  // fully shaped — a half-valid suspect block routes to the banner arm like any
  // other malformation rather than being partially iterated.
  if (r.suspects !== undefined && r.suspects !== null) {
    const s = r.suspects;
    if (typeof s !== 'object' || Array.isArray(s)) return 'suspects is not an object';
    if (!isStr(s.header) || !isStr(s.footer)) return 'suspects.header/footer is not a string';
    if (!Array.isArray(s.entries)) return 'suspects.entries is not an array';
    for (const e of s.entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return 'a suspects.entries element is not an object';
      if (!isStr(e.id) || !e.id) return 'a suspects.entries element carries no string id';
      if (!isStr(e.line)) return 'a suspects.entries element carries no string line';
    }
  }
  const tails = r.tails;
  if (!tails || typeof tails !== 'object' || Array.isArray(tails)) return 'tails is not an object';
  if (!isCount(tails.hazards ?? 0) || !isCount(tails.decisions ?? 0)) {
    return 'tails carries a count that is not a non-negative safe integer';
  }
  return null;
}

function validatePointerVerifyRecipe(r) {
  if (r.header !== undefined && !isStr(r.header)) return 'header is not a string';
  if (r.tail !== undefined && !isStr(r.tail)) return 'tail is not a string';
  if (!Array.isArray(r.entries)) return 'entries is not an array';
  for (const e of r.entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'an entries element is not an object';
    if (!isStr(e.id) || !e.id) return 'an entries element carries no string id';
    if (!isStr(e.line)) return 'an entries element carries no string line';
  }
  return null;
}

function unverifiedBanner(payload, reason) {
  return [
    `⚠ UNVERIFIED AT DRAIN (H19): ${reason}. The text below is the payload CACHED when this was queued, NOT a fresh read — a ruling superseded or deleted since then would still read as live here. Re-query (knowledge_query / knowledge_get) before relying on it.`,
    payload,
  ].join('\n');
}

// EVERY LINE BELOW IS BUILT AT DRAIN AND INTERPOLATES STORED RECORD FIELDS, so
// each such fragment goes through normalizeWs first (fixer F4): a status, scope,
// superseded_by or id that carries an embedded newline would otherwise let stored
// prose fabricate an ADDITIONAL delivery line inside the drain's own output —
// a forged '⚠ SUPERSEDED AT DRAIN' or '(+N more)' row is indistinguishable from
// a real one to the reader. Scoped deliberately to the drain-built lines; the
// wider renderer-escaping question is boarded separately.

/** One-line disclosure for a queued id that no longer resolves at all. Names the
 *  id (the reader's only handle on what went missing) and states in words that
 *  the body was DROPPED rather than served from cache. */
function missingDisclosure(id) {
  return (
    `⚠ STALE AT DRAIN (H19): queued record ${normalizeWs(id)} NO LONGER RESOLVES in the store — it was present when this delivery was queued and is now missing, ` +
    `so its cached body is WITHHELD rather than served as current.`
  );
}

/** The superseded stub. Names the QUEUED id first and the successor as a FORWARD
 *  POINTER — the reader is never handed the successor's body as if it were what
 *  they touched. A chain whose successor is absent or does not resolve is
 *  disclosed IN WORDS: the old shape (`see ${record.superseded_by}`) renders
 *  "see null" on a dangling chain, which reads as a real target and sends the
 *  reader nowhere. */
function supersededDisclosure(store, record) {
  const successorId = record.superseded_by;
  let successor;
  if (successorId) {
    try {
      successor = store.get(successorId);
    } catch {
      successor = undefined;
    }
  }
  if (successorId && successor) {
    return (
      `⚠ SUPERSEDED AT DRAIN (H19): queued record ${normalizeWs(record.id)} was live when this delivery was queued and is now SUPERSEDED [${normalizeWs(statusBracket(record))}] — ` +
      `its cached body is WITHHELD. Forward pointer only, not the successor rendered as the original: read the replacement with knowledge_get ${normalizeWs(successorId)}.`
    );
  }
  const named = successorId ? ` (${normalizeWs(successorId)})` : '';
  return (
    `⚠ SUPERSEDED AT DRAIN (H19): queued record ${normalizeWs(record.id)} is now SUPERSEDED, and its successor${named} is UNRESOLVABLE — a dangling supersession chain, ` +
    `so no forward target can be named and its cached body is WITHHELD. Re-query this territory (knowledge_query) rather than trusting either half of the chain.`
  );
}

/** Lifecycle disclosure for a record that is STILL SERVED but no longer plainly
 *  active (flagged_stale, and any status this drain does not recognise). The
 *  pointer above stands and the body is never touched — 'flagged_stale is
 *  disclosed AND served' (decision db3392db part 2), so this line deliberately
 *  avoids any withheld/dropped wording, which belongs only to the terminal and
 *  missing arms.
 *
 *  CLAIMS ONLY WHAT THE CODE CHECKED (fixer F8). The arm that reaches this line
 *  tests exactly one thing: the status is not 'active'. It does NOT establish
 *  that the store "flags it for re-verification" — that reads the flagged_stale
 *  meaning onto every non-active status, including one this build has never
 *  heard of, and a disclosure that over-claims is a small lie in the one place
 *  whose entire job is telling the reader what is uncertain. The sentence now
 *  states the status it saw, points at the bracket, and asks for re-verification. */
function staleServedDisclosure(record) {
  return (
    `ⓘ LIFECYCLE AT DRAIN (H19): queued record ${normalizeWs(record.id)} is SERVED exactly as pointed at above, but its status is NOT 'active' — ` +
    `[${normalizeWs(statusBracket(record))}] is the non-active status the store reports for it; re-verify (knowledge_get ${normalizeWs(record.id)}) before relying on it.`
  );
}

/** Read one queued id from the drain's single store snapshot. Returns either a
 *  served record or the disclosure line that replaces it. A store read that
 *  THROWS for one id is treated as that id being unreadable, never as a reason
 *  to lose the rest of the entry. */
function resolveQueuedId(store, id) {
  let record;
  try {
    record = store.get(id);
  } catch {
    record = undefined;
  }
  if (!record) return { served: null, disclosure: missingDisclosure(id) };
  // 'superseded' is the store's DERIVED terminal status (lifecycle 'retired'
  // included — retirement derives status 'superseded'). Everything else,
  // 'flagged_stale' explicitly among it, is still SERVED: a stale ruling is the
  // best answer the store has and withholding it delivers nothing. Its bracket
  // rides the ordinary pointer annotation.
  if (record.status === 'superseded') return { served: null, disclosure: supersededDisclosure(store, record) };
  return { served: record, disclosure: null };
}

function rerenderFromRecipe(store, recipe) {
  const charCap = recipe.char_cap;
  const disclosures = [];
  const take = (ids) => {
    const served = [];
    for (const id of ids ?? []) {
      const { served: record, disclosure } = resolveQueuedId(store, id);
      if (record) served.push(record);
      else disclosures.push(disclosure);
    }
    return served;
  };
  // Resolved in the entry's own semantic order (hazards, owners, decisions) so
  // the disclosure list reads in the same order the payload would have.
  const hazards = take(recipe.hazard_ids);
  const owners = take(recipe.owner_ids);
  const decisions = take(recipe.decision_ids);

  // F3: the recipe's id arrays ARE the original shown slice, so the original
  // totals are (shown ids) + (suppressed tail) — computed from the RECIPE, never
  // from the survivors, or a record that died since enqueue would silently
  // shrink the '… N more' arithmetic the reader is being handed.
  const hazardTail = recipe.tails?.hazards ?? 0;
  const decisionTail = recipe.tails?.decisions ?? 0;
  const hazardTotal = recipe.hazard_ids.length + hazardTail;
  const decisionTotal = recipe.decision_ids.length + decisionTail;

  // LINE-SUSPECT ADVISORY, RE-RESOLVED (fixer M1). Each line names a record, so a
  // line whose record no longer resolves — or has gone terminal — is DROPPED
  // rather than replayed: the advisory is warn-only, so a tombstone would cost
  // more attention than the dropped hint was worth, but serving the cached line
  // would assert that a dead record still cites that position. joinSuspectBlock
  // returns '' when nothing survives, which is what keeps a header-and-footer
  // shell promising "position(s) below" out of the payload.
  const suspectEntries = recipe.suspects?.entries ?? [];
  const survivingSuspects = suspectEntries.filter((e) => resolveQueuedId(store, e.id).served);
  const suspectText = recipe.suspects
    ? joinSuspectBlock({ header: recipe.suspects.header, lines: survivingSuspects, footer: recipe.suspects.footer })
    : '';

  // SUBSTANTIVE blocks only (fixer F5/L1) — the disclosure block is appended after
  // and is deliberately NOT counted, so an unowned entry whose every record died
  // renders the plain frontier notice instead of promising hazards below it. The
  // suspect block counts only when a line actually SURVIVED (suspectText is ''
  // otherwise, and the filter below drops it from the count as well as the output).
  const substantive = [
    ...renderHazards(hazards, charCap, { fileKeys: [recipe.rel], total: hazardTotal, suppressed: hazardTail }),
    ...owners.map((r) => (r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap))),
    ...(decisions.length || decisionTail
      ? [renderDecisionPointers(recipe.rel, decisions, DECISION_POINTER_CAP, { total: decisionTotal, suppressed: decisionTail })]
      : []),
    ...(recipe.trailing_blocks ?? []),
    suspectText,
  ].filter((b) => typeof b === 'string' && b);
  const blocks = [
    ...substantive,
    // Disclosures TRAIL the knowledge that did survive: what is still true
    // outranks the footnote about what changed under it.
    ...(disclosures.length ? [disclosures.join('\n')] : []),
  ];
  return renderPayload(recipe.rel, blocks, { unowned: recipe.unowned, substantiveCount: substantive.length });
}

/** REBUILD the pointer block from the recipe's per-record lines (fixer F1) —
 *  never the cached blob with footnotes appended beneath it.
 *
 *  Per record, one of four outcomes, and the terminal ones REPLACE the line
 *  rather than annotating it:
 *    live 'active'          → the captured line, verbatim.
 *    non-active, non-terminal (flagged_stale, or an unrecognised status)
 *                           → the captured line PLUS staleServedDisclosure.
 *    superseded (incl. retired, which derives status 'superseded')
 *                           → the STUB naming the queued id and its successor,
 *                             INSTEAD of the line.
 *    no longer resolves     → the one-line disclosure, INSTEAD of the line.
 *
 *  That last pair is the whole point of v2: v1 replayed the cached line for a
 *  dead record and appended a disclosure below it, so the reader was handed a
 *  line still asserting the record's title/id as current, footnoted. A pointer
 *  is a short line and readers act on it — the assertion has to GO. */
function rebuildPointerPayload(store, recipe) {
  const out = [];
  // header/tail are producer chrome (fixed sentences, H23's '(+N more matched)'
  // remainder) with no record field interpolated, so they replay verbatim.
  if (recipe.header) out.push(recipe.header);
  for (const entry of recipe.entries) {
    const { served, disclosure } = resolveQueuedId(store, entry.id);
    if (!served) {
      out.push(disclosure); // stub (superseded) or missing disclosure — REPLACES the line
      continue;
    }
    // F4: the captured line is record-derived (a title/slug was interpolated into
    // it at enqueue), so it is flattened to one line before being replayed — a
    // newline in stored prose must not fabricate an extra pointer row here.
    out.push(flattenToOneLine(entry.line));
    // SERVED but not plainly active: the line stands and the lifecycle is
    // DISCLOSED. The non-active test IS statusAnnotation's own output, never a
    // second predicate beside it, so the two can never drift apart.
    if (statusAnnotation(served)) out.push(staleServedDisclosure(served));
  }
  if (recipe.tail) out.push(recipe.tail);
  return out.join('\n');
}

/**
 * What ONE queued entry injects at drain. NEVER THROWS — per-entry containment
 * (decision db3392db part 2): the batch is already claimed and deleted by the
 * time this runs, so an exception escaping here would destroy every OTHER
 * entry's delivery too. A contained failure degrades to that entry's stored
 * payload plus the UNVERIFIED banner, which is the same fail-open arm the
 * store-unavailable case takes.
 *
 * `store` null means the drain could not open the store at all; `storeReason`
 * carries why, so the banner says which of "absent" and "unreadable" happened
 * instead of making the reader guess.
 */
export function renderDrainEntry(store, entry, storeReason) {
  const payload = typeof entry?.payload === 'string' ? entry.payload : '';
  try {
    // A BATCH-level failure the claim step already diagnosed (an unparseable or
    // non-array queue file, fixer F6): it carries its own reason and never had an
    // entry to re-resolve, so it lands on the same disclosed banner arm rather
    // than being dropped from the injection silently.
    if (isStr(entry?.unverified_reason) && entry.unverified_reason) {
      return unverifiedBanner(payload, entry.unverified_reason);
    }
    if (!store) {
      return unverifiedBanner(payload, storeReason ?? 'the project store could not be read at drain');
    }
    const recipe = entry?.recipe;
    if (!recipe || recipe.version !== DELIVERY_RECIPE_VERSION) {
      return unverifiedBanner(
        payload,
        recipe
          ? `this entry carries a render recipe version this drain does not know (${JSON.stringify(recipe.version)}), so its ids were not re-read`
          : 'this entry carries no render recipe (queued before the re-resolve upgrade, or by a producer that attaches none), so its ids could not be re-read'
      );
    }
    // SHAPE-CHECKED BEFORE USE (fixer F7): a malformed field lands on the banner
    // arm, never on optimistic iteration.
    if (recipe.mode === 'rerender') {
      const bad = validateRerenderRecipe(recipe);
      if (bad) {
        return unverifiedBanner(
          payload,
          `this entry's v${DELIVERY_RECIPE_VERSION} rerender recipe is malformed (${bad}), so its ids were not re-read`
        );
      }
      return rerenderFromRecipe(store, recipe);
    }
    if (recipe.mode === 'pointer_verify') {
      const bad = validatePointerVerifyRecipe(recipe);
      if (bad) {
        return unverifiedBanner(
          payload,
          `this entry's v${DELIVERY_RECIPE_VERSION} pointer_verify recipe is malformed (${bad}), so its ids were not re-read`
        );
      }
      return rebuildPointerPayload(store, recipe);
    }
    return unverifiedBanner(payload, `this entry's render recipe names an unknown mode (${JSON.stringify(recipe.mode)}), so its ids were not re-read`);
  } catch (e) {
    return unverifiedBanner(payload, `re-resolving this entry against the store failed (${(e && e.message) || e})`);
  }
}

/** The unowned-territory notice. `hasOtherKnowledge` is load-bearing, not
 *  cosmetic: since ca23c811 this notice is the HEADER above any hazard and
 *  decision blocks, and the old unconditional "there is no knowledge to deliver"
 *  became FALSE in exactly the case the change exists to fix — a reader who
 *  trusts that sentence stops before the BLOCK-severity hazard printed beneath
 *  it, which rebuilds the skippable step delivery deletes (correctness review
 *  2026-07-30). */
export function renderFrontier(rel, { hasOtherKnowledge = false } = {}) {
  return (
    `STERLING FRONTIER SIGNAL (H19): territory '${rel}' is UNOWNED — no owning article exists in the store. ` +
    (hasOtherKnowledge
      ? `KEEP READING: no article describes this territory, but the store DOES hold the hazards and/or decisions below for this exact path — they are all it has here. `
      : `There is no knowledge to deliver; `) +
    `H10 will demand the owning article at session end if this work lands here. ` +
    `Query adjacent knowledge (knowledge_query) before designing in unmapped territory.`
  );
}
