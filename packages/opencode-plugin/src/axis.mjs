// The mechanism axis (H20) and the output axis (H23) on OpenCode 2.
//
// H20: on the subagent, question and codex tools, the store is matched against
// the outgoing text (the brief, the question form, the consult prompt) with H20's
// three floors, and the carriage built in execute.before is appended to the
// tool result in execute.after. That is the same timing as Claude Code, where
// PreToolUse additionalContext reaches the model with the tool result. On a codex
// opener the configured config.sparring_partner.model is written into the call's
// arguments when the call names none: execute.before's input is the live object
// (finding opencode-2-plugin-spike-hooks-and-sidebar-october-2026, supplement 2).
// H20 never denies on either host: Claude Code's deny-once rung was removed by
// decision sterling-claude-code-scale-down-boundary (h20-mechanism-axis.mjs:435-441),
// so the question surface is a post-answer audit here too.
//
// H23: after a completed read or shell call, the tool's own output is matched
// against anti_patterns with the same floors; one advisory pointer line plus the
// remainder count is appended. A read of territory an article owns is skipped (H19
// delivers it), as are VCS and listing commands.
//
// The scoring, rendering and guard helpers are scripts/hooks/lib/delivery.mjs's,
// shared with the hooks. The composition below follows h20-mechanism-axis.mjs and
// h23-output-axis.mjs, whose bodies live in the hook entry files and cannot be
// imported; a change there must be mirrored here.
//
// Tool names: subagent {agent, description, prompt, ...} and question {questions}
// were read from ctx.tool.list and the OpenCode 2.0.21 binary. The codex MCP tool's
// name inside execute.before is unmeasured: permission keys are `<server>_<tool>`
// (finding opencode-2-0-21-mcp-permission-key-is-server-underscore-tool) and the
// displayed name is `<server>.<tool>`, so both spellings are accepted.
import { isAbsolute, join, resolve } from 'node:path';
import { MAX_RANK_TERMS } from '@sterling/store';
import { loadConfig, repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { recordAdvisoryFire } from '../../../scripts/hooks/lib/advisory-counter.mjs';
import { dispatchOverlapNotice } from '../../../scripts/hooks/lib/dispatch-overlap.mjs';
import { isListingCommand } from '../../../scripts/hooks/lib/listing-command.mjs';
import { isForeignTree } from '../../../scripts/hooks/lib/working-tree.mjs';
import {
  ARTICLE_POINTER_CAP,
  AXIS_MIN_DISCRIMINATING_HITS,
  AXIS_MIN_HITS,
  DECISION_REJECTED_CLIP,
  DECISION_STATEMENT_CLIP,
  DENY_RULING_TYPES,
  assembleDelivery,
  axisHits,
  boundedTermClause,
  decisionPointerPart,
  extractAxisTerms,
  guardPath,
  hasDiscriminatingHit,
  hasRecordCentralityHit,
  hazardParts,
  isKnownDelivered,
  isSubstanceDelivered,
  joinPointerBlock,
  markDiscoveryDelivered,
  markSubstanceDelivered,
  outgoingProposalText,
  readGuard,
  recordCentralityHits,
  recordRevision,
  renderArticlePointers,
  resolveTotalCap,
  statusAnnotation,
  subQuestionText,
  writeGuard,
} from '../../../scripts/hooks/lib/delivery.mjs';
import { appendToResult } from './delivery.mjs';

const CODEX_OPENERS = new Set(['codex_codex', 'codex.codex']);
const CODEX_TOOL = /^codex[._]/;
const PENDING_CAP = 200;
// h20-mechanism-axis.mjs: MAX_DECISIONS and the prior-answer cap.
const MAX_DECISIONS = 5;
const PRIOR_ANSWER_CAP = 3;
// h23-output-axis.mjs: OUTPUT_AXIS_CLIP and OUTPUT_AXIS_POINTER_CAP (ruling h23-kept-raised-threshold-one-pointer-payload).
const OUTPUT_AXIS_CLIP = 16_000;
const OUTPUT_AXIS_POINTER_CAP = 1;

/** Which H20 surface a tool call is on, or null. */
export function axisSurface(tool) {
  if (tool === 'subagent') return 'dispatch';
  if (tool === 'question') return 'question';
  if (typeof tool === 'string' && CODEX_TOOL.test(tool)) return 'consult';
  return null;
}

const QUESTION_WORDS_RE = /\b(where|what|which|who|whom|whose|when|why|how|does|do|did|is|are|was|were|can|could|would|will|should)\b/i;
const isQuestionShaped = (t) => String(t ?? '').includes('?') && QUESTION_WORDS_RE.test(String(t ?? ''));

const clip = (v, n = 160) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};
const quoteTerms = (xs) => [...new Set(xs.flatMap((x) => x.hits))].map((t) => `"${t}"`).join(',');

/**
 * H20's codex model pin (h20-mechanism-axis.mjs buildModelPin): { line } and, on an
 * opener that names no model, `model` to write into the call. Never throws.
 */
export function codexModelPin(root, tool, args) {
  const PIN = 'STERLING CODEX MODEL PIN (H20)';
  const show = (v) => {
    const s = JSON.stringify(String(v ?? ''));
    return s.length <= 120 ? s : `${s.slice(0, 120)}…`;
  };
  if (!CODEX_OPENERS.has(tool)) {
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
  const callModel = typeof args?.model === 'string' && args.model !== '' ? args.model : null;
  const configured = sp && typeof sp.model === 'string' && sp.model !== '' ? sp.model : null;
  if (callModel !== null) {
    lines.push(
      `${PIN} — this call names model ${show(callModel)} EXPLICITLY, so the call-site value wins and Sterling leaves the input untouched` +
        `${configured ? ` (config.sparring_partner.model is ${show(configured)} and was not applied)` : ''}.`
    );
    return { line: lines.join('\n') };
  }
  if (unreadable) {
    lines.push(`${PIN} — .sterling/config.json could not be parsed (${show(unreadable)}), so NO model was applied and the Codex CLI default is in force. Fix the config file; a consult is never denied over this.`);
    return { line: lines.join('\n') };
  }
  if (!configured) {
    lines.push(
      `${PIN} — no model is set in config.sparring_partner.model${config ? '' : ' (no .sterling/config.json to read)'}, so this consult takes the Codex CLI default. ` +
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

/** True when the brief cites this record by id8 or slug (h20-mechanism-axis.mjs citedInBrief). */
function citedInBrief(record, text) {
  const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id8 = String(record.id ?? '').slice(0, 8);
  if (id8.length === 8 && new RegExp(`(?<![0-9a-f])${esc(id8)}(?![0-9a-f])`, 'i').test(text)) return true;
  return !!record.slug && new RegExp(`(?<![a-z0-9-])${esc(record.slug)}(?![a-z0-9-])`, 'i').test(text);
}

/**
 * H20's carriage for one call: the assembled delivery, or null when nothing
 * survives the floors and the guard. `extra` are pinned chrome parts (the model
 * pin first, the dispatch overlap last), as H20 composes them.
 */
function buildMechanismAxis(store, root, { surface, args, subagentType, guard, pinLine, overlap }) {
  const isQuestion = surface === 'question';
  const isConsult = surface === 'consult';
  const isDispatch = surface === 'dispatch';
  const outgoing = outgoingProposalText(args);
  if (!outgoing) return null;
  const terms = extractAxisTerms(outgoing, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) return null;
  const candidates = ['anti_pattern', 'decision', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question'].flatMap((type) =>
    store.query({ types: [type], rank_terms: terms, cap: 40 })
  );
  // Multi-question forms also query each sub-question's own terms for the ruling types.
  if (isQuestion && Array.isArray(args.questions) && args.questions.length > 1) {
    const seen = new Set(candidates.map((r) => r.id));
    for (const q of args.questions) {
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
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(x.record, outgoing))
    .sort((a, b) => b.hits.length - a.hits.length);
  const briefText = String(args?.prompt ?? '');
  const fresh = scored.filter((x) => {
    if (x.record.type !== 'anti_pattern') return !isKnownDelivered(guard, x.record);
    if (isDispatch && citedInBrief(x.record, briefText)) return false;
    return isConsult ? !isSubstanceDelivered(guard, x.record) : !isKnownDelivered(guard, x.record);
  });
  const hazards = fresh.filter((x) => x.record.type === 'anti_pattern');
  const decisions = fresh.filter((x) => x.record.type === 'decision');
  const articles = fresh.filter((x) => x.record.type === 'feature_article');
  const priorAnswers = fresh.filter((x) => ['research_finding', 'disconfirmed_hypothesis', 'open_question'].includes(x.record.type));
  if (!hazards.length && !decisions.length && !articles.length && !priorAnswers.length) return null;

  const matched = [...new Set(fresh.flatMap((x) => x.hits))].join(', ');
  const centralCovered = boundedTermClause(fresh.flatMap((x) => recordCentralityHits(x.record, outgoing)));
  const matchedClause = `matched on: ${matched}; central to the record: ${centralCovered}`;
  const header = isQuestion
    ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you have just put a CHOICE TO THE USER. ` +
      `The store already governs this subject (${matchedClause}) and no file you touched would have surfaced it. ` +
      `THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask. ` +
      `Before treating the answer as a ruling, check these records: a user's answer becomes authoritative, so if one of them ` +
      `already decides the question, the pick just manufactured a contradiction with a settled ruling — ` +
      `disclose the record to the user and re-affirm before acting on the answer.`
    : isConsult
      ? `STERLING MECHANISM-AXIS DELIVERY (H20) — you are about to CONSULT the sparring partner (codex). ` +
        `The store holds records matching this prompt's SUBJECT (${matchedClause}) rather than any file you touched. ` +
        `Path-scoped delivery cannot find these. Check them BEFORE the consult goes out — a bad premise sent to an external model is still a bad premise.`
      : `STERLING MECHANISM-AXIS DELIVERY (H20) — you have just dispatched '${subagentType || 'an agent'}'; the brief has already gone out. ` +
        `The store holds records matching its SUBJECT (${matchedClause}), which no file you touched would surface. ` +
        `If one changes the brief's premise, correct the agent now by continuing it through the subagent tool with its sessionID (or re-dispatch) — a fan-out multiplies a bad premise by N.`;

  const pointerHead = (r, name) => `  → ${clip(name, 80)} (${String(r.id).slice(0, 8)})`;
  const questionDecisionText = (records, remedy) => {
    const shown = records.slice(0, MAX_DECISIONS);
    return [
      `▸ DECISIONS for this subject (${records.length}) — one may already settle the question you just put; the user's pick must not silently contradict it. One line each, knowledge_get the id for the full ruling:`,
      ...shown.map((d) => {
        const rejected = (Array.isArray(d.alternatives_rejected) ? d.alternatives_rejected : [])
          .map((a) => (typeof a?.option === 'string' ? a.option.trim() : ''))
          .filter(Boolean)
          .join('; ');
        return (
          `${pointerHead(d, d.slug || d.title || d.statement)} — ${d.authority ? `[${d.authority}] ` : ''}${clip(d.statement, DECISION_STATEMENT_CLIP)}${statusAnnotation(d)}` +
          (rejected ? ` — rejected: ${clip(rejected, DECISION_REJECTED_CLIP)}` : '')
        );
      }),
      ...(records.length > shown.length ? [`  … ${records.length - shown.length} more NOT shown (cap ${MAX_DECISIONS}) — ${remedy} for the full set`] : []),
    ].join('\n');
  };
  const questionPriorLine = (r) => {
    const stale = r.status === 'flagged_stale' ? ', FLAGGED STALE — re-verify before trusting' : '';
    const head = pointerHead(r, r.slug || r.question);
    const q = r.slug ? `: ${clip(r.question, 120)}` : '';
    if (r.type === 'research_finding') return `${head} — ANSWERED${q} (captured ${r.capture_date ?? '?'}${stale})`;
    if (r.type === 'open_question') {
      return r.resolution_status === 'closed' ? `${head} — ANSWERED (question closed into ${r.closed_into ?? 'an unnamed record'})${q}` : `${head} — ALREADY UNDER INVESTIGATION (open, no answer yet)${q}`;
    }
    return `${head} — REFUTED TRAIL${q} — rejected: ${clip(r.rejected_answer, 100)}`;
  };
  const dispatchPriorLine = (r) => {
    if (r.type === 'research_finding') {
      return `  → ANSWERED: ${clip(r.question)} (source ${r.source_date ?? '?'}, captured ${r.capture_date ?? '?'}${r.status === 'flagged_stale' ? ', FLAGGED STALE — re-verify before trusting' : ''}) · knowledge_get ${r.id}`;
    }
    if (r.type === 'open_question') {
      return r.resolution_status === 'closed'
        ? `  → ANSWERED (question closed into ${r.closed_into ?? 'an unnamed record'}): ${clip(r.question)} · knowledge_get ${r.id}`
        : `  → ALREADY UNDER INVESTIGATION (open, no answer yet): ${clip(r.question)} · knowledge_get ${r.id}`;
    }
    return `  → REFUTED TRAIL: ${clip(r.question)} — rejected: ${clip(r.rejected_answer, 100)} · knowledge_get ${r.id}`;
  };

  const decisionRemedy = `knowledge_query types:["decision"] rank_terms:[${quoteTerms(decisions)}] cap:${decisions.length}`;
  const hazardBlocks = hazardParts(hazards.map((x) => x.record), {
    remedy: `knowledge_query types:["anti_pattern"] rank_terms:[${quoteTerms(hazards)}] cap:${hazards.length || 1}`,
    matchLabel: 'for this subject',
    mode: isQuestion ? 'question' : isDispatch ? 'lead' : 'whole',
  });
  const decisionBlocks = decisions.length
    ? [
        ((part) => (isQuestion ? { ...part, text: questionDecisionText(decisions.map((x) => x.record), decisionRemedy) } : part))(
          decisionPointerPart('(subject match)', decisions.map((x) => x.record), { widen: decisionRemedy, cap: MAX_DECISIONS, remedy: decisionRemedy, matchLabel: 'for this subject' })
        ),
      ]
    : [];
  const asPart = (text, widen, identities) => ({ kind: 'ordinary', contentClass: 'discovery', identities, text, pointer: `▸ held back by the delivery cap — ${widen}` });
  const articleWiden = `knowledge_query types:["feature_article"] rank_terms:[${quoteTerms(articles)}] cap:${articles.length}`;
  const articleParts = articles.length
    ? [
        asPart(
          renderArticlePointers(articles.map((x) => x.record), ARTICLE_POINTER_CAP, { remedy: articleWiden }),
          articleWiden,
          articles.slice(0, ARTICLE_POINTER_CAP).map((x) => ({ identity: x.record.id, revision: recordRevision(x.record), name: x.record.slug || x.record.title }))
        ),
      ]
    : [];
  const priorWiden = `knowledge_query types:["research_finding","disconfirmed_hypothesis","open_question"] rank_terms:[${quoteTerms(priorAnswers)}] cap:${priorAnswers.length}`;
  const shownPrior = priorAnswers.slice(0, PRIOR_ANSWER_CAP);
  const priorParts = priorAnswers.length
    ? [
        asPart(
          [
            isQuestion
              ? `▸ PRIOR ANSWERS in the store (${priorAnswers.length}) — the question you just put may already be answered, or already under investigation. If one answers it, tell the user before acting on their pick:`
              : `▸ PRIOR ANSWERS in the store (${priorAnswers.length}) — this dispatch may be about to RE-DERIVE one of these, or duplicate a question already under investigation. knowledge_get before fanning out:`,
            ...shownPrior.map((x) => (isQuestion ? questionPriorLine(x.record) : dispatchPriorLine(x.record))),
            ...(priorAnswers.length > PRIOR_ANSWER_CAP ? [`  (+${priorAnswers.length - PRIOR_ANSWER_CAP} more — ${priorWiden})`] : []),
          ].join('\n'),
          priorWiden,
          shownPrior.map((x) => ({ identity: x.record.id, revision: recordRevision(x.record), name: x.record.slug || clip(x.record.question, 60) }))
        ),
      ]
    : [];
  const chrome = (text) => ({ kind: 'ordinary', pinned: true, contentClass: 'chrome', text });
  const parts = [
    ...(pinLine ? [chrome(pinLine)] : []),
    chrome(header),
    ...(isQuestionShaped(outgoing) ? [...priorParts, ...articleParts, ...decisionBlocks, ...hazardBlocks] : [...hazardBlocks, ...decisionBlocks, ...priorParts, ...articleParts]),
    ...(overlap ? [chrome(overlap)] : []),
  ];
  return assembleDelivery(parts, resolveTotalCap(root));
}

/** The text a completed tool result carries, for the output-axis match. */
function resultText(result) {
  const c = result?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return '';
}

/**
 * H23's pointer block for a completed read or shell call, or null. `commit()`
 * records the pointed-at hazards in guard.output_axis (never guard.records).
 */
function buildOutputAxis(store, root, { tool, args, content, sessionID, directory }) {
  if (tool === 'shell' && isListingCommand(args?.command)) return null;
  if (tool === 'read') {
    const raw = args?.path;
    const rel = typeof raw === 'string' && raw ? repoRel(isAbsolute(raw) ? raw : resolve(directory, raw), root) : null;
    if (rel === '.git' || rel?.startsWith('.git/') || rel?.startsWith('.sterling/')) return null;
    if (rel) {
      const owners = store.query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 }).filter((r) => !isForeignTree(r, root));
      if (owners.length) return null;
    }
  }
  const clipped = content.slice(0, OUTPUT_AXIS_CLIP);
  const terms = extractAxisTerms(clipped, MAX_RANK_TERMS);
  if (terms.length < AXIS_MIN_HITS) return null;
  const candidates = store.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 });
  const scored = candidates
    .map((r) => ({ record: r, hits: axisHits(r, terms) }))
    .filter((x) => x.hits.length >= AXIS_MIN_HITS && hasDiscriminatingHit(x.hits, AXIS_MIN_DISCRIMINATING_HITS) && hasRecordCentralityHit(x.record, clipped))
    .sort((a, b) => b.hits.length - a.hits.length);
  if (!scored.length) return null;
  const gPath = guardPath(root, undefined, sessionID);
  const guard = readGuard(gPath);
  const seen = new Set(guard.output_axis ?? []);
  const fresh = scored.filter((x) => !seen.has(x.record.id));
  if (!fresh.length) return null;
  const shown = fresh.slice(0, OUTPUT_AXIS_POINTER_CAP);
  const remainder = fresh.length - shown.length;
  const header =
    'ADVISORY (not an error) — STERLING OUTPUT-AXIS DELIVERY (H23): the tool output you just consumed matches a recorded hazard. ' +
    'Pointer only, never a block: follow the read below before assuming the answer, never treat this line as the ruling itself.';
  const lines = shown.map((x) => ({ id: x.record.id, hazard: true, line: `  → HAZARD anti_pattern '${clip(x.record.title, 140)}' · knowledge_get ${x.record.id}` }));
  return {
    text: joinPointerBlock({ header, lines, tail: remainder > 0 ? `  (+${remainder} more matched)` : '' }),
    commit: () => {
      recordAdvisoryFire(root, 'h23', sessionID);
      if (!gPath) return;
      guard.output_axis = [...seen, ...shown.map((x) => x.record.id)];
      writeGuard(gPath, guard);
    },
  };
}

/**
 * The axis handlers: onBefore (H20, including the codex model pin), onAfter
 * (appends the H20 carriage built before), outputOf and onOutput (H23). Take
 * outputOf(input) before any handler appends to the result, so only the tool's
 * own output is matched, and call onOutput(input, output) after the file
 * delivery has written its guard, because H23 reads the guard fresh and a
 * delivery commit writes back the guard it read before the call.
 */
export function createAxisHandlers({ openStore, rootOf, directory, fenced }) {
  const pending = new Map();

  async function onBefore(input) {
    const surface = axisSurface(input?.tool);
    if (!surface) return;
    const root = rootOf();
    if (!root) return;
    const args = input.input && typeof input.input === 'object' ? input.input : {};
    let pinLine = null;
    if (surface === 'consult') {
      // The pin is applied before the carriage is built, so a carriage failure cannot cost the call its model.
      await fenced('axis', root, () => {
        const pin = codexModelPin(root, input.tool, args);
        if (pin.model && input.input && typeof input.input === 'object') input.input.model = pin.model;
        pinLine = pin.line;
      });
    }
    const overlap =
      surface === 'dispatch'
        ? dispatchOverlapNotice({ tool_input: { subagent_type: args.agent, prompt: args.prompt }, cwd: root, session_id: input.sessionID })
        : null;
    let built = null;
    await fenced('axis', root, () => {
      const gPath = guardPath(root, undefined, input.sessionID);
      const guard = readGuard(gPath);
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      try {
        const assembled = buildMechanismAxis(store, root, { surface, args, subagentType: args.agent, guard, pinLine, overlap });
        if (assembled) {
          built = {
            text: assembled.text,
            commit: () => {
              recordAdvisoryFire(root, 'h20', input.sessionID);
              if (!gPath) return;
              markSubstanceDelivered(guard, assembled.emittedSubstance);
              markDiscoveryDelivered(guard, assembled.emittedDiscovery);
              writeGuard(gPath, guard);
            },
          };
        }
      } finally {
        store.close();
      }
    });
    if (!built) {
      const text = [pinLine, overlap].filter(Boolean).join('\n\n');
      if (text) built = { text, commit: () => {} };
    }
    if (!built) return;
    pending.set(input.id, built);
    while (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value);
  }

  async function onAfter(input) {
    const built = pending.get(input?.id);
    if (!built) return;
    pending.delete(input.id);
    const root = rootOf();
    if (!root || input.status !== 'completed') return;
    await fenced('axis', root, () => {
      appendToResult(input.result, built.text);
      built.commit();
    });
  }

  /** The output H23 matches, or '' when the call is not a completed read or shell. */
  function outputOf(input) {
    if ((input?.tool !== 'read' && input?.tool !== 'shell') || input.status !== 'completed') return '';
    return resultText(input.result);
  }

  async function onOutput(input, content) {
    if (!content) return;
    const root = rootOf();
    if (!root) return;
    await fenced('axis', root, () => {
      const store = openStore(join(root, '.sterling', 'sterling.db'));
      let block;
      try {
        block = buildOutputAxis(store, root, { tool: input.tool, args: input.input ?? {}, content, sessionID: input.sessionID, directory: directory() });
      } finally {
        store.close();
      }
      if (!block) return;
      appendToResult(input.result, block.text);
      block.commit();
    });
  }

  return { onBefore, onAfter, outputOf, onOutput };
}
