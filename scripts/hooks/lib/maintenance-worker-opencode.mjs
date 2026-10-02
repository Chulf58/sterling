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
// NOT MEASURED: denying built-in tools on a paid model. On the free model
// opencode/big-pickle, any built-in deny made the provider answer 403
// FreeTierError, so a free-tier worker run fails loudly instead of running
// with write tools.
//
// DEPENDENCY-FREE (node builtins only), like maintenance-worker.mjs.

const SERVER = 'sterling';

/** Built-in OpenCode tools the worker must not use. execute (the MCP code-mode
 *  tool), read, grep and glob stay allowed. The names come from ctx.tool.list
 *  on 2.0.21 (domain finding opencode-2-0-21-plugin-hook-capabilities-spike,
 *  knowledge_get 4ec729f4, item f): subagent, websearch, skill and question
 *  were measured only that way; shell, edit, write and patch were also seen
 *  denied or called in live runs (finding
 *  opencode-2-0-21-tool-shapes-execpath-and-shell-store-guard-october-2026). */
export const OPENCODE_DENIED_BUILTINS = ['shell', 'edit', 'write', 'patch', 'subagent', 'webfetch', 'websearch', 'skill', 'question'];
/** The sterling write tools the claude runner denies, under OpenCode's
 *  permission key for an MCP tool (<server>_<tool>). knowledge_line_ref_fix and
 *  maintenance_remove stay allowed, as on the claude runner. */
export const OPENCODE_DENIED_MCP = [
  ...['create', 'update', 'append', 'edit', 'array_remove', 'retire', 'supersede', 'split', 'extract', 'promote', 'link'].map((v) => `${SERVER}_knowledge_${v}`),
  ...['add', 'remove', 'update', 'edit'].map((v) => `${SERVER}_board_${v}`),
  `${SERVER}_config_set`,
];

/** Appended to the shipped prompt on this host: the prompt names the claude
 *  tool names, and per-call result text needs one sterling call per execute. */
export const OPENCODE_PROMPT_NOTE =
  '\nHOST NOTE (OpenCode): the sterling tools named above are called inside the execute tool as tools.sterling.<name>, for example tools.sterling.knowledge_get({ id }). Make exactly ONE sterling call per execute call, so the runner can pair each call with its own result. Read is the read tool ({ path }) and Grep is the grep tool ({ pattern, path }).\n';

/** The OpenCode config for the child (passed as OPENCODE_CONFIG_CONTENT):
 *  the sterling MCP server from the plugin's wiring (`mcpConfig` is the JSON
 *  resolveMcpConfig returns), the deny list, and the model. runWorker refuses
 *  before this without a model (decision
 *  opencode-maintenance-worker-refuses-without-a-configured-model). */
export function buildOpencodeConfig({ mcpConfig, model = null }) {
  const entry = JSON.parse(mcpConfig).mcpServers[SERVER];
  const permission = Object.fromEntries([...OPENCODE_DENIED_BUILTINS, ...OPENCODE_DENIED_MCP].map((k) => [k, 'deny']));
  return { mcp: { [SERVER]: { type: 'local', command: [entry.command, ...entry.args], enabled: true } }, permission, ...(model ? { model } : {}) };
}

/** `opencode run` argv. --standalone runs a private server (no background
 *  service, no port); --auto approves what is not explicitly denied, so the
 *  run never waits on a prompt nobody will answer. */
export function buildOpencodeArgs({ prompt, model = null }) {
  return ['run', '--standalone', '--format', 'json', '--auto', ...(model ? ['--model', model] : []), prompt];
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

const fixEntry = (input, is_error, result) => ({ kind: 'tool_call', tool: 'knowledge_line_ref_fix', article_id: input.id ?? null, field: input.field ?? null, find: input.find ?? null, replace: input.replace ?? null, anchor: input.anchor ?? null, is_error, result });

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
  const out = { result: null, removes: 0, closedOk: 0, lineRefFixes: 0, lineRefFixesOk: 0, lines: 0, mcpStatus: null, sterlingOk: 0 };
  const texts = [];
  let lastTextMessage = null;
  let cost = 0;
  let costSeen = false;
  let error = null;
  // `executeFailed`: the OUTER execute ended in error, so the model got the
  // execute's error text and never saw this call's output. A write it made
  // (a remove, a line-ref fix) still happened server-side and counts; a read
  // is never evidence (task-end review 2026-10-02).
  const sterlingCall = (name, input, is_error, text, executeFailed) => {
    const ok = is_error === false;
    const resultText = executeFailed && ok ? `the execute failed after this call completed: ${text}` : text;
    const marked = executeFailed ? { execute_failed: true } : {};
    if (name === 'maintenance_remove') {
      if (is_error === null) {
        journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error: null, result: 'no result before the run ended' });
        return;
      }
      journal({ kind: 'tool_call', tool: 'maintenance_remove', item_id: input.id ?? null, item_file_keys_at_launch: keysAtLaunch(input.id), is_error, result: resultText.slice(0, 400), ...marked });
      out.removes++;
      if (ok) {
        out.closedOk++;
        out.sterlingOk++;
      }
      return;
    }
    if (name === 'knowledge_line_ref_fix') {
      journal({ ...fixEntry(input, is_error, is_error === null ? 'no result before the run ended' : resultText.slice(0, 400)), ...marked });
      if (is_error === null) return;
      out.lineRefFixes++;
      if (ok) {
        out.lineRefFixesOk++;
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
        for (const c of ours) {
          const name = String(c.tool).slice(SERVER.length + 1);
          const innerFinished = c.status === 'completed' || c.status === 'error';
          const is_error = finished && innerFinished ? c.status === 'error' : null;
          sterlingCall(name, c.input ?? {}, is_error, text, status === 'error');
        }
        return;
      }
      if (status !== 'completed') return;
      if (part.tool === 'read' && input.path) observe('Read', { file_path: String(input.path) });
      else if (part.tool === 'grep') observe('Grep', input.path ? { path: String(input.path) } : {});
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
