import { z } from 'zod';

// Project config (§12: default config — caps, watcher, model+effort table,
// reviewer-selection rules, difficulty rubric thresholds — ALL TUNABLE).
// templates/default-config.json is the shipped source; init copies it into
// <project>/.sterling/config.json and bakes toolchain declarations (§9.1).
// One schema, every reader: a malformed config fails loud, never half-applies.

// .strict() (review fix, config_set decision config-writes-get-a-config-set-
// mcp-tool-with-positive-key-allowlist-raw-edit-denial-stays item 5): this
// shape has been fixed since inception, no downgrade risk — so an unknown
// sibling key (`models.coder {"model":..,"junk":..}`) is refused by schema
// validation rather than silently persisted (config_set writes its caller's
// raw merged object, so a non-strict shape here would let a typo'd field
// land on disk unrefused, same rationale as the delivery leaf check below).
const modelEffort = z.object({
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']),
}).strict();

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
  // §3.3: the project's stack_tags, declared at init, ARE the domain mount
  // manifest — the SAME list that filters retrieval (§3.4) mounts the shared
  // domain stores, so the mounted set and the filter align by construction. Each
  // tag mounts a store at ~/.sterling/domains/<tag>/sterling.db (lazily created).
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
  undeclared_source_exclude_globs: z.array(z.string()).default([]),
  // Attestation disclosure (decision attestation-staleness-disclosure-only-
  // never-a-refusing-gate, 1f069af4; board attestation-gate 9868a0dd): the
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
  // decision `sterling-claude-code-scale-down-boundary` (2ad87dd1); windows
  // and conductor.{soft_pct,hard_pct} survive — H10 reads both (the gauge
  // denominator and the direct-mode pressure thresholds).
  context_watch: z
    .object({
      windows: z.record(z.string(), z.number().int().positive()).default({ default: 200_000 }),
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
  // §7.2 model + effort defaults (tunable config, not architecture).
  // Hard rule encoded here as data: no xhigh/max for subagents; max never
  // appears. Slice 5/8 (decision sterling-claude-code-scale-down-boundary,
  // 2ad87dd1, change 3) renamed these keys to match the roster directly —
  // 'coder' -> 'implementor', 'explorer' -> 'scout' — so AGENT_MODEL_KEY no
  // longer needs an indirection layer between an agent's name and its config
  // key.
  models: z
    .object({
      implementor: modelEffort.default({ model: 'claude-sonnet-5', effort: 'high' }),
      researcher: modelEffort.default({ model: 'claude-sonnet-5', effort: 'medium' }),
      scout: modelEffort.default({ model: 'claude-sonnet-5', effort: 'low' }),
      classifiers: modelEffort.default({ model: 'claude-haiku-4-5', effort: 'low' }),
      // Conductor-direct agents (no agent_exit/handoff_write; final text is the
      // deliverable). librarian is mechanical clerking — cheap model, low effort
      // (P8); debugger is root-cause judgment — high effort. No debugger.md
      // template is registered yet (agent-templates/registry.json) — this key
      // stays config-only until one is.
      librarian: modelEffort.default({ model: 'claude-sonnet-5', effort: 'low' }),
      debugger: modelEffort.default({ model: 'claude-sonnet-5', effort: 'high' }),
    })
    .default({}),
  // §6 H10 article demand: direct-mode touches in unowned territory at this
  // threshold (or any new unowned file vs git HEAD) demand the owning article
  article_demand: z
    .object({
      min_unowned_files: z.number().int().positive().default(3),
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
  // NOT .strict() (review-reverted, config_set decision config-writes-get-a-
  // config-set-mcp-tool-with-positive-key-allowlist-raw-edit-denial-stays
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
      // TUI System-tab model selector (article sparring-partner interaction i,
      // board a0714d0b): the model argument sent on every consult. Absent/empty
      // = the Codex CLI's own default. Deliberately a FREE string, no enum —
      // codex validates model names server-side with a loud 400, so a client-
      // side allowlist would only drift from what the CLI actually accepts.
      model: z.string().optional(),
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
  // Mutation-verification posture toggle (decision foreign_752caf98), independent of
  // tdd above: whether "verify a ruling change by mutation, not by a green
  // suite alone" (measured 2026-08-22) fires automatically. Same additive-
  // optional, default-true shape as tdd — the two toggles are deliberately
  // separate fields, not one combined toggle (rejected in 752caf98).
  mutation_verification: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
});

export type SterlingConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): SterlingConfig {
  return configSchema.parse(raw);
}
