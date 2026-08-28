// H20 — mechanism-axis delivery at DISPATCH (board 62806222; concept family
// knowledge-delivery, member 7). Registered at PreToolUse on TWO matcher entries:
// Task|Agent (the dispatch surface) and AskUserQuestion (the question surface,
// decision f5638a84). Every delivery member elsewhere NEVER blocks; AC7 still
// holds for the dispatch/consult surfaces here. The AskUserQuestion surface is
// the ONE exception (decision 68332e4b, 2026-08-24): a first-attempt question
// whose subject STRONGLY matches a store RULING (decision/anti_pattern) is
// DENIED (exit 2) before it ever reaches the user — see the DENY-ONCE block
// below and its plumbing in lib/delivery.mjs. Everywhere else this file still
// never exits 2.
//
// TIMING, probed live 2026-08-11 (research_finding 63a9646d-2f0d-406e-8a36-9e95d0b11dbd):
// PreToolUse additionalContext reaches the model WITH the tool result — and
// structurally, a PreToolUse hook fires only after the model has already emitted
// the call. On the dispatch surface that is still pre-flight enough to matter
// (the conductor reads it before acting on the subagent's report); on the
// question surface it lands after the user has ANSWERED, so the question payload
// is a POST-ANSWER AUDIT, never a pre-ask gate — the header wording says so.
//
// WHY IT EXISTS, and why no H19 improvement could have covered it: H19 joins the
// store on the FILE PATH being touched. An anti_pattern is filed against the file
// where the incident HAPPENED, not against every file where the mistake can
// RECUR — so path-scoped delivery is structurally blind to exactly the reusable
// lesson it would be most valuable to receive. Two measured cases:
//   * a conductor shipped a fix whose design was described VERBATIM by a stored
//     anti_pattern's trigger ("a node connects a signal in _ready() but finishes
//     initialising LATER"), filed against a file it never touched;
//   * a stored ruling that no breach countdown is EVER shown was violated in a
//     brief, because the countdown lived in NO file — it was a SUBJECT, not
//     territory.
// (Both records live in the CONSUMING project's store, so their ids are
// deliberately not cited here — they resolve to nothing in this one, which is
// what check-record-citations exists to catch. Provenance is in decision
// 35952525-07fb-46b6-a84a-fb7d6f748f07.)
// Both were caught by a coder refusing the work order, one step downstream of
// N agents already reasoning from the premise.
//
// WHY THE DISPATCH SEAM: a fan-out multiplies one bad premise by N, so "I am
// about to brief" is the last cheap moment to intervene. Both consuming-project
// documents name it independently. And PreToolUse on Task is PROVEN to deliver
// additionalContext to the DISPATCHING agent (research_finding e14dcf9a, issue
// #39814) — which is the right destination here, because the conductor writing
// the prompt is who needs stopping. (That same finding is why this is NOT the
// seam for H19 AC5 dispatch staging: for staging knowledge INTO the subagent,
// this destination is wrong. Different mechanism, different board item.)
//
// WHY IT DOES NOT BECOME NOISE (the P1 half, and the reason board 7bbec3bd
// exists): it is SILENT unless a real match survives both stages. A hook that
// fires on every dispatch would train the reader to skip it, which is precisely
// the H10 file-count failure this must not repeat. Measured 2026-08-04
// (board 648bb497, research_finding bf74c65f): on THIS repo it was firing
// 15/15, dominated by universal dev vocabulary that AXIS_MIN_HITS alone could
// not exclude — stage 2 now also requires hasDiscriminatingHit, a third floor
// that a match matching ONLY generic terms (test, check, file, ...) cannot
// clear on its own.
import { readStdin, allow, deny, warnNonBlocking, openStore } from './lib/common.mjs';
import { MAX_RANK_TERMS } from '@sterling/store';
import {
  guardPath,
  readGuard,
  writeGuard,
  extractAxisTerms,
  axisHits,
  outgoingProposalText,
  renderHazards,
  renderDecisionPointers,
  renderArticlePointers,
  ARTICLE_POINTER_CAP,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  recordCentralityHits,
  HAZARD_CAP,
  isDelivered,
  markDelivered,
  DENY_RULING_TYPES,
  STRICT_MIN_HITS,
  STRICT_MIN_RECORD_TERMS,
  DELTA_MIN_NEW_TERMS,
  subQuestionText,
  denyLedgerPath,
  readDenyLedger,
  writeDenyLedger,
  denyIntentKey,
  idCitedIn,
  renderDenyOnceMessage,
} from './lib/delivery.mjs';

// Injection ceilings. Deliberately tighter than H19's file-touch payload: a
// keyword match is WEAKER evidence of relevance than an explicit file_keys
// join, so it earns less of the reader's attention. Also note the separate
// finding that config.delivery.payload_char_cap is applied per FIELD and does
// not bound a payload at all — so these counts are the real bound here.
// The hazard ceiling is the ONE shared definition (HAZARD_CAP, invariant 1):
// since board a470046d slice 1, H19's path-scoped hazard block caps at the
// same count, so the two channels share the bound.
const MAX_DECISIONS = 5;
const NARROW_CLIP = 700;

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

const input = readStdin();
// TWO SURFACES, ONE MECHANISM (board 62806222 + board 4e6eb510). Task/Agent
// carries the brief in tool_input.prompt; AskUserQuestion has no prompt field at
// all and carries its text in questions[]/options[]. outgoingProposalText knows
// both and returns '' for anything else, so an unrecognised tool is inert rather
// than half-scanned. Registering the matcher WITHOUT this would have produced a
// hook that never fires and a probe that proves nothing, since silence is this
// hook's default state.
const outgoing = outgoingProposalText(input.tool_input);
if (!outgoing) allow(); // nothing readable on this surface
const isQuestion = Array.isArray(input.tool_input?.questions);
const isConsult = typeof input.tool_name === 'string' && input.tool_name.startsWith('mcp__codex__');

const store = openStore(input.cwd);
if (!store) allow(); // not a Sterling project — no ceremony (P1)

try {
  const terms = extractAxisTerms(outgoing, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) allow(); // too little vocabulary to match on

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
  if (isQuestion && input.tool_input.questions.length > 1) {
    const seen = new Set(candidates.map((r) => r.id));
    for (const q of input.tool_input.questions) {
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
  if (!candidates.length) allow();

  // DENY-ONCE PRE-STEP (decision 68332e4b) — AskUserQuestion ONLY. Runs over the
  // SAME stage-1 candidate pool built above with the canonical rank_terms
  // extraction (amendment 4: one pool, two thresholds — loose STAGE 2 below is
  // unchanged and keeps driving the existing post-answer audit; this block adds
  // a STRICTER floor whose only job is deny eligibility). Scored PER
  // SUB-QUESTION (amendment 2): a form's outgoing text is the concatenation of
  // every sub-question, so scoring only the whole blob would let one ruled
  // sub-question hide behind an unrelated one, or a false match on the
  // combined text deny an otherwise-clean single question.
  if (isQuestion) {
    const questions = input.tool_input.questions;
    const perQuestion = questions.map((q, index) => {
      const subText = subQuestionText(q);
      const subTerms = extractAxisTerms(subText, MAX_RANK_TERMS);
      const strict = candidates
        .filter((r) => DENY_RULING_TYPES.includes(r.type))
        .map((r) => ({ record: r, hits: axisHits(r, subTerms) }))
        .filter(
          (x) =>
            x.hits.length >= STRICT_MIN_HITS &&
            hasDiscriminatingHit(x.hits) &&
            hasRecordCentralityHit(x.record, subText, { minTerms: STRICT_MIN_RECORD_TERMS })
        );
      // Truthy fallback, not nullish (fix 3, dual-review finding): header:''
      // is falsy but not nullish, so `??` let an empty-string header win over
      // the question text — `||` falls through to the question whenever the
      // header is absent OR empty, while staying undefined-safe via `?.`.
      return { index, label: q?.header || q?.question, subText, subTerms, strict };
    });

    const ledgerPath = denyLedgerPath(input.cwd, input.agent_id);
    const ledger = readDenyLedger(ledgerPath);
    const unresolved = [];
    const openIndexes = new Set();

    for (const p of perQuestion) {
      // OVERRIDE CHECK FIRST, independent of whether THIS attempt still
      // strict-matches anything on its own (decision 68332e4b, amendment 1).
      // A valid override's own explanatory text legitimately drifts away from
      // full centrality coverage once it states the delta — e.g. "for a
      // debug-only diagnostic overlay" pulls the text off the ruling's own
      // vocabulary on purpose — so recognition rides on CITING a
      // PREVIOUSLY-DENIED ruling id (from the ledger) plus a delta, never on
      // re-clearing the strict floor a second time. Checked against every
      // ledger entry, not just this attempt's own strict matches, so an
      // override is recognized even when the retry no longer strict-matches
      // at all.
      // When THIS attempt still strict-matches something, a cited entry only
      // counts as overriding IT if the cited entry's recordIds INTERSECT this
      // attempt's own strict-matched ids — otherwise citing an unrelated prior
      // denial (R1) would let a live, never-denied match (R2) sail through just
      // by pasting R1's id and adding filler words (reviewer finding).
      const currentStrictIds = new Set(p.strict.map((x) => x.record.id));
      let overridden = null;
      for (const [key, entry] of Object.entries(ledger.entries)) {
        if (!entry.recordIds.some((id) => idCitedIn(p.subText, id))) continue;
        if (p.strict.length > 0 && !entry.recordIds.some((id) => currentStrictIds.has(id))) continue;
        const newTerms = p.subTerms.filter((t) => !entry.terms.includes(t));
        if (newTerms.length >= DELTA_MIN_NEW_TERMS) {
          overridden = { key, recordIds: entry.recordIds };
          break;
        }
      }
      if (overridden) {
        // OVERRIDES LOGGED (amendment 3) — written to the SAME ledger file,
        // BEFORE writeDenyLedger below runs and BEFORE any allow/deny exit, so
        // a crash after this point fails toward an extra log line, never an
        // unlogged override.
        ledger.overrides.push({ key: overridden.key, recordIds: overridden.recordIds, at: new Date().toISOString() });
        openIndexes.add(p.index);
        continue;
      }

      if (p.strict.length === 0) {
        openIndexes.add(p.index); // never matched anything this attempt
        continue;
      }

      // Keyed on the matched RECORD ids, never the raw prompt text (decision
      // 68332e4b) — the same underlying question about the same ruling(s)
      // still matches the same records across a paraphrase, so it resolves to
      // the SAME key instead of dodging as a "fresh" first attempt (see
      // denyIntentKey for why the prompt's own hit terms are NOT part of the
      // key).
      const recordIds = [...new Set(p.strict.map((x) => x.record.id))];
      const key = denyIntentKey(recordIds);
      // First attempt under this key (or a retry that never validly cited
      // it): (re)seed the ledger entry so a LATER retry can be measured
      // against THIS attempt's terms, never silently overwritten.
      if (!ledger.entries[key]) ledger.entries[key] = { terms: p.subTerms, recordIds };
      unresolved.push({ index: p.index, label: p.label, decisions: p.strict.map((x) => x.record) });
    }

    writeDenyLedger(ledgerPath, ledger);
    // ANY strongly-matched, non-overridden sub-question denies the WHOLE form
    // (amendment 2). `open` names every sub-question that is NOT still
    // unresolved — never matched anything, OR was matched but validly
    // overridden — so a sub-question that was ruled but legitimately
    // overridden is not dropped from BOTH lists; it belongs in "open" (nothing
    // further is owed on it) exactly as much as a never-matched one.
    if (unresolved.length) {
      const open = perQuestion.filter((p) => openIndexes.has(p.index)).map((p) => ({ index: p.index, label: p.label }));
      deny(renderDenyOnceMessage(unresolved, questions.length, open));
    }
    // Every ruled sub-question was validly overridden (or never ruled at
    // all) — fall through to the unchanged loose audit below (the override
    // does not silence the audit; it only clears the pre-step gate).
  }

  // STAGE 2 — require precision against the NARROW fields (trigger/title, not
  // rationale). Stage 1's index spans long discursive fields, so an FTS hit is
  // not yet a reason to interrupt anyone.
  // GENERIC-TERM FLOOR (board 648bb497, tuned on the measured 15/15 fire
  // rate in research_finding bf74c65f): AXIS_MIN_HITS alone is satisfied by
  // universal dev vocabulary in a store whose own subject IS this repo's
  // machinery, so a payload matched PURELY on generic terms goes silent here
  // — at least one matched term must actually discriminate.
  // RECORD-CENTRALITY FLOOR (board b655cb6f, third floor): the two floors above
  // ask whether the PROMPT is specific; this one asks whether the matched terms
  // are central to the RECORD — a record may not fire on words that appear only
  // in passing in its own trigger (the measured 2026-08-09 Blender case).
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits) && hasRecordCentralityHit(x.record, outgoing))
    .sort((a, b) => b.hits.length - a.hits.length);
  if (!scored.length) allow();

  // Share H19's session guard, keyed on the dispatching context. A record
  // already delivered by file-touch is already in this context — re-injecting it
  // at dispatch is the duplicate H19's own guard exists to prevent, and the
  // reverse holds too (what H20 delivers, H19 will not repeat).
  const gPath = guardPath(input.cwd, input.agent_id);
  const guard = readGuard(gPath);
  const fresh = scored.filter((x) => !isDelivered(guard, x.record));
  if (!fresh.length) allow();

  const hazards = fresh.filter((x) => x.record.type === 'anti_pattern').slice(0, HAZARD_CAP);
  const decisions = fresh.filter((x) => x.record.type === 'decision').slice(0, MAX_DECISIONS);
  // NOT sliced here — renderArticlePointers itself caps at ARTICLE_POINTER_CAP
  // and discloses the overflow, the same shape as renderHazards/
  // renderDecisionPointers; slicing early would lose the true matched count
  // the disclosure line needs.
  const articles = fresh.filter((x) => x.record.type === 'feature_article');
  const priorAnswers = fresh.filter((x) => x.record.type === 'research_finding' || x.record.type === 'disconfirmed_hypothesis');
  if (!hazards.length && !decisions.length && !articles.length && !priorAnswers.length) allow();

  const matched = [...new Set(fresh.flatMap((x) => x.hits))].join(', ');
  // Name the covered CENTRAL terms too, so the reader can see at a glance that
  // the match is about the record's subject, not a passing mention.
  const centralCovered = [...new Set(fresh.flatMap((x) => recordCentralityHits(x.record, outgoing)))].join(', ');
  const matchedClause = `matched on: ${matched}; central to the record: ${centralCovered}`;
  // The header names the SURFACE, because the stakes differ and the reader should
  // feel which one they are on. A bad dispatch wastes agent work; a bad choice put
  // to the USER manufactures an authorised ruling that contradicts a real one, and
  // the store then holds both (board 4e6eb510). So the question wording is
  // deliberately the stronger of the two.
  const header = isQuestion
    ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you have just put a CHOICE TO THE USER. ` +
      `The store already governs this subject (${matchedClause}) and no file you touched would have surfaced it. ` +
      `THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask (probed 2026-08-11). ` +
      `Before treating the answer as a ruling, check these records: a user's answer becomes authoritative, so if one of them ` +
      `already decides the question, the pick just manufactured a contradiction with a settled ruling — ` +
      `disclose the record to the user and re-affirm before acting on the answer.`
    : isConsult
    ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to CONSULT the sparring partner (codex). ` +
      `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
      `Path-scoped delivery cannot find these. Check them BEFORE the consult goes out — a bad premise sent to an external model is still a bad premise.`
    : `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to dispatch '${input.tool_input?.subagent_type ?? 'an agent'}'. ` +
      `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
      `Path-scoped delivery cannot find these. Check them BEFORE the brief goes out — a fan-out multiplies a bad premise by N.`;
  // A subject match has no file_keys answer — overflow widening queries are
  // rank_terms-shaped (review finding 4's class, fixed at both call sites).
  const hazardTerms = [...new Set(hazards.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
  const decisionTerms = [...new Set(decisions.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');
  const articleTerms = [...new Set(articles.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');

  const hazardDecisionBlocks = [
    ...renderHazards(hazards.map((x) => x.record), NARROW_CLIP, {
      remedy: `knowledge_query types:["anti_pattern"] rank_terms:[${hazardTerms}] cap:${hazards.length || 1}`,
    }),
    ...(decisions.length
      ? [
          renderDecisionPointers('(subject match)', decisions.map((x) => x.record), MAX_DECISIONS, {
            remedy: `knowledge_query types:["decision"] rank_terms:[${decisionTerms}] cap:${decisions.length}`,
          }),
        ]
      : []),
  ];
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
  const clip = (v, n = 160) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length <= n ? t : `${t.slice(0, n)}…`;
  };
  const shownPrior = priorAnswers.slice(0, PRIOR_ANSWER_CAP);
  const priorBlocks = priorAnswers.length
    ? [
        [
          `▸ PRIOR ANSWERS in the store (${priorAnswers.length}) — this dispatch may be about to RE-DERIVE one of these. knowledge_get before fanning out:`,
          ...shownPrior.map((x) => {
            const r = x.record;
            return r.type === 'research_finding'
              ? `  → ANSWERED: ${clip(r.question)} (source ${r.source_date ?? '?'}, captured ${r.capture_date ?? '?'}${r.status === 'flagged_stale' ? ', FLAGGED STALE — re-verify before trusting' : ''}) · knowledge_get ${r.id}`
              : `  → REFUTED TRAIL: ${clip(r.question)} — rejected: ${clip(r.rejected_answer, 100)} · knowledge_get ${r.id}`;
          }),
          ...(priorAnswers.length > PRIOR_ANSWER_CAP
            ? [`  (+${priorAnswers.length - PRIOR_ANSWER_CAP} more — knowledge_query types:["research_finding","disconfirmed_hypothesis"] rank_terms:[${[...new Set(priorAnswers.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',')}] cap:${priorAnswers.length})`]
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
  const blocks = [
    header,
    // A prior ANSWER outranks everything on a question-shaped prompt — it is
    // the direct "don't re-derive" signal; on a change-shaped prompt hazards
    // still lead (stop the mistake), answers ride with the article pointers.
    ...(promptIsQuestionShaped
      ? [...priorBlocks, ...articleBlocks, ...hazardDecisionBlocks]
      : [...hazardDecisionBlocks, ...priorBlocks, ...articleBlocks]),
  ];

  // SIDE EFFECT FIRST, GUARD SECOND — same rule as H19 (council wf_db9a59aa-0af):
  // the guard is what makes delivery once-per-session, so writing it before the
  // delivery lands turns any failure into permanent silent loss with no retry.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: blocks.join('\n\n') },
    })
  );
  // Only the SHOWN (capped) article pointers are marked delivered — same rule
  // as cappedHazards: an article capped out of the payload was never actually
  // read by the recipient, so it stays eligible for a later dispatch instead
  // of being silently lost for the rest of the session.
  const shownArticles = articles.slice(0, ARTICLE_POINTER_CAP).map((x) => x.record);
  markDelivered(guard, [...hazards.map((x) => x.record), ...decisions.map((x) => x.record), ...shownArticles, ...shownPrior.map((x) => x.record)]);
  writeGuard(gPath, guard);
  allow();
} catch (e) {
  // Delivery is an aid, never a gate: loud but NON-blocking (P5 without AC7 harm).
  warnNonBlocking(`H20: mechanism-axis delivery failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
