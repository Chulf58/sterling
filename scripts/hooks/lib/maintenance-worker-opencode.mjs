// OPENCODE RUNNER for the background maintenance worker (board item Parity P8;
// decision sterling-is-fully-standalone-on-opencode-2-full-parity-with-claude-code:
// "the maintenance worker gets an OpenCode-based runner when `claude` is absent").
// runWorker (maintenance-worker.mjs) uses this when the launcher chose the
// 'opencode' host: it builds the `opencode run` argv and config, and parses the
// run's JSON event stream into the same journal entries and evidence calls the
// claude stream-json parser produces, so the SAME evidence gate judges both
// (anti_pattern trusting-a-headless-agents-self-reported-verdict-to-change-durable-state).
//
// MEASURED on OpenCode 2.0.21, `opencode run --standalone --format json`, with the
// sterling MCP as a local server (fixture scripts/tests/fixtures/opencode-run-events.jsonl):
// - One `tool_use` event per FINISHED tool call: part.state.status is
//   'completed' (with output) or 'error' (with error). The call and its result
//   arrive in the same event, keyed by part.id.
// - MCP tools run in code mode: the model calls tools.sterling.<name>(...) inside
//   the `execute` tool, and part.state.metadata.metadata.toolCalls lists each
//   inner call as {tool: 'sterling.<name>', status, input}. The outer execute can
//   be 'completed' while an inner call is 'error' (the model caught it), so the
//   inner status is what counts.
// - Built-in tools: read {path}, grep {pattern, path}.
// - Final text arrives as `text` events; step_finish carries part.cost; a
//   provider failure is a top-level `error` event and the process exits 1.
// - The session directory follows the PWD environment variable, not the spawn
//   cwd, so the runner sets PWD to the project root.
// - permission {"sterling_<tool>": "deny"} removes that MCP tool from the code-mode
//   catalog ("Unknown tool 'sterling.<tool>'").
// - On 2.0.22 a top-level permission does not bind the run: the default
//   agent's own rules win (see OPENCODE_WORKER_AGENT), so the run uses its own
//   agent with an allow-list.
// On the free model opencode/big-pickle, any built-in deny made the provider
// answer 403 FreeTierError, so a free-tier worker run fails loudly instead of
// running with write tools.
//
// DEPENDENCY-FREE (node builtins only), like maintenance-worker.mjs. The import
// below is a cycle with that module; only functions are used, and only at call
// time, so neither module reads the other's bindings while it loads.
import { knowledgeWriteName, writeEntry } from './maintenance-worker.mjs';

const SERVER = 'sterling';

/** The worker's own agent. MEASURED on 2.0.22 (board item d1149d0e): a
 *  top-level permission deny does not hold, because the child runs as the
 *  user's default agent (default_agent in the global config, here a conductor
 *  with shell and subagent allowed) and that agent's rules come later, and the
 *  last matching rule wins. With the deny list at the top level, shell ran and
 *  wrote a file; under `--agent build` the same config removed shell and
 *  subagent. So the run names this agent, defined in OPENCODE_CONFIG_CONTENT. */
export const OPENCODE_WORKER_AGENT = 'sterling-maintenance-worker';
/** Everything the worker may call, as OpenCode permission keys: execute (the
 *  MCP code-mode tool), mcp (measured on 2.0.22: under '*' deny, no MCP tool
 *  reaches the code-mode catalog without it, even one allowed by its own key;
 *  it does not allow the tools themselves), read and grep, webfetch and
 *  websearch (OpenCode's own web tools: parity with the claude host's
 *  WebFetch/WebSearch, decision change (vii)), and the sterling tools the
 *  claude host's --allowedTools grants (an MCP tool's key is <server>_<tool>). */
export const OPENCODE_ALLOWED_TOOLS = [
  'execute',
  'mcp',
  'read',
  'grep',
  'webfetch',
  'websearch',
  ...['maintenance_query', 'knowledge_get', 'maintenance_remove', 'knowledge_line_ref_fix', 'knowledge_update', 'knowledge_edit', 'knowledge_append', 'knowledge_array_remove', 'knowledge_query', 'knowledge_schema'].map((v) => `${SERVER}_${v}`),
];
/** The allow-list: '*' denied first, then each allowed key (last match wins),
 *  so a tool OpenCode adds later is denied by default. */
const workerPermission = () => ({ '*': 'deny', ...Object.fromEntries(OPENCODE_ALLOWED_TOOLS.map((k) => [k, 'allow'])) });

/** Appended to the shipped prompt on this host: the prompt names the claude
 *  tool names, and per-call result text needs one sterling call per execute. */
export const OPENCODE_PROMPT_NOTE =
  '\nHOST NOTE (OpenCode): the sterling tools named above are called inside the execute tool as tools.sterling.<name>, for example tools.sterling.knowledge_get({ id }). Make exactly ONE sterling call per execute call and return that call\'s result unchanged as the execute\'s value, so the runner can pair each call with its own result and see the write stamp on it. Read is the read tool ({ path }), Grep is the grep tool ({ pattern, path }), WebFetch is the webfetch tool and WebSearch is the websearch tool.\n';

/** The tools sentence of templates/maintenance-worker-prompt.md, which the
 *  claude host sends unchanged. */
export const CLAUDE_TOOLS_LINE =
  'Tools you may use: mcp__sterling__maintenance_query, mcp__sterling__knowledge_get, mcp__sterling__knowledge_query, mcp__sterling__knowledge_schema, mcp__sterling__maintenance_remove, mcp__sterling__knowledge_update, mcp__sterling__knowledge_edit, mcp__sterling__knowledge_append, mcp__sterling__knowledge_array_remove, mcp__sterling__knowledge_line_ref_fix, Read, Grep, WebSearch and WebFetch. Nothing else is granted, so do not try other tools.';
/** Its OpenCode replacement. The model sees no mcp__sterling__* tool here, only
 *  `execute`: told "nothing else is granted" with the execute route mentioned
 *  only in the trailing note, openai/gpt-6-luna made no tool call in 2 of 2 live
 *  runs (board item d1149d0e), so the route comes first. MEASURED on 2.0.22:
 *  the code-mode catalog is empty when the session starts (execute's own
 *  description says no Code Mode tools) and holds the sterling tools a few
 *  seconds later, with or without the worker agent; a model that trusts the
 *  first view reports the tools missing, so the line says to retry. */
export const OPENCODE_TOOLS_LINE =
  "Tools you may use: OpenCode's `execute` tool, which is the one permitted way to reach the Sterling tools. Inside execute, call them as tools.sterling.maintenance_query, tools.sterling.knowledge_get, tools.sterling.knowledge_query, tools.sterling.knowledge_schema, tools.sterling.maintenance_remove, tools.sterling.knowledge_update, tools.sterling.knowledge_edit, tools.sterling.knowledge_append, tools.sterling.knowledge_array_remove and tools.sterling.knowledge_line_ref_fix, one Sterling call per execute call; the mcp__sterling__<name> names below are these same tools. The Sterling tools load a few seconds after the session starts, so if execute reports no Code Mode tools, read one of the item's file_keys first and then call execute again; never conclude they are unavailable before that. Read is the read tool ({ path }), Grep is the grep tool ({ pattern, path }), WebFetch is the webfetch tool and WebSearch is the websearch tool. Nothing else is granted, so do not try other tools.";

/** The OpenCode prompt: the shipped prompt with its tools line rewritten for
 *  this host, plus the host note. A prompt without the shipped tools line is
 *  refused rather than sent with only the note. */
export function opencodePrompt(prompt) {
  const parts = String(prompt).split(CLAUDE_TOOLS_LINE);
  if (parts.length !== 2) {
    throw new Error(`the worker prompt must hold the shipped tools line exactly once for the OpenCode runner to rewrite it (found ${parts.length - 1}): "${CLAUDE_TOOLS_LINE}"`);
  }
  return parts.join(OPENCODE_TOOLS_LINE) + OPENCODE_PROMPT_NOTE;
}

/** The OpenCode config for the child (passed as OPENCODE_CONFIG_CONTENT):
 *  the sterling MCP server from the plugin's wiring (`mcpConfig` is the JSON
 *  resolveMcpConfig returns), the worker agent with its allow-list (also set
 *  at the top level), and the model. runWorker refuses
 *  before this without a model (decision
 *  opencode-maintenance-worker-refuses-without-a-configured-model). */
export function buildOpencodeConfig({ mcpConfig, model = null }) {
  const entry = JSON.parse(mcpConfig).mcpServers[SERVER];
  const agent = { mode: 'primary', description: 'Sterling background maintenance worker (unattended, allow-listed tools)', permission: workerPermission(), ...(model ? { model } : {}) };
  return {
    mcp: { [SERVER]: { type: 'local', command: [entry.command, ...entry.args], enabled: true } },
    agent: { [OPENCODE_WORKER_AGENT]: agent },
    permission: workerPermission(),
    ...(model ? { model } : {}),
  };
}

/** `opencode run` argv. --standalone runs a private server (no background
 *  service, no port); --auto approves what is not explicitly denied, so the
 *  run never waits on a prompt nobody will answer; --agent picks the worker
 *  agent, so the user's default agent's rules never apply. */
export function buildOpencodeArgs({ prompt, model = null }) {
  return ['run', '--standalone', '--format', 'json', '--auto', '--agent', OPENCODE_WORKER_AGENT, ...(model ? ['--model', model] : []), prompt];
}

/** The child's environment additions. PWD picks the session directory
 *  (measured). OPENCODE_DISABLE_PROJECT_CONFIG is meant to keep the project's
 *  own OpenCode config out of the child; its effect on project config is NOT
 *  measured (the name is in the 2.0.21 binary). It does NOT keep out a global
 *  plugin: measured 2026-10-02, a plugin in the global config dir's plugins/
 *  loaded in `opencode run --standalone` with this flag set, and saw
 *  STERLING_MAINTENANCE_WORKER=1 in its process.env. The Sterling plugin is
 *  installed globally (scripts/lib/opencode-install.mjs), so it loads in the
 *  child and no-ops its settlement and worker launch on that flag, which
 *  runWorker sets in the child's environment. */
export function opencodeEnv({ root, config }) {
  return { PWD: root, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
}

/**
 * The OpenCode counterpart of streamJournal: same feed()/end() interface and
 * the same `out` shape, so runWorker's gate, journal and run summary are
 * shared. `observe(name, input)` fires only for a call whose OWN status is
 * 'completed' and, for a sterling call, whose execute also completed, with the claude tool names the gate already knows
 * (mcp__sterling__<name>, Read {file_path}, Grep {path}). `result` is
 * synthesized from the final message's text, the summed step cost and any
 * error event; it stays null when the stream held no text and no error.
 */
export function opencodeStreamJournal(journal, observe = () => {}, launchKeys = new Map()) {
  const keysAtLaunch = (id) => launchKeys.get(id) ?? null;
  let buf = '';
  const out = { result: null, removes: 0, closedOk: 0, lineRefFixes: 0, lineRefFixesOk: 0, writes: 0, writesOk: 0, lines: 0, mcpStatus: null, sterlingOk: 0 };
  const texts = [];
  let lastTextMessage = null;
  let cost = 0;
  let costSeen = false;
  let error = null;
  // `executeFailed`: the OUTER execute ended in error, so the model got the
  // execute's error text and never saw this call's output. A write it made
  // (a remove, a knowledge write) still happened server-side and counts; a
  // read is never evidence (task-end review 2026-10-02). Every journal call
  // passes the result text as a second argument for the runner's stamp check.
  const sterlingCall = (name, input, is_error, text, executeFailed, stampText = text) => {
    const ok = is_error === false;
    const resultText = executeFailed && ok ? `the execute failed after this call completed: ${text}` : text;
    const marked = executeFailed ? { execute_failed: true } : {};
    if (name === 'maintenance_remove') {
      if (is_error === null) {
        journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error: null, result: 'no result before the run ended' }, '');
        return;
      }
      journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error, result: resultText.slice(0, 400), ...marked }, stampText);
      out.removes++;
      if (ok) {
        out.closedOk++;
        out.sterlingOk++;
      }
      return;
    }
    const write = knowledgeWriteName(name);
    if (write) {
      journal({ ...writeEntry(write, input, is_error, is_error === null ? 'no result before the run ended' : resultText.slice(0, 400)), ...marked }, is_error === null ? '' : stampText);
      if (is_error === null) return;
      const fix = write === 'knowledge_line_ref_fix';
      if (fix) out.lineRefFixes++;
      else out.writes++;
      if (ok) {
        if (fix) out.lineRefFixesOk++;
        else out.writesOk++;
        out.sterlingOk++;
      }
      return;
    }
    if (ok && !executeFailed) {
      out.sterlingOk++;
      observe(`mcp__${SERVER}__${name}`, input);
    }
  };
  const handle = (e) => {
    out.lines++;
    const part = e?.part;
    if (e?.type === 'tool_use' && part?.type === 'tool') {
      const state = part.state ?? {};
      const status = state.status;
      const finished = status === 'completed' || status === 'error';
      const input = state.input ?? {};
      if (part.tool === 'execute') {
        const inner = Array.isArray(state.metadata?.metadata?.toolCalls) ? state.metadata.metadata.toolCalls : [];
        const ours = inner.filter((c) => String(c?.tool ?? '').startsWith(`${SERVER}.`));
        // OpenCode reports one output per execute, not per inner call: it is the
        // call's own result text only when the execute made exactly one call.
        const whole = String(state.output ?? state.error ?? '');
        const text = ours.length === 1 ? whole : `(execute made ${ours.length} sterling calls; OpenCode reports one combined output) ${whole}`;
        // One output cannot show which mutation a stamp in it belongs to, so
        // when an execute holds more than one mutation (a remove or a
        // knowledge write) none of them is given a stamp: each successful one
        // is an unpoliced write and the run fails closed.
        const mutates = (c) => {
          const n = String(c.tool).slice(SERVER.length + 1);
          return n === 'maintenance_remove' || knowledgeWriteName(n) !== null;
        };
        const shared = ours.filter(mutates).length > 1;
        for (const c of ours) {
          const name = String(c.tool).slice(SERVER.length + 1);
          const innerFinished = c.status === 'completed' || c.status === 'error';
          const is_error = finished && innerFinished ? c.status === 'error' : null;
          sterlingCall(name, c.input ?? {}, is_error, text, status === 'error', shared && mutates(c) ? '' : text);
        }
        return;
      }
      if (status !== 'completed') return;
      if (part.tool === 'read' && input.path) observe('Read', { file_path: String(input.path) });
      else if (part.tool === 'grep') observe('Grep', input.path ? { path: String(input.path) } : {});
      else if (part.tool === 'webfetch') observe('WebFetch', input);
      else if (part.tool === 'websearch') observe('WebSearch', input);
    } else if (e?.type === 'text' && typeof part?.text === 'string') {
      if (part.messageID !== lastTextMessage) texts.length = 0;
      lastTextMessage = part.messageID;
      texts.push(part.text);
    } else if (e?.type === 'step_finish' && Number.isFinite(Number(part?.cost))) {
      cost += Number(part.cost);
      costSeen = true;
    } else if (e?.type === 'error') {
      error = { type: String(e.error?.type ?? 'unknown'), message: String(e.error?.message ?? '') };
    }
  };
  const feedLine = (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch {
      // a non-JSON line (a CLI warning) is kept in the log only
    }
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        feedLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      feedLine(buf);
      buf = '';
      if (texts.length || error) {
        out.result = {
          type: 'result',
          subtype: error ? `error (${error.type}: ${error.message.slice(0, 200)})` : 'success',
          is_error: Boolean(error),
          result: texts.join(''),
          permission_denials: [],
          ...(costSeen ? { total_cost_usd: cost } : {}),
        };
      }
      return out;
    },
  };
}
