// H19 — dispatch staging (AC5; board 7b01f139-7341-4d3c-9991-6c1c27ceafc7,
// probe evidence 35a89a0f-120e-4b18-97f9-63dc82016c74). SubagentStart hook (no
// matcher — every agent type): stages the SAME knowledge-delivery payload
// h19-knowledge-delivery.mjs computes for a governed touch, but for the
// territory named in the DISPATCH PROMPT rather than a file the spawned agent
// has touched yet. Closes the gap the board item names: N agents can start
// reasoning from one stale premise before any of their own Read/Edit ever
// fires the file-touch hook.
//
// LIVE-PROBED, not inferred (2026-08-04, research_finding foreign_35a89a0f):
// SubagentStart's hookSpecificOutput.additionalContext lands in the SPAWNED
// subagent's own context (not the parent's), on the WSL CLI headless surface,
// CC 2.1.220. Its stdin carries session_id, transcript_path, cwd, prompt_id,
// agent_id, agent_type, hook_event_name — THERE IS NO PROMPT FIELD. The
// dispatch prompt is therefore recovered through the dispatch-state machine
// (scripts/lib/dispatch-register.mjs's resolveDispatchStart) — NOT the parent
// transcript, which is measurably LAGGED at this event and cannot attribute a
// prompt to a spawn safely by any ordering trick (decision
// dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-
// replaces-transcript-attribution, superseding the earlier transcript-tail
// recovery this file used).
//
// Never a gate (AC7 precedent): internal failure degrades to no output, exit 1
// non-blocking (P5) — dispatch staging is an aid layered on top of the file-
// touch delivery, never a second place that can deny a spawn.
//
// H28 FOLD (2026-08-30, decision foreign_04982f45): h28-return-contract.mjs absorbed
// here — same SubagentStart event, same advisory/fail-open posture (both
// warnNonBlocking). EXEMPT_AGENT_TYPES and RETURN_CONTRACT below are its
// unchanged substance; the return contract is injected on EVERY dispatch
// regardless of the payload path above (ALWAYS inject, no dedup — the text
// is self-subordinating, so repeated injection is harmless). `finish()`
// combines the knowledge-delivery payload (may be empty) with the return
// contract into ONE additionalContext emission so neither clobbers the
// other (mirrors H25's two-advisory merge), and both arms stay inside this
// file's existing try/warnNonBlocking shape — the fold does not change h19's
// own failure posture.
import { readStdin, allow, warnNonBlocking, exitAfterWrite, openStore, loadConfig, repoRel } from './lib/common.mjs';
// Plan-lock primitives — ONE implementation, shared with h31-plan-lock.mjs,
// h1-session-start.mjs and scripts/plan-lock.mjs.
import { readLock as readPlanLock, sanitizeForContext, sterlingDirOf } from './lib/plan-lock.mjs';
// Path extraction lives in lib/dispatch-prompt.mjs — one mechanism, imported
// never reimplemented (decision foreign_f5638a84). Prompt RECOVERY no longer reads the
// parent transcript (decision dispatch-state-machine-pre-slot-post-binding-
// locked-start-resolution-replaces-transcript-attribution): this hook resolves
// its own dispatch's prompt through the dispatch-state machine instead.
import { extractPathCandidates } from './lib/dispatch-prompt.mjs';
import { resolveDispatchStart } from '../lib/dispatch-register.mjs';
import { MAX_RANK_TERMS } from '@sterling/store';
import {
  guardPath,
  readGuard,
  writeGuard,
  renderArticle,
  isOwnerDiscoveryOnly,
  renderReference,
  renderDecisionPointers,
  rankFileDecisionPointers,
  payloadHeaderLine,
  extractAxisTerms,
  axisHits,
  AXIS_MIN_HITS,
  hasDiscriminatingHit,
  AXIS_MIN_DISCRIMINATING_HITS,
  hasRecordCentralityHit,
  recordCentralityHits,
  stripReviewTerritoryLine,
  assembleDelivery,
  hazardParts,
  recordRevision,
  resolveTotalCap,
  isSubstanceDelivered,
  isDiscoveryDelivered,
  markSubstanceDelivered,
  markDiscoveryDelivered,
  ownerPointer,
  ownerSuffix,
  decisionBlockPointer,
} from './lib/delivery.mjs';

// Subject-channel decision ceiling — mirrors H20's MAX_DECISIONS: a keyword
// match is weaker evidence than a file_keys join, so it earns less attention.
const SUBJECT_MAX_DECISIONS = 5;

// True platform-internal agents whose output configures the harness rather
// than being a human-facing work product (h28 fold) — kept deliberately
// NARROW: only agents whose report a return contract would be noise for.
const EXEMPT_AGENT_TYPES = new Set(['statusline-setup']);

// STATIC and SELF-SUBORDINATING (h28 fold) — the first clause cedes
// precedence to any explicit brief/role output contract, so combining it
// with the knowledge payload above is always harmless.
const RETURN_CONTRACT =
  'STERLING DEFAULT RETURN CONTRACT — Explicit output requirements in your ' +
  'agent definition or dispatch brief take precedence. Otherwise, return the ' +
  'conclusion, not a work transcript: maximum ~250 words; no pasted diffs, raw ' +
  'logs, or step-by-step narration. Report only the outcome, decisive evidence, ' +
  'relevant files/tests, and unresolved risks.';

const input = readStdin();

// TDD POSTURE (decision foreign_752caf98
// tdd-and-mutation-toggles-in-system-tab, board 7e7279c4 slice 3C): implementor
// dispatches (the roster's one writing role) get the SAME live per-project posture line H1
// injects at SessionStart — read fresh here via loadConfig rather than
// relying on a copy baked into the agent template at install time, so a
// toggle flipped mid-session still reaches a freshly spawned agent's own
// context (agent templates are NOT edited for this — no sync-agents needed).
// Guarded like every other config read in this file: a malformed config
// costs only this line, never the knowledge payload or the return contract.
// Only an explicit `false` reads as OFF — absent/undefined is the documented
// schema default (true, decision foreign_752caf98), never invented.
//
// THREE-STATE TREATMENT, mirroring h1-session-start.mjs's configUnreadable
// guard exactly (review 2026-09-06 — H19 reproduced the same false-posture
// defect H1 already closed there). loadConfig can THROW (malformed JSON) or
// return a value that PARSES but is not a usable object (`[]`, `true`,
// `false`, `0`, `""`, `"x"`, `5`) — every `cfg?.x?.y` read below optional-
// chains to undefined for either shape, which would otherwise render a
// confident "ON" for a config that was never actually read. Both shapes
// fold into one `cfgUnusable` flag and render the SAME UNKNOWN wording H1
// uses, rather than the old silent catch: an implementor seeing no posture line
// while the session banner (H1) says UNKNOWN is a divergence someone would
// have to notice and track down later, so this deliberately matches H1
// instead of staying silent.
// `null` (an ABSENT file) is excluded from the shape guard, same as H1: an
// absent config legitimately means the documented default.
// THE COMPARISON MUST STAY A NULL TEST, NOT A TRUTHINESS TEST — `if (cfg &&
// ...)` would wrongly swallow `false`, `0` and `""` back into a confident
// ON reading (same hazard named in H1's comment).
const TDD_POSTURE_AGENT_TYPES = new Set(['implementor']);
let tddPostureLine = '';
try {
  if (TDD_POSTURE_AGENT_TYPES.has(input.agent_type)) {
    let cfg = null;
    let cfgUnusable = false;
    try {
      cfg = loadConfig(input.cwd);
    } catch {
      cfg = null;
      cfgUnusable = true;
    }
    if (cfg !== null && (typeof cfg !== 'object' || Array.isArray(cfg))) {
      cfgUnusable = true;
    }
    if (cfgUnusable) {
      tddPostureLine =
        'TDD posture: UNKNOWN — the project config could not be read, so ' +
        'config.tdd.enabled could not be determined. ' +
        'This is NOT the default posture: repair the config, or state your posture explicitly.';
    } else {
      const tddOn = cfg?.tdd?.enabled !== false;
      tddPostureLine =
        `TDD posture: tests-first ${tddOn ? 'ON' : 'OFF'} ` +
        `(config.tdd.enabled — TUI System tab; explicit asks still work)`;
    }
  }
} catch {
  // fail-open — a malformed config costs only this line, never h19's other staging
}

// ACTIVE PLAN (decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`):
// one bounded line telling a WRITING lane which approved plan its slice belongs
// to. Scoped to the implementor (the writing role) — a researcher, scout or
// reviewer judges against the store and the brief, not the plan's ordering, so
// the line would be noise there. Omitted entirely with no lock (P1, no ceremony). Bounded here as
// well as at the write, because the lock file is not necessarily H31's.
const PLAN_LINE_AGENT_TYPES = new Set(['implementor']);
const PLAN_TITLE_MAX = 120;
const PLAN_PATH_MAX = 320;
let activePlanLine = '';
// UNATTRIBUTABLE-START DISCLOSURE (decision dispatch-state-machine-pre-slot-
// post-binding-locked-start-resolution-replaces-transcript-attribution §6):
// set inside main() once resolveDispatchStart's verdict is known, and folded
// into combinedContext() beside the return contract — never a transcript
// fallback, exactly one line, on 'unattributable' only ('resume' emits
// nothing extra).
let unattributableLine = '';
try {
  if (PLAN_LINE_AGENT_TYPES.has(input.agent_type)) {
    // The shared VALIDATING reader: a record that is JSON but not a lock stages
    // no line at all, rather than a confident line built from junk fields.
    const read = readPlanLock(sterlingDirOf(input.cwd));
    if (read.lock) {
      // RENDERED copy — sanitised and bounded tighter than the store bound,
      // because this rides inside another agent's context window.
      const title = sanitizeForContext(read.lock.title, PLAN_TITLE_MAX);
      const path = sanitizeForContext(read.lock.plan_path, PLAN_PATH_MAX);
      if (title || path) {
        activePlanLine = `ACTIVE PLAN: ${title || '(untitled plan)'} (${path || 'no path recorded'}) — this lane belongs to one of its slices; the plan governs the objective's scope and ordering, standing store decisions still govern mechanisms.`;
      }
    }
  }
} catch {
  // fail-open — a malformed lock costs only this line, never h19's other staging
}

// THE ONE-ENVELOPE RULE IS THE HELPER'S NOW (decision hook-stdout-exit-after-
// write-callback-bound-exit-deny-stays-synchronous): exitAfterWrite suppresses a
// second non-empty stdout payload and DISCLOSES the drop on stderr, so the local
// `emitted` flag this file used to carry is gone — one mechanism, not two that
// can disagree. The same call is also what makes the exit wait for the stream to
// take the payload, so a large staging envelope is never truncated by the exit.

// Combines PAYLOAD (the knowledge-delivery text, may be '') with the return
// contract (h28 fold — omitted only for EXEMPT_AGENT_TYPES) into one string.
function combinedContext(payload) {
  const out = [];
  if (activePlanLine) out.push(activePlanLine);
  if (payload) out.push(payload);
  if (tddPostureLine) out.push(tddPostureLine);
  if (unattributableLine) out.push(unattributableLine);
  if (!EXEMPT_AGENT_TYPES.has(input.agent_type)) out.push(RETURN_CONTRACT);
  return out.join('\n\n');
}

/** The stdout envelope, in the one shape this hook emits. */
function envelope(out) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: out } });
}

// Emits the combined context (if any) and allows — used at every early exit
// below so the return contract still injects even when the knowledge-payload
// path has nothing to stage (h28's own posture: ALWAYS inject).
function finish(payload) {
  const out = combinedContext(payload);
  if (out) return exitAfterWrite(envelope(out), 0);
  return allow();
}

// THE BODY IS A FUNCTION, AND EVERY TERMINAL CALL INSIDE IT IS A `return`: the
// exit now happens in the stdout write callback, so a bare `finish('')` would
// no longer stop the statements after it the way its hard exit did.
async function main(input) {
  try {
    const store = openStore(input.cwd);
    if (!store) return finish(''); // not a Sterling project — no ceremony for the payload half (P1)

    // DISPATCH-STATE RESOLUTION replaces the old parent-transcript prompt scan
    // (decision dispatch-state-machine-pre-slot-post-binding-locked-start-
    // resolution-replaces-transcript-attribution §5/§6). 'resume' emits nothing
    // extra; 'unattributable' stages no territory and gets exactly one line
    // beside the return contract; a resolved prompt is staged normally.
    const resolution = await resolveDispatchStart(
      input.cwd,
      { session_id: input.session_id, agent_id: input.agent_id, agent_type: input.agent_type },
      { consumer: 'h19' }
    );
    if (resolution.source === 'unattributable') {
      unattributableLine = `STERLING DISPATCH STAGING (H19): this spawn's dispatch could not be attributed at Start [${resolution.case}] — no territory was staged; file-touch delivery still fires on your first Read/Edit`;
    }

    const prompts = typeof resolution.prompt === 'string' ? [resolution.prompt] : [];
    const candidates = [...new Set(prompts.flatMap(extractPathCandidates))];

    const rels = [...new Set(candidates.map((c) => repoRel(c, input.cwd)).filter(Boolean))].filter(
      (r) => r !== '.git' && !r.startsWith('.git/') && !r.startsWith('.sterling/')
    );

    // PATH CHANNEL (AC5's original contract): declared file_keys get the payload
    // staged. No candidates is no longer an early exit — the SUBJECT channel
    // below (relevance slice 3, board 8f3141d4) can deliver on a pathless
    // dispatch, which is exactly the case path-scoping is structurally blind to.
    const owners = rels.length
      ? store.query({ types: ['feature_article', 'reference_material'], file_keys: rels, cap: 100 }).filter((r) => !r.working_tree)
      : [];
    const hazards = rels.length ? store.query({ types: ['anti_pattern'], file_keys: rels, cap: 100 }) : [];
    const decisions = rels.length ? store.query({ types: ['decision'], file_keys: rels, cap: 100 }) : [];

    // SUBJECT CHANNEL (relevance slice 3): the same mechanism-axis match H20
    // applies at the conductor's dispatch seam, run over the SAME recovered
    // prompt text, delivered to the SPAWNED agent — one mechanism, imported
    // never reimplemented (decision foreign_f5638a84 constraint). All three stage-2
    // floors apply (AXIS_MIN_HITS, discriminating hit, record centrality) so the
    // measured 1-in-3 noise problem is not replicated one seam deeper. Records
    // the path channel already carries are excluded — one payload, one mention.
    // Matched PER PROMPT, not over the union (review finding 5, 2026-08-10): a
    // parallel dispatch's union lets the longest prompt's vocabulary dominate
    // extraction (diluting short siblings to silence) and attributes one task's
    // subject to another's agent. Per-prompt costs one query pair per dispatch
    // block — bounded by the dispatch cap.
    const pathIds = new Set([...owners, ...hazards, ...decisions].map((r) => r.id));
    const subjectMatches = [];
    const seenSubject = new Set();
    for (const p of prompts) {
      // STRIP THE REVIEW-TERRITORY RECEIPT LINE before axis-term extraction —
      // the SAME helper H20's outgoingProposalText applies (decision
      // h20-specificity-rebuild-not-fourth-patch-structural-fixes-now-red-probes-frozen,
      // fix 1). This is the OTHER consumer of the raw dispatch prompt for
      // subject-axis matching: without routing it through the identical
      // helper, this surface and H20's dispatch-seam surface could disagree on
      // whether a REVIEW-TERRITORY boilerplate line counts as "subject",
      // reintroducing the same false positive one seam over. Path extraction
      // just above (extractPathCandidates) deliberately still reads the RAW
      // prompt — the declared territory's paths are legitimate path-channel
      // input, only axis-term SUBJECT matching must not see the line.
      const subjectText = stripReviewTerritoryLine(p);
      const terms = extractAxisTerms(subjectText, MAX_RANK_TERMS);
      if (terms.length < AXIS_MIN_HITS) continue;
      const candidatesBySubject = [
        ...store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 }),
        ...store.query({ types: ['decision'], rank_terms: terms, cap: 40 }),
      ];
      for (const r of candidatesBySubject) {
        if (pathIds.has(r.id) || seenSubject.has(r.id)) continue;
        const hits = axisHits(r, terms);
        if (hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(r, subjectText)) {
          seenSubject.add(r.id);
          subjectMatches.push({ record: r, hits, prompt: subjectText });
        }
      }
    }
    subjectMatches.sort((a, b) => b.hits.length - a.hits.length);

    // Nothing on either channel: still the undeclared case for AC5's purposes —
    // no frontier notice here (that signal belongs to the file-touch hook, which
    // fires once the agent actually touches the path; staging is a bonus, not a
    // second frontier surface).
    if (!owners.length && !hazards.length && !decisions.length && !subjectMatches.length) return finish('');

    const gPath = guardPath(input.cwd, input.agent_id, input.session_id);
    const guard = readGuard(gPath);

    // Hazards render as SUBSTANCE (whole hazard block) here; decisions and the
    // subject channel's own hazards/decisions split the same way
    // h19-knowledge-delivery.mjs's do — see its equivalent comment.
    const freshHazards = hazards.filter((r) => !isSubstanceDelivered(guard, r));
    // OWNERS SPLIT BY WHAT THEY WILL ACTUALLY RENDER AS (fix-round MEDIUM 3) —
    // see h19-knowledge-delivery.mjs's identical comment: a reference_material
    // or oversize (digested) article never renders as substance, so filtering
    // it against `isSubstanceDelivered` alone left it permanently "fresh" —
    // the SAME pointer/digest re-delivered on every touch, forever.
    const freshOwners = owners.filter((r) => (isOwnerDiscoveryOnly(r) ? !isDiscoveryDelivered(guard, r) : !isSubstanceDelivered(guard, r)));
    // RANKED ONCE, AT THE BIRTH POINT — the SAME defect and the same repair as
    // h19-knowledge-delivery.mjs (2026-09-06). This is the
    // PATH channel: the store's file_keys join degenerates to newest-first, so
    // capping in the renderer below evicted the older standing rulings on
    // any file carrying more decisions than the cap. Ranking here — not at the
    // slice, not at the renderer — is what keeps the guard slice, the render call
    // and this array in ONE order; re-sorting at any of them would mark one set
    // delivered while the payload showed another.
    // NOT applied to the SUBJECT channel below (`subjectDecisions`): those are
    // ordered by axis-hit strength against the dispatch prompt, which is the
    // correct key for a subject match — this ranking answers the file-touch
    // question ("which rulings govern this territory"), not the relevance one.
    const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDiscoveryDelivered(guard, r)));
    // subjectMatches is anti_pattern or decision only (the two queries above) —
    // route each to the SAME ledger its rendered contentClass will spend.
    const freshSubject = subjectMatches.filter((x) =>
      x.record.type === 'anti_pattern' ? !isSubstanceDelivered(guard, x.record) : !isDiscoveryDelivered(guard, x.record)
    );
    if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !freshSubject.length) return finish('');

    // LOAD-BEARING, deliberately uncaught: a corrupt config.json must fail the
    // staging payload shut under the shared-fate ruling pinned by
    // h19-dispatch-staging.test.mjs:533 ("H19+H28 shared-fate"). Do not wrap
    // this or replace it with an unused binding; the outer catch preserves the
    // return contract while withholding knowledge delivery. Its POSITION is
    // load-bearing too: throwing before dispatch resolution leaves its slot unbound.
    loadConfig(input.cwd);

    // Split subject matches by their delivery class. The “beyond any file the
    // task names” block below reads from these same arrays.
    const subjectHazards = freshSubject.filter((x) => x.record.type === 'anti_pattern').map((x) => x.record);
    const subjectDecisions = freshSubject.filter((x) => x.record.type === 'decision').map((x) => x.record);

    // PER-DELIVERY TOTAL CAP (scale-down Slice 3c, assembleDelivery in
    // lib/delivery.mjs — decision 92088a62's ONE ASSEMBLER). Hazards are
    // complete unbudgeted substance; article bodies, decisions,
    // and every other ordinary line share the cap and degrade to
    // `knowledge_get <id>` pointers. CHROME IS CHARGED TOO (item 6): the
    // active-plan line, TDD posture, unattributable-start disclosure and the
    // h28 return contract are folded in as PINNED-BUT-CHARGED parts (leading
    // and trailing respectively) in the SAME assembleDelivery call that caps
    // the knowledge payload — the cap is charged on the FINAL composed
    // context, never the knowledge payload alone, which is exactly what let a
    // smaller cap escape by 12,888 B when this text was appended AFTER
    // capping (Sol's reproduction).
    const totalCap = resolveTotalCap(input.cwd);
    const leadingChromeParts = activePlanLine ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: activePlanLine }] : [];
    const trailingChromeParts = [
      ...(tddPostureLine ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: tddPostureLine }] : []),
      ...(unattributableLine ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: unattributableLine }] : []),
      ...(!EXEMPT_AGENT_TYPES.has(input.agent_type) ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: RETURN_CONTRACT }] : []),
    ];
    const assemble = () => {
      const parts = [];
      if (freshOwners.length || freshHazards.length || freshDecisions.length) {
        const decisionWiden = `knowledge_query types:["decision"] file_keys:[${rels.map((r) => `"${r}"`).join(',')}] cap:${freshDecisions.length}`;
        const ownerParts = freshOwners.map((r) => {
          const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r);
          const contentClass = isOwnerDiscoveryOnly(r) ? 'discovery' : 'substance';
          return { kind: 'ordinary', contentClass, identity: r.id, revision: recordRevision(r), text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
        });
        const decisionParts = freshDecisions.length
          ? [{
              kind: 'ordinary', contentClass: 'discovery',
              identities: freshDecisions.map((d) => ({ identity: d.id, revision: recordRevision(d) })),
              text: renderDecisionPointers(rels.join(', '), freshDecisions),
              pointer: decisionBlockPointer(freshDecisions.length, decisionWiden),
              suffix: `  … the rest held back by the delivery cap — ${decisionWiden}`,
            }]
          : [];
        parts.push(
          { kind: 'ordinary', contentClass: 'chrome', text: payloadHeaderLine(rels.join(', ')) },
          ...hazardParts(freshHazards, { fileKeys: rels }),
          ...ownerParts,
          ...decisionParts
        );
      }
      if (subjectHazards.length || subjectDecisions.length) {
        const matched = [...new Set(freshSubject.flatMap((x) => x.hits))].join(', ');
        const central = [...new Set(freshSubject.flatMap((x) => recordCentralityHits(x.record, x.prompt)))].join(', ');
        const subjectLabel = `your task's SUBJECT`;
        const subjectTerms = [...new Set(freshSubject.flatMap((x) => x.hits))];
        const remedy = `knowledge_query types:["anti_pattern"] rank_terms:[${subjectTerms.map((t) => `"${t}"`).join(',')}] cap:${subjectHazards.length || 1}`;
        const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${subjectTerms.map((t) => `"${t}"`).join(',')}] cap:${subjectDecisions.length || 1}`;
        parts.push(
          {
            text:
              `STERLING MECHANISM-AXIS STAGING (H19) — the store holds records matching ${subjectLabel} ` +
              `(matched on: ${matched}; central to the record: ${central}), beyond any file the task names. ` +
              `Path-scoped delivery cannot find these — consult them before acting on the premise they govern.`,
            kind: 'ordinary',
            contentClass: 'chrome',
          },
          ...hazardParts(subjectHazards, { remedy }),
          ...(subjectDecisions.length
            ? [
                {
                  kind: 'ordinary', contentClass: 'discovery',
                  identities: subjectDecisions.slice(0, SUBJECT_MAX_DECISIONS).map((d) => ({ identity: d.id, revision: recordRevision(d) })),
                  text: renderDecisionPointers('(subject match)', subjectDecisions, SUBJECT_MAX_DECISIONS, { remedy: decisionRemedy }),
                  pointer: decisionBlockPointer(subjectDecisions.length, decisionRemedy),
                  suffix: `  … the rest held back by the delivery cap — ${decisionRemedy}`,
                },
              ]
            : [])
        );
      }
      const allParts = [...leadingChromeParts, ...parts, ...trailingChromeParts];
      const assembled = assembleDelivery(allParts, totalCap);
      return { payload: assembled.text, emittedSubstance: assembled.emittedSubstance, emittedDiscovery: assembled.emittedDiscovery };
    };
    // `built.payload` is now the WHOLE composed context — chrome (plan line,
    // TDD posture, unattributable-start line, return contract) was assembled
    // IN, not appended after (item 6) — so there is no separate
    // combinedContext(payload) call left to make on this path.
    const built = assemble();
    const out = built.payload;

    // Side effect first, guard second (the ordering rule
    // mirrored from h19-knowledge-delivery.mjs): a throw before this line leaves
    // the guard untouched, so a later touch of the same territory — the main
    // file-touch hook, or a later dispatch — still delivers it. The return
    // contract (h28 fold) rides the SAME emission — it is folded into
    // `built.payload` above — so a fresh knowledge payload and the return
    // contract never clobber each other in two separate writes.
    // THE ORDERING IS NOW MECHANICAL: the guard write rides `onWritten`, so it
    // runs only after the stream has actually taken the envelope — a failed
    // write leaves every staged record eligible for the next dispatch, and the
    // process exits non-zero rather than reporting a clean staging.
    const recordStaged = () => {
      // Guard only what the assembler says it actually emitted — never a
      // re-scan of the composed text (decision 92088a62's ONE ASSEMBLER
      // CONTRACT).
      markSubstanceDelivered(guard, built.emittedSubstance);
      markDiscoveryDelivered(guard, built.emittedDiscovery);
      writeGuard(gPath, guard);
    };
    if (!out) {
      recordStaged();
      return allow();
    }
    return exitAfterWrite(envelope(out), 0, { onWritten: recordStaged });
  } catch (e) {
    // Staging is an aid, never a gate: internal failure is loud but NON-blocking
    // (P5 visibility without an AC7-style violation). The return contract (h28
    // fold) must still land on a throw here — pre-fold it ran in its own
    // process and was unaffected by an h19 crash (a malformed config, a
    // store-query throw, a render throw all now share this one process).
    // THE HELPER HOLDS THE ONE-ENVELOPE RULE: if an envelope already went out
    // above, this second payload is suppressed and disclosed on stderr and that
    // write's exit 0 carries; an EXEMPT agent still gets nothing, since
    // combinedContext('') reduces to '' for it exactly as it does elsewhere.
    // EXIT CODE IS LOAD-BEARING when the contract is delivered: a hook that
    // exits NONZERO cannot rely on the platform honoring its hookSpecificOutput,
    // so a catch-emit followed by exit 1 would be theatre — the failure note
    // rides stderr (try-wrapped) and the process exits 0, exactly the finish('')
    // shape the review prescribed. Only when NOTHING can be emitted (an exempt
    // agent, or a failed write) does the warnNonBlocking exit-1 posture remain,
    // preserving the platform's failed-hook signal — and warnNonBlocking is
    // itself pending-aware, so it never lowers a delivered envelope's exit 0.
    try {
      process.stderr.write(`H19: dispatch staging failed: ${(e && e.message) || e}\n`);
    } catch {
      /* a failed stderr note must not change the delivery outcome */
    }
    const out = combinedContext('');
    if (out) return exitAfterWrite(envelope(out), 0);
    return warnNonBlocking(`H19: dispatch staging failed and nothing was emitted`);
  }
}

main(input);
