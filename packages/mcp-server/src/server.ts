// MCP wiring (spec §10): thin layer over SterlingTools. Tool handlers throw on
// protocol violations; the SDK returns those in-band (isError) so callers —
// including spawned agents — see the message and self-correct (§5.2).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from './tools.js';

const passthrough = z.object({}).passthrough();

export function createSterlingServer(storePath: string): { server: McpServer; store: SterlingStore; tools: SterlingTools } {
  const store = new SterlingStore(storePath);
  // config.json sits beside the store in .sterling/ (§12); malformed fails loud
  const configPath = join(dirname(storePath), 'config.json');
  const config = parseConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
  const tools = new SterlingTools({ store, config });
  const server = new McpServer({ name: 'sterling', version: '0.1.0' });

  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

  server.registerTool(
    'knowledge_create',
    {
      description: 'Create a knowledge record. Schema-validated against the registered record types; unregistered types are rejected.',
      inputSchema: { type: z.string(), fields: passthrough },
    },
    ({ type, fields }) => json(tools.knowledgeCreate(type, fields))
  );

  server.registerTool(
    'knowledge_query',
    {
      description:
        'Retrieve knowledge: filter (type/stack tags) → file-key join → rank (rank_terms: plain keyword array, never prose) → cap. derived_unconfirmed excluded unless include_unconfirmed.',
      inputSchema: {
        types: z.array(z.string()).optional(),
        stack_tags: z.array(z.string()).optional(),
        file_keys: z.array(z.string()).optional(),
        rank_terms: z.array(z.string()).optional(),
        include_unconfirmed: z.boolean().optional(),
        cap: z.number().int().positive().optional(),
      },
    },
    (opts) => json(tools.knowledgeQuery(opts))
  );

  server.registerTool(
    'knowledge_get',
    { description: 'Fetch a record by id.', inputSchema: { id: z.string() } },
    ({ id }) => json(tools.knowledgeGet(id))
  );

  server.registerTool(
    'knowledge_update',
    {
      description: 'Versioned update: writes a new version and supersedes the prior (which is retained). Never mutates in place.',
      inputSchema: { id: z.string(), body: passthrough },
    },
    ({ id, body }) => json(tools.knowledgeUpdate(id, body))
  );

  server.registerTool(
    'board_add',
    {
      description: 'Add a todo to the board (source: user) or the maintenance queue (source: system, requires system_reason).',
      inputSchema: {
        text: z.string(),
        source: z.enum(['user', 'system']),
        file_keys: z.array(z.string()).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        feature_link: z.string().optional(),
        system_reason: z.string().optional(),
        stack_tags: z.array(z.string()).optional(),
      },
    },
    (args) => json(tools.boardAdd(args))
  );

  server.registerTool(
    'board_query',
    {
      description: 'List open board items. source=user is the board; source=system is the maintenance queue.',
      inputSchema: {
        source: z.enum(['user', 'system']).optional(),
        file_keys: z.array(z.string()).optional(),
        cap: z.number().int().positive().optional(),
      },
    },
    (args) => json(tools.boardQuery(args))
  );

  server.registerTool(
    'board_remove',
    {
      description: 'Remove a todo — the only way items leave the board (done = removed, bound to the artifact-write).',
      inputSchema: { id: z.string() },
    },
    ({ id }) => json(tools.boardRemove(id))
  );

  server.registerTool(
    'run_state',
    {
      description: 'Current run record — the conductor source of truth for run state (re-read after compaction; never trust recall).',
      inputSchema: { run_id: z.string().optional() },
    },
    ({ run_id }) => json(tools.runState(run_id))
  );

  server.registerTool(
    'agent_exit',
    {
      description:
        'The exit wire (never prose): record your typed exit signal + payload before finishing. Signals: complete{handoff_ref} | research-needed{question,context,blocking} | review-unresolved | blocked{reason} | tests-invalid{evidence} | contract-violated{path,rule} | bug-found{description,location,depends_on_current_work,workaround_built} | phase-overflow{agent,fill_pct}. agent-died is conductor-reported, never agent-emitted. Invalid signal or payload is rejected — correct and re-call.',
      inputSchema: {
        run_id: z.string().optional(),
        phase_id: z.string(),
        agent_role: z.string(),
        signal: z.string(),
        payload: passthrough.optional(),
      },
    },
    (args) => json(tools.agentExit(args))
  );

  server.registerTool(
    'run_signal',
    {
      description:
        "The brain: computes the reaction to the recorded exit and returns the next action; the conductor executes exactly that. Routing (§5.2): abnormal exits come here immediately; normal 'complete' only at the PHASE BOUNDARY — intra-phase completes are consumed via scripts/consume-exit.mjs as the next §8.1 step, never signalled here.",
      inputSchema: {
        run_id: z.string().optional(),
        exit: z
          .object({ signal: z.string(), payload: passthrough.optional(), phase_id: z.string().optional(), agent_role: z.string().optional() })
          .optional(),
      },
    },
    (args) => json(tools.runSignal(args))
  );

  server.registerTool(
    'knowledge_link',
    {
      description: 'Add a typed link between records: cites | informed_by | fulfills | supersedes.',
      inputSchema: { from: z.string(), rel: z.string(), to: z.string() },
    },
    ({ from, rel, to }) => json(tools.knowledgeLink(from, rel, to))
  );

  server.registerTool(
    'run_escalate',
    {
      description: 'Surface a judgment branch / typed escalation onto the active run record.',
      inputSchema: { payload: passthrough },
    },
    ({ payload }) => json(tools.runEscalate(payload))
  );

  server.registerTool(
    'maintenance_enqueue',
    {
      description: 'Enqueue a maintenance item (system todo): reconcile_needed | stale_research | deletion_candidate | capture_owed | promotion_review | wire_in_dormant.',
      inputSchema: {
        reason: z.string(),
        text: z.string(),
        file_keys: z.array(z.string()).optional(),
        feature_link: z.string().optional(),
      },
    },
    (args) => json(tools.maintenanceEnqueue(args))
  );

  server.registerTool(
    'maintenance_query',
    {
      description: 'List open maintenance-queue items (system todos), optionally by system_reason or file keys.',
      inputSchema: {
        system_reason: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        cap: z.number().int().positive().optional(),
      },
    },
    (args) => json(tools.maintenanceQuery(args))
  );

  server.registerTool(
    'handoff_write',
    {
      description: 'Write your phase handoff (schema-validated). Run-scoped transient state — never enters the durable store.',
      inputSchema: { run_id: z.string().optional(), handoff: passthrough },
    },
    (args) => json(tools.handoffWrite(args))
  );

  server.registerTool(
    'handoff_read',
    {
      description: 'Read handoffs for a phase, or those touching the given files.',
      inputSchema: { run_id: z.string().optional(), phase_id: z.string().optional(), files: z.array(z.string()).optional() },
    },
    (args) => json(tools.handoffRead(args))
  );

  return { server, store, tools };
}
