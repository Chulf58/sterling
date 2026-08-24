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
 * knowledge_create's typed `fields` body (decision 7c7f6db1, probe
 * research_finding 15c8e6b5) — REPLACES the passthrough with a per-type
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
 * finding 15c8e6b5 actually measured. This was re-verified against the
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
 * Served as a bare `anyOf` (research_finding 15c8e6b5 measured this against
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
 * 7c7f6db1, probe research_finding 15c8e6b5, re-confirmed empirically against
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
        'Create a knowledge record. `fields` is TYPED PER `type` (decision 7c7f6db1): each of the 9 registered record types gets its own shape — unknown fields inside `fields` are refused loudly at parse time, naming that type\'s actual allowed set, before the write path is ever entered. Server-owned fields (id/created_at/updated_at/status/superseded_by/lifecycle/freshness/file_baselines/version) are not part of any variant\'s `fields` shape — the server assigns them. Set fields.type to select one schema branch; use only properties from that matching branch. fields.type must match the outer `type` argument.',
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
        'Retrieve knowledge: filter (type/stack tags) → file-key join → rank (rank_terms: plain keyword array, never prose) → cap. derived_unconfirmed excluded unless include_unconfirmed. Unknown parameter names are REJECTED, never ignored. Returns {matched_filter, returned, cap, capped, records}: capped=true means you are holding a WINDOW, not the whole set. matched_filter counts the FILTER only — rank_terms order that set, they never narrow it. projection:"digest" returns one headline line per record (id + slug/title, anti_pattern trigger, research_finding clocks) instead of full bodies: use it to SEE THE LANDSCAPE cheaply — a wide digest then knowledge_get on the few that matter beats a capped full-body window you can neither complete nor trust. Query results omit the supersedes chain (see supersedes_count) and server-owned file_baselines — knowledge_get is the full-fidelity read. min_score (requires rank_terms) answers the ABSENCE QUESTION a capped window cannot: the result gains above_threshold, the count of records scoring >= min_score over the FULL match set (never the capped `records` window), so above_threshold:0 is a usable "nothing is ruled about this". SCALE: the score is `-bm25(records_fts)` — SQLite FTS5\'s bm25() is lower-is-better and unbounded below, so this negates it: HIGHER means more relevant, a bare keyword match sits near 0, and there is no fixed upper bound.',
      inputSchema: strict({
        types: z.array(z.string()).optional(),
        stack_tags: z.array(z.string()).optional(),
        file_keys: z.array(z.string()).optional(),
        rank_terms: z.array(z.string()).optional(),
        include_unconfirmed: z.boolean().optional(),
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
        'Fetch a record by id — the full-fidelity read (query results are projected). No `field`: exactly the whole record, terminus handling included. With `field`: a WINDOWED projection of just that one field instead of the whole record (decision compaction-tooling-windowed-read-plus-split) — the measured defect this closes is an oversize article that overflows its own read tool. Unknown field is refused, naming it plus the valid set for the record\'s type. A string/array field returns {kind, total_chars|total_entries, offset, value|entries} — offset/length address CHARACTERS on a string, ELEMENTS on an array; offset at/past the end is not an error (empty value/entries, true total still reported, for clean paging termination). A scalar/object field returns {kind:"value", value} whole — offset/length alongside it are refused as not windowable. offset/length without field is refused.',
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
    'knowledge_split',
    {
      description:
        'Split a feature_article: move a subset of its files[]/current_ac[]/live_test_refs entries into one or more NEW child articles, mechanically enforcing the invariants decision 8b87efcb established by hand for the hooks-suite split (decision compaction-tooling-windowed-read-plus-split) — prose moved VERBATIM, ac_ids INHERITED never renumbered, live_test_refs RE-POINTED to whichever side now owns the ac_id, the parent SURVIVES under its ORIGINAL slug (superseded to version+1, never replaced), and FILE COVERAGE stays TOTAL (every parent-owned path lands on exactly the parent or one child). Every child move_files path must be owned by the parent and claimed by at most one child; same for move_ac_ids; child slugs must be pairwise distinct and not collide with an existing feature_article; the parent must retain at least one file (moving all of them is refused — that shape is retire-and-replace, not a split). ALL validation runs before any write, and the whole split (every child plus the parent supersession) lands in ONE transaction, so a mid-split failure leaves the store untouched. resolves closes named open maintenance items exactly like knowledge_update\'s explicit-claim contract; an unnamed item stays open. Returns {parent:{id,slug,version}, children:[{id,slug}], warnings:[]} — warnings never gate the write, and report a still-oversize parent or an oversize-born child needing its own further split, the same article_oversize mechanism knowledge_update carries.',
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
    'knowledge_schema',
    {
      description:
        'Ask what a record type requires BEFORE writing it, instead of learning by rejection. Returns {type, fields:[{name, required, type, enum_values?, server_owned?}], required[], optional[]} — derived from the registered zod schema, so it cannot drift from what a write will accept. A field marked server_owned:true (id, created_at, status, superseded_by, …) is set by the server and refused if you pass it — it still appears in `fields` so you know it exists, but never in `required`/`optional`, because those two lists answer "what may I supply", not "what does this record hold". required[] means required FROM THE CALLER on a create, not every field the raw schema declares. Use it when you are unsure of a field name, whether a field is mandatory, whether it takes a string or an array of objects, or what a closed enum permits (volatility_hint is fast|medium|stable — "low" is refused). An unregistered type lists the registered ones.',
      inputSchema: strict({ type: z.string() }),
    },
    ({ type }) => json(tools.knowledgeSchema(type))
  );

  server.registerTool(
    'knowledge_stats',
    {
      description:
        'Size and composition WITHOUT the body (board a382af6b). With id (uuid/slug/8-char prefix): body_chars (the number the article_oversize threshold judges — history excluded), history_chars, history_entries, supersedes_count, and over_threshold for a feature_article. With no id: the aggregate over the MOUNTED store set (project + any domain mounts, unconfirmed included) — per-type counts and body sizes, the total, and the 10 largest feature_article bodies flagged against the threshold. Use it before deciding how to write to a big record (knowledge_edit/knowledge_append vs a full retransmit) and to find what is bloating; query digest lines carry each record\'s size_chars for the cheap scan, this is the drill-down.',
      inputSchema: strict({ id: z.string().optional() }),
    },
    ({ id }) => json(tools.knowledgeStats(id))
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
        'Versioned update IN PLACE: the record\'s id NEVER changes, the server-owned version counter bumps by one, and the full prior body is archived (read it back with knowledge_get version:<n>). REPLACES each field you pass and KEEPS every field you do not — so revising what_it_does while leaving a contradicting intended_behavior ships a self-contradicting record; the result carries a warning when that shape is detected. `body` is a PARTIAL PATCH, not a knowledge_create body — provide only the changed mutable fields; omitted fields are preserved. To EXTEND an array (history, files, current_ac) without retransmitting it, use knowledge_append. Pass expected_version:<the version you read> to make the write conditional: a stale token is refused naming both versions with nothing written. A `version` inside body is server-owned and ignored (disclosed as a warning). The ONE exception to in-place: an attestation update is a concept replacement (new id, prior retired), because an inspection verdict is immutable. This write does NOT auto-close any maintenance item: pass resolves:[<item ids>] to explicitly discharge open reconcile_needed/refresh_reference items on this record\'s chain (validated before the write — a bad id refuses the whole call, and the drain rides the write\'s own transaction); anything left unnamed stays open and is warned on the receipt. The echo defaults to a one-line digest receipt carrying version + previous_version (body dropped — you just authored it); pass projection:"full" for the whole stored record.',
      inputSchema: strict({
        id: z.string(),
        body: passthrough,
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed/refresh_reference item ids this write discharges — validated before the write'),
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
        'Append entries to an ARRAY field (history, files, current_ac, live_test_refs, …) without retransmitting the whole array — the cheap path for adding a history entry to a long article. Goes through the same versioned update path, so the version bump, the retained prior version, and the file_baselines re-baseline are identical — including resolves: pass item ids to explicitly discharge open reconcile_needed/refresh_reference items on this record\'s chain (validated before the write); anything unnamed stays open and is warned on the receipt. Refuses an unknown field (naming the valid set), a non-array field, an empty entry list, and links (use knowledge_link). The echo defaults to a one-line digest receipt (warnings kept) — a single full-record append echo once measured 49.8KB of content the caller had just written; pass projection:"full" for the whole stored record.',
      inputSchema: strict({
        id: z.string(),
        field: z.string(),
        entries: z.array(z.unknown()),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed/refresh_reference item ids this write discharges — validated before the write'),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, field, entries, resolves, projection }) => json(tools.writeProjected(tools.knowledgeAppend(id, field, entries, resolves), projection))
  );

  server.registerTool(
    'knowledge_edit',
    {
      description:
        "Replace a passage INSIDE a long string field (what_it_does, intended_behavior, statement, …) without retransmitting the whole field — the string sibling of knowledge_append. 'find' must match EXACTLY ONCE: zero matches and multiple matches are both refused with the count, because a blind replace inside a field too large to read is an unreviewable write (extend 'find' with surrounding text to disambiguate). ARRAY-ELEMENT ADDRESSING: field also accepts a selector 'arr[key=value].sub' (e.g. \"files[path=scripts/prep.mjs].role\") to edit one string inside one array element — the selector must match exactly one element, same refuse-on-ambiguity contract, so a stale files[] role no longer needs a full-array retransmit. Goes through the same versioned update path as every other write, so the version bump, retained prior version, and baseline re-baseline are identical — including resolves: pass item ids to explicitly discharge open reconcile_needed/refresh_reference items on this record's chain (validated before the write); anything unnamed stays open and is warned on the receipt. The echo defaults to a one-line digest receipt (warnings + replaced counts kept — chars_before/chars_after prove the edit landed); pass projection:\"full\" for the whole stored record.",
      inputSchema: strict({
        id: z.string(),
        field: z.string(),
        find: z.string(),
        replace: z.string(),
        resolves: z
          .array(z.string())
          .optional()
          .describe('open reconcile_needed/refresh_reference item ids this write discharges — validated before the write'),
        projection: z.enum(['full', 'digest']).optional(),
      }),
    },
    ({ id, field, find, replace, resolves, projection }) => json(tools.writeProjected(tools.knowledgeEdit(id, field, find, replace, resolves), projection))
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
        'Add a task to the board (source: user) or the maintenance queue (source: system, requires system_reason). EVERY user-source add answers parentage via `objective` (decision a8d2ce6c): when the task is a SLICE of a larger objective — the conductor slicing a big ask mints one board_add per slice, all sharing the objective name — pass objective:"<name>"; a freestanding task passes objective:"standalone" (exact lowercase, stored as ungrouped). The TUI groups slices under their objective, so declared parentage is what keeps the board readable as N objectives instead of N×slices. Omitting objective never loses the task — it saves ungrouped with a loud notice, and board_update can group it later. system-source items never take an objective (lane-keyed by system_reason). measured_at_head (decision board-provenance-measured-at-head) is server-stamped to HEAD unless you supply a resolvable 40-hex sha yourself — an unresolvable one is refused, never silently replaced. The echoed item defaults to its one-line digest; pass projection:"full" for the stored record.',
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
        'List open board items. source=user is the board; source=system is the maintenance queue. contains narrows to items whose text contains that substring (case-insensitive, literal — never FTS5 query syntax). Returns {matched_filter, returned, cap, capped, offset, provenance, records}: capped=true means more items matched than are shown past this page — raise cap or page with offset before concluding the board or queue is shorter than it is. offset (default 0) pages through a DETERMINISTIC order (updated_at DESC, stable) — offset:0, offset:cap, offset:2*cap, … visits every matching item exactly once. provenance (decision board-provenance-measured-at-head) states whether the one-shot git walk behind the per-item "⚠ file_keys changed in N commits since this item\'s evidence was measured (<sha7>)" annotation ran: \'checked\', or \'unavailable:<reason>\' when it could not (no git, detached HEAD, no eligible file_keys, or the walk\'s commit cap was hit) — an absent warning is never proof of freshness. projection:"digest" returns one clipped line per item instead of its full text; projection:"headline" is smaller still (id, priority, objective, first 80 chars of text — no source/status/type/size_chars) for auditing or paging a large board cheaply; read the full item only for the ones you act on.',
      inputSchema: strict({
        source: z.enum(['user', 'system']).optional(),
        file_keys: z.array(z.string()).optional(),
        contains: z.string().optional(),
        cap: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        projection: z.enum(['full', 'digest', 'headline']).optional(),
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
        'IN-PLACE edit of a board/queue item — text/priority/file_keys/objective/measured_at_head only, id stable, no new version is minted. Updating an item never closes it: board_remove, bound to the fulfilling artifact-write, remains the only way an item leaves the board (P4). objective (re)groups a task under a larger objective (decision a8d2ce6c — the remedy for a slice saved ungrouped or a late-discovered slice); objective:"standalone" un-groups it. A text or file_keys change re-stamps measured_at_head to the current HEAD automatically (decision board-provenance-measured-at-head — new evidence); a priority/objective-only patch leaves it untouched; pass measured_at_head yourself (a resolvable 40-hex sha) to re-verify without rewriting text — an unresolvable sha is refused, never silently replaced. Only todo records are editable this way; source/system_reason/status/id and every other field are refused by name (they decide which surface an item lives on, or are server-owned). At least one updatable field is required. The echoed item defaults to its one-line digest — board items run to several KB and you just wrote the change; pass projection:"full" for the stored record.',
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
        "Declare that this session's direct-mode work produced NOTHING durable — satisfies H10's duty for every touch/debug/research event EARLIER than the declaration, ON THE LANE YOU DECLARE (later work re-arms it). LANE-SCOPED since 2026-08-22 (decision no-capture-discharge-is-lane-scoped): OMITTING lane declares the CAPTURE lane only — discharging the RESEARCH duty requires lane 'research' (or 'all' for both), because a locally-true 'typo fix, nothing durable' must never silently clear an unrelated earlier research duty. An unrecognized lane is refused, never coerced. A false declaration is drift, not a bypass: the reason is register-recorded. If a capture EXISTS and is merely landing later, use capture_pending instead. Replaces hunting for scripts/no-capture.mjs in the plugin clone; the script remains the no-server fallback (--lane there).",
      inputSchema: strict({ reason: z.string(), lane: z.enum(NO_CAPTURE_LANES).optional() }),
    },
    ({ reason, lane }) => json(tools.noCapture(reason, lane))
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
        'List open maintenance-queue items (system todos), optionally by system_reason, file keys, contains (substring narrowing on text, case-insensitive, literal — never FTS5 query syntax), or feature_slug (narrows to items owned by ONE article, resolved from its slug and CHAIN-AWARE — an item raised against an earlier superseded version of the article still matches; every filter combines as a genuine AND). An unresolvable feature_slug narrows to nothing rather than erroring. Returns {matched_filter, returned, cap, capped, offset, records}: capped=true means the queue is DEEPER than what is shown past this page — a drain that stops at the cap leaves the tail behind, so raise cap or page with offset until capped is false. offset (default 0) pages a DETERMINISTIC order (updated_at DESC, stable) — offset:0, offset:cap, offset:2*cap, … visits every item exactly once, even a 186-item queue a single capped call cannot see past item 1 of. projection:"digest" returns one clipped line per item (with its system_reason lane); projection:"headline" is smaller still (id, priority, system_reason, first 80 chars of text) — the cheap way to size, sort, and page a deep queue before draining it.',
      inputSchema: strict({
        system_reason: z.string().optional(),
        file_keys: z.array(z.string()).optional(),
        contains: z.string().optional(),
        feature_slug: z.string().optional(),
        cap: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        projection: z.enum(['full', 'digest', 'headline']).optional(),
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
