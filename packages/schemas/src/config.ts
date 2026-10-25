import { z } from 'zod';
import { judgeProjectMode } from './project.js';

// Project config (§12: default config — caps, watcher, model+effort table,
// reviewer-selection rules, difficulty rubric thresholds — ALL TUNABLE).
// templates/default-config.json is the shipped source; init copies it into
// <project>/.sterling/config.json and bakes toolchain declarations (§9.1).
// One schema, every reader: a malformed config fails loud, never half-applies.

// .strict() (review fix, config_set
// decision config-writes-get-a-config-set-mcp-tool-with-positive-key-allowlist-raw-edit-denial-stays item 5): this
// shape has been fixed since inception, no downgrade risk — so an unknown
// sibling key (`models.coder {"model":..,"junk":..}`) is refused by schema
// validation rather than silently persisted (config_set writes its caller's
// raw merged object, so a non-strict shape here would let a typo'd field
// land on disk unrefused, same rationale as the delivery leaf check below).
const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh']);

// A hard_task or vendor pin is {model, effort?} (decision
// system-tab-sets-vendor-policy-and-models-for-reviewer-sparring-and-hard-tasks):
// effort omitted means the host's own default, so none is invented here.
const modelPin = z.object({
  model: z.string(),
  effort: effortLevel.optional(),
}).strict();

// An OpenCode model reference, <provider>/<model> (for example
// openai/gpt-5.6-terra): the form an OpenCode agent's `model:` line takes.
export const OPENCODE_MODEL_REF_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A Claude model id as config.models.<agent>.model holds it (claude-sonnet-5-5,
// an alias such as opus, or an id with a context suffix such as
// claude-opus-4-6[1m]). The value lands on a frontmatter `model:` line in the
// Claude and OpenCode agent files, so whitespace, a newline or YAML syntax is
// refused here, when the config is written.
export const CLAUDE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9]+\])?$/;

// models.<agent>: the default pin plus an optional hard_task pin the conductor
// passes when it escalates that agent. effort is REQUIRED on the default pin:
// it fills {{EFFORT}} in the agent template, and resolveModelVars
// (scripts/lib/agent-distribution.mjs) throws at render time without it, so a
// config missing it is refused here, when it is written.
// opencode_model is the role's OpenCode-only override (decision
// opencode-only-model-override-per-role-for-openai-picks): `model` stays the
// Claude model Claude Code runs, and the OpenCode agent pins opencode_model
// when it is set, anthropic/<model> otherwise.
const agentModelEntry = z.object({
  model: z.string().regex(CLAUDE_MODEL_ID_RE, 'model must be a Claude model id such as claude-sonnet-5-5, with no spaces or newlines'),
  effort: effortLevel,
  hard_task: modelPin.optional(),
  opencode_model: z.string().regex(OPENCODE_MODEL_REF_RE, 'opencode_model must be <provider>/<model>, for example openai/gpt-5.6-terra').optional(),
}).strict();

// One pin per vendor, shared by sparring_partner.models and review.models.
const vendorPins = z
  .object({
    openai: modelPin.optional(),
    anthropic: modelPin.optional(),
  })
  .default({});

// Toolchain success predicates (decision foreign_98549344, slug
// toolchain-success-predicates-run-gate, board babf3a9e). Lives ALONGSIDE
// run_commands, keyed by the same run_command key — never nested inside a
// run_commands string value (that would break H14's Object.values flatMap
// over run_commands as plain strings). At least one criterion must be
// declared; an empty {} is refused rather than silently accepted as "nothing
// to check" (P5).
const successPredicateSchema = z
  .object({
    output_regex: z.string().optional(),
    output_regex_absent: z.string().optional(),
    artifact: z
      .object({
        path: z.string(),
        min_bytes: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.output_regex !== undefined || v.output_regex_absent !== undefined || v.artifact !== undefined,
    { message: 'success_predicates entry must declare at least one criterion (output_regex, output_regex_absent, or artifact)' }
  );

// One tool name for config.agents.<name>.extra_tools (the former ruling 'per-project-agent-extra-tools-config-appended-at-render' (not in the current store)). Enforced at the
// render step (not in the schema), because the rendered value lands in frontmatter.
export const AGENT_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*\*?$/;

// See undeclared_source_exclude_globs below. Frozen copies are handed out, so a
// caller can never mutate the shared default.
export const DEFAULT_UNDECLARED_SOURCE_EXCLUDE_GLOBS: readonly string[] = Object.freeze(['**/*.sh']);

export const configSchema = z.object({
  toolchains: z
    .array(
      z.object({
        adapter: z.string(),
        path_globs: z.array(z.string()),
        // baked from the adapter at init (§9.1)
        test_globs: z.array(z.string()).optional(),
        run_commands: z.record(z.string(), z.string()).optional(),
        capabilities: z.record(z.string(), z.boolean()).optional(),
        // §see comment above: keyed by run_command key, optional, never defaulted to {}
        success_predicates: z.record(z.string(), successPredicateSchema).optional(),
      })
    )
    .default([]),
  backup_path: z.string().optional(),
  // §2.3: init refuses without a backup path OR an explicit recorded opt-out;
  // with opt-out, disposal skips the snapshot LOUDLY (check_skipped).
  backup_opt_out: z.boolean().default(false),
  // §3.3: the project's stack_tags, declared at init, are the domain mount
  // manifest and nothing else; they do not filter retrieval (a query's own
  // stack_tags option is a separate, caller-supplied filter). Each tag mounts an
  // EXISTING store at ~/.sterling/domains/<tag>/sterling.db; a new domain store
  // is made only by createDomain in @sterling/store, which requires a description.
  stack_tags: z.array(z.string()).default([]),
  // §3.3 (spec line 94 — path configurable per domain): per-tag store-path
  // override; default is the per-user root above. tag → absolute db path (POSIX).
  domain_paths: z.record(z.string(), z.string()).default({}),
  // Named detached working trees (comsoft-juiced incident 2026-07-17): map of
  // SYMBOLIC tree name → tree path (absolute POSIX, or relative to the project
  // root). Records carrying working_tree: <name> resolve their file paths
  // against the mapped tree instead of the project root; an unmapped name makes
  // every consumer abstain LOUD (verify_before_use), never guess. Machine-
  // specific paths live here, in per-project config — never inside store
  // records (invariant 2).
  working_trees: z.record(z.string(), z.string()).default({}),
  // Generated projection files (regen↔baseline circularity, 2026-07-17):
  // repo-relative POSIX paths of files REGENERATED from the store
  // (architecture.md). Content churn on these is a regen, not out-of-band
  // drift, so the read-time drift check skips its CONTENT-change arm for them
  // — their currency is guarded by check-projection-fresh at the merge gate,
  // not by article baselines. DELETION still flags (a vanished committed
  // deliverable is real drift regardless of how the file is produced).
  generated_projections: z.array(z.string()).default([]),
  // Undeclared-source disclosure (decision
  // undeclared-source-disclosure-per-file-coverage-live-h1-scan, board
  // 44ef6838): POSIX globs excluded from the live per-file source-extension
  // coverage scan H1 (SessionStart) and init render — an excluded file never
  // participates (neither covered nor uncovered), same precedence as
  // classifyCoverage's excludeGlobs parameter in
  // scripts/hooks/lib/undeclared-source.mjs (excluded wins over a matching
  // toolchain path_glob).
  // DEFAULT ['**/*.sh'] (decision gap-hunt-2026-09-28-rulings item 6): shell
  // scripts are launcher and console glue, never a toolchain's source, and
  // flagging them was banner noise answered the same way every session. The
  // default lives in THREE places that must agree: here, templates/default-
  // config.json (the former ruling 'assuming sync-agents propagates a config.models bump to installed agents' (not in the current store)), and the raw-config ladder in
  // scripts/hooks/lib/undeclared-source-scan.mjs, which imports this constant.
  // An explicit [] still opts back in.
  undeclared_source_exclude_globs: z.array(z.string()).default(() => [...DEFAULT_UNDECLARED_SOURCE_EXCLUDE_GLOBS]),
  // Attestation disclosure
  // (decision attestation-staleness-disclosure-only-never-a-refusing-gate, 1f069af4; board attestation-gate 9868a0dd): the
  // POSIX globs whose touched paths get a comparable-human-record rollup at
  // commit and at both merge surfaces. DECLARATION ONLY — nothing keyed on this
  // field can ever refuse an operation; the refusing form of this feature was
  // DECLINED, because a gate the conductor must pass turns the conductor into
  // the de-facto attestation trigger, reversing decision foreign_a7dbac2f (an
  // attestation records a HUMAN inspection). EMPTY IS THE DEFAULT AND MEANS
  // FULLY DORMANT: no store is opened, no diff is taken, nothing is printed.
  // Sterling's own config declares none — the feature exists for consuming
  // projects with render/asset paths.
  // `z.unknown()` IS THE POINT, AND IT IS DELIBERATE (Codex review HIGH-1 +
  // roster MEDIUM-1, 2026-09-01). This field cannot validate ANYTHING here — not
  // element type, not emptiness, not duplicates — because direct-merge.mjs and
  // merge-gate.mjs run parseConfig through openProject() long before the
  // disclosure's fail-open wrapper exists, so ANY refusal on this field kills the
  // whole merge command. Measured shapes that must not do that: `["", …]`,
  // duplicated globs, and the bracket-less hand-edit
  // `"attestation_path_globs": "renders/**"` (a plain string, not an array).
  // An ADVISORY declaration that can refuse a merge inverts this feature's own
  // ruling, which is the one thing the design is not allowed to do.
  // z.unknown().default([]) PRESERVES the declared value verbatim rather than
  // coercing or dropping it, and it forces any future consumer of the PARSED
  // config to narrow this field explicitly instead of assuming string[].
  // WHERE THE REAL READ LIVES: readAttestationGlobs() in
  // scripts/lib/attestation-inspection.mjs is the ONE place this field is
  // interpreted — it re-reads .sterling/config.json itself, drops a non-array
  // container, non-string members, empty strings and exact duplicates, and
  // DISCLOSES every drop in the rollup. No surface may take these globs from the
  // parsed config object instead.
  attestation_path_globs: z.unknown().default([]),
  // §12 ensure-manifest: declarations are read back from the recorded config on
  // re-runs (no flags required), so the project name is recorded alongside them.
  project_name: z.string().optional(),
  // §11 launcher split ratio
  tui_split_ratio: z.number().positive().max(1).default(0.35),
  // §6 H6/H10 conductor-session pressure gauge. warn_pct/block_pct/mode were
  // H6-only (agent-scoped context enforcement) and DELETED with H6 under
  // decision `sterling-claude-code-scale-down-boundary` (d3e63e16); windows
  // and conductor.{soft_pct,hard_pct} survive — H10 reads both (the gauge
  // denominator and the direct-mode pressure thresholds). `windows.default`
  // is a REAL fallback (decision context-window-default-is-a-real-fallback,
  // user-ruled 2026-09-22, reversing the earlier "never a default"): it is
  // the window H10 uses for any model with no per-model entry, so it is
  // seeded at the largest generation's window rather than a conservative
  // guess — a per-model entry still always wins when one exists.
  context_watch: z
    .object({
      windows: z.record(z.string(), z.number().int().positive()).default({ default: 1_000_000 }),
      // Conductor-session pressure thresholds (direct mode, H10 Stop seam): soft = advisory
      // "finish before opening new areas"; hard = once-per-session soft-block naming the
      // delegation remedy.
      conductor: z
        .object({
          soft_pct: z.number().positive().default(35),
          hard_pct: z.number().positive().default(50),
        })
        .default({}),
    })
    .default({}),
  // In-flight dispatch register (decision foreign_ec9eacaa, H22): how long an entry may
  // sit in .sterling/transient/dispatch-register.json before H10 stops deferring
  // duties for the files it owns. SubagentStop on a killed/aborted subagent was
  // never probed (research_finding foreign_20b44518), so this TTL is what converts that
  // unknown into a bounded, disclosed degradation instead of a duty deferred
  // forever (P5).
  dispatch_register: z
    .object({
      stale_minutes: z.number().int().positive().default(60),
      // H10 keeps holding a capture_pending declaration while any row of the
      // current session ENDED within this many minutes, so a lane that parks
      // on background work and resumes as a new round does not open a gap
      // (decision capture-pending-hold-window-spans-resume-rounds). 0 turns
      // the window off.
      resume_hold_minutes: z.number().int().nonnegative().default(10),
    })
    .default({}),
  // Concurrent-subagent ceiling (decision foreign_d7a0289f, board 18a22b56): every
  // surface that states the "N concurrent subagents" ceiling (H1's banner
  // prose, H8's dispatch cap, CLAUDE.md) reads it from here rather than a
  // hardcoded literal, so a ruling that changes it takes effect everywhere
  // without a hook-text edit. The anti-quota semantics are UNCHANGED either
  // way — this tunes only the number, never a floor/quota (decisions
  // 677f1639/299d853a stand). Absent → shipped default 5.
  delegation: z
    .object({
      max_concurrent: z.number().int().positive().default(5),
    })
    .default({}),
  // Board task claims (decision
  // board-task-claims-for-parallel-sessions-claim-generation-ren): a claim not
  // renewed by task work or board_reaffirm for lease_minutes shows as 'check
  // owner', is kept out of READY and may be taken over by any session.
  board_claims: z
    .object({
      lease_minutes: z.number().int().positive().default(60),
    })
    .default({}),
  // §7.2 model + effort defaults (tunable config, not architecture).
  // Hard rule encoded here as data: no xhigh/max for subagents; max never
  // appears. Slice 5/8 (decision sterling-claude-code-scale-down-boundary,
  // 2ad87dd1, change 3) renamed these keys to match the roster directly —
  // 'coder' -> 'implementor', 'explorer' -> 'scout' — so AGENT_MODEL_KEY no
  // longer needs an indirection layer between an agent's name and its config
  // key.
  models: z
    .object({
      // The reviewer's and sparring's opencode_model below are the models the conductor
      // named on those dispatches before the OpenCode dispatch model resolver (decision
      // subagent-model-choice-on-opencode-conductor-states-dispatch). They are whole-entry
      // defaults only, never hidden field defaults: an entry that exists without them means
      // "none" (clearing opencode_model in the System tab runs the role on its Claude
      // model). Live entries written before them get them once, visibly, from
      // addModelDefaults below at sync and init (user-ruled 2026-10-23, "Write it into each
      // config").
      // The plain implementor runs at medium (user-ruled 2026-10-25, "Trial medium, then
      // measure"; decision overpass-default-effort-per-role-high-for-agentic-auto-roles, v2).
      implementor: agentModelEntry.default({ model: 'claude-sonnet-5-5', effort: 'medium' }),
      // implementor-hard is the sterling/implementor-hard agent (decision
      // hard-implementor-is-its-own-agent-sterling-implementor-hard): the hard implementor
      // lane, with its own Overpass tier and System tab row. It replaces
      // models.implementor.hard_task, whose default it keeps (Opus 5.5, at the
      // implementor's effort); moveImplementorHardTask below moves a live hard_task here.
      'implementor-hard': agentModelEntry.default({ model: 'claude-opus-5-5', effort: 'high' }),
      researcher: agentModelEntry.default({ model: 'claude-sonnet-5-5', effort: 'medium' }),
      scout: agentModelEntry.default({ model: 'claude-sonnet-5-5', effort: 'low' }),
      // librarian is mechanical clerking — cheap model, low effort (P8). The
      // roster is classless (decision agent-roster-is-classless-four-agents), and
      // the debugger role it rejected has no key here.
      librarian: agentModelEntry.default({ model: 'claude-haiku-5-5', effort: 'low' }),
      // reviewer judges a diff (decision
      // reviewer-agent-is-the-one-review-rubric-for-claude-and-codex). Every
      // dispatch pins its model explicitly; this is the install-time default.
      reviewer: agentModelEntry.default({ model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' }),
      // sparring is the sterling/sparring agent (user-ruled 2026-10-22): the same
      // read-only grant as the reviewer, so the same install-time default. Every
      // dispatch pins its model (Astra, else a Fable model); under Overpass its
      // role tier decides.
      sparring: agentModelEntry.default({ model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6-astra' }),
      // preflight is the sterling/preflight agent (decision
      // knowledge-pre-flight-agent-sterling-preflight-a-read-only-la): a read-only store
      // lookup, so a cheap model at low effort like the scout.
      preflight: agentModelEntry.default({ model: 'claude-sonnet-5-5', effort: 'low' }),
    })
    // Any installed agent's name is a key (decision
    // system-tab-sets-vendor-policy-and-models-for-reviewer-sparring-and-hard-tasks):
    // the roster is discovered from the installed agent files, so the schema
    // cannot list it. The pre-rename keys in RETIRED_MODEL_KEYS are dropped by
    // normalizeRawConfig before this parse, so a stale value cannot fail it.
    .catchall(agentModelEntry)
    .default({}),
  // Per-project agent tool extension (decision
  // the former ruling 'per-project-agent-extra-tools-config-appended-at-render' (not in the current store):
  // agents.<registered-agent-name>.extra_tools is appended to that agent's
  // rendered tools: line at install. It must live in the schema — this top-level
  // object strips unknown keys silently. Each entry is one tool name with an
  // optional trailing `*`; commas, whitespace and newlines are refused because a
  // newline in the rendered frontmatter could inject keys such as hooks:.
  // All of that — entry syntax, unknown keys, registry membership, tools:-line
  // presence and the Sterling-MCP-prefix ban — is refused loudly at render
  // (scripts/lib/agent-distribution.mjs), where install and sync fail; parsing
  // stays lenient so a typo never breaks MCP boot or a hook.
  agents: z
    .record(
      z.string(),
      // LENIENT on purpose (review fix): the MCP server and every hook parse
      // this file, so a hand-edit typo must not make every parseConfig throw —
      // the hazard the delivery block records for .strict(). passthrough keeps
      // an unknown key (a typo such as extra_tool) so render can refuse it by
      // name; entry syntax (AGENT_TOOL_NAME_RE) is enforced at render too.
      z
        .object({
          // z.unknown, not z.array: even a non-array value (a string) must
          // parse; render refuses it by name ("not an array").
          extra_tools: z.unknown().default([]),
        })
        .passthrough(),
    )
    .default({}),
  // §6 H10 article demand: direct-mode touches in unowned territory at this
  // threshold (or any new unowned file vs git HEAD) demand the owning article
  article_demand: z
    .object({
      min_unowned_files: z.number().int().positive().default(3),
      // Per-project policy data (decision
      // article-demand-ignore-globs-per-project-policy-data): a touched path
      // matching any glob is dropped from the demand candidate set PER PATH.
      // Ships empty so every project is unchanged until it opts in (Dome
      // Farmer: `**/*.uid`, Godot's tracked identity sidecars).
      ignore_globs: z.array(z.string().min(1)).default([]),
    })
    .default({}),
  // §3.2.7 H1 queue-depth signal: at or above this many open maintenance items,
  // SessionStart tells the CONDUCTOR the queue is deep and wants draining — not
  // just the human. The counts have always been computed and sent as a
  // systemMessage the MODEL never sees, on the reasoning that an event-drained
  // queue is otherwise noise; that holds while it is shallow and fails once it is
  // not. A consuming project reached 63 items, most of them work already finished
  // and never closed, with nothing prompting a drain (reported 2026-07-29).
  // Below the threshold H1 stays silent to the model (P1 — no ceremony).
  maintenance_queue: z
    .object({
      deep_threshold: z.number().int().positive().default(15),
    })
    .default({}),
  // Background maintenance worker kill switch (decision
  // maintenance-queue-background-haiku-worker-simple-redesign): when true, H10
  // (at Stop) and H19's Bash surface (after a git commit) start a detached
  // headless Claude run that judges open reconcile_needed items and closes the
  // ones already paid (scripts/hooks/lib/maintenance-worker.mjs). false stops
  // every launch; the queue then drains by hand with /sterling:drain.
  // There is no daily budget: the worker runs whenever the queue has eligible
  // work, capped only per run (decision
  // maintenance-worker-notices-session-start-only-and-no-sliver-launch). A
  // daily_budget_usd left in an existing config is stripped by this non-strict
  // object. The default lives here AND in templates/default-config.json,
  // because install/sync fill an omitted key from this zod default, not the
  // template.
  maintenance_worker: z
    .object({
      enabled: z.boolean().default(true),
      // The OpenCode runner's model as provider/model (decision
      // opencode-maintenance-worker-refuses-without-a-configured-model): the
      // worker REFUSES to start without it, so config_set must not call it
      // unread (GitHub issue 23). No default, deliberately. Reader:
      // scripts/hooks/lib/maintenance-worker.mjs opencodeModelOf(). PERMISSIVE
      // like `mode`: a non-string is preserved raw and refused loudly by that
      // reader, never thrown on here (a throw would fail the MCP server's boot).
      opencode_model: z.unknown().optional(),
    })
    .default({}),
  // Board 8390f8fa: a registry-style feature_article can outgrow its own
  // round-trip — knowledge_append responses on mcp-tool-surface (29 history
  // entries) and hooks-suite's what_it_does (26k tokens) both blew the MCP
  // token cap. Measured: mcp-tool-surface serializes ~104KB. Set well below
  // that observed failure and above every healthy article; a knowledge_update/
  // append/edit that lands a feature_article over this many chars (as
  // knowledge_get would return it) warns via the write's result envelope and
  // enqueues one deduped article_oversize maintenance item. Tunable per
  // machine, not architecture.
  article_oversize_chars: z.number().int().positive().default(60000),
  // Decision foreign_881baf13 (supersedes foreign_d547d3b0): per-article accepted-oversize
  // exemption register, article slug -> justifying decision id. Consulted at
  // the article_oversize minting site (articleOversizeWarnings,
  // packages/mcp-server/src/tools.ts) BEFORE it mints/dedup-refreshes the
  // maintenance item — the exemption suppresses the mint ONLY while the cited
  // decision resolves and is live (status active, not superseded/retired) in
  // the store the minting code already has open. A missing/unresolvable/dead
  // citation VOIDS the exemption; the mint proceeds with the void reason
  // appended to the item text — never a silent suppression (P5).
  article_oversize_exempt: z.record(z.string(), z.string()).default({}),
  // Board 0697c6bd: history is bounded AT THE WRITE — a feature_article landing
  // with more entries than this keeps the first article_history_genesis_entries
  // plus the newest remainder, evicting the middle (board ab87fe24; disclosed on
  // the write's warnings channel). Nothing is lost: every rotated-away entry
  // remains readable in the retained superseded versions, which the store keeps
  // forever — the supersede chain IS the archive, so no new table or archive
  // record type exists for retrieval to mis-serve. Measured 2026-08-10: the
  // three oversize articles carried 29/41/46 entries at 0.65–1.5KB each —
  // 42–57% of their serialized size — and history dominated every write echo
  // and full read. 20 keeps a reconcile trail deep enough for the brief-lookup
  // consumers (promotion/completeness match on RECENT entries' target_id)
  // while bounding the round-trip.
  article_history_max_entries: z.number().int().positive().default(20),
  // Board ab87fe24: middle-out rotation sibling to article_history_max_entries
  // above. On rotation the live record keeps the FIRST genesis_entries entries
  // (founding/genesis, by array position) plus the newest
  // (max - genesis_entries) entries, evicting the middle. genesis_entries >=
  // max clamps to max - 1 so at least one recent entry always survives.
  article_history_genesis_entries: z.number().int().nonnegative().default(2),
  // Whether THIS project store is the one the repo's shared, store-DERIVED
  // artifacts are produced from. Two exist: record-id citations in tracked source,
  // and the committed architecture.md projection. Both are checked into git while
  // the store that produces them is NOT (.sterling/ is gitignored), so on any
  // store but the producing one they read as broken when they are merely foreign.
  // Record ids make this concrete: an id is minted by the store that first created
  // the record, and knowledge crosses machines as an export payload whose ids the
  // receiving server RE-MINTS, so one record ends up with a different id per store.
  //
  // 'primary'   — this store mints the ids the tree cites and owns the projection.
  //               A dangling citation (a typo, or a record never created) and a
  //               stale projection are real defects here. Both arms fail.
  // 'secondary' — the tree cites another store's id namespace, and the committed
  //               projection was generated from that store. Neither is verifiable
  //               here, and REGENERATING the projection here would actively regress
  //               a shared file, since a smaller store projects a smaller document.
  //               Both arms report in full and exit 0 (P1 — a gate that cannot
  //               change an outcome is ceremony; P5 — it never goes quiet, and each
  //               pass line names the setting so a weakened arm is never mistaken
  //               for a clean one).
  //
  // KNOWN COST, not a side effect: under 'secondary' a citation written on THAT
  // machine goes unchecked too — the arm cannot tell it from a foreign one. What
  // removes the need for this knob entirely is preserving origin ids on import, so
  // a record carries one id everywhere; see the decision 'Citation and projection
  // authority is per-store' (cited by title, not id, deliberately — citing its id
  // here would itself dangle on every store but the one that minted it).
  store_authority: z.enum(['primary', 'secondary']).default('primary'),
  // Machine-local role marker (todo cabbc10f, decision foreign_a9b98b7d) — DELIBERATELY
  // OPTIONAL with NO DEFAULT: absence is a meaningful state ('undeclared'), not
  // a value to infer. 'authoring' is declared once, by hand, on the machine
  // where Sterling work lands and merges; a successful /sterling:update stamps
  // 'consumer' into a clone that has it absent, and never overwrites an
  // existing value (so an authoring machine that occasionally pulls stays
  // 'authoring'). H1 reads this — never store_authority, whose 'primary'
  // default would mislabel every consumer that never opted in (the rejected
  // alternative in a9b98b7d) — and reports it only on a Sterling clone itself.
  machine_role: z.enum(['authoring', 'consumer']).optional(),
  // §6 H16 session-event register (run r-0501): which agent types are considered
  // research agents for the research_owed lane (phase 2 filtering). Default list
  // is over-inclusive (§7.1 precedent) — tune down on run data.
  session_events: z
    .object({
      research_agents: z.array(z.string()),
    })
    .default({ research_agents: ['researcher', 'claude-code-guide'] }),
  // §3.4 stale-at-read thresholds (days)
  staleness: z
    .object({
      research_days: z
        .object({
          fast: z.number().int().positive().default(30),
          medium: z.number().int().positive().default(90),
          stable: z.number().int().positive().default(365),
        })
        .default({}),
      platform_external_days: z.number().int().positive().default(180),
    })
    .default({}),
  // run r-ea9e, AC7: TUI System tab — how long a KB-maintained models catalog
  // reference_material is considered fresh before the tab prompts a refresh.
  // Distinct from the existing `staleness` block (which governs research
  // findings and platform docs, not the models catalog).
  models_catalog: z
    .object({
      staleness_days: z.number().int().positive().default(45),
    })
    .default({}),
  // H19 knowledge delivery (decision foreign_6dfbe675). injection_rung is PROBE-SET
  // per machine/CC version (verify-at-build 0956a464): 'prompt' (default,
  // platform-proven — enqueue at file-touch, inject at next UserPromptSubmit),
  // 'read' (PostToolUse injects directly at the touch), 'edit' (only
  // PreToolUse injection works; Read touches fall back to the queue).
  // NOT .strict() (review-reverted, config_set
  // decision config-writes-get-a-config-set-mcp-tool-with-positive-key-allowlist-raw-edit-denial-stays
  // item 1): a first attempt made this object .strict() so config_set's
  // whole-document validation would refuse an unrecognized delivery leaf.
  // That is a FORWARD-COMPATIBILITY BRICK with no in-session remedy — ANY
  // unknown key already sitting in a project's delivery block (a forward-
  // shipped field, a hand-edit) turns EVERY parseConfig call into a startup
  // failure of the MCP server itself (server.ts's boot-time parseConfig)
  // AND an H15 environment-defect deny for every other Bash/store call on
  // that project, with no config_set available to fix it because the server
  // never came up to serve the tool. config_set instead membership-checks
  // the delivery leaf itself (configSetAllowlistVerdict, tools.ts) exactly
  // as it already does for models.<key> — this schema stays permissive so a
  // config.json carrying an unmodeled delivery key never bricks anything
  // that merely READS the file.
  delivery: z
    .object({
      // `prompt` and `edit` are accepted only to migrate existing project
      // configs. Parsed configuration exposes only the surviving read rung.
      injection_rung: z.enum(['prompt', 'edit', 'read']).default('read').transform(() => 'read' as const),
      payload_char_cap: z.number().int().positive().default(2400),
      // Per-delivery total cap in UTF-8 bytes (H19 delivery family, Slice 3's
      // "H19 gets a per-delivery total cap and cross-entry dedup across the
      // turn"): scripts/hooks/lib/delivery.mjs reads this at
      // DELIVERY_TOTAL_CAP_DEFAULT's fallback site. 0 disables the cap. An
      // absent/invalid value falls back to the same default there, same
      // three-state guard used for other config-derived delivery values.
      total_cap_bytes: z.number().int().nonnegative().default(3000),
    })
    .default({}),
  // Sparring partner (decision sparring-partner-partnership-shape, board a0714d0b):
  // whether the automatic consult moments (design/review/gate second opinions via
  // the official `codex mcp-server`) are ACTIVE for this project. Mirrors the
  // additive advisory-block pattern (every field has a default; an absent
  // block still parses) — a project without the
  // Codex CLI installed still parses and defaults to true; the TUI System tab
  // flips it per project (decision foreign_98064d77's config-is-authoritative pattern).
  // A machine missing Codex is a DISTINCT, louder state (init's probe skip report)
  // — this field never stands in for that absence, only for a deliberate OFF.
  sparring_partner: z
    .object({
      enabled: z.boolean().default(true),
      // Which vendor's model the consult runs on (decision
      // system-tab-sets-vendor-policy-and-models-for-reviewer-sparring-and-hard-tasks).
      // 'openai' is the behaviour before the setting existed.
      vendor: z.enum(['openai', 'anthropic']).default('openai'),
      // The model pinned per vendor. Absent = no pin (the host's default). The
      // old sparring_partner.model is converted to models.openai by
      // normalizeRawConfig, before this schema strips unknown keys. The default
      // ships no pin: the decision names no model per vendor.
      models: vendorPins,
    })
    .default({}),
  // Reviews (same decision): the vendor policy and the model pinned per vendor.
  // cross_vendor = the other family than the model that wrote the diff; openai
  // and anthropic force one vendor even when that makes reviewer and author the
  // same family (user-ruled 2026-10-03). Ships no pin, like sparring_partner.
  review: z
    .object({
      policy: z.enum(['cross_vendor', 'openai', 'anthropic']).default('cross_vendor'),
      models: vendorPins,
    })
    .default({}),
  // TDD-by-default posture toggle (decision foreign_752caf98,
  // tdd-and-mutation-toggles-in-system-tab): whether the standing "tests first
  // for new behavior" posture (user-affirmed 2026-08-09) fires automatically.
  // Mirrors sparring_partner's additive-optional shape exactly — an absent
  // block still parses with {enabled: true}, and an unknown field inside the
  // block strips silently rather than refusing (forward-compat, non-strict).
  // OFF silences only the automatic default posture: an explicit user ask
  // still works, and H5 (frozen tests)/H18 (write wall) are untouched — no
  // gate or hook arm keys on this toggle.
  tdd: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  // Project mode (decision project-mode-hobby-work-toggle-decides-flow, narrowed
  // by project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
  // the per-project switch that decides how work ships. 'hobby' (the default)
  // merges directly through /sterling:merge; 'work' opens a pull request and
  // runs the review loop. It decides nothing else: whether the handoff files
  // are written is `handoff` below. Toggled in the TUI System tab. A missing
  // key means hobby.
  // PERMISSIVE ON PURPOSE, like attestation_path_globs above (Sol review of
  // S1): any other value is PRESERVED raw, never coerced to hobby and never
  // thrown on — a typo here must not turn every parseConfig reader (the MCP
  // server's boot included) into a startup failure. The strict judge is
  // readProjectMode() in packages/schemas/src/project.ts (re-exported by scripts/lib/handoff-projection.mjs), which every
  // surface that ACTS on the mode (/sterling:merge, the PR review loop duty,
  // sync-agents, /sterling:update) uses, and which refuses an invalid value loudly.
  // Consumers of the PARSED config must narrow this field themselves.
  // The default lives twice (the former ruling 'assuming sync-agents propagates a config.models bump to installed agents' (not in the current store)): here and in
  // templates/default-config.json; config.test.ts pins that they agree.
  mode: z.unknown().default('hobby'),
  // Where the project's stores live (decision
  // storage-backend-is-its-own-config-key-written-only-by-store-move): absent
  // or 'sqlite' is the local SQLite store, 'postgres' the project's schema in
  // the Served database, valid only with mode 'work'. Only
  // scripts/move-store.mjs writes it, after the stores have moved; config_set
  // and the TUI refuse it. Strict, unlike `mode`: a wrong value must never
  // route a project to the wrong backend. The reader is
  // packages/store/src/routing.ts (resolveStoreRoute). No default on purpose.
  storage: z.enum(['sqlite', 'postgres']).optional(),
  // Handoff files (decision
  // project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
  // `enabled` says whether Sterling writes the files for colleagues who do not
  // have Sterling, the portable OpenCode agents (.opencode/agents/) and the
  // handoff projection (architecture.md, rulings.md, docs/sterling/). Off by
  // default, independent of `mode`. Toggled in the TUI System tab.
  // PERMISSIVE for the same reason as `mode`: the value is preserved raw. The
  // strict judge is readHandoffEnabled() in scripts/lib/handoff-projection.mjs,
  // which init, sync-agents, /sterling:update, the handoff-projection CLI and
  // the git exclude block use. It refuses a value that is not a boolean, and it
  // reads a config with NO key as on when portable agents are already tracked
  // in git, which this default cannot express: read the setting through it,
  // never from the parsed config.
  // The default lives twice (the former ruling 'assuming sync-agents propagates a config.models bump to installed agents' (not in the current store)): here and in
  // templates/default-config.json; config.test.ts pins that they agree.
  handoff: z.unknown().default({ enabled: false }),
  // PR review loop (decision project-mode-hobby-work-toggle-decides-flow, S3):
  // copilot_logins pins the EXACT Copilot reviewer login(s) observed on the S0
  // first use; empty means unpinned (any Bot login matching /copilot/i, with
  // identity_confirmed false). PERMISSIVE like mode: a malformed value is
  // preserved raw, never thrown on; scripts/pr-review-wait.mjs is the strict
  // judge. auto_merge_on_clean (decision
  // work-mode-pr-auto-merge-when-copilot-loop-ends-clean, board 2ebbea9d): when
  // the loop settles clean and GitHub reports the PR mergeable, the conductor
  // squash-merges it and deletes the branch; false leaves the merge to a human.
  // Absent means on. Its strict judge is autoMergeOnCleanOf() in
  // scripts/lib/work-pr.mjs, which refuses a value that is not a boolean, so a
  // typo never turns into a merge. Toggled in the TUI System tab. The default
  // lives twice: here and in templates/default-config.json (config.test.ts pins
  // that they agree).
  pr_review: z.unknown().default({ copilot_logins: [], auto_merge_on_clean: true }),
  // Overpass toggle (decisions overpass-toggle-work-mode-only-routes-every-lane-through-tiers
  // and overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice):
  // routes the conductor and every lane through the provider's tiered models.
  // Work mode on OpenCode only. PERMISSIVE like mode: the value is preserved
  // raw so a typo never fails every parseConfig reader; the strict judge is
  // resolveOverpass() below, which throws on a present but invalid value,
  // including an unknown role or field under the optional `roles` map
  // (per-role tier and effort, resolveOverpassRoles). The default lives twice: here and in templates/default-config.json
  // (config.test.ts pins that they agree).
  overpass: z.unknown().default({ enabled: false, provider: 'overpass', conductor_bypass: true }),
  // The one-time config migrations already applied to this file (addModelDefaults),
  // so a value a migration added and the user later cleared is never added again.
  // Written by sync and init only.
  applied_config_migrations: z.array(z.string()).optional(),
});

export type SterlingConfig = z.infer<typeof configSchema>;

// ── Overpass resolver ────────────────────────────────────────────────────────
// Pure: takes an already-parsed (or raw) config object, reads nothing. The mode
// uses the same strict judge as readProjectMode (judgeProjectMode).

export const DEFAULT_OVERPASS_PROVIDER = 'overpass';
// A provider id: letters, digits, '-', '_', '.'; no '/', no '#', non-empty. It
// is interpolated into `<provider>/agentic-conductor` model references.
export const OVERPASS_PROVIDER_RE = /^[A-Za-z0-9._-]+$/;

// Per-role routing (decision overpass-toggle-work-mode-only-routes-every-lane-through-tiers,
// amended 2026-10-22, "Effort and tier per role"): config.overpass.roles maps a subagent
// role to an optional tier (the role's lanes run on <provider>/<tier> instead of the
// role's default tier, DEFAULT_OVERPASS_ROLE_TIERS) and an optional client reasoning effort, which the OpenCode
// plugin sends on each request of that role's lane. Effort is an exact override, not a
// minimum: 'high' also replaces an xhigh the gateway would have picked. A role with no
// effort set takes its default effort (DEFAULT_OVERPASS_ROLE_EFFORTS), which for some roles
// is none. Plan is not a role here and keeps laneModel.
// 'maintenance-worker' (board c97ddc97, user-ruled 2026-10-23, "Row + its own Overpass tier") is
// the one role that is not a subagent: no installed agent has that name, so a dispatch never
// reaches it through agentRole (the worker's own agent is WORKER_AGENT, 'sterling-maintenance-worker').
// Its route is read by the OpenCode plugin's worker launch (packages/opencode-plugin/src/worker.mjs).
export const OVERPASS_ROLES = ['implementor', 'implementor-hard', 'researcher', 'scout', 'reviewer', 'librarian', 'sparring', 'preflight', 'maintenance-worker'] as const;
export const MAINTENANCE_WORKER_ROLE = 'maintenance-worker' as const satisfies OverpassRole;
// The model and effort of the worker when it runs through the `claude` CLI (decision
// maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet). Fixed in
// scripts/hooks/lib/maintenance-worker.mjs (WORKER_MODEL, WORKER_EFFORT), which stays
// dependency-free, so a test pins the two copies to each other; the System tab shows them.
export const MAINTENANCE_WORKER_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const MAINTENANCE_WORKER_CLAUDE_EFFORT = 'medium';
export type OverpassRole = (typeof OVERPASS_ROLES)[number];
export const OVERPASS_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type OverpassEffort = (typeof OVERPASS_EFFORTS)[number];
export const OVERPASS_TIER_RE = /^agentic-[a-z0-9-]+$/;
export const DEFAULT_OVERPASS_TIER = 'agentic-high';
// The Overpass tiers the user listed (user-stated 2026-10-23), in that order: the System
// tab's tier picker offers these. They are not a closed set: OVERPASS_TIER_RE still accepts
// any agentic-* name, and the picker adds a role's current tier when it is not listed.
export const OVERPASS_TIERS = ['agentic-low', 'agentic-high', 'agentic-conductor', 'agentic-auto', 'agentic-premium', 'agentic-premium-max'] as const;
// Per-role default tiers (user-ruled 2026-10-22 through the question form, "Yes, as
// stated"): the implementor role defaulted to agentic-premium (Sonnet 5.5, Opus 5.5 and
// Sol 6.1, each at high, xhigh or max) and the sparring role (the sterling/sparring agent)
// to agentic-premium-max (Fable 5.1 and Astra 6, each at high, xhigh or
// max). Every other role, the reviewer included, stays on DEFAULT_OVERPASS_TIER. An
// explicit roles.<role>.tier still wins, and any name matching OVERPASS_TIER_RE is
// accepted, so no list of tier names needs to grow when the gateway adds one.
// implementor-hard (the sterling/implementor-hard agent, decision
// hard-implementor-is-its-own-agent-sterling-implementor-hard) took over agentic-premium,
// and the implementor moved to agentic-auto (user-ruled 2026-10-23, verbatim: "The new
// implementer-hard should run the angentic-premium tier, and the regular implementer should
// run angentic-auto"). The scout, librarian, preflight and maintenance-worker roles moved to
// agentic-auto too (user-ruled 2026-10-23, 'Defaults + reset + bypass ON': the tiers CH.Core's
// System tab showed are the defaults for every project; resetOverpassDefaults clears the live overrides).
export const DEFAULT_OVERPASS_ROLE_TIERS: Record<OverpassRole, string> = {
  implementor: 'agentic-auto',
  'implementor-hard': 'agentic-premium',
  researcher: DEFAULT_OVERPASS_TIER,
  scout: 'agentic-auto',
  reviewer: DEFAULT_OVERPASS_TIER,
  librarian: 'agentic-auto',
  sparring: 'agentic-premium-max',
  preflight: 'agentic-auto',
  'maintenance-worker': 'agentic-auto',
};
// Per-role default client efforts (decision overpass-default-effort-per-role-high-for-agentic-auto-roles,
// user-ruled 2026-10-24 for GitHub #203): with no effort sent, the gateway used each
// member's own default (max on some members), and a max-effort lane failed at OpenCode
// compaction. The plugin cannot set a default per served model, because the gateway picks
// the member, so the default is per role: high for the other agentic-auto roles, medium for
// the plain implementor (user-ruled 2026-10-25, "Trial medium, then measure"), xhigh for
// implementor-hard and sparring, and none for reviewer and researcher, whose agentic-high
// members carry their own effort and never served max. No default is ever max. An explicit
// roles.<role>.effort still wins.
export const DEFAULT_OVERPASS_ROLE_EFFORTS: Readonly<Partial<Record<OverpassRole, OverpassEffort>>> = {
  implementor: 'medium',
  'implementor-hard': 'xhigh',
  scout: 'high',
  librarian: 'high',
  sparring: 'xhigh',
  preflight: 'high',
  'maintenance-worker': 'high',
};

export interface OverpassRoleRoute {
  /** <provider>/<roles[role].tier ?? DEFAULT_OVERPASS_ROLE_TIERS[role]>. */
  model: string;
  /** The client reasoning effort for the role's requests: roles[role].effort, else
   *  DEFAULT_OVERPASS_ROLE_EFFORTS[role]; absent when neither is set. */
  effort?: OverpassEffort;
}

export interface OverpassResolution {
  /** overpass.enabled is true in the config, whatever the mode or host. */
  configured: boolean;
  /** configured AND mode is 'work' AND host is 'opencode'. */
  effective: boolean;
  /** effective AND conductor_bypass is false: the conductor itself is routed. */
  conductorRouted: boolean;
  provider: string;
  conductorModel: string;
  /** The lane model of Plan, and of a subagent that is not one of OVERPASS_ROLES. */
  laneModel: string;
  /** Every role in OVERPASS_ROLES, with its lane model and effort (config.overpass.roles). */
  roles: Record<OverpassRole, OverpassRoleRoute>;
  /** Why a configured overpass is not effective; absent otherwise. */
  reason?: string;
}

/**
 * The error resolveOverpass throws for a config.overpass.roles key outside OVERPASS_ROLES.
 * Its own class so a reader can tell the likely cause: a newer Sterling, which knows more
 * roles, wrote the key (GitHub #202), and the remedy is updating the reader.
 */
export class OverpassUnknownRoleError extends Error {
  readonly role: string;
  constructor(role: string) {
    super(`config.overpass.roles has the unknown role ${JSON.stringify(role)} — the roles are ${OVERPASS_ROLES.join(', ')}`);
    this.name = 'OverpassUnknownRoleError';
    this.role = role;
  }
}

/** config.overpass.roles judged strictly: unknown roles, unknown entry fields and bad values throw. */
function resolveOverpassRoles(raw: unknown, provider: string): Record<OverpassRole, OverpassRoleRoute> {
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new Error(`config.overpass.roles is ${JSON.stringify(raw)} — it must be an object like {"reviewer": {"tier": "agentic-high", "effort": "high"}}`);
  }
  const block = raw ?? {};
  for (const key of Object.keys(block)) {
    if (!(OVERPASS_ROLES as readonly string[]).includes(key)) {
      throw new OverpassUnknownRoleError(key);
    }
  }
  const out = {} as Record<OverpassRole, OverpassRoleRoute>;
  for (const role of OVERPASS_ROLES) {
    const entry = block[role];
    if (entry !== undefined && !isPlainObject(entry)) {
      throw new Error(`config.overpass.roles.${role} is ${JSON.stringify(entry)} — it must be an object with an optional "tier" and "effort"`);
    }
    const fields = entry ?? {};
    for (const key of Object.keys(fields)) {
      if (key !== 'tier' && key !== 'effort') throw new Error(`config.overpass.roles.${role} has the unknown field ${JSON.stringify(key)} — only "tier" and "effort" are allowed`);
    }
    const tier = fields.tier === undefined ? DEFAULT_OVERPASS_ROLE_TIERS[role] : fields.tier;
    if (typeof tier !== 'string' || !OVERPASS_TIER_RE.test(tier)) {
      throw new Error(`config.overpass.roles.${role}.tier is ${JSON.stringify(fields.tier)} — it must be an Overpass tier name like "agentic-high" (agentic- then lowercase letters, digits and '-')`);
    }
    const effort = fields.effort;
    if (effort !== undefined && (typeof effort !== 'string' || !(OVERPASS_EFFORTS as readonly string[]).includes(effort))) {
      throw new Error(`config.overpass.roles.${role}.effort is ${JSON.stringify(effort)} — it must be one of ${OVERPASS_EFFORTS.join(', ')}`);
    }
    const chosen = (effort as OverpassEffort | undefined) ?? DEFAULT_OVERPASS_ROLE_EFFORTS[role];
    out[role] = chosen === undefined ? { model: `${provider}/${tier}` } : { model: `${provider}/${tier}`, effort: chosen };
  }
  return out;
}

export function resolveOverpass(config: unknown, opts: { host: string }): OverpassResolution {
  const cfg = isPlainObject(config) ? config : {};
  const raw = cfg.overpass;
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new Error(`config.overpass is ${JSON.stringify(raw)} — it must be an object like {"enabled": false, "provider": "overpass"}`);
  }
  const block = raw ?? {};
  const enabled = block.enabled === undefined ? false : block.enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error(`config.overpass.enabled is ${JSON.stringify(enabled)} — it must be true or false`);
  }
  const bypass = block.conductor_bypass === undefined ? true : block.conductor_bypass;
  if (typeof bypass !== 'boolean') {
    throw new Error(`config.overpass.conductor_bypass is ${JSON.stringify(bypass)} — it must be true or false`);
  }
  const provider = block.provider === undefined ? DEFAULT_OVERPASS_PROVIDER : block.provider;
  if (typeof provider !== 'string' || !OVERPASS_PROVIDER_RE.test(provider)) {
    throw new Error(`config.overpass.provider is ${JSON.stringify(provider)} — it must be a provider id of letters, digits, '-', '_' and '.', with no '/' or '#'`);
  }
  const roles = resolveOverpassRoles(block.roles, provider);
  const base = { configured: enabled, provider, conductorModel: `${provider}/agentic-conductor`, laneModel: `${provider}/${DEFAULT_OVERPASS_TIER}`, roles };
  if (!enabled) return { ...base, effective: false, conductorRouted: false };
  const mode = judgeProjectMode(cfg.mode, 'the config');
  if (mode !== 'work') return { ...base, effective: false, conductorRouted: false, reason: `overpass applies in work mode only; the project mode is '${mode}'` };
  if (opts.host !== 'opencode') return { ...base, effective: false, conductorRouted: false, reason: `overpass applies on OpenCode only; the host is '${opts.host}'` };
  return { ...base, effective: true, conductorRouted: !bypass };
}

// Pre-rename models keys: never read, so dropped before the parse and named by
// unreadConfigKeys. They must stay out of `models`, which now accepts any agent
// name as a key. 'classifiers' belonged to the retired Haiku noise-gate and was read by
// nothing (user-ruled 2026-10-23, "Remove it").
const RETIRED_MODEL_KEYS: readonly string[] = [
  'coder',
  'coder_hard',
  'explorer',
  'test_writer',
  'reviewers',
  'implementation_architect',
  'debugger',
  'classifiers',
];

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The raw-config rewrites that must happen before configSchema strips unknown
 *  keys. Returns a copy; the caller's object is never mutated (config_set
 *  round-trips the raw document). Anything that is not a plain object passes
 *  through for the schema to refuse.
 *   - sparring_partner.model (the old single pin) becomes
 *     sparring_partner.models.openai; when models.openai already exists the new
 *     key wins and an old STRING value is dropped. '' is the TUI's clear-to-unset
 *     signal, not a model id, so it creates no pin. A non-string value is moved
 *     as is so the pin schema refuses it loud, over an existing models.openai
 *     too: an invalid value is never dropped unrefused.
 *   - models keys in RETIRED_MODEL_KEYS are dropped. */
export function normalizeRawConfig(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  let out: Record<string, unknown> = raw;
  const sp = raw.sparring_partner;
  if (isPlainObject(sp) && Object.prototype.hasOwnProperty.call(sp, 'model')) {
    const { model, ...rest } = sp;
    if (model !== undefined && model !== '') {
      const existing = rest.models;
      if (existing === undefined || isPlainObject(existing)) {
        const models = { ...(existing ?? {}) };
        if (models.openai === undefined || typeof model !== 'string') models.openai = { model };
        rest.models = models;
      }
    }
    out = { ...out, sparring_partner: rest };
  }
  const models = raw.models;
  if (isPlainObject(models) && RETIRED_MODEL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(models, k))) {
    out = { ...out, models: Object.fromEntries(Object.entries(models).filter(([k]) => !RETIRED_MODEL_KEYS.includes(k))) };
  }
  return out;
}

export function parseConfig(raw: unknown): SterlingConfig {
  return configSchema.parse(normalizeRawConfig(raw));
}

// ── Model defaults: the one-time on-disk add ─────────────────────────────────
// The OpenCode dispatch model resolver (decision
// subagent-model-choice-on-opencode-conductor-states-dispatch) reads
// models.<role>.opencode_model and hard_task, whose shipped defaults reproduce the
// models the conductor named before. A live entry written before those defaults
// lacks them and would silently move (Sol reviews to Opus): anti_pattern
// wiring-a-formerly-inert-config-field-to-authoritative-without-migrating-the-live-config-values.
// User-ruled 2026-10-23 through the question form, "Write it into each config
// (Recommended)": the value is written into the file, visibly and reported, never
// held as a hidden schema default. ADD ONLY: a field already present is never
// overwritten, and a role with no entry gets the schema's whole default entry. It
// runs once per file: its id goes into applied_config_migrations, so a value the
// user clears afterwards (meaning "use the Claude model", or "no hard lane") stays cleared.
export const MODEL_DEFAULTS_MIGRATION_ID = 'model-defaults-2026-10-23';
const MODEL_DEFAULT_FIELDS: ReadonlyArray<readonly [string, 'opencode_model' | 'hard_task']> = [
  ['implementor', 'hard_task'],
  ['reviewer', 'opencode_model'],
  ['sparring', 'opencode_model'],
];
// The implementor's hard_task this migration adds, frozen as it shipped: the schema
// default no longer carries it (models.implementor-hard replaced it), and
// moveImplementorHardTask, which runs after this one, moves it into that key.
const ADDED_IMPLEMENTOR_HARD_TASK = { model: 'claude-opus-5-5' };

export interface ModelDefaultAdd {
  role: string;
  /** The field added, or 'entry' when the role had no entry and got the schema's whole default. */
  field: 'opencode_model' | 'hard_task' | 'entry';
  value: unknown;
}

export interface ModelDefaultsMigration {
  config: unknown;
  /** True when the file must be rewritten: something was added, or the migration id was recorded. */
  changed: boolean;
  added: ModelDefaultAdd[];
}

/** Add the model defaults a live config lacks (see above). Pure; anything that is not a
 *  plain object with an absent-or-object `models`, or a file that already records the
 *  migration, comes back unchanged. */
export function addModelDefaults(raw: unknown): ModelDefaultsMigration {
  const none = { config: raw, changed: false, added: [] };
  if (!isPlainObject(raw)) return none;
  const applied = raw.applied_config_migrations;
  if (applied !== undefined && !(Array.isArray(applied) && applied.every((x) => typeof x === 'string'))) return none;
  if ((applied ?? []).includes(MODEL_DEFAULTS_MIGRATION_ID)) return none;
  if (raw.models !== undefined && !isPlainObject(raw.models)) return none;
  const schemaDefaults = configSchema.shape.models.parse({}) as Record<string, Record<string, unknown>>;
  const defaults: Record<string, Record<string, unknown>> = { ...schemaDefaults, implementor: { ...schemaDefaults.implementor, hard_task: ADDED_IMPLEMENTOR_HARD_TASK } };
  const models: Record<string, unknown> = { ...(raw.models ?? {}) };
  const added: ModelDefaultAdd[] = [];
  for (const [role, field] of MODEL_DEFAULT_FIELDS) {
    const entry = models[role];
    if (entry === undefined) {
      models[role] = defaults[role];
      added.push({ role, field: 'entry', value: defaults[role] });
    } else if (isPlainObject(entry) && !Object.prototype.hasOwnProperty.call(entry, field)) {
      models[role] = { ...entry, [field]: defaults[role][field] };
      added.push({ role, field, value: defaults[role][field] });
    }
  }
  const config = { ...raw, ...(added.length ? { models } : {}), applied_config_migrations: [...(applied ?? []), MODEL_DEFAULTS_MIGRATION_ID] };
  return { config, changed: true, added };
}

// ── models.implementor.hard_task → models.implementor-hard: the one-time move ──
// Decision hard-implementor-is-its-own-agent-sterling-implementor-hard: the hard
// implementor lane is its own agent, so its pin moves out of the implementor entry
// into the new key (anti_pattern wiring-a-formerly-inert-config-field-to-authoritative-
// without-migrating-the-live-config-values: the live value moves, it is never left
// behind to be ignored). It runs after addModelDefaults, once per file (its id goes into
// applied_config_migrations), and each change is reported:
//   - hard_task set, no implementor-hard entry: the entry is built from it. Its effort is
//     hard_task.effort, else the implementor's effort (what a hard dispatch was sent
//     with). A <provider>/<model> hard_task becomes the entry's opencode_model, with the
//     schema default's Claude model; any other value lands in `model`, where the
//     schema refuses it loud and the caller leaves the file untouched.
//   - hard_task set and an implementor-hard entry already there: the entry wins and
//     the hard_task is dropped, its value reported.
//   - no hard_task on an existing implementor entry (the user cleared it, meaning "no
//     separate hard lane"; addModelDefaults has already added it otherwise): the
//     implementor's own model, effort and opencode_model are copied, so a hard lane
//     keeps running where it ran.
// Other roles keep their hard_task.
export const IMPLEMENTOR_HARD_MIGRATION_ID = 'implementor-hard-2026-10-23';

export interface ImplementorHardMove {
  /** moved: hard_task became the entry; dropped: an entry existed, hard_task was removed; copied: no hard_task, the implementor's pin was copied. */
  kind: 'moved' | 'dropped' | 'copied';
  /** The implementor's hard_task that was removed (absent for 'copied'). */
  hard_task?: unknown;
  /** The models.implementor-hard entry the file now holds. */
  entry: unknown;
}

export interface ImplementorHardMigration {
  config: unknown;
  /** True when the file must be rewritten: something moved, or the migration id was recorded. */
  changed: boolean;
  move: ImplementorHardMove | null;
}

/** Move models.implementor.hard_task into models.implementor-hard (see above). Pure;
 *  anything that is not a plain object with an absent-or-object `models`, or a file that
 *  already records the migration, comes back unchanged. */
export function moveImplementorHardTask(raw: unknown): ImplementorHardMigration {
  const none = { config: raw, changed: false, move: null };
  if (!isPlainObject(raw)) return none;
  const applied = raw.applied_config_migrations;
  if (applied !== undefined && !(Array.isArray(applied) && applied.every((x) => typeof x === 'string'))) return none;
  if ((applied ?? []).includes(IMPLEMENTOR_HARD_MIGRATION_ID)) return none;
  if (raw.models !== undefined && !isPlainObject(raw.models)) return none;
  const record = (models: Record<string, unknown> | null, move: ImplementorHardMove | null): ImplementorHardMigration => ({
    config: { ...raw, ...(models ? { models } : {}), applied_config_migrations: [...(applied ?? []), IMPLEMENTOR_HARD_MIGRATION_ID] },
    changed: true,
    move,
  });
  const models: Record<string, unknown> = { ...(raw.models ?? {}) };
  const implementor = models.implementor;
  if (!isPlainObject(implementor)) return record(null, null);
  const hasHard = Object.prototype.hasOwnProperty.call(implementor, 'hard_task');
  const existing = models['implementor-hard'];
  if (!hasHard) {
    if (existing !== undefined) return record(null, null);
    const entry: Record<string, unknown> = { model: implementor.model, effort: implementor.effort };
    if (implementor.opencode_model !== undefined) entry.opencode_model = implementor.opencode_model;
    models['implementor-hard'] = entry;
    return record(models, { kind: 'copied', entry });
  }
  const { hard_task, ...rest } = implementor;
  models.implementor = rest;
  if (existing !== undefined) return record(models, { kind: 'dropped', hard_task, entry: existing });
  const pin = isPlainObject(hard_task) ? hard_task : {};
  const effort = pin.effort ?? implementor.effort;
  const fallbackModel = (configSchema.shape.models.parse({}) as Record<string, Record<string, unknown>>)['implementor-hard'].model;
  const entry: Record<string, unknown> =
    typeof pin.model === 'string' && OPENCODE_MODEL_REF_RE.test(pin.model)
      ? { model: fallbackModel, effort, opencode_model: pin.model }
      : { model: pin.model, effort };
  models['implementor-hard'] = entry;
  return record(models, { kind: 'moved', hard_task, entry });
}

// ── Overpass defaults: the one-time reset ───────────────────────────────────
// Decision overpass-per-role-default-tiers-implementor-premium-sparring-premium-max (user-
// ruled 2026-10-23, 'Defaults + reset + bypass ON'; verbatim: "The ch.core tui shows the
// models/effect that I want overpass to use on all projects, both current but also new
// init'ed"): every existing project drops its config.overpass.roles overrides, so the
// shipped DEFAULT_OVERPASS_ROLE_TIERS apply, and gets overpass.conductor_bypass true.
// It touches those two keys only, runs once per file (its id goes into
// applied_config_migrations, so a roles override or a bypass switched off afterwards stays),
// and reports each change. A config whose `overpass` is present but not an object is
// refused whole, never half-written.
export const OVERPASS_DEFAULTS_MIGRATION_ID = 'overpass-defaults-2026-10-23';

export interface OverpassDefaultsMigration {
  config: unknown;
  /** True when the file must be rewritten: something changed, or the migration id was recorded. */
  changed: boolean;
  /** The config.overpass.roles value that was removed; absent when there was none. */
  rolesRemoved?: { value: unknown };
  /** The conductor_bypass value that was replaced by true; absent when it was already true. */
  bypassSet?: { was: unknown };
  /** Set when the file cannot be migrated and must stay as it is. */
  refusal?: string;
}

/** Reset the Overpass overrides to the shipped defaults (see above). Pure; anything that
 *  is not a plain object, or a file that already records the migration, comes back unchanged. */
export function resetOverpassDefaults(raw: unknown): OverpassDefaultsMigration {
  const none = { config: raw, changed: false };
  if (!isPlainObject(raw)) return none;
  const applied = raw.applied_config_migrations;
  if (applied !== undefined && !(Array.isArray(applied) && applied.every((x) => typeof x === 'string'))) return none;
  if ((applied ?? []).includes(OVERPASS_DEFAULTS_MIGRATION_ID)) return none;
  if (raw.overpass !== undefined && !isPlainObject(raw.overpass)) {
    return { ...none, refusal: `config.overpass is ${JSON.stringify(raw.overpass)}, not an object, so the Overpass defaults reset cannot be applied` };
  }
  const { roles, ...block } = raw.overpass ?? {};
  const result: OverpassDefaultsMigration = { config: raw, changed: true };
  if (Object.prototype.hasOwnProperty.call(raw.overpass ?? {}, 'roles')) result.rolesRemoved = { value: roles };
  if (block.conductor_bypass !== true) result.bypassSet = { was: block.conductor_bypass };
  result.config = { ...raw, overpass: { ...block, conductor_bypass: true }, applied_config_migrations: [...(applied ?? []), OVERPASS_DEFAULTS_MIGRATION_ID] };
  return result;
}

// ── Retired models keys: the on-disk migration ──────────────────────────────
// normalizeRawConfig drops a retired key in memory on every parse, so the key
// stays in the file forever and its value is lost without a word. This is the
// one rewrite that removes them from the document and names each value it
// removed (anti_pattern wiring-a-formerly-inert-config-field-to-authoritative-
// without-migrating-the-live-config-values). DROP ONLY, never a carry (user-
// ruled 2026-10-23): these keys have been ignored since the rename, so removing
// one changes no rendered model, while carrying a stale pin to its successor
// would make it authoritative (decisions pin exact model ids and keep scout on
// Sonnet). A renamed key's report names its successor so the user can set it by hand.

export interface RetiredModelKeyDrop {
  key: string;
  value: unknown;
  /** The models key that replaced this one in the roster rename, when it has one (CONFIG_KEY_RENAMES). */
  renamed_to?: string;
}

export interface RetiredModelKeysMigration {
  /** A copy with the retired keys gone; the input itself when nothing changed. */
  config: unknown;
  changed: boolean;
  dropped: RetiredModelKeyDrop[];
  /** The models keys that were not retired and so were left exactly as written. */
  untouched: string[];
}

/** Drop every retired models key and report each with its value. Pure and
 *  idempotent: a config with no retired key comes back as the same object,
 *  unreported. Anything that is not a plain object with a plain-object `models`
 *  passes through. */
export function migrateRetiredModelKeys(raw: unknown): RetiredModelKeysMigration {
  const none = (untouched: string[]): RetiredModelKeysMigration => ({ config: raw, changed: false, dropped: [], untouched });
  if (!isPlainObject(raw) || !isPlainObject(raw.models)) return none([]);
  const models = raw.models;
  const retired = RETIRED_MODEL_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(models, k));
  const untouched = Object.keys(models).filter((k) => !RETIRED_MODEL_KEYS.includes(k));
  if (retired.length === 0) return none(untouched);
  const dropped = retired.map((key): RetiredModelKeyDrop => {
    const renamed = CONFIG_KEY_RENAMES[`models.${key}`]?.replace(/^models\./, '');
    return renamed === undefined ? { key, value: models[key] } : { key, value: models[key], renamed_to: renamed };
  });
  const next = Object.fromEntries(Object.entries(models).filter(([k]) => !RETIRED_MODEL_KEYS.includes(k)));
  return { config: { ...raw, models: next }, changed: true, dropped, untouched };
}

// ── Config keys Sterling no longer reads (decision gap-hunt-2026-09-28-rulings
//    item 12) ────────────────────────────────────────────────────────────────
// Every non-strict z.object above STRIPS a key it does not define, silently, so
// a key left behind by a rename or a deleted mechanism is never read — and a
// write to it (config_set has no key allowlist) is lost without a word
// (measured: Dome Farmer's models.coder, 2026-09-28). This walks a RAW config
// against the schema and names each such key by dotted path. DISCLOSURE ONLY:
// callers (/sterling:update, /sterling:init) print it and never delete a key.
// Descends only into schema objects in 'strip' mode: records, arrays,
// passthrough objects and z.unknown() fields hold data, not schema keys, and a
// 'strict' object refuses an unknown key at parse time, which is a louder
// failure than this one.

export interface UnreadConfigKey {
  path: string;
  renamed_to?: string;
}

// Known renames, so the line says where the value now lives. Source: the
// Slice 5/8 roster rename recorded on `models` above ('coder' -> 'implementor',
// 'explorer' -> 'scout'; decision sterling-claude-code-scale-down-boundary).
const CONFIG_KEY_RENAMES: Readonly<Record<string, string>> = {
  'models.coder': 'models.implementor',
  'models.explorer': 'models.scout',
};

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodDefault) s = s._def.innerType;
    else if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap();
    else if (s instanceof z.ZodEffects) s = s.innerType();
    else return s;
  }
}

export function unreadConfigKeys(raw: unknown): UnreadConfigKey[] {
  const out: UnreadConfigKey[] = [];
  const walk = (value: unknown, schema: z.ZodTypeAny, prefix: string): void => {
    const s = unwrapSchema(schema);
    if (!(s instanceof z.ZodObject) || s._def.unknownKeys !== 'strip' || !isPlainObject(value)) return;
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(shape, key)) {
        // sparring_partner.model is converted by normalizeRawConfig, so it is read.
        if (path === 'sparring_partner.model') continue;
        // A catchall object (models) reads every key, so only the retired ones are unread.
        if (!(s._def.catchall instanceof z.ZodNever) && !(prefix === 'models' && RETIRED_MODEL_KEYS.includes(key))) continue;
        const renamed = CONFIG_KEY_RENAMES[path];
        out.push(renamed ? { path, renamed_to: renamed } : { path });
      } else {
        walk(child, shape[key], path);
      }
    }
  };
  walk(raw, configSchema, '');
  return out;
}

/** The one rendering both /sterling:update and /sterling:init print after
 *  "…/.sterling/config.json carries ". */
export function describeUnreadConfigKeys(keys: readonly UnreadConfigKey[]): string {
  const names = keys.map((k) => (k.renamed_to ? `${k.path} (renamed to ${k.renamed_to})` : k.path));
  return `${keys.length} key(s) Sterling no longer reads: ${names.join(', ')} — ignored; sync and init drop the retired models keys and report their values, any other key stays in the file; move a renamed value to its new key, and delete the rest by hand when convenient`;
}
