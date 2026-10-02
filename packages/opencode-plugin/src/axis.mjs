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
        const pin = codexModelPin(root, { opener: CODEX_OPENERS.has(input.tool), toolInput: args });
        if (pin.model && input.input && typeof input.input === 'object') input.input.model = pin.model;
        pinLine = pin.line;
      });
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
    await fenced('axis', root, () => {
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
