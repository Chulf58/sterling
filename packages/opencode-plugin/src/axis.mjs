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
// On a subagent call, while Overpass is effective, the lane model replaces the call's
// model (overpass.mjs dispatchPin; finding
// opencode-2-0-23-how-session-and-subagent-models-are-chosen-and-overridden: the
// mutated model reaches execution, and an unavailable one fails as a tool error).
// A brief with an `OVERPASS-BYPASS: <reason>` line keeps the model the call names
// (decision overpass-per-dispatch-bypass-a-brief-line-overpass-bypass-re).
// While Overpass is not effective, a call that names no model gets one from
// config.models through the brief's MODEL-INTENT line (dispatch-model.mjs; decision
// subagent-model-choice-on-opencode-conductor-states-dispatch).
// H20 never denies on either host: Claude Code's deny-once rung was removed by
// decision sterling-claude-code-scale-down-boundary (h20-mechanism-axis.mjs:435-441),
// so the question surface is a post-answer audit here too.
//
// H23: after a completed read or shell call, the tool's own output is matched
// against anti_patterns with the same floors; one advisory pointer line plus the
// remainder count is appended. A read of territory an article owns is skipped (H19
// delivers it), as are VCS and listing commands.
//
// The composition (the floors, the headers, the blocks, the H23 pointer block and
// the codex model pin) is scripts/hooks/lib/axis-compose.mjs, the one copy the
// two hooks call too; this file keeps only the OpenCode plumbing.
//
// Tool names: subagent {agent, description, prompt, ...} and question {questions}
// were read from ctx.tool.list and the OpenCode 2.0.21 binary. The codex MCP tool's
// name inside execute.before is unmeasured: permission keys are `<server>_<tool>`
// (finding opencode-2-0-21-mcp-permission-key-is-server-underscore-tool) and the
// displayed name is `<server>.<tool>`, so both spellings are accepted.
import { isAbsolute, resolve } from 'node:path';
import { repoRel } from '../../../scripts/hooks/lib/common.mjs';
import { recordAdvisoryFire } from '../../../scripts/hooks/lib/advisory-counter.mjs';
import { codexModelPin, composeMechanismAxis, composeOutputAxis, outputAxisReadGated } from '../../../scripts/hooks/lib/axis-compose.mjs';
import { dispatchOverlapNotice } from '../../../scripts/hooks/lib/dispatch-overlap.mjs';
import { agentRole } from './agent-name.mjs';
import { isListingCommand } from '../../../scripts/hooks/lib/listing-command.mjs';
import { guardPath, markDiscoveryDelivered, markSubstanceDelivered, outgoingProposalText, readGuard, writeGuard } from '../../../scripts/hooks/lib/delivery.mjs';
import { appendToResult } from './delivery.mjs';
import { dispatchOverpass, dispatchPin, overpassRefusal, overpassUnknownLine } from './overpass.mjs';
import { dispatchModel } from './dispatch-model.mjs';
import { logLine } from './log.mjs';
import { addNotice } from './notices.mjs';
import { openSubjectFan, warnFanDegraded } from '../../../scripts/hooks/lib/subject-fan.mjs';

const CODEX_OPENERS = new Set(['codex_codex', 'codex.codex']);
const CODEX_TOOL = /^codex[._]/;
const PENDING_CAP = 200;

/** Which H20 surface a tool call is on, or null. */
export function axisSurface(tool) {
  if (tool === 'subagent') return 'dispatch';
  if (tool === 'question') return 'question';
  if (typeof tool === 'string' && CODEX_TOOL.test(tool)) return 'consult';
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
 * The axis handlers: onBefore (H20, including the codex model pin), onAfter
 * (appends the H20 carriage built before), outputOf and onOutput (H23). Take
 * outputOf(input) before any handler appends to the result, so only the tool's
 * own output is matched, and call onOutput(input, output) after the file
 * delivery has written its guard, because H23 reads the guard fresh and a
 * delivery commit writes back the guard it read before the call.
 * `deliveryPolicy` (delivery-policy.mjs) gates H23 only. H20 is left on: it
 * delivers to the session that makes the call, so it reaches a blind lane only
 * when that lane dispatches (decision blind-lane-sterling-delivery-off-brief-line, point 6).
 */
export function createAxisHandlers({ openStore, rootOf, directory, fenced, deliveryPolicy }) {
  if (!deliveryPolicy) throw new Error('createAxisHandlers needs the deliveryPolicy tracker');
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
        const pin = codexModelPin(root, { opener: CODEX_OPENERS.has(input.tool), toolInput: args });
        if (pin.model && input.input && typeof input.input === 'object') input.input.model = pin.model;
        pinLine = pin.line;
      });
    }
    if (surface === 'dispatch') {
      // Overpass (overpass.mjs): while effective, every subagent call runs on the lane
      // model, replacing a model the call named. An overpass block that is present but
      // invalid is never read as off: the call is REFUSED by a throw out of
      // execute.before, outside the fence (OpenCode's documented way for a plugin to block
      // a tool call), because letting it run could put it on a direct provider. A whole
      // config that cannot be read or parsed does not refuse (a hobby project that never
      // turned Overpass on keeps dispatching): the call goes ahead unrouted and carries a
      // loud UNKNOWN line. Applied before the carriage, like the codex pin.
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
        // An OVERPASS-BYPASS brief line keeps the call's model; one that cannot be honoured
        // (no model on the call, no reason) throws and refuses the dispatch the same way.
        // While Overpass is not effective, the model comes from config.models through the
        // dispatch intent instead (dispatch-model.mjs); a bad MODEL-INTENT line refuses the same way.
        let pin;
        try {
          pin = read.res.effective ? dispatchPin(read.res, args) : dispatchModel(read.config, args);
        } catch (e) {
          reportOverpass(root, e.message);
          throw e;
        }
        if (pin.model && input.input && typeof input.input === 'object') input.input.model = pin.model;
        pinLine = pin.line;
        // The bypass is also told to the conductor's session as a notice, so it stays visible beyond the one result.
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

  return { onBefore, onAfter, outputOf, onOutput };
}
