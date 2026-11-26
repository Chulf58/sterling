// The mechanism axis (H20) and the output axis (H23) on OpenCode 2.
//
// H20: on the subagent and question tools, the store is matched against
// the outgoing text (the brief, the question form) with H20's
// three floors, and the carriage built in execute.before is appended to the
// tool result in execute.after. That is the same timing as Claude Code, where
// PreToolUse additionalContext reaches the model with the tool result.
// On a subagent call that names no model, the agent's one model from config.models is
// written into the call (dispatch-model.mjs; finding
// opencode-2-0-23-how-session-and-subagent-models-are-chosen-and-overridden: the
// mutated model reaches execution, and an unavailable one fails as a tool error). An
// Overpass tier model missing from OpenCode's model list refuses the call with the fix
// steps (overpass.mjs readInventory, GitHub #257, #258, #281); a role with two models not
// yet chosen refuses the call too.
// H20 never denies on either host: Claude Code's deny-once rung was removed by
// decision sterling-claude-code-scale-down-boundary (h20-mechanism-axis.mjs:435-441),
// so the question surface is a post-answer audit here too.
//
// H23: after a completed read or shell call, the tool's own output is matched
// against anti_patterns with the same floors; one advisory pointer line plus the
// remainder count is appended. A read of territory an article owns is skipped (H19
// delivers it), as are VCS and listing commands.
//
// The composition (the floors, the headers, the blocks, and the H23 pointer block) is scripts/hooks/lib/axis-compose.mjs, the one copy the
// two hooks call too; this file keeps only the OpenCode plumbing.
//
// Tool names: subagent {agent, description, prompt, ...} and question {questions}
// were read from ctx.tool.list and the OpenCode 2.0.21 binary.
import { isAbsolute, resolve } from 'node:path';
import { repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { recordAdvisoryFire } from '../../../scripts/hooks/lib/advisory-counter.mjs';
import { composeMechanismAxis, composeOutputAxis, outputAxisReadGated } from '../../../scripts/hooks/lib/axis-compose.mjs';
import { dispatchOverlapNotice } from '../../../scripts/hooks/lib/dispatch-overlap.mjs';
import { agentRole } from './agent-name.mjs';
import { isListingCommand } from '../../../scripts/hooks/lib/listing-command.mjs';
import { guardPath, markDiscoveryDelivered, markSubstanceDelivered, outgoingProposalText, readGuard, writeGuard } from '../../../scripts/hooks/lib/delivery.mjs';
import { appendToResult } from './delivery.mjs';
import { dispatchOverpass, missingRouteRefusal, overpassRefusal, overpassUnknownLine, readInventory, routeAvailability, unknownRouteLine } from './overpass.mjs';
import { checkVariant, dispatchModel } from './dispatch-model.mjs';
import { logLine } from './log.mjs';
import { addNotice } from './notices.mjs';
import { appendPendingAnswer, entryFromOpenCode } from '../../../scripts/hooks/lib/pending-answers.mjs';
import { openSubjectFan, warnFanDegraded } from '../../../scripts/hooks/lib/subject-fan.mjs';

const PENDING_CAP = 200;
// How long a dispatch waits for OpenCode's model list before the variant guard gives up
// (checkVariant then marks the variant "not checked"), so a list that never settles
// cannot stall a dispatch; the same race-with-timer shape as context.mjs sendSynthetic.
export const MODEL_LIST_TIMEOUT_MS = 2000;

/** listModels() raced against `ms`: { list } or { error }; never throws, never waits longer than `ms`. */
export async function boundedModelList(listModels, ms) {
  let timer;
  try {
    const call = Promise.resolve(listModels?.()).then((list) => ({ list }));
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ error: new Error(`the model list timed out after ${ms} ms`) }), ms);
    });
    return await Promise.race([call, late]);
  } catch (e) {
    return { error: e };
  } finally {
    clearTimeout(timer);
  }
}

/** Which H20 surface a tool call is on, or null. */
export function axisSurface(tool) {
  if (tool === 'subagent') return 'dispatch';
  if (tool === 'question') return 'question';
  return null;
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
    if (outputAxisReadGated(store, rel, root)) return null;
  }
  const gPath = guardPath(root, undefined, sessionID);
  const composed = composeOutputAxis(store, { content, guardFor: () => readGuard(gPath) });
  if (!composed) return null;
  const { text, guard, seen, shown } = composed;
  return {
    text,
    commit: () => {
      recordAdvisoryFire(root, 'h23', sessionID);
      if (!gPath) return;
      guard.output_axis = [...seen, ...shown.map((x) => x.record.id)];
      writeGuard(gPath, guard);
    },
  };
}

/** `message` into the plugin log, or onto stderr when the log cannot be written. */
function reportOverpass(root, message) {
  try {
    logLine(root, `axis: ${message}`);
  } catch (reportError) {
    process.stderr.write(`[sterling] ${message} (and the plugin log is unwritable: ${reportError?.message ?? reportError})\n`);
  }
}

/**
 * The axis handlers: onBefore (H20), onAfter
 * (appends the H20 carriage built before), outputOf and onOutput (H23). Take
 * outputOf(input) before any handler appends to the result, so only the tool's
 * own output is matched, and call onOutput(input, output) after the file
 * delivery has written its guard, because H23 reads the guard fresh and a
 * delivery commit writes back the guard it read before the call.
 * `deliveryPolicy` (delivery-policy.mjs) gates H23 only. H20 is left on: it
 * delivers to the session that makes the call, so it reaches a blind lane only
 * when that lane dispatches (decision blind-lane-sterling-delivery-off-brief-line, point 6).
 */
export function createAxisHandlers({ openStore, rootOf, directory, fenced, deliveryPolicy, listModels, modelListTimeoutMs = MODEL_LIST_TIMEOUT_MS }) {
  if (!deliveryPolicy) throw new Error('createAxisHandlers needs the deliveryPolicy tracker');
  const pending = new Map();

  async function onBefore(input) {
    const surface = axisSurface(input?.tool);
    if (!surface) return;
    const root = rootOf();
    if (!root) return;
    const args = input.input && typeof input.input === 'object' ? input.input : {};
    let pinLine = null;
    if (surface === 'dispatch') {
      // The model step (dispatch-model.mjs): a config whose model settings cannot be carried
      // (an invalid overpass block or legacy value) is never guessed at: the call is REFUSED
      // by a throw out of execute.before, outside the fence (OpenCode's documented way for a
      // plugin to block a tool call). A whole config that cannot be read or parsed does not
      // refuse: the call goes ahead on its own model and carries a loud UNKNOWN line.
      // Applied before the carriage.
      let read;
      try {
        read = dispatchOverpass(root);
      } catch (e) {
        const message = overpassRefusal(e);
        reportOverpass(root, message);
        throw new Error(message, { cause: e });
      }
      if (read.unreadable) {
        pinLine = overpassUnknownLine(read.unreadable);
        reportOverpass(root, pinLine);
      } else {
        // A role with two models not yet chosen throws and refuses the dispatch the same way.
        let pin;
        try {
          pin = dispatchModel(read.routing, args);
        } catch (e) {
          reportOverpass(root, e.message);
          throw e;
        }
        // The availability check (overpass.mjs readInventory): a tier route OpenCode does not
        // list refuses the dispatch before it starts, with the fix steps; a list that cannot
        // be read sends the dispatch to its tier unchecked, with an UNKNOWN line. A call that
        // named its own model (pin.model null) keeps it and is not checked here.
        if (pin.overpass && pin.model) {
          const route = routeAvailability(readInventory(await boundedModelList(listModels, modelListTimeoutMs)), pin.model);
          if (route.state === 'missing') {
            const message = missingRouteRefusal(read.res, args.agent, pin.model, route.why);
            reportOverpass(root, message);
            throw new Error(message);
          }
          if (route.state === 'unknown') {
            const line = unknownRouteLine(pin.model, route.why);
            reportOverpass(root, line);
            pin = { ...pin, line: [pin.line, line].filter(Boolean).join(' ') };
          }
        }
        // A resolved model whose variant OpenCode does not list runs without it (checkVariant).
        if (pin.resolved) {
          const { list, error } = await boundedModelList(listModels, modelListTimeoutMs);
          const checked = checkVariant(pin.model, list, error);
          pin = { ...pin, model: checked.model, line: checked.note ? `${pin.line} ${checked.note}` : pin.line };
        }
        if (pin.model && input.input && typeof input.input === 'object') input.input.model = pin.model;
        pinLine = pin.line;
        // A notice (an invalid config.models value) is also told to the conductor's session, so it stays visible beyond the one result.
        if (pin.notice) {
          reportOverpass(root, pin.notice);
          await fenced('axis', root, () => addNotice(root, pin.notice));
        }
      }
    }
    const overlap =
      surface === 'dispatch'
        ? dispatchOverlapNotice({ tool_input: { subagent_type: agentRole(args.agent), prompt: args.prompt }, cwd: root, session_id: input.sessionID })
        : null;
    let built = null;
    await fenced('axis', root, () => {
      const outgoing = outgoingProposalText(args);
      if (!outgoing) return;
      const gPath = guardPath(root, undefined, input.sessionID);
      // The subject fan: the project store plus the mounted domains, each opened with this plugin's opener.
      const store = openSubjectFan(root, { opener: openStore });
      if (!store) return;
      try {
        const composed = composeMechanismAxis(store, {
          root,
          outgoing,
          toolInput: args,
          surface,
          subagentType: args.agent,
          guardFor: () => readGuard(gPath),
          pinLine,
          overlap,
          host: 'opencode',
        });
        if (composed) {
          const { assembled, guard } = composed;
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
        warnFanDegraded(store, 'H20');
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

  /** Keeps a completed question form as a pending answer (scripts/hooks/lib/pending-answers.mjs); a dismissed form is status 'error' and adds nothing. */
  async function onAnswers(input) {
    if (input?.tool !== 'question') return;
    const root = rootOf();
    if (!root) return;
    await fenced('axis', root, () => {
      const entry = entryFromOpenCode(input);
      if (entry) appendPendingAnswer(root, entry);
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
    await fenced('axis', root, async () => {
      // H23 is a store delivery too: a session whose STERLING-DELIVERY policy is not 'on'
      // gets its notice once and no hazard pointer (delivery-policy.mjs).
      const policy = await deliveryPolicy.resolve(root, input.sessionID);
      if (policy !== 'on') {
        const notice = deliveryPolicy.disclose(input.sessionID, policy);
        if (notice) appendToResult(input.result, notice);
        return;
      }
      const store = openSubjectFan(root, { opener: openStore });
      if (!store) return;
      let block;
      try {
        block = buildOutputAxis(store, root, { tool: input.tool, args: input.input ?? {}, content, sessionID: input.sessionID, directory: directory() });
      } finally {
        store.close();
        warnFanDegraded(store, 'H23');
      }
      if (!block) return;
      appendToResult(input.result, block.text);
      block.commit();
    });
  }

  return { onBefore, onAfter, onAnswers, outputOf, onOutput };
}
