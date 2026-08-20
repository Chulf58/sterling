// MCP wiring (spec §10): thin layer over SterlingTools. Tool handlers throw on
// protocol violations; the SDK returns those in-band (isError) so callers —
// including spawned agents — see the message and self-correct (§5.2).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, resolveDomainMounts } from '@sterling/store';
import { SterlingTools } from './tools.js';

const passthrough = z.object({}).passthrough();

/**
 * Every tool's TOP-LEVEL parameters are STRICT: an unknown key is a loud
 * validation error, never a silent drop (P5).
 *
 * The SDK builds `z.object(shape)` from a raw shape, and zod's default object
 * mode STRIPS unknown keys — so a caller using a plausible-but-wrong parameter
 * name got a successful call with its argument silently discarded. Measured
 * 2026-07-29: knowledge_query called with {query, limit} — neither is a real
 * parameter — returned a normal unfiltered window, and a sibling conductor
 * reasoned from it three times as though it were the whole store. The served
 * JSON Schema said additionalProperties:false the whole time, so the surface was
 * advertising a contract it did not enforce.
 *
 * A full ZodObject passes through the SDK's normalizeObjectSchema untouched
 * (verified against @modelcontextprotocol/sdk 1.29.0 — it accepts a schema OR a
 * raw shape), so .strict() survives to the parse. The SDK validates before the
 * handler runs and returns the InvalidParams error IN-BAND (isError + the zod
 * message naming the offending keys) — the same channel spawned agents already
 * self-correct from (§5.2). Record BODIES stay `passthrough`: fields /
 * body / payload / handoff carry arbitrary validated-downstream shapes, and it is
 * only the parameter names that are a closed set.
 */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export function createSterlingServer(storePath: string): { server: McpServer; store: MountedStores; tools: SterlingTools } {
  // config.json sits beside the store in .sterling/ (§12); malformed fails loud.
  // Read before opening the store: config.stack_tags is the §3.3 mount manifest.
  const configPath = join(dirname(storePath), 'config.json');
  const config = parseConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
  // §3.3: mount one shared domain store per stack tag (resolveDomainMounts) — the
  // mounted set equals the §3.4 filter set by construction.
  const store = new MountedStores(storePath, resolveDomainMounts(config));
  // store lives at <project>/.sterling/sterling.db (§2.3) — project root is two up;
  // §3.2.5 repo-located doc mtime checks resolve against it
  const tools = new SterlingTools({ store, config, repoRoot: dirname(dirname(storePath)) });
  const server = new McpServer({ name: 'sterling', version: '0.1.0' });

  const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

  server.registerTool(
    'knowledge_create',
    {
      description:
        'Create a knowledge record. Schema-validated against the registered record types; unregistered types are rejected. The echoed record defaults to its one-line digest receipt (id + headline) — the write landed either way; pass projection:"full" if you need the stored record back.',
      inputSchema: strict({ type: z.string(), fields: passthrough, projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ type, fields, projection }) => json(tools.writeProjected(tools.knowledgeCreate(type, fields), projection))
  );

  server.registerTool(
    'knowledge_query',
    {
      description:
        'Retrieve knowledge: filter (type/stack tags) → file-key join → rank (rank_terms: plain keyword array, never prose) → cap. derived_unconfirmed excluded unless include_unconfirmed. Unknown parameter names are REJECTED, never ignored. Returns {matched_filter, returned, cap, capped, records}: capped=true means you are holding a WINDOW, not the whole set. matched_filter counts the FILTER only — rank_terms order that set, they never narrow it. projection:"digest" returns one headline line per record (id + slug/title, anti_pattern trigger, research_finding clocks) instead of full bodies: use it to SEE THE LANDSCAPE cheaply — a wide digest then knowledge_get on the few that matter beats a capped full-body window you can neither complete nor trust. Query results omit the supersedes chain (see supersedes_count) and server-owned file_baselines — knowledge_get is the full-fidelity read.',
      inputSchema: strict({
        types: z.array(z.string()).optional(),
        stack_tags: z.array(z.string()).optional(),
        file_keys: z.array(z.string()).optional(),
        rank_terms: z.array(z.string()).optional(),
        include_unconfirmed: z.boolean().optional(),
        cap: z.number().int().positive().optional(),
        projection: z.enum(['full', 'digest', 'count']).optional(),
      }),
    },
    (opts) => json(tools.knowledgeQueryResult(opts))
  );

  server.registerTool(
    'knowledge_get',
    { description: 'Fetch a record by id — the full-fidelity read (query results are projected).', inputSchema: strict({ id: z.string() }) },
    ({ id }) => json(tools.knowledgeGet(id))
  );

  server.registerTool(
    'knowledge_schema',
    {
      description:
        'Ask what a record type requires BEFORE writing it, instead of learning by rejection. Returns {type, fields:[{name, required, type, enum_values?}], required[], optional[]} — derived from the registered zod schema, so it cannot drift from what a write will accept. Use it when you are unsure of a field name, whether a field is mandatory, whether it takes a string or an array of objects, or what a closed enum permits (volatility_hint is fast|medium|stable — "low" is refused). An unregistered type lists the registered ones.',
      inputSchema: strict({ type: z.string() }),
    },
    ({ type }) => json(tools.knowledgeSchema(type))
  );

  server.registerTool(
    'knowledge_retire',
    {
      description:
        'Retire a record in favour of a surviving one: sets status=superseded and superseded_by=<in_favor_of> with NO new row, so queries stop serving it while provenance and inbound links survive and it stays fetchable by id. THIS IS NOT FOR A MERELY WRONG RECORD — fix those FORWARD with knowledge_update, which supersedes the error. Use it for the one shape update cannot repair: a genuine DUPLICATE, where two records claim to describe one thing and the reader must be sent to the survivor. in_favor_of is required and must be a live record — retiring into a void or into a tombstone leaves the reader nowhere. todos are refused (they leave via board_remove / maintenance_remove, P4).',
      inputSchema: strict({ id: z.string(), in_favor_of: z.string() }),
    },
    ({ id, in_favor_of }) => json(tools.knowledgeRetire(id, in_favor_of))
  );

  server.registerTool(
    'knowledge_supersede',
    {
      description:
        'Atomically REPLACE a ruling record (decision / anti_pattern / research_finding only) with a NEW one: creates the replacement from `fields` (a COMPLETE create-shaped body, not a delta) and marks old_id superseded → the new id, in ONE transaction. Distinct from knowledge_update (a fix-forward DELTA within one lineage — pass only what changed) and knowledge_retire (a no-new-row duplicate tombstone, no replacement content). old_id resolves via the same uuid/slug/8-char-prefix ladder as knowledge_get. fields with no slug inherit the old record\'s slug so the concept handle survives; an explicit fields.slug is checked for collision like any other. ORPHAN DETECTION: when the old record\'s text enumerates 2+ numbered/bulleted rulings, a replacement that leaves any of them without substantive lexical coverage is REFUSED — naming the orphaned excerpts and both remedies (extend fields to carry the ruling forward, or re-call with orphans_acknowledged:true, which proceeds and discloses the accepted candidates). Fewer than 2 enumerated units never triggers the check. todo/feature_article/reference_material old_ids are refused, naming their real exit paths (board_remove/maintenance_remove, or knowledge_update/knowledge_retire respectively). Every refusal leaves the store untouched.',
      inputSchema: strict({ old_id: z.string(), fields: passthrough, orphans_acknowledged: z.boolean().optional() }),
    },
    ({ old_id, fields, orphans_acknowledged }) => json(tools.knowledgeSupersede(old_id, fields, orphans_acknowledged))
  );

  server.registerTool(
    'knowledge_update',
    {
      description:
        'Versioned update: writes a new version and supersedes the prior (which is retained). Never mutates in place. REPLACES each field you pass and KEEPS every field you do not — so revising what_it_does while leaving a contradicting intended_behavior ships a self-contradicting record; the result carries a warning when that shape is detected. To EXTEND an array (history, files, current_ac) without retransmitting it, use knowledge_append. The echo defaults to a one-line digest receipt (warnings kept, body dropped — you just authored it); pass projection:"full" for the whole stored record.',
      inputSchema: strict({ id: z.string(), body: passthrough, projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ id, body, projection }) => json(tools.writeProjected(tools.knowledgeUpdateResult(id, body), projection))
  );

  server.registerTool(
    'knowledge_append',
    {
      description:
        'Append entries to an ARRAY field (history, files, current_ac, live_test_refs, …) without retransmitting the whole array — the cheap path for adding a history entry to a long article. Goes through the same versioned update path, so the version bump, the retained prior version, the file_baselines re-baseline and the drift-item drain are identical. Refuses an unknown field (naming the valid set), a non-array field, an empty entry list, and links (use knowledge_link). The echo defaults to a one-line digest receipt (warnings kept) — a single full-record append echo once measured 49.8KB of content the caller had just written; pass projection:"full" for the whole stored record.',
      inputSchema: strict({ id: z.string(), field: z.string(), entries: z.array(z.unknown()), projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ id, field, entries, projection }) => json(tools.writeProjected(tools.knowledgeAppend(id, field, entries), projection))
  );

  server.registerTool(
    'knowledge_edit',
    {
      description:
        "Replace a passage INSIDE a long string field (what_it_does, intended_behavior, statement, …) without retransmitting the whole field — the string sibling of knowledge_append. 'find' must match EXACTLY ONCE: zero matches and multiple matches are both refused with the count, because a blind replace inside a field too large to read is an unreviewable write (extend 'find' with surrounding text to disambiguate). ARRAY-ELEMENT ADDRESSING: field also accepts a selector 'arr[key=value].sub' (e.g. \"files[path=scripts/prep.mjs].role\") to edit one string inside one array element — the selector must match exactly one element, same refuse-on-ambiguity contract, so a stale files[] role no longer needs a full-array retransmit. Goes through the same versioned update path as every other write, so the version bump, retained prior version, baseline re-baseline and drift-item drain are identical. The echo defaults to a one-line digest receipt (warnings + replaced counts kept — chars_before/chars_after prove the edit landed); pass projection:\"full\" for the whole stored record.",
      inputSchema: strict({ id: z.string(), field: z.string(), find: z.string(), replace: z.string(), projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ id, field, find, replace, projection }) => json(tools.writeProjected(tools.knowledgeEdit(id, field, find, replace), projection))
  );

  server.registerTool(
    'knowledge_promote',
    {
      description:
        'Promote a project-scoped record into a mounted domain store (§3.3): copies it to the domain (scope domain:<name>, informed_by the origin) and retires the project original as a superseded tombstone pointing at the copy. feature_article (always project) and todo never promote; an unmounted target domain is rejected. Draining any matching promotion_review is the review outcome.',
      inputSchema: strict({ id: z.string(), domain: z.string() }),
    },
    ({ id, domain }) => json(tools.knowledgePromote(id, domain))
  );

  server.registerTool(
    'board_add',
    {
      description:
        'Add a task to the board (source: user) or the maintenance queue (source: system, requires system_reason). EVERY user-source add answers parentage via `objective` (decision a8d2ce6c): when the task is a SLICE of a larger objective — the conductor slicing a big ask mints one board_add per slice, all sharing the objective name — pass objective:"<name>"; a freestanding task passes objective:"standalone" (exact lowercase, stored as ungrouped). The TUI groups slices under their objective, so declared parentage is what keeps the board readable as N objectives instead of N×slices. Omitting objective never loses the task — it saves ungrouped with a loud notice, and board_update can group it later. system-source items never take an objective (lane-keyed by system_reason). The echoed item defaults to its one-line digest; pass projection:"full" for the stored record.',
      inputSchema: strict({
        text: z.string(),
        source: z.enum(['user', 'system']),
        objective: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        feature_link: z.string().optional(),
        system_reason: z.string().optional(),
        stack_tags: z.array(z.string()).optional(),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ projection, ...args }) => json(tools.writeProjected(tools.boardAdd(args), projection))
  );

  server.registerTool(
    'board_query',
    {
      description:
        'List open board items. source=user is the board; source=system is the maintenance queue. contains narrows to items whose text contains that substring (case-insensitive, literal — never FTS5 query syntax). Returns {matched_filter, returned, cap, capped, records}: capped=true means more items matched than are shown — raise cap before concluding the board or queue is shorter than it is. projection:"digest" returns one clipped line per item instead of its full text — board items run to several KB each, so prefer it for auditing or triaging the whole board and read the full text only for the items you act on.',
      inputSchema: strict({
        source: z.enum(['user', 'system']).optional(),
        file_keys: z.array(z.string()).optional(),
        contains: z.string().optional(),
        cap: z.number().int().positive().optional(),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    (args) => json(tools.boardQueryResult(args))
  );

  server.registerTool(
    'board_remove',
    {
      description:
        "Remove a task — the only way items leave the board (done = removed, bound to the artifact-write). The result discloses artifact_evidence: durable records touching the item's file_keys written since the item was created. An empty list means the close rides YOUR word — legitimate for genuine abandonment, drift if work fulfilled the item and its capture is missing.",
      inputSchema: strict({ id: z.string() }),
    },
    ({ id }) => json(tools.boardRemove(id))
  );

  server.registerTool(
    'maintenance_remove',
    {
      description:
        "Remove a MAINTENANCE-QUEUE item (source:'system') once its fulfilling artifact exists — board_remove narrowed to the queue, so an agent that drains the queue can close what it drains. Refuses user-source board items: that board is the human's own surface and is not an agent's to clear. Removals are logged to the §3.2.7 drain-log audit trail exactly as board_remove's are, and the result discloses the same artifact_evidence (durable records touching the item's file_keys since its creation) — an empty list on a drain means verify against HEAD before closing.",
      inputSchema: strict({ id: z.string() }),
    },
    ({ id }) => json(tools.maintenanceRemove(id))
  );

  server.registerTool(
    'board_update',
    {
      description:
        'IN-PLACE edit of a board/queue item — text/priority/file_keys/objective only, id stable, no new version is minted. Updating an item never closes it: board_remove, bound to the fulfilling artifact-write, remains the only way an item leaves the board (P4). objective (re)groups a task under a larger objective (decision a8d2ce6c — the remedy for a slice saved ungrouped or a late-discovered slice); objective:"standalone" un-groups it. Only todo records are editable this way; source/system_reason/status/id and every other field are refused by name (they decide which surface an item lives on, or are server-owned). At least one updatable field is required. The echoed item defaults to its one-line digest — board items run to several KB and you just wrote the change; pass projection:"full" for the stored record.',
      inputSchema: strict({
        id: z.string(),
        text: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        file_keys: z.array(z.string()).optional(),
        objective: z.string().optional(),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, projection, ...patch }) => json(tools.writeProjected(tools.boardUpdate(id, patch), projection))
  );

  server.registerTool(
    'board_get',
    {
      description:
        'Fetch a board/queue item by id — the full, untruncated record (board_query\'s projection:"digest" clips text; this is the escape hatch back to the whole item). Resolves through the same ladder as knowledge_get: full uuid, exact slug, or an unambiguous 8-char citation prefix. An unknown id is refused, naming the id that was not found.',
      inputSchema: strict({ id: z.string() }),
    },
    ({ id }) => json(tools.boardGet(id))
  );

  server.registerTool(
    'board_edit',
    {
      description:
        'Replace a passage INSIDE a board/queue item\'s text without retransmitting the whole field — knowledge_edit\'s exactly-once find/replace contract, but IN PLACE: id stable, no new version minted (decision a91c80b5 — board_update\'s identity semantics, not knowledge_update\'s supersession). \'find\' must match EXACTLY ONCE: zero matches and multiple matches are both refused, naming the count, with nothing written. Works identically on a user task or a system maintenance item. The echo defaults to a one-line digest receipt; pass projection:"full" for the whole stored record.',
      inputSchema: strict({ id: z.string(), find: z.string(), replace: z.string(), projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ id, find, replace, projection }) => json(tools.writeProjected(tools.boardEdit(id, find, replace), projection))
  );

  server.registerTool(
    'no_capture',
    {
      description:
        "Declare that this session's direct-mode work produced NOTHING durable — satisfies H10's capture duty for every touch/debug event EARLIER than the declaration (later work re-arms it). A false declaration is drift, not a bypass: the reason is register-recorded. If a capture EXISTS and is merely landing later, use capture_pending instead. Replaces hunting for scripts/no-capture.mjs in the plugin clone; the script remains the no-server fallback.",
      inputSchema: strict({ reason: z.string() }),
    },
    ({ reason }) => json(tools.noCapture(reason))
  );

  server.registerTool(
    'concept_designed',
    {
      description:
        "Register that a domain concept FAMILY's design SETTLED this session (decision 7208729b) — H10 then demands the family's concept article (feature_article with concept_family) before the session ends, deferring to a concept_article_missing queue item if unmet. Pass the family slug(s). Replaces node scripts/concept-designed.mjs; the script remains the no-server fallback.",
      inputSchema: strict({ families: z.array(z.string()).min(1) }),
    },
    ({ families }) => json(tools.conceptDesigned(families))
  );

  server.registerTool(
    'capture_pending',
    {
      description:
        "Declare that a capture EXISTS and its write is IN FLIGHT on a named target — a pending gated commit, a dispatched agent, a lane. H10 then defers the capture duty instead of nagging: the registers survive one Stop so the landed write settles the duty cleanly, and a still-pending duty on the next Stop becomes ONE deduped capture_owed item citing the target. Use this instead of a boilerplate no_capture when the truth is 'captured, landing later' — pending work defers or lands on the queue, it never evaporates.",
      inputSchema: strict({ target: z.string(), reason: z.string() }),
    },
    ({ target, reason }) => json(tools.capturePending(target, reason))
  );

  server.registerTool(
    'run_state',
    {
      description: 'Current run record — the conductor source of truth for run state (re-read after compaction; never trust recall).',
      inputSchema: strict({ run_id: z.string().optional() }),
    },
    ({ run_id }) => json(tools.runState(run_id))
  );

  server.registerTool(
    'agent_exit',
    {
      description:
        'The exit wire (never prose): record your typed exit signal + payload before finishing. Signals: complete{handoff_ref} | research-needed{question,context,blocking} | review-unresolved | blocked{reason} | tests-invalid{evidence} | contract-violated{path,rule} | bug-found{description,location,depends_on_current_work,workaround_built} | phase-overflow{agent,fill_pct}. agent-died is conductor-reported, never agent-emitted. Invalid signal or payload is rejected — correct and re-call.',
      inputSchema: strict({
        run_id: z.string().optional(),
        phase_id: z.string(),
        agent_role: z.string(),
        signal: z.string(),
        payload: passthrough.optional(),
      }),
    },
    (args) => json(tools.agentExit(args))
  );

  server.registerTool(
    'run_signal',
    {
      description:
        "The brain: computes the reaction to the recorded exit and returns the next action; the conductor executes exactly that. Routing (§5.2): abnormal exits come here immediately; normal 'complete' only at the PHASE BOUNDARY — intra-phase completes are consumed via scripts/consume-exit.mjs as the next §8.1 step, never signalled here.",
      inputSchema: strict({
        run_id: z.string().optional(),
        exit: strict({ signal: z.string(), payload: passthrough.optional(), phase_id: z.string().optional(), agent_role: z.string().optional() }).optional(),
      }),
    },
    (args) => json(tools.runSignal(args))
  );

  server.registerTool(
    'knowledge_link',
    {
      description: 'Add a typed link between records: cites | informed_by | fulfills | supersedes.',
      inputSchema: strict({ from: z.string(), rel: z.string(), to: z.string() }),
    },
    ({ from, rel, to }) => json(tools.knowledgeLink(from, rel, to))
  );

  server.registerTool(
    'knowledge_preflight',
    {
      description:
        'Ask "does the store govern this subject?" BEFORE dispatching or designing — verify a brief or design agenda against store targets instead of discovering a governing record only after the work has gone wrong. Reuses the H20 delivery floors (axis-term extraction + record centrality) over anti_pattern + decision + feature_article + research_finding records. Pass ONE of: text (a single subject) or texts (an agenda — one verdict row per question, in order). Verdicts: "insufficient" means too little extractable vocabulary to judge at all (reason:"too_little_vocabulary"); "verify_targets" means the store governs this subject — verify against the named matches (open the records; a match row is a lookup, never the source); "ungoverned" means nothing in the store governs it (a genuinely open question). Single-text returns {terms, matches:[{id,type,title,matched_on,central}], answerability}; texts returns {verdicts:[{text, ...same}]}.',
      inputSchema: strict({ text: z.string().optional(), texts: z.array(z.string()).optional() }),
    },
    ({ text, texts }) => {
      if ((text === undefined) === (texts === undefined)) {
        throw new Error(`knowledge_preflight: pass exactly ONE of 'text' (single subject) or 'texts' (agenda)`);
      }
      return json(texts !== undefined ? tools.knowledgePreflightBatch(texts) : tools.knowledgePreflight(text as string));
    }
  );

  server.registerTool(
    'run_escalate',
    {
      description: 'Surface a judgment branch / typed escalation onto the active run record.',
      inputSchema: strict({ payload: passthrough }),
    },
    ({ payload }) => json(tools.runEscalate(payload))
  );

  // maintenance_enqueue is deliberately NOT wire-registered (decision
  // 6269b714, todo-stays-one-type…keep): system items are minted only by
  // registered detection events through the server-internal
  // tools.maintenanceEnqueue / enqueueSystemTodo choke point. The wire tool
  // had zero legitimate external callers and was the route by which agents
  // gamed source/system_reason to hand-park work as store maintenance.

  server.registerTool(
    'maintenance_query',
    {
      description:
        'List open maintenance-queue items (system todos), optionally by system_reason, file keys, contains (substring narrowing on text, case-insensitive, literal — never FTS5 query syntax), or feature_slug (narrows to items owned by ONE article, resolved from its slug and CHAIN-AWARE — an item raised against an earlier superseded version of the article still matches; every filter combines as a genuine AND). An unresolvable feature_slug narrows to nothing rather than erroring. Returns {matched_filter, returned, cap, capped, records}: capped=true means the queue is DEEPER than what is shown — a drain that stops at the cap leaves the tail behind, so raise cap until capped is false. projection:"digest" returns one clipped line per item (with its system_reason lane) — the cheap way to size and sort a deep queue before draining it.',
      inputSchema: strict({
        system_reason: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        contains: z.string().optional(),
        feature_slug: z.string().optional(),
        cap: z.number().int().positive().optional(),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    (args) => json(tools.maintenanceQueryResult(args))
  );

  server.registerTool(
    'handoff_write',
    {
      description: 'Write your phase handoff (schema-validated). Run-scoped transient state — never enters the durable store.',
      inputSchema: strict({ run_id: z.string().optional(), handoff: passthrough }),
    },
    (args) => json(tools.handoffWrite(args))
  );

  server.registerTool(
    'handoff_read',
    {
      description: 'Read handoffs for a phase, or those touching the given files.',
      inputSchema: strict({ run_id: z.string().optional(), phase_id: z.string().optional(), files: z.array(z.string()).optional() }),
    },
    (args) => json(tools.handoffRead(args))
  );

  return { server, store, tools };
}
