// MCP wiring (spec §10): thin layer over SterlingTools. Tool handlers throw on
// protocol violations; the SDK returns those in-band (isError) so callers —
// including spawned agents — see the message and self-correct (§5.2).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { parseConfig, NO_CAPTURE_LANES, RECORD_TYPES, objectShapeFor } from '@sterling/schemas';
import { MountedStores, resolveDomainMounts } from '@sterling/store';
import { SterlingTools, SERVER_OWNED_FIELDS, CREATE_DEFAULTED_FIELDS } from './tools.js';

const passthrough = z.object({}).passthrough();

/**
 * knowledge_create's typed `fields` body (decision foreign_7c7f6db1, probe
 * research_finding foreign_15c8e6b5) — REPLACES the passthrough with a per-type
 * z.discriminatedUnion('type', ...) derived MECHANICALLY from RECORD_TYPES, so
 * a malformed first write is refused at PARSE TIME with a variant-scoped zod
 * error instead of round-tripping through knowledgeCreate's own schema.parse.
 * knowledge_update and knowledge_supersede deliberately KEEP passthrough (see
 * the decision): update needs a hand-derived PARTIAL variant per type that
 * would drift, and the token cost of typing all three tools is ~3x this one.
 *
 * WHY THE UNION MUST BE NESTED (not the top-level tool inputSchema): a
 * z.discriminatedUnion has no `.shape`, and the SDK's tools/list handler calls
 * `normalizeObjectSchema(tool.inputSchema)` to build the served JSON Schema —
 * when that returns undefined (verified empirically against this repo's
 * installed @modelcontextprotocol/sdk 1.29.0: a top-level discriminated union
 * input schema serves as `{type:"object",properties:{}}`, EMPTY, not a bare
 * `anyOf`) the tool is served with NO schema at all, strictly worse than the
 * passthrough it replaces. Nesting the union as the VALUE of a normal object
 * property (`fields`) sidesteps this entirely: the outer object DOES have
 * `.shape`, normalizeObjectSchema succeeds on it, and zod-to-json-schema then
 * recurses into `fields` and renders the union as the bare `anyOf` research_
 * finding foreign_15c8e6b5 actually measured. This was re-verified against the
 * installed SDK build for this exact shape before settling on it.
 *
 * WHY THE DISCRIMINATOR LITERAL THEREFORE LIVES INSIDE `fields` (fields.type),
 * matching the decision's own words ("fields body BECOMES the union") and the
 * served description's hint ("Set fields.type to select one schema branch"):
 * z.discriminatedUnion requires the discriminant key to be a property of the
 * union members themselves — there is no way to discriminate `fields` by a
 * SIBLING key. This collides with a PINNED invariant this slice does not
 * own — tools.test.ts's "knowledge_schema: the whole unforgeable envelope is
 * server_owned ... (board 617e97d4)" asserts `tools.knowledgeCreate('decision',
 * {...body, type: 'decision'})` THROWS /SERVER-OWNED/ even when the value
 * MATCHES the real type, because refuseServerOwnedFields (tools.ts) refuses
 * ANY `type` key inside the fields object it receives, unconditionally. The
 * fix stays entirely on THIS side of the boundary: the tool HANDLER (below)
 * strips the now-validated `fields.type` back out — after confirming it
 * matches the outer `type` argument, so a caller who sets the two
 * inconsistently is refused loudly rather than silently routed to the wrong
 * schema — before ever calling `tools.knowledgeCreate`. tools.ts's guard never
 * sees the key; the pinned test is untouched; the discriminator still lives
 * exactly where the decision and the served schema both say it does.
 *
 * Each RECORD_TYPES schema is base.extend({...}).superRefine(...) — a
 * ZodEffects wrapping the real ZodObject — so objectShapeFor (already
 * exported by records.ts for knownFieldsFor/schemaFor) unwraps it to a raw
 * shape. The dropped superRefine refinements need no re-home at this layer:
 * knowledgeCreate re-validates every candidate against the FULL registered
 * schema server-side (schema.parse at tools.ts), which stays the authoritative
 * check — this layer only narrows the shape a well-formed request can take.
 *
 * Per variant: SERVER_OWNED_FIELDS (WRITE_REFUSED_FIELDS + version — id,
 * created_at, updated_at, status, superseded_by, type, lifecycle, freshness,
 * file_baselines, version) are DROPPED from the raw shape entirely, never
 * merely marked optional — knowledgeCreate assigns every one of them itself,
 * and a caller-supplied value would have been silently discarded (the same
 * defect refuseServerOwnedFields exists to name loudly). `type` is then
 * RE-ADDED as the per-variant z.literal discriminator the decision names.
 * CREATE_DEFAULTED_FIELDS (author/links/scope/stack_tags) are KEPT but marked
 * `.optional()` since knowledgeCreate defaults every one when absent — this
 * mirrors knowledge_schema's required/optional split exactly (decision
 * 7c7f6db1: "keep the two surfaces consistent"). `dedup_override` is a
 * create-time directive stripped by knowledgeCreate before it ever reaches a
 * record body (tools.ts), never a stored field, so it is admitted on every
 * variant as an optional boolean rather than folded into any one type's shape.
 *
 * Each variant stays `.strict()` — additionalProperties:false — so an unknown
 * field inside `fields` still refuses loudly at parse time exactly as the
 * passthrough body did via knowledgeCreate's own refuseUnknownFields; this
 * layer just makes the SAME refusal fire one step earlier, before the write
 * path is even entered, and names the type's actual allowed set in the zod
 * error rather than a generic "unknown field" message.
 *
 * Served as a bare `anyOf` (research_finding foreign_15c8e6b5 measured this against
 * the SDK's actual zod-to-json-schema conversion, re-confirmed above): each
 * variant carries its own accurate `properties` / `required[]` /
 * `type:{const:...}` literal even though the discriminator keyword itself is
 * lost, so a model can still infer the right branch, and parse-time
 * validation (the part that actually matters) is correct and variant-scoped:
 * a wrong-variant body is refused naming exactly that variant's missing/extra
 * fields, never a generic union failure.
 */
const KNOWLEDGE_CREATE_FIELD_VARIANTS = Object.keys(RECORD_TYPES).map((type) => {
  const rawShape = objectShapeFor(type);
  if (!rawShape) throw new Error(`knowledge_create input schema: '${type}' is registered but has no unwrappable object shape`);
  const defaulted = new Set(CREATE_DEFAULTED_FIELDS);
  const fieldsShape: z.ZodRawShape = {};
  for (const [key, node] of Object.entries(rawShape)) {
    if (SERVER_OWNED_FIELDS.includes(key)) continue; // dropped entirely — server-assigned, never caller-supplied
    fieldsShape[key] = defaulted.has(key) ? (node as z.ZodTypeAny).optional() : (node as z.ZodTypeAny);
  }
  // the per-variant discriminator the decision names — re-added after the
  // SERVER_OWNED_FIELDS strip above (which also matches bare 'type').
  fieldsShape.type = z.literal(type);
  // create-time directive, never a stored field (the tool handler strips it
  // before the candidate is built) — admitted on every variant, not type-specific.
  fieldsShape.dedup_override = z.boolean().optional();
  return z.object(fieldsShape).strict();
});

// z.discriminatedUnion needs a TUPLE of at least two ZodObjects at the type
// level; KNOWLEDGE_CREATE_FIELD_VARIANTS is built by a runtime .map over the
// RECORD_TYPES registry (invariant 1 — the variant LIST must never be
// hand-duplicated), so TypeScript only ever sees `ZodObject[]`. The cast is
// the seam between "derived mechanically" and "typed as a tuple"; the runtime
// assertion below is what actually protects it — a shrunk registry (< 2
// types) would make z.discriminatedUnion itself throw at import time, loud
// and immediate, never a silent single-variant union.
if (KNOWLEDGE_CREATE_FIELD_VARIANTS.length < 2) {
  throw new Error(
    `knowledge_create input schema: RECORD_TYPES registered only ${KNOWLEDGE_CREATE_FIELD_VARIANTS.length} type(s) — z.discriminatedUnion needs at least 2`
  );
}
const knowledgeCreateFieldsSchema = z.discriminatedUnion(
  'type',
  KNOWLEDGE_CREATE_FIELD_VARIANTS as unknown as [z.ZodDiscriminatedUnionOption<'type'>, ...z.ZodDiscriminatedUnionOption<'type'>[]]
);

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
 *
 * A z.discriminatedUnion is verified the SAME way, separately (decision
 * 7c7f6db1, probe research_finding foreign_15c8e6b5, re-confirmed empirically against
 * this same installed SDK build): `normalizeObjectSchema` only ever runs on
 * the TOP-LEVEL tool.inputSchema, and it requires `.shape` — a union has none,
 * so a union AS the top-level inputSchema serves EMPTY (`{properties:{}}`),
 * not a bare `anyOf`. knowledge_create's union therefore lives NESTED, as the
 * value of the `fields` property on a normal top-level ZodObject (`strict({
 * type, fields: <union>, projection })`, same as always) — the outer object
 * DOES normalize, and zod-to-json-schema then recurses into `fields` and
 * renders the union as the bare `anyOf` the probe measured (discriminator
 * keyword lost, per-variant properties/required kept accurate). For tools/call
 * parsing, the union validates as part of the outer object's own `.parse` —
 * ordinary nested-schema validation, no special-casing — and produces zod's
 * own discriminated-union behavior at that nested path: variant-scoped
 * errors, never a generic union failure. See knowledge_create's
 * KNOWLEDGE_CREATE_FIELD_VARIANTS above for the one call site that relies on
 * this, and its handler below for why `type` is validated as part of `fields`
 * (the discriminator) yet still passed to `tools.knowledgeCreate` separately.
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
        "Create a knowledge record. `fields` is typed per `type`: unknown fields are refused naming the type's allowed set; server-owned fields (id, created_at, updated_at, status, superseded_by, lifecycle, freshness, file_baselines, version) are refused. Set fields.type to select one schema branch; use only properties from that matching branch. fields.type must match the outer `type`. A colliding feature_article slug is refused. Use knowledge_schema first for an unfamiliar type. The echo defaults to a one-line digest receipt; projection:\"full\" returns the whole stored record.",
      inputSchema: strict({ type: z.string(), fields: knowledgeCreateFieldsSchema, projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ type, fields, projection }) => {
      // `fields.type` is the schema's own discriminator (see the design note
      // above for why it has to live here, not on a sibling key) — it is
      // VALIDATED as part of `fields` but is not itself a stored field, so it
      // is stripped back out here, after confirming it agrees with the outer
      // `type` argument (a caller setting the two inconsistently is refused
      // loudly rather than silently routed to whichever branch parsed).
      // tools.knowledgeCreate never sees a `type` key inside fields — its own
      // refuseServerOwnedFields guard (tools.ts) refuses that unconditionally,
      // matching (correctly) even a value equal to the real type.
      const { type: fieldsType, ...restFields } = fields as { type: string } & Record<string, unknown>;
      if (fieldsType !== type) {
        // Two causes reach this mismatch, each with its own remedy (decision
        // d0b88e27): an unregistered OUTER type (the union side is literal,
        // the outer param is a bare string) vs two registered types disagreeing.
        if (!(type in RECORD_TYPES)) {
          throw new Error(`knowledge_create: outer 'type' ('${type}') is not a registered record type — fields.type is '${fieldsType}'; registered: ${Object.keys(RECORD_TYPES).sort().join(', ')}.`);
        }
        throw new Error(`knowledge_create: outer 'type' ('${type}') does not match fields.type ('${fieldsType}') — set both to the same registered type`);
      }
      return json(tools.writeProjected(tools.knowledgeCreate(type, restFields), projection));
    }
  );

  server.registerTool(
    'knowledge_query',
    {
      description:
        "Retrieve knowledge: filter (types, stack_tags) → file_keys join → rank (rank_terms: single keywords, never prose) → cap. Unknown parameters are refused. Returns {matched_filter, returned, cap, capped, provenance, records}: capped=true means a WINDOW — raise cap or narrow the filter before concluding anything about absence. matched_filter counts the filter only; rank_terms order, never narrow. projection: \"full\" (default), \"digest\" (one headline line per record — scan wide, then knowledge_get the few you need), or \"count\". Results omit the supersedes chain (see supersedes_count) and file_baselines; knowledge_get is the full-fidelity read. A record whose owned files changed since it was written carries baseline_drift; provenance says whether that check ran ('checked' or 'unavailable:<reason>'), so an absent annotation is never proof of freshness. min_score (requires rank_terms) adds above_threshold: the count over the FULL match set scoring >= min_score (score = -bm25, higher is more relevant, unbounded).",
      inputSchema: strict({
        types: z.array(z.string()).optional(),
        stack_tags: z.array(z.string()).optional(),
        file_keys: z.array(z.string()).optional(),
        rank_terms: z.array(z.string()).optional(),
        cap: z.number().int().positive().optional(),
        projection: z.enum(['full', 'digest', 'count']).optional(),
        min_score: z.number().optional(),
      }),
    },
    (opts) => json(tools.knowledgeQueryResult(opts))
  );

  server.registerTool(
    'knowledge_get',
    {
      description:
        "Fetch one record by id (full uuid, exact slug, or unambiguous 8-char prefix) — the full-fidelity read. version:<n> reads an archived prior version. With `field`: a windowed read of just that field — strings page by characters, arrays by elements (offset/length); returns {kind, total_chars|total_entries, offset, value|entries}; an offset past the end returns empty with the true total. Scalar/object fields return whole and refuse offset/length. Unknown field is refused naming the valid set; offset/length without field is refused.",
      inputSchema: strict({
        id: z.string(),
        field: z.string().optional(),
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().positive().optional(),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('read the ARCHIVED snapshot at this version instead of the current record; an unknown version is refused, never silently the latest'),
      }),
    },
    ({ id, field, offset, length, version }) => json(tools.knowledgeGet(id, { field, offset, length, version }))
  );

  server.registerTool(
    'knowledge_render',
    {
      description:
        "Read-only: render 1-20 records (same id ladder as knowledge_get) as one paste-ready plain-text block, for embedding store rulings into an external reviewer prompt. Any id that fails to resolve or is ambiguous refuses the whole call, naming it. Records render in request order with a header (type, title, handle, status) and every content field; server-owned plumbing is omitted; superseded records render with their status. Never writes.",
      inputSchema: strict({ ids: z.array(z.string()).min(1).max(20).describe('1-20 record ids (uuid / slug / unambiguous 8-char prefix)') }),
    },
    ({ ids }) => ({ content: [{ type: 'text' as const, text: tools.knowledgeRender({ ids }) }] })
  );

  server.registerTool(
    'knowledge_split',
    {
      description:
        "Split a feature_article: move a subset of its files[] / current_ac[] / live_test_refs into one or more NEW child articles. Prose moves verbatim, ac_ids are inherited (never renumbered), live_test_refs follow their ac_id, the parent keeps its slug (new version), and file coverage stays total. Refused: a moved path/ac_id not owned by the parent or claimed by two children, a child slug that duplicates another or an existing article, or moving every parent file. All validation runs first and the whole split is one transaction. resolves:[<full item ids>] explicitly closes open items of any lane except promotion_review that are keyed to the parent's chain, or that are the parent's article_oversize item (validated before the write; unnamed items stay open and are warned on the receipt). Returns {parent:{id,slug,version}, children:[{id,slug}], warnings[]} — warnings (e.g. still-oversize) never gate.",
      inputSchema: strict({
        id: z.string(),
        children: z
          .array(
            z.object({
              slug: z.string().min(1),
              title: z.string().min(1),
              what_it_does: z.string().min(1),
              intended_behavior: z.string().min(1),
              move_files: z.array(z.string()).min(1),
              move_ac_ids: z.array(z.string()),
              dependencies: z.object({ relies_on: z.array(z.string()), relied_by: z.array(z.string()) }).optional(),
            }).strict()
          )
          .min(1),
        parent_what_it_does: z.string(),
        parent_intended_behavior: z.string().optional(),
        reason: z.string().optional(),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open maintenance-queue item ids this split discharges — validated before the write'),
      }),
    },
    ({ id, children, parent_what_it_does, parent_intended_behavior, reason, resolves }) =>
      json(tools.knowledgeSplitResult({ id, children, parent_what_it_does, parent_intended_behavior, reason, resolves }))
  );

  server.registerTool(
    'knowledge_extract',
    {
      description:
        "Lift a passage out of one string field of a live record into a NEW record of a caller-chosen type (new_record.type required; todo/attestation refused); the source stays active minus the passage. (field, find) must match exactly once (0 or >1 matches refused with the count); replace (default '') is inserted literally. Edges are written both ways: new informed_by source, source cites new. The new record inherits the source scope (an explicit different scope is refused); attestation sources are refused; on a domain-held source a non-empty resolves is refused. All validation runs first and everything lands in one transaction. resolves:[<full item ids>] explicitly closes open reconcile_needed/refresh_reference items whose file_keys overlap the source record's (validated before the write; unnamed items stay open and are warned on the receipt). Returns {extracted, source:{id,version}, edges, warnings[]}.",
      inputSchema: strict({
        id: z.string(),
        field: z.string(),
        find: z.string(),
        replace: z.string().optional().describe('the text that replaces the matched passage in the source field — defaults to \'\' (pure excision)'),
        new_record: z
          .object({
            type: z.string(),
            fields: z.record(z.string(), z.unknown()),
          })
          .strict(),
        reason: z.string().optional(),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open maintenance-queue item ids this extract discharges — validated (plain lane, file_keys overlap) before the write'),
      }),
    },
    ({ id, field, find, replace, new_record, reason, resolves }) =>
      json(tools.knowledgeExtractResult({ id, field, find, replace, new_record, reason, resolves }))
  );

  server.registerTool(
    'knowledge_schema',
    {
      description:
        "Describe what a record type accepts before writing it. Returns {type, fields:[{name, required, type, enum_values?, element_fields?, example?, server_owned?}], required[], optional[]}, derived from the registered schema. `example` is a schema-validated worked value (absent when none is derivable). server_owned fields are listed but refused on write and excluded from required/optional. An unregistered type lists the registered ones.",
      inputSchema: strict({ type: z.string() }),
    },
    ({ type }) => json(tools.knowledgeSchema(type))
  );

  server.registerTool(
    'knowledge_stats',
    {
      description:
        "Size and composition without the body. With id: body_chars (what article_oversize judges; history excluded), history_chars, history_entries, supersedes_count, and over_threshold for a feature_article. Without id: per-type counts and sizes over the mounted stores, plus the 10 largest feature_article bodies against the threshold.",
      inputSchema: strict({ id: z.string().optional() }),
    },
    ({ id }) => json(tools.knowledgeStats(id))
  );

  server.registerTool(
    'knowledge_retire',
    {
      description:
        "Retire a genuine DUPLICATE in favour of a surviving record: status=superseded, superseded_by=in_favor_of, no new row; it stays fetchable by id and its links survive, but queries stop serving it. Not for a merely wrong record — fix that with knowledge_update. in_favor_of is required and must be live. todos are refused (use board_remove / maintenance_remove).",
      inputSchema: strict({ id: z.string(), in_favor_of: z.string() }),
    },
    ({ id, in_favor_of }) => json(tools.knowledgeRetire(id, in_favor_of))
  );

  server.registerTool(
    'knowledge_supersede',
    {
      description:
        "Atomically replace a decision / anti_pattern / research_finding with a NEW record built from `fields` (a complete create-shaped body, not a delta) and mark old_id superseded by it, in one transaction. A slugless `fields` inherits the old slug; an explicit slug is collision-checked. If the old record enumerates 2+ rulings and the replacement leaves any uncovered, the call is refused naming them — carry them forward, or pass orphans_acknowledged:true. Other types are refused naming their exit path (todo → board_remove/maintenance_remove; feature_article/reference_material → knowledge_update/knowledge_retire). Refusals write nothing.",
      inputSchema: strict({ old_id: z.string(), fields: passthrough, orphans_acknowledged: z.boolean().optional() }),
    },
    ({ old_id, fields, orphans_acknowledged }) => json(tools.knowledgeSupersede(old_id, fields, orphans_acknowledged))
  );

  server.registerTool(
    'knowledge_update',
    {
      description:
        "Versioned update in place: id stays, version bumps, the prior body is archived (knowledge_get version:<n>). `body` is a PARTIAL PATCH, not a knowledge_create body — pass only changed mutable fields; omitted fields are kept (a warning flags a what_it_does change that leaves intended_behavior contradicting it). expected_version:<read version> makes the write conditional; a stale token is refused naming both versions. status/superseded_by are refused; a `version` in body is ignored with a warning. Attestation updates mint a new id and retire the prior. To extend an array use knowledge_append; to replace a passage use knowledge_edit. resolves:[<full item ids>] explicitly closes open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review items keyed to this record's chain (validated before the write; unnamed items stay open and are warned on the receipt). The echo defaults to a one-line digest receipt; projection:\"full\" returns the whole stored record.",
      inputSchema: strict({
        id: z.string(),
        body: passthrough,
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review item ids keyed to this record\'s chain that this write discharges — full ids, validated before the write'),
        expected_version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CAS token: the version you read. A stale value refuses naming both versions, with nothing written'),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, body, resolves, expected_version, projection }) =>
      json(tools.writeProjected(tools.knowledgeUpdateResult(id, body, resolves, expected_version), projection))
  );

  server.registerTool(
    'knowledge_append',
    {
      description:
        "Append entries to an array field (history, files, current_ac, live_test_refs, …) without retransmitting it; same versioned write path as knowledge_update. Refuses an unknown field (naming the valid set), a non-array field, an empty entry list, and links (use knowledge_link). resolves:[<full item ids>] explicitly closes open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review items keyed to this record's chain, plus an article_missing item when an appended files[] entry's path is one of that item's file_keys (validated before the write; unnamed items stay open and are warned on the receipt). The echo defaults to a one-line digest receipt; projection:\"full\" returns the whole stored record.",
      inputSchema: strict({
        id: z.string(),
        field: z.string(),
        entries: z.array(z.unknown()),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review item ids keyed to this record\'s chain, or an article_missing item whose file_keys include an appended files[] path, that this write discharges — full ids, validated before the write'),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, field, entries, resolves, projection }) => json(tools.writeProjected(tools.knowledgeAppend(id, field, entries, resolves), projection))
  );

  server.registerTool(
    'knowledge_edit',
    {
      description:
        "Replace one passage inside a string field without retransmitting it. `find` must match EXACTLY ONCE — zero or multiple matches are refused with the count; extend find to disambiguate. `field` may be an array-element selector 'arr[key=value].sub' (e.g. \"files[path=scripts/prep.mjs].role\"), which must match exactly one element. A BOOLEAN sub-field is set by value: find is its current value ('true'/'false'), replace the new one (e.g. field \"files[path=scripts/prep.mjs].unverified\", find 'true', replace 'false' clears the flag). Same versioned write path as knowledge_update. resolves:[<full item ids>] explicitly closes open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review items keyed to this record's chain (validated before the write; unnamed items stay open and are warned on the receipt). The echo defaults to a digest receipt with chars_before/chars_after; projection:\"full\" returns the whole stored record.",
      inputSchema: strict({
        id: z.string(),
        field: z.string(),
        find: z.string(),
        replace: z.string(),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review item ids keyed to this record\'s chain that this write discharges — full ids, validated before the write'),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, field, find, replace, resolves, projection }) => json(tools.writeProjected(tools.knowledgeEdit(id, field, find, replace, resolves), projection))
  );

  server.registerTool(
    'knowledge_array_remove',
    {
      description:
        "Remove ONE element from an array field by selector 'arr[key=value]' (no trailing .sub), e.g. \"files[path=scripts/prep.mjs]\". Zero or multiple matches are refused with the count; a selector only matches elements that have the key. Destructive, so: id must be the EXACT FULL UUID (no slug or prefix), and expected_version is REQUIRED — a stale token is refused naming both versions; a non-positive token is refused as invalid; a record with no stored version is refused. Refused: removing a feature_article's last files[] entry, or the last history entry. current_ac and live_test_refs may be emptied. Surviving elements keep order and bytes. resolves:[<full item ids>] explicitly closes open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review items keyed to this record's chain (validated before the write; unnamed items stay open and are warned on the receipt). The echo defaults to a digest receipt carrying the removed element; projection:\"full\" returns the whole stored record.",
      inputSchema: strict({
        id: z.string().describe('the EXACT full uuid — this call destroys, so no slug and no 8-char prefix is accepted'),
        selector: z.string().describe("arr[key=value] — knowledge_edit's grammar with NO trailing '.sub'; the whole matched element is removed"),
        expected_version: z
          .number()
          .int()
          .positive()
          .describe('REQUIRED: the version you read — a stale token refuses naming both versions, with nothing written'),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed, refresh_reference, stale_research, wire_in_dormant or state_review item ids keyed to this record\'s chain that this write discharges — full ids, validated before the write'),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, selector, expected_version, resolves, projection }) =>
      json(tools.writeProjected(tools.knowledgeArrayRemove(id, selector, expected_version, resolves), projection))
  );

  server.registerTool(
    'knowledge_promote',
    {
      description:
        "Promote a project-scoped record into a mounted domain store: copies it (scope domain:<name>, informed_by the origin) and supersedes the project original pointing at the copy. feature_article and todo never promote; an unmounted domain is refused. file_keys are dropped and stack_tags intersected with the domain (disclosed as dropped_file_keys/dropped_stack_tags/kept_stack_tags), with a warn-only scan for project-local labels left in the prose. Clears a matching promotion_review item. The echo (`promoted`) defaults to a digest; projection:\"full\" returns the whole record.",
      inputSchema: strict({ id: z.string(), domain: z.string(), projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ id, domain, projection }) => json(tools.writeProjected(tools.knowledgePromote(id, domain), projection))
  );

  server.registerTool(
    'board_add',
    {
      description:
        "Add a task to the board (source:\"user\") or the maintenance queue (source:\"system\", requires system_reason). User items declare `objective`: the shared name of the larger objective a slice belongs to, or \"standalone\" for a freestanding task (stored ungrouped); omitting it saves ungrouped with a notice. System items never take an objective. measured_at_head is stamped to HEAD unless you pass a resolvable 40-hex sha (an unresolvable one is refused). The echo defaults to a digest; projection:\"full\" returns the stored record.",
      inputSchema: strict({
        text: z.string(),
        source: z.enum(['user', 'system']),
        objective: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        feature_link: z.string().optional(),
        system_reason: z.string().optional(),
        stack_tags: z.array(z.string()).optional(),
        measured_at_head: z.string().optional(),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ projection, ...args }) => json(tools.writeProjected(tools.boardAdd(args), projection))
  );

  server.registerTool(
    'board_query',
    {
      description:
        "List open board items. source:\"user\" is the board, source:\"system\" the maintenance queue. Filters (AND): objective (exact; \"standalone\" selects ungrouped items), file_keys, contains (case-insensitive literal substring). Returns {matched_filter, returned, cap, capped, offset, next_cursor?, provenance, reconcile_provenance, lane_advisory_count?|lane_advisory?, artifact_evidence_provenance, artifact_evidence_note, note?, records}. capped=true means more items matched — raise cap or page before concluding the board is shorter. Paging: order is updated_at DESC, id DESC. offset pages by position (can skip an item bumped between fetches); cursor (pass back next_cursor) resumes by identity and never skips an item behind it. cursor and offset are mutually exclusive; a cursor is bound to its filters (a mismatch is refused); cap/projection may vary. projection: \"text\" (default) — id, slug, objective, source, system_reason, status, priority, feature_link, updated_at, text clipped to 240 chars, artifact_evidence_count, and lane collisions as lane_advisory_count; \"headline\" — id, name, priority, objective/system_reason, 80-char text; \"digest\" — one clipped line per item; \"full\" — whole records with file_keys, per-item artifact_evidence {count, records?, file_key_check}, annotation prose, and the lane_advisory block. Use board_get for one whole item. Advisory annotations never filter or reorder: provenance / reconcile_provenance say whether the git-based staleness checks ran ('checked' or 'unavailable:<reason>'); artifact_evidence counts knowledge records written since the item that touch its file_keys or cite its id — a lookup, never a verdict (verify against HEAD); lane_advisory marks user items sharing a write path, which serializes only the implementation lane.",
      inputSchema: strict({
        source: z.enum(['user', 'system']).optional(),
        objective: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        contains: z.string().optional(),
        cap: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        cursor: z.string().optional(),
        projection: z.enum(['text', 'full', 'digest', 'headline']).optional(),
      }),
    },
    (args) => json(tools.boardQueryResult(args))
  );

  server.registerTool(
    'board_remove',
    {
      description:
        "Remove a board or queue item — the only way an item leaves (done = removed, after its fulfilling artifact-write). Destructive: id must be the EXACT FULL UUID (no slug or 8-char prefix). The result discloses artifact_evidence (records touching the item's file_keys written since it was created); an empty list means the close rests on your word. An already-removed id reports when it was removed.",
      inputSchema: strict({ id: z.string() }),
    },
    ({ id }) => json(tools.boardRemove(id))
  );

  server.registerTool(
    'maintenance_remove',
    {
      description:
        "Remove a maintenance-queue (source:\"system\") item once its fulfilling artifact exists; user board items are refused. Destructive: id must be the EXACT FULL UUID (no slug or 8-char prefix). Logged to the drain log; the result discloses artifact_evidence like board_remove — an empty list means verify against HEAD before closing.",
      inputSchema: strict({ id: z.string() }),
    },
    ({ id }) => json(tools.maintenanceRemove(id))
  );

  server.registerTool(
    'board_update',
    {
      description:
        "Edit a board/queue item in place (id stable, no new version): text, priority, file_keys, objective, measured_at_head. Never closes an item (use board_remove). objective (re)groups a task; \"standalone\" ungroups it. A text or file_keys change re-stamps measured_at_head to HEAD; pass a resolvable 40-hex sha to set it explicitly (unresolvable is refused). Todos only; source/system_reason/status/id and other fields are refused by name. At least one field is required. The echo defaults to a digest; projection:\"full\" returns the stored record.",
      inputSchema: strict({
        id: z.string(),
        text: z.string().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        file_keys: z.array(z.string()).optional(),
        objective: z.string().optional(),
        measured_at_head: z.string().optional(),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, projection, ...patch }) => json(tools.writeProjected(tools.boardUpdate(id, patch), projection))
  );

  server.registerTool(
    'board_get',
    {
      description:
        "Fetch one board/queue item in full (untruncated text). Resolves a full uuid, exact slug, or unambiguous 8-char prefix; an unknown id is refused naming it. Returns the stored `slug` untouched (an immutable address, never re-derived) alongside a `label` — the display name derived from the item's CURRENT text, which is what a reader should be shown after a rename or renumbering.",
      inputSchema: strict({ id: z.string() }),
    },
    ({ id }) => json(tools.boardGet(id))
  );

  server.registerTool(
    'board_edit',
    {
      description:
        "Replace one passage inside a board/queue item's text in place (id stable, no new version). `find` must match EXACTLY ONCE — zero or multiple matches are refused with the count, nothing written. Works on user and system items. The echo defaults to a one-line digest receipt; projection:\"full\" returns the whole stored record.",
      inputSchema: strict({ id: z.string(), find: z.string(), replace: z.string(), projection: z.enum(['full', 'digest']).optional() }),
    },
    ({ id, find, replace, projection }) => json(tools.writeProjected(tools.boardEdit(id, find, replace), projection))
  );

  server.registerTool(
    'no_capture',
    {
      description:
        "Declare that this session's work produced nothing durable, discharging H10's duty for events earlier than the declaration on the declared lane (later work re-arms it): omitted lane = capture only; lane:\"research\" for the research duty; lane:\"all\" for both. An unknown lane is refused. The reason is recorded. If a capture exists but lands later, use capture_pending.",
      inputSchema: strict({ reason: z.string(), lane: z.enum(NO_CAPTURE_LANES).optional() }),
    },
    ({ reason, lane }) => json(tools.noCapture(reason, lane))
  );

  // enforcement_reconcile was removed together with H17 (decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1) — see tools.ts.

  server.registerTool(
    'concept_designed',
    {
      description:
        "Register that a concept family's design settled this session (pass the family slug(s)); H10 then requires that family's concept article (feature_article with concept_family) before the session ends, or queues concept_article_missing.",
      inputSchema: strict({ families: z.array(z.string()).min(1) }),
    },
    ({ families }) => json(tools.conceptDesigned(families))
  );

  server.registerTool(
    'capture_pending',
    {
      description:
        "Declare that a capture exists and its write is in flight on a named target (a pending commit, a dispatched agent). H10 defers the capture duty: the declaration holds while any dispatched subagent is live, then gets one Stop of grace counted from the declaration (an earlier nag does not spend it); if still pending after that it becomes a capture_owed queue item citing this target, deduped per target. A real capture spends the declaration.",
      inputSchema: strict({ target: z.string(), reason: z.string() }),
    },
    ({ target, reason }) => json(tools.capturePending(target, reason))
  );

  server.registerTool(
    'config_set',
    {
      description:
        "Conductor-only (not granted to roster agents): set one key in the active project's .sterling/config.json, validating the whole document against the config schema before writing. `path` is a dotted key (e.g. 'tdd.enabled'; intermediate objects are created); `value` is required; __proto__/constructor/prototype in the path are refused. `expected_digest` (sha256 of the current file bytes) makes the write conditional — a stale token is refused naming both digests. Pass it against concurrent writers such as the TUI: the call also re-checks the digest just before its atomic rename, but a small window between that re-check and the rename remains, so last write wins inside it. A symlinked or non-regular config.json or .sterling directory is refused. The file is re-serialized as 2-space LF JSON (BOM stripped; other keys preserved). Returns {path, previous_value, value, digest}; digest is the next expected_digest.",
      inputSchema: strict({
        path: z.string(),
        value: z.unknown().refine((v) => v !== undefined, { message: "'value' is required" }),
        expected_digest: z.string().optional(),
      }),
    },
    ({ path, value, expected_digest }) => json(tools.configSet({ path, value, expected_digest }))
  );

  // run_state / agent_exit / run_signal — the staged pipeline's run protocol
  // — were removed (decision sterling-claude-code-scale-down-boundary,
  // 2ad87dd1). See tools.ts.

  server.registerTool(
    'knowledge_link',
    {
      description:
        "Add a typed link: cites | informed_by | fulfills | falsified_by (supersedes is refused — use knowledge_supersede / knowledge_retire). falsified_by points FROM the record whose claim was disproven TO the record carrying the evidence; the falsified record stays live. When a successor claim exists, supersede instead.",
      inputSchema: strict({ from: z.string(), rel: z.string(), to: z.string() }),
    },
    ({ from, rel, to }) => json(tools.knowledgeLink(from, rel, to))
  );

  server.registerTool(
    'knowledge_preflight',
    {
      description:
        "Pre-write conflict check: does the store already govern this subject? Run it before dispatching, designing, asking the user, or drafting a new record. Pass `text` (one subject) or `texts` (an agenda, one verdict per entry, in order). Matches anti_pattern, decision, feature_article, research_finding, disconfirmed_hypothesis and open_question records. Verdicts: \"verify_targets\" — the store governs this; open the named matches before proceeding (a match is a pointer, not the source); \"ungoverned\" — nothing governs it; \"insufficient\" — too little vocabulary to judge; the verdict and matched_total are decided from the centrality-passing candidate set only, not the capped `matches` window. Returns {terms, matched_total, capped (present/true only when `matches` was truncated), matches:[{id,type,title,matched_on,central}], answerability} or {verdicts:[…]}. `matches` is capped at 20, sorted centrality-first (a central match always outranks a merely-hitting one), then by raw hit count. `matches` may include records with `central:[]` (non-central) — record-centrality is no longer required to LIST a candidate, only to decide the verdict and matched_total. matched_total counts centrality-passing, qualifying records among the candidates evaluated (each record type's own query is itself capped at 40), not a true/exact/full count.",
      inputSchema: strict({ text: z.string().optional(), texts: z.array(z.string()).optional() }),
    },
    ({ text, texts }) => {
      if ((text === undefined) === (texts === undefined)) {
        throw new Error(`knowledge_preflight: pass exactly ONE of 'text' (single subject) or 'texts' (agenda)`);
      }
      return json(texts !== undefined ? tools.knowledgePreflightBatch(texts) : tools.knowledgePreflight(text as string));
    }
  );

  // run_escalate was removed with the staged pipeline (decision
  // sterling-claude-code-scale-down-boundary, 2ad87dd1).

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
        "List open maintenance-queue items. Filters (AND): system_reason, file_keys, contains (case-insensitive literal substring), feature_slug (items owned by one article, including earlier superseded versions; unresolvable = empty). Same envelope, paging and projections as board_query: capped=true means the queue is deeper than shown — page (offset, or cursor = next_cursor, which never skips an item behind it; mutually exclusive; bound to its filters) until capped is false. projection: \"text\" (default; text clipped to 240 chars, artifact_evidence_count), \"headline\", \"digest\", or \"full\" (per-item artifact_evidence detail and annotation prose). artifact_evidence is a lookup, never a verdict — verify against HEAD before draining on it.",
      inputSchema: strict({
        system_reason: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        contains: z.string().optional(),
        feature_slug: z.string().optional(),
        cap: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        cursor: z.string().optional(),
        projection: z.enum(['text', 'full', 'digest', 'headline']).optional(),
      }),
    },
    (args) => json(tools.maintenanceQueryResult(args))
  );

  // handoff_write / handoff_read were removed with the staged pipeline
  // (decision sterling-claude-code-scale-down-boundary, 2ad87dd1).

  return { server, store, tools };
}
