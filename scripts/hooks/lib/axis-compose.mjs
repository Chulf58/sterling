// scripts/hooks/lib/axis-compose.mjs — THE ONE COPY of H20's mechanism-axis
// composition and H23's output-axis composition (board 16f96c84; decision
// sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code).
// Called by scripts/hooks/h20-mechanism-axis.mjs and h23-output-axis.mjs on
// Claude Code and by packages/opencode-plugin/src/axis.mjs on OpenCode 2, so the
// two hosts render the same carriage from the same code. Each caller keeps only
// its own plumbing: reading the call, opening the store, the guard path, how
// the text reaches the model and when the guard is written.
//
// HOST TEXT: the only wording that differs by host is HOST_TEXT below (how a
// dispatched agent is corrected; the timing probe the question header cites).
// Everything else renders byte-for-byte the same on both hosts.
//
// The comments below moved here with the code from the two hook files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_RANK_TERMS } from '@sterling/store';
import { loadConfig } from './common.mjs';
import { isForeignTree } from './working-tree.mjs';
import {
  extractAxisTerms,
  axisHits,
  renderArticlePointers,
  ARTICLE_POINTER_CAP,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  AXIS_MIN_DISCRIMINATING_HITS,
  hasRecordCentralityHit,
  recordCentralityHits,
  isKnownDelivered,
  isSubstanceDelivered,
  hazardParts,
  recordRevision,
  DENY_RULING_TYPES,
  subQuestionText,
  assembleDelivery,
  resolveTotalCap,
  decisionPointerPart,
  statusAnnotation,
  authorityMarker,
  withInboundSupersedes,
  DECISION_STATEMENT_CLIP,
  DECISION_REJECTED_CLIP,
  boundedTermClause,
  joinPointerBlock,
} from './delivery.mjs';

/** Host-specific wording. `correction`: how the conductor corrects an agent
 *  whose brief has gone out. `timing`: the probe behind the question header's
 *  post-answer claim (on OpenCode the audit rides the tool result by construction). */
const HOST_TEXT = {
  claude: { correction: 'with SendMessage (or re-dispatch)', timing: ' (probed 2026-08-11)' },
  opencode: { correction: 'by continuing it through the subagent tool with its sessionID (or re-dispatch)', timing: '' },
};

// ===========================================================================
// H20 — mechanism-axis composition
// ===========================================================================

// Injection ceilings. Deliberately tighter than H19's file-touch payload: a
// keyword match is WEAKER evidence of relevance than an explicit file_keys
// join, so it earns less of the reader's attention. Also note the separate
// finding that config.delivery.payload_char_cap is applied per FIELD and does
// not bound a payload at all — so these counts are the real bound here.
// The hazard ceiling is the ONE shared definition (HAZARD_CAP, invariant 1):
// since board a470046d slice 1, H19's path-scoped hazard block caps at the
// same count, so the two channels share the bound.
const MAX_DECISIONS = 5;

// PROMPT-SHAPE RANKING (consuming-project retro 2026-08-17-2111): a QUESTION
// ("where is X", "does X exist", "how many...") is the reader asking the
// store a fact — the article pointer IS the answer, so it must lead. A
// CHANGE ("implement X", "fix X") is the reader about to act on a file the
// store cannot see — the existing hazard-first order (stop me before I
// repeat a mistake) stays the priority, with article pointers after.
// Gated on an actual '?' so a change-shaped brief that happens to use a word
// like "does" ("this change does X") is never misread as a question — the
// interrogative words alone are common enough in ordinary prose that the
// mark is the real signal; the words narrow it to a genuine interrogative.
const QUESTION_WORDS_RE =
  /\b(where|what|which|who|whom|whose|when|why|how|does|do|did|is|are|was|were|can|could|would|will|should)\b/i;
function isQuestionShapedPrompt(text) {
  const t = String(text ?? '');
  return t.includes('?') && QUESTION_WORDS_RE.test(t);
}

/**
 * The model-pin decision for a codex call in the Sterling project at `root`:
 * `{ line, model? }`, where `model` is the configured model to write into a call
 * that named none. `opener` is true for the tool that opens a thread (it takes a
 * model); a reply tool takes none. The caller decides first that this is a codex
 * call in a Sterling project, and how the model reaches the call (H20: an
 * updatedInput; OpenCode: the live call arguments).
 * NEVER THROWS: a broken config is a disclosure, not an exception.
 *
 * Everything this block needs lives INSIDE this function (the label included):
 * a top-level initialized const is a fail-closed-boundary finding in a hook
 * classified 'blocking' (scripts/check-failclosed-boundary), and this change
 * has no business adding new baseline debt to H20's existing set.
 */
export function codexModelPin(root, { opener, toolInput }) {
  const PIN = 'STERLING CODEX MODEL PIN (H20)';
  // EVERY UNTRUSTED VALUE THAT REACHES THE DISCLOSURE GOES THROUGH THIS
  // (reviewer-security, 2026-09-05). .sterling/config.json is agent-writable, so
  // sparring_partner.model — and the JSON.parse error text, which quotes the
  // file's own bytes — are attacker-influenced strings landing verbatim in the
  // conductor's context. JSON.stringify is the fix that matters: it escapes
  // embedded NEWLINES and quotes, so a planted value can no longer break out of
  // its line and fabricate a Sterling-voiced sentence beneath the pin; the clip
  // bounds a value planted to flood the payload.
  // SCOPE, deliberately: this escapes what is DISPLAYED, never what is INJECTED
  // — updatedInput.model still crosses byte-for-byte, which frozen pin M-8
  // requires and decision foreign_8b329d57 rules ("free non-empty string verbatim, no
  // validation" — there is no shell/TOML boundary on this route and codex
  // validates ids server-side with a loud 400).
  const show = (v) => {
    const s = JSON.stringify(String(v ?? ''));
    return s.length <= 120 ? s : `${s.slice(0, 120)}…`;
  };
  if (!opener) {
    // codex-reply and any future sibling: disclose, never touch the input.
    return {
      line:
        `STERLING CODEX MODEL (H20) — this tool takes no model argument, so the thread keeps the model its opener started with. ` +
        `Sterling changes nothing on this call; to move a conversation onto a different model, open a NEW consult.`,
    };
  }

  let config = null;
  let unreadable = null;
  try {
    config = loadConfig(root);
  } catch (e) {
    unreadable = (e && e.message) || String(e);
  }
  const sp = config && typeof config.sparring_partner === 'object' && config.sparring_partner ? config.sparring_partner : null;
  const lines = [];
  if (sp && sp.enabled === false) {
    lines.push(
      `${PIN} — the codex sparring partner is OFF for this project (config.sparring_partner.enabled:false). ` +
        `That is ADVISORY, NEVER A GATE: this consult is not blocked, and the model below still applies. ` +
        `Turn it back on in the TUI System tab if the OFF state is stale.`
    );
  }
  // The call's OWN model wins, always — the pin only fills an OMITTED value.
  const callModel = typeof toolInput?.model === 'string' && toolInput.model !== '' ? toolInput.model : null;
  // An EMPTY configured value is the TUI's clear-to-unset signal, not a model id
  // (main.ts applySparringModel deletes the key on an empty commit) — the two
  // are one state, and codex would 400 on ''.
  const configured = sp && typeof sp.model === 'string' && sp.model !== '' ? sp.model : null;

  if (callModel !== null) {
    lines.push(
      `${PIN} — this call names model ${show(callModel)} EXPLICITLY, so the call-site value wins and Sterling leaves the input untouched` +
        `${configured ? ` (config.sparring_partner.model is ${show(configured)} and was not applied)` : ''}.`
    );
    return { line: lines.join('\n') };
  }
  if (unreadable) {
    lines.push(
      `${PIN} — .sterling/config.json could not be parsed (${show(unreadable)}), so NO model was applied and the Codex CLI default is in force. ` +
        `Fix the config file; a consult is never denied over this.`
    );
    return { line: lines.join('\n') };
  }
  if (!configured) {
    lines.push(
      `${PIN} — no model is set in config.sparring_partner.model` +
        `${config ? '' : ' (no .sterling/config.json to read)'}, so this consult takes the Codex CLI default. ` +
        `Set one on the TUI System tab row 'Default Codex model'.`
    );
    return { line: lines.join('\n') };
  }
  lines.push(
    `${PIN} — model ${show(configured)} injected into this call from config.sparring_partner.model (.sterling/config.json), which named none. ` +
      `A model named on the call itself would have won instead; an already-running codex-reply thread keeps its opener's model.`
  );
  return { line: lines.join('\n'), model: configured };
}

/** True when the outgoing brief already cites this record by full id, id8 or
 *  slug. On the dispatch surface such a hazard is dropped before selection
 *  and spends no mark (a4912f91 point 1): the brief already carries it.
 *  Bounded on both sides so a longer slug or a longer hex run is not a
 *  citation; an id8 followed by '-' is the start of a full id and counts. */
function citedInBrief(record, text) {
  const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id8 = String(record.id ?? '').slice(0, 8);
  if (id8.length === 8 && new RegExp(`(?<![0-9a-f])${esc(id8)}(?![0-9a-f])`, 'i').test(text)) return true;
  return !!record.slug && new RegExp(`(?<![a-z0-9-])${esc(record.slug)}(?![a-z0-9-])`, 'i').test(text);
}

/**
 * H20's relevance carriage for one call, or null where H20 stays silent (too
 * little vocabulary, no candidate, nothing past the floors or the guard).
 * Returns { assembled, guard }: the caller emits assembled.text and, only after
 * it reached the model, marks assembled.emittedSubstance/emittedDiscovery on
 * `guard` and writes it.
 *   surface     'dispatch' | 'question' | 'consult'
 *   outgoing    outgoingProposalText(toolInput), non-empty
 *   toolInput   the call's arguments (prompt, or questions[])
 *   guardFor    () => the session guard; called only once a match survives
 *   pinLine     the codex model pin line, folded in as a leading pinned part
 *   overlap     the dispatch-overlap block, appended pinned
 *   host        'claude' | 'opencode' (HOST_TEXT)
 */
export function composeMechanismAxis(store, { root, outgoing, toolInput, surface, subagentType, guardFor, pinLine, overlap, host }) {
  if (!Object.hasOwn(HOST_TEXT, host)) throw new Error(`composeMechanismAxis: unknown host '${host}'`);
  const isQuestion = surface === 'question';
  const isConsult = surface === 'consult';
  const isDispatch = surface === 'dispatch';
  const terms = extractAxisTerms(outgoing, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) return null; // too little vocabulary to match on

  // STAGE 1 — narrow in the store. rank_terms genuinely FILTER (packages/store/
  // src/index.ts builds `... AND records_fts MATCH ?` with the terms OR-joined),
  // so an empty result here is a REAL zero, not a ranked top-N of everything.
  // That property is what lets this hook stay silent; without it the query would
  // return rows on every dispatch. NOTE the disclosed matched_filter count does
  // NOT reflect this narrowing — it counts the base filter only.
  // feature_article joined here too (consuming-project retro 2026-08-17-2111):
  // a subject a stored article fully answers was silently excluded before —
  // H20's carve was anti_pattern/decision only. axisNarrowText already covers
  // feature_article (slug + concept_family + title, board 39c3d762), so no
  // change to the shared axis matcher is needed — only widening what this
  // hook queries and does with the result.
  const candidates = [
    ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }),
    ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }),
    ...store.query({ types: ['feature_article'], rank_terms: terms, cap: 40 }),
    // PRIOR ANSWERS (board e7157d0b): a research_finding is an already-answered
    // question and a disconfirmed_hypothesis an already-refuted trail — the two
    // types a dispatch about to fan out on that question is about to RE-DERIVE
    // (measured: a 158k-token debugger re-deriving a recorded diagnosis; a
    // 6,142-file sweep on a question the store answered). Same floors as every
    // other candidate; axisNarrowText matches their question fields.
    ...store.query({ types: ['research_finding'], rank_terms: terms, cap: 40 }),
    ...store.query({ types: ['disconfirmed_hypothesis'], rank_terms: terms, cap: 40 }),
    // OPEN QUESTIONS (board a9be48f2) ride the SAME surface for the adjacent
    // question: not "was this answered?" but "is this ALREADY BEING
    // INVESTIGATED?". A fan-out onto a live open_question duplicates an
    // investigation instead of re-deriving a finished one — the same waste,
    // one step earlier. NOTE the deny rung is deliberately untouched: an
    // open_question is not a RULING, so it stays out of DENY_RULING_TYPES and
    // can never deny a user's question.
    ...store.query({ types: ['open_question'], rank_terms: terms, cap: 40 }),
  ];

  // MULTI-QUESTION CANDIDATE AUGMENTATION (post-commit follow-up, deny-once
  // recall floor): `terms` above is extractAxisTerms(outgoing, MAX_RANK_TERMS)
  // over the WHOLE combined form text, capped at 16 — a verbose sub-question
  // can crowd a terser, genuinely-ruled sub-question's own vocabulary out of
  // that shared top-16 before the STORE QUERY even runs, so the strict
  // classifier never sees the record: retrieval, not scoring, starved it.
  // Fix: for a multi-question form, ALSO query using each sub-question's OWN
  // top-16 extraction (independently capped — no sub-question's terms compete
  // with another's for a slot), restricted to the ruling types deny-once
  // scores, and merge the results into the SAME candidate pool (deduped by
  // id) before any early-exit or scoring runs. A single-question form's own
  // text already equals `outgoing`, so this only adds work when there is
  // more than one sub-question to protect.
  if (isQuestion && toolInput.questions.length > 1) {
    const seen = new Set(candidates.map((r) => r.id));
    for (const q of toolInput.questions) {
      const subTerms = extractAxisTerms(subQuestionText(q), MAX_RANK_TERMS);
      if (subTerms.length < AXIS_MIN_HITS) continue;
      for (const type of DENY_RULING_TYPES) {
        for (const r of store.query({ types: [type], rank_terms: subTerms, cap: 40 })) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            candidates.push(r);
          }
        }
      }
    }
  }
  if (!candidates.length) return null;

  // DENY-ONCE PRE-STEP removed (scale-down decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1): H20 no longer
  // denies (exit 2) a first-attempt AskUserQuestion -- it is advisory-only
  // now, falling straight through to the loose STAGE 2 audit below, which
  // still runs post-answer and warns non-blocking. `DENY_RULING_TYPES` and
  // `subQuestionText` remain imported from delivery.mjs for candidate
  // selection above; see the audit below for what H20 enforces.

  // STAGE 2 — require precision against the NARROW fields (trigger/title, not
  // rationale). Stage 1's index spans long discursive fields, so an FTS hit is
  // not yet a reason to interrupt anyone.
  // GENERIC-TERM FLOOR (board 648bb497, tuned on the measured 15/15 fire
  // rate in research_finding foreign_bf74c65f): AXIS_MIN_HITS alone is satisfied by
  // universal dev vocabulary in a store whose own subject IS this repo's
  // machinery, so a payload matched PURELY on generic terms goes silent here
  // — at least one matched term must actually discriminate.
  // RECORD-CENTRALITY FLOOR (board b655cb6f, third floor): the two floors above
  // ask whether the PROMPT is specific; this one asks whether the matched terms
  // are central to the RECORD — a record may not fire on words that appear only
  // in passing in its own trigger (the measured 2026-08-09 Blender case).
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(x.record, outgoing))
    .sort((a, b) => b.hits.length - a.hits.length);
  if (!scored.length) return null;

  // Share H19's session guard, keyed on the dispatching context. A record
  // already delivered by file-touch is already in this context — re-injecting it
  // at dispatch is the duplicate H19's own guard exists to prevent, and the
  // reverse holds too (what H20 delivers, H19 will not repeat).
  const guard = guardFor();
  // Conservative pre-filter: a candidate already shown at ALL this session
  // (either ledger) is dropped from consideration here — the per-type
  // render below (hazard=substance, everything else=discovery) is what
  // actually earns the mark, but re-showing something already fully known
  // is noise this stage need not risk (decision 92088a62's split still
  // holds: an owner shown here as a mere article POINTER is untouched by
  // this check's effect on H19, which guards SUBSTANCE independently).
  //
  // EXCEPTION, the CONSULT surface only: an anti_pattern there is judged by
  // `isSubstanceDelivered` alone, because a consult still renders hazards
  // whole and a pointer shown elsewhere must not suppress that (fix round on
  // decision 6300c1e8). The DISPATCH surface judges hazards by
  // `isKnownDelivered` (decision a4912f91 point 4): ranks 2-3 go out as
  // one-line pointers credited as discovery, and the substance ledger alone
  // would re-show them on every dispatch. Accepted cost, stated in that
  // ruling's NOT GUARANTEED: a hazard shown as a line (here or on the
  // question surface) is not shown whole later by H20 in this session.
  // Hazards the brief already cites are dropped first and spend no mark
  // (point 1).
  const briefText = String(toolInput?.prompt ?? '');
  const fresh = scored.filter((x) => {
    if (x.record.type !== 'anti_pattern') return !isKnownDelivered(guard, x.record);
    if (isDispatch && citedInBrief(x.record, briefText)) return false;
    return isConsult ? !isSubstanceDelivered(guard, x.record) : !isKnownDelivered(guard, x.record);
  });
  if (!fresh.length) return null;

  // NOT sliced to HAZARD_CAP here (fix-round MEDIUM 5): `hazardParts` below
  // already applies the SAME cap internally (cappedHazards) and, crucially,
  // DISCLOSES the omitted count — an early slice here would hand it an
  // already-≤3 list and the "N more hazard(s) NOT shown" line would never
  // fire even when the true match count was higher (decision 92088a62:
  // "at most 3 per package... with the omitted count stated").
  const hazards = fresh.filter((x) => x.record.type === 'anti_pattern');
  // NOT sliced to MAX_DECISIONS here either (board 6c0c848f item 3): an
  // early slice silently dropped the sixth match with no count and no
  // degraded flag. decisionPointerPart caps the rendered pointers AND the
  // credited identities at MAX_DECISIONS and discloses the rest.
  // Each decision carries its inbound supersedes edges (board 7e4850cf (c)),
  // so a record another one supersedes is never rendered as [standing].
  const decisions = fresh
    .filter((x) => x.record.type === 'decision')
    .map((x) => ({ ...x, record: withInboundSupersedes(store, x.record) }));
  // NOT sliced here — renderArticlePointers itself caps at ARTICLE_POINTER_CAP
  // and discloses the overflow, the same shape as renderHazards/
  // renderDecisionPointers; slicing early would lose the true matched count
  // the disclosure line needs.
  const articles = fresh.filter((x) => x.record.type === 'feature_article');
  // open_question shares this bucket (board a9be48f2) rather than minting a
  // fourth block: it answers the same reader question — "has someone been here
  // already?" — and a candidate type queried above but rendered by no bucket
  // would be dead weight (the terminal release just below would fire on an
  // open_question-only match, i.e. silence). Its own line label distinguishes
  // it from an ANSWER.
  const priorAnswers = fresh.filter(
    (x) => x.record.type === 'research_finding' || x.record.type === 'disconfirmed_hypothesis' || x.record.type === 'open_question'
  );
  if (!hazards.length && !decisions.length && !articles.length && !priorAnswers.length) return null;

  const matched = [...new Set(fresh.flatMap((x) => x.hits))].join(', ');
  // Name the covered CENTRAL terms too, so the reader can see at a glance that
  // the match is about the record's subject, not a passing mention.
  // BOUNDED (user ruling 2026-09-24, H20 decision crowd-out): the union of
  // every record's central terms ran to ~50 words and ~400 bytes of the
  // capped budget, crowding out the records themselves. The first few are
  // named and the rest counted, so the clause stays honest about its size.
  const centralCovered = boundedTermClause(fresh.flatMap((x) => recordCentralityHits(x.record, outgoing)));
  const matchedClause = `matched on: ${matched}; central to the record: ${centralCovered}`;
  // The header names the SURFACE, because the stakes differ and the reader should
  // feel which one they are on. A bad dispatch wastes agent work; a bad choice put
  // to the USER manufactures an authorised ruling that contradicts a real one, and
  // the store then holds both (board 4e6eb510). So the question wording is
  // deliberately the stronger of the two.
  const header = isQuestion
    ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you have just put a CHOICE TO THE USER. ` +
      `The store already governs this subject (${matchedClause}) and no file you touched would have surfaced it. ` +
      `THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask${HOST_TEXT[host].timing}. ` +
      `Before treating the answer as a ruling, check these records: a user's answer becomes authoritative, so if one of them ` +
      `already decides the question, the pick just manufactured a contradiction with a settled ruling — ` +
      `disclose the record to the user and re-affirm before acting on the answer.`
    : isConsult
    ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to CONSULT the sparring partner (codex). ` +
      `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
      `Path-scoped delivery cannot find these. Check them BEFORE the consult goes out — a bad premise sent to an external model is still a bad premise.`
    : // PreToolUse context arrives WITH the dispatch (timing note at the top
      // of this file), so the brief has already gone out: the act this
      // prompts is a correction (decision a4912f91 point 5).
      `STERLING MECHANISM-AXIS DELIVERY (H20) — you have just dispatched '${subagentType ?? 'an agent'}'; the brief has already gone out. ` +
      `The store holds records matching its SUBJECT (${matchedClause}), which no file you touched would surface. ` +
      `If one changes the brief's premise, correct the agent now ${HOST_TEXT[host].correction} — a fan-out multiplies a bad premise by N.`;
  // A subject match has no file_keys answer — overflow widening queries are
  // rank_terms-shaped (review finding 4's class, fixed at both call sites).
  const hazardTerms = [...new Set(hazards.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
  const decisionTerms = [...new Set(decisions.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
  const articleTerms = [...new Set(articles.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');

  const clip = (v, n = 160) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length <= n ? t : `${t.slice(0, n)}…`;
  };
  // QUESTION-SURFACE POINTERS (gap-hunt idea 13, decision
  // gap-hunt-2026-09-28-rulings). On AskUserQuestion the reader is weighing a
  // user's answer, not briefing a fan-out: measured 93 injections at a median
  // 2.8KB carrying the dispatch wording (finding
  // sterling-gap-hunt-ranked-ideas-september-2026). So prior answers and
  // decisions render ONE line each, `name (id8)` name first — the form a
  // record takes in front of a human (CLAUDE.md), and one the conductor can
  // quote to the user as-is when it re-affirms. The id8 resolves in
  // knowledge_get. Hazards and article pointers are unchanged here.
  const pointerHead = (r, name) => `  → ${clip(name, 80)} (${String(r.id).slice(0, 8)})`;
  const questionDecisionText = (records, remedy) => {
    const shown = records.slice(0, MAX_DECISIONS);
    return [
      `▸ DECISIONS for this subject (${records.length}) — one may already settle the question you just put; the user's pick must not silently contradict it. One line each, knowledge_get the id for the full ruling:`,
      ...shown.map((d) => {
        // The rejected options ride the SAME line (review MEDIUM-2): they are
        // exactly what a user's pick may collide with, so dropping them loses
        // the signal; a second line would break the one-line form.
        const rejected = (Array.isArray(d.alternatives_rejected) ? d.alternatives_rejected : [])
          .map((a) => (typeof a?.option === 'string' ? a.option.trim() : ''))
          .filter(Boolean)
          .join('; ');
        return (
          `${pointerHead(d, d.slug || d.title || d.statement)} — ${authorityMarker(d)}${clip(d.statement, DECISION_STATEMENT_CLIP)}${statusAnnotation(d)}` +
          (rejected ? ` — rejected: ${clip(rejected, DECISION_REJECTED_CLIP)}` : '')
        );
      }),
      ...(records.length > shown.length ? [`  … ${records.length - shown.length} more NOT shown (cap ${MAX_DECISIONS}) — ${remedy} for the full set`] : []),
    ].join('\n');
  };
  const questionPriorLine = (r) => {
    const stale = r.status === 'flagged_stale' ? ', FLAGGED STALE — re-verify before trusting' : '';
    // A slug names the record and the question follows; without one the
    // clipped question IS the name, so it is not repeated.
    const head = pointerHead(r, r.slug || r.question);
    const q = r.slug ? `: ${clip(r.question, 120)}` : '';
    if (r.type === 'research_finding') return `${head} — ANSWERED${q} (captured ${r.capture_date ?? '?'}${stale})`;
    if (r.type === 'open_question') {
      return r.resolution_status === 'closed'
        ? `${head} — ANSWERED (question closed into ${r.closed_into ?? 'an unnamed record'})${q}`
        : `${head} — ALREADY UNDER INVESTIGATION (open, no answer yet)${q}`;
    }
    return `${head} — REFUTED TRAIL${q} — rejected: ${clip(r.rejected_answer, 100)}`;
  };
  const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${decisionTerms}] cap:${decisions.length}`;
  // Hazards render WHOLE on the consult surface — a whole hazard IS
  // substance there (decision 92088a62 item 4). On the dispatch surface the
  // rank-1 hazard is whole and ranks 2-3 are one-line trigger pointers
  // ('lead' mode, decision a4912f91 — the third narrowing). On the
  // AskUserQuestion surface only, they
  // render as ONE-LINE POINTERS (decision question-surface-gets-hazards-
  // as-pointers, 6300c1e8 — the second narrowing of 301d8a0a's hazards-whole
  // rule, after 21e3637e's read-only-lane pointer): no edit happens while
  // the user answers a question, so the whole right-way text is not needed
  // there. `hazardParts`' 'question' mode is the SAME cap-and-disclose
  // renderer as 'whole'/'pointer' mode, never a second one built here.
  // Decisions stay pointer-only on both surfaces — discovery.
  const hazardBlocks = [
    ...hazardParts(hazards.map((x) => x.record), {
      remedy: `knowledge_query types:["anti_pattern"] rank_terms:[${hazardTerms}] cap:${hazards.length || 1}`,
      // Matched on the prompt's SUBJECT, not a file path (the H19 label).
      matchLabel: 'for this subject',
      // Dispatch: rank 1 whole, ranks 2-3 as trigger lines (a4912f91).
      mode: isQuestion ? 'question' : isDispatch ? 'lead' : 'whole',
    }),
  ];
  // The question surface keeps the part's identities and disclosure (the SAME
  // capped slice, anti-pattern one-identity-list-for-credit-and-disclosure…)
  // and swaps only its TEXT for one-line pointers (see questionDecisionText).
  const decisionBlocks = [
    ...(decisions.length
      ? [
          ((part) => (isQuestion ? { ...part, text: questionDecisionText(decisions.map((x) => x.record), decisionRemedy) } : part))(
            decisionPointerPart('(subject match)', decisions.map((x) => x.record), {
              widen: decisionRemedy, cap: MAX_DECISIONS, remedy: decisionRemedy, matchLabel: 'for this subject',
            })
          ),
        ]
      : []),
  ];
  // Only the SHOWN (capped) article pointers are eligible for a discovery
  // mark — same rule as cappedHazards: an article capped out of the payload
  // was never actually read by the recipient, so it stays eligible for a
  // later dispatch instead of being silently lost for the rest of the
  // session (board a470046d slice 1's rule, now enforced by the assembler
  // itself rather than a second hand-derived slice here).
  const shownArticles = articles.slice(0, ARTICLE_POINTER_CAP).map((x) => x.record);
  const articleBlocks = articles.length
    ? [
        renderArticlePointers(articles.map((x) => x.record), ARTICLE_POINTER_CAP, {
          remedy: `knowledge_query types:["feature_article"] rank_terms:[${articleTerms}] cap:${articles.length}`,
        }),
      ]
    : [];
  // PRIOR-ANSWER pointers (board e7157d0b): one line each — the question is the
  // subject, the clocks say how current the answer is, the id is the read. Shown
  // slice only marks delivered (cappedHazards rule).
  const PRIOR_ANSWER_CAP = 3;
  const shownPrior = priorAnswers.slice(0, PRIOR_ANSWER_CAP);
  const priorBlocks = priorAnswers.length
    ? [
        [
          isQuestion
            ? `▸ PRIOR ANSWERS in the store (${priorAnswers.length}) — the question you just put may already be answered, or already under investigation. If one answers it, tell the user before acting on their pick:`
            : `▸ PRIOR ANSWERS in the store (${priorAnswers.length}) — this dispatch may be about to RE-DERIVE one of these, or duplicate a question already under investigation. knowledge_get before fanning out:`,
          ...shownPrior.map((x) => {
            const r = x.record;
            if (isQuestion) return questionPriorLine(r);
            if (r.type === 'research_finding') {
              return `  → ANSWERED: ${clip(r.question)} (source ${r.source_date ?? '?'}, captured ${r.capture_date ?? '?'}${r.status === 'flagged_stale' ? ', FLAGGED STALE — re-verify before trusting' : ''}) · knowledge_get ${r.id}`;
            }
            // An OPEN question is not an answer: it names live hypotheses and
            // says the investigation exists, so the reader joins it (or cites
            // it) instead of starting a second one.
            if (r.type === 'open_question') {
              // A CLOSED question is not a live investigation: it already
              // closed into a research_finding, and THAT record is the prior
              // answer this block exists to surface — point the reader there
              // (review finding, 2026-08-31: the unbranched render said
              // 'closed, no answer yet', a self-contradicting false clause).
              if (r.resolution_status === 'closed') {
                return `  → ANSWERED (question closed into ${r.closed_into ?? 'an unnamed record'}): ${clip(r.question)} · knowledge_get ${r.id}`;
              }
              return `  → ALREADY UNDER INVESTIGATION (open, no answer yet): ${clip(r.question)} · knowledge_get ${r.id}`;
            }
            return `  → REFUTED TRAIL: ${clip(r.question)} — rejected: ${clip(r.rejected_answer, 100)} · knowledge_get ${r.id}`;
          }),
          ...(priorAnswers.length > PRIOR_ANSWER_CAP
            ? [`  (+${priorAnswers.length - PRIOR_ANSWER_CAP} more — knowledge_query types:["research_finding","disconfirmed_hypothesis","open_question"] rank_terms:[${[...new Set(priorAnswers.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',')}] cap:${priorAnswers.length})`]
            : []),
        ].join('\n'),
      ]
    : [];
  // RANKING (consuming-project retro 2026-08-17-2111, AC2): a QUESTION-SHAPED
  // prompt is the reader asking the store a fact, so the article pointer — the
  // direct answer — leads; a CHANGE-SHAPED prompt keeps today's hazard-first
  // order (stop the mistake before it recurs) with article pointers after. A
  // matched article is never withheld either way (AC3) — only its POSITION
  // in the payload moves.
  const promptIsQuestionShaped = isQuestionShapedPrompt(outgoing);
  const asPart = (text, widen, identities) => ({ kind: 'ordinary', contentClass: 'discovery', identities, text, pointer: `▸ held back by the delivery cap — ${widen}` });
  const articleParts = articleBlocks.map((t) =>
    asPart(
      t,
      `knowledge_query types:["feature_article"] rank_terms:[${articleTerms}] cap:${articles.length}`,
      shownArticles.map((a) => ({ identity: a.id, revision: recordRevision(a), name: a.slug || a.title }))
    )
  );
  const priorParts = priorBlocks.map((t) =>
    asPart(
      t,
      `knowledge_query types:["research_finding","disconfirmed_hypothesis","open_question"] rank_terms:[${[...new Set(priorAnswers.flatMap((x) => x.hits))].map((t2) => `"${t2}"`).join(',')}] cap:${priorAnswers.length}`,
      shownPrior.map((x) => ({ identity: x.record.id, revision: recordRevision(x.record), name: x.record.slug || clip(x.record.question, 60) }))
    )
  );
  // PER-DELIVERY TOTAL CAP (scale-down Slice 3c, assembleDelivery — decision
  // 92088a62's ONE ASSEMBLER): hazards are complete unbudgeted substance;
  // header, decisions, prior answers and article pointers are ordinary and
  // degrade under the cap. The codex model pin (if this is a consult) is
  // folded in as a LEADING, PINNED-but-CHARGED chrome part (item 6) so it
  // is charged on the FINAL composed context exactly like every other
  // caller, rather than prepended after capping the way `envelopeFor`
  // does for every OTHER call site in this file (none of which combine a
  // pin with a capped carriage the way this one does).
  const pinPart = pinLine ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: pinLine }] : [];
  const blocks = [
    // PINNED (P5): the header attributes the whole block to H20. Unpinned it
    // was placed AFTER whole hazards, which are exempt from the configured
    // cap and bound only by the transport ceiling, so three whole hazards at
    // the ceiling degraded it to nothing and the conductor got an
    // unattributed block. Pinned chrome is placed first; a hazard that then
    // no longer fits falls to its pointer (the existing held-back behaviour).
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: header },
    // A prior ANSWER outranks everything on a question-shaped prompt — it is
    // the direct "don't re-derive" signal; on a change-shaped prompt hazards
    // still lead (stop the mistake), answers ride with the article pointers.
    // Decisions come BEFORE hazards on a question-shaped prompt (user ruling
    // 2026-09-24): a standing decision can answer the question outright,
    // while a hazard only warns against a mistake the question is not yet
    // making. On a change-shaped prompt the order is unchanged.
    ...(promptIsQuestionShaped
      ? [...priorParts, ...articleParts, ...decisionBlocks, ...hazardBlocks]
      : [...hazardBlocks, ...decisionBlocks, ...priorParts, ...articleParts]),
    // DISPATCH OVERLAP, appended and PINNED: it is about this dispatch's
    // write territory, not a record, so the cap must not trade it away for
    // a pointer. Absent when there is no overlap, leaving the rest unchanged.
    ...(overlap ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: overlap }] : []),
  ];
  const assembled = assembleDelivery([...pinPart, ...blocks], resolveTotalCap(root));
  return { assembled, guard };
}

// ===========================================================================
// H23 — output-axis composition
// ===========================================================================

// Clip and cap, named per the brief (foreign_b266d6b7): matching runs over the first
// 16,000 chars of the stringified tool_response only, and at most
// OUTPUT_AXIS_POINTER_CAP pointer lines render per block regardless of how many
// records matched.
export const OUTPUT_AXIS_CLIP = 16_000;
/** ONE pointer line + the suppressed-count tail (was 3 + tail), per USER RULING
 *  h23-kept-raised-threshold-one-pointer-payload (284fc4b0, 2026-08-31). H23 is
 *  KEPT — the drop-premise broke on the pre-check, because one of its real saves
 *  is structurally output-only (no path event for H19, no dispatch/ask event for
 *  H20 at that moment) — but it is measured as the largest single advisory
 *  consumer on this repo (57 of 103 all-time fires) at a ~6% follow rate, so the
 *  volume comes down where it is cheapest. The remainder is still DISCLOSED, never
 *  silently dropped: capping to one line must not turn "3 more matched" into
 *  "that is all there is" (the same cap-and-disclose rule renderHazards keeps). */
export const OUTPUT_AXIS_POINTER_CAP = 1;

// THE OTHER HALF OF RULING 284fc4b0 — THE RAISED MATCH THRESHOLD — IS NOT BUILT
// HERE, and deliberately so: the mechanism the ruling names cannot express it.
// Measured 2026-08-31, before implementing, and reported rather than shipped:
//
//   (1) min_score thresholds `-bm25(records_fts)`, which is IDF-WEIGHTED and so
//       corpus-relative in MAGNITUDE, not just in ordering. A floor tuned on this
//       repo's store (records passing the three axis floors: 49 -> 18 for
//       CLAUDE.md at a floor of 12, with pure-noise prose silenced by 6) reduces
//       to "never fires" on a young or homogeneous store: probed at corpus sizes
//       1, 4 and 20 where every record matched, EVERY record scored below 0.05,
//       so ANY positive floor silenced all of them. Shipping a constant would
//       have implemented DROP — the option this very ruling rejected on the
//       evidence — on every consumer project, silently.
//   (2) The two portable floors already exported for H20's deny path do not
//       substitute. STRICT_MIN_HITS (>=3 distinct hits) barely cuts (49->44,
//       29->24, and the noise samples not at all); hasFullNarrowCentralityCoverage
//       over-cuts (4 of 5 real samples to zero).
//   (3) The reframing both measurements force: H23's noise is NOT weak matches.
//       On a repo whose own text IS the store's subject matter, the records it
//       surfaces score high on every axis measure available — this is intrinsic
//       high recall, not a mis-set threshold.
//
// Left to the conductor + an outside-family consult, per the ruling's own
// fallback clause (FOLD into H19/H20 if noise persists).

/** Title-only clip: this channel renders NO guidance/rationale/statement
 *  prose inline, ever — a pointer line names the record, it never restates
 *  it (pointer-not-substance, same rule as H19's Bash pointers). */
function clipTitle(text, cap = 140) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}


/** H23's READ SEAM gate: true when a Read of `rel` must stay silent here.
 *
 * READ SEAM OWNERSHIP GATE: silent on territory an owning feature_article or
 * repo-located reference_material already covers — H19 delivers substance
 * (or, for a reference doc, its own pointer) there. Mirrors
 * h19-knowledge-delivery's owner query EXACTLY (same types, same
 * working_tree filter, review finding 2) so the two channels agree on what
 * 'governed' means — a divergent predicate here would silently disagree
 * with H19 about the same path. Unresolvable/outside-repo paths fall through
 * to the match (no jurisdiction to gate on).
 *
 * PATH EXCLUSIONS mirror h19-knowledge-delivery.mjs:41-42 (review finding
 * 1): reading the store's own tree or its delivery queue is the highest
 * false-positive input this hook could face, and it is self-referential —
 * matching on .sterling/transient/delivery/pending.json's own content would
 * let this hook feed itself.
 */
export function outputAxisReadGated(store, rel, root) {
  if (rel === '.git' || rel?.startsWith('.git/')) return true;
  if (rel?.startsWith('.sterling/')) return true;
  if (rel) {
    const owners = store
      .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
      .filter((r) => !isForeignTree(r, root));
    if (owners.length) return true;
  }
  return false;
}

/**
 * H23's pointer block for consumed tool output `content`, or null where H23
 * stays silent. Returns { text, guard, seen, shown }: after the text reached the
 * model the caller sets guard.output_axis = [...seen, ...shown ids] and writes it.
 */
export function composeOutputAxis(store, { content, guardFor }) {
  const clipped = content.slice(0, OUTPUT_AXIS_CLIP);

  const terms = extractAxisTerms(clipped, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) return null; // too little vocabulary to match on

  // STAGE 1 — narrow in the store. anti_pattern ONLY (ruling 5564361d v2):
  // decisions reach the model through H20 and explicit store lookups.
  const candidates = store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 });
  if (!candidates.length) return null;

  // STAGE 2 — the same three floors H20 proved: enough distinct hits, at
  // least one discriminating (not universal dev vocabulary), and the hits
  // must be central to the RECORD's own narrow fields, not a passing mention.
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(x.record, clipped))
    .sort((a, b) => b.hits.length - a.hits.length);
  if (!scored.length) return null;

  // OWN DEDUP NAMESPACE — guard.output_axis, never guard.records/pointer_files.
  const guard = guardFor();
  const seen = new Set(guard.output_axis ?? []);
  const fresh = scored.filter((x) => !seen.has(x.record.id));
  if (!fresh.length) return null; // already pointed at this session, on this axis

  // Every candidate is an anti_pattern, so the remainder counts hazards only.
  const shown = fresh.slice(0, OUTPUT_AXIS_POINTER_CAP);
  const remainder = fresh.length - shown.length;

  // PER-RECORD LINES, keyed by id (fixer F1): the drain rebuilds this block from
  // the recipe, replaying a still-live record's line verbatim and REPLACING a
  // superseded/missing one with its stub, so the payload is assembled from the
  // same {header, lines, tail} decomposition the recipe carries. `header` and the
  // '(+N more matched)' tail interpolate no record field, so they replay verbatim.
  const header =
    'ADVISORY (not an error) — STERLING OUTPUT-AXIS DELIVERY (H23): the tool output you just consumed matches a recorded hazard. ' +
    'Pointer only, never a block: follow the read below before assuming the answer, never treat this line as the ruling itself.';
  const pointerLines = shown.map((x) => {
    const r = x.record;
    return { id: r.id, hazard: true, line: `  → HAZARD anti_pattern '${clipTitle(r.title)}' · knowledge_get ${r.id}` };
  });
  const tail = remainder > 0 ? `  (+${remainder} more matched)` : '';

  return { text: joinPointerBlock({ header, lines: pointerLines, tail }), guard, seen, shown };
}
