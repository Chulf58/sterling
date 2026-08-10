import { z } from 'zod';

// Project config (§12: default config — caps, watcher, model+effort table,
// reviewer-selection rules, difficulty rubric thresholds — ALL TUNABLE).
// templates/default-config.json is the shipped source; init copies it into
// <project>/.sterling/config.json and bakes toolchain declarations (§9.1).
// One schema, every reader: a malformed config fails loud, never half-applies.

const modelEffort = z.object({
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']),
});

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
  // §12 ensure-manifest: declarations are read back from the recorded config on
  // re-runs (no flags required), so the project name is recorded alongside them.
  project_name: z.string().optional(),
  // §11 launcher split ratio
  tui_split_ratio: z.number().positive().max(1).default(0.35),
  prep_cap: z.number().int().positive().default(20),
  // Concept-article slice (decision 7208729b, brief concept-article-layer-wiring):
  // prep reserves up to this many of prep_cap's slots for concept articles
  // (feature_article with concept_family) so the two classes never silently
  // displace each other under the shared cap. A sub-cap, never additive.
  prep_concept_cap: z.number().int().positive().default(5),
  // §5.1: caps that convert loops into signals
  caps: z
    .object({
      inner_loop_n: z.number().int().positive().default(3),
      outer_loop_m: z.number().int().positive().default(2),
      research_resume_per_phase: z.number().int().positive().default(2),
      dispatch_per_agent_type: z.number().int().positive().default(25),
      phase_death_cap: z.number().int().positive().default(1),
    })
    .default({}),
  // §6 H6 / §14
  context_watch: z
    .object({
      warn_pct: z.number().positive().default(60),
      block_pct: z.number().positive().default(95),
      mode: z.enum(['observe', 'enforce']).default('observe'),
      windows: z.record(z.string(), z.number().int().positive()).default({ default: 200_000 }),
      // Conductor-session pressure thresholds (direct mode, H10 Stop seam): soft = advisory
      // "finish before opening new areas"; hard = once-per-session soft-block naming the
      // delegation remedy. Deliberately NOT warn_pct/block_pct — those are agent-scoped with
      // different consequences (run escalation / dispatch deny in enforce mode).
      conductor: z
        .object({
          soft_pct: z.number().positive().default(65),
          hard_pct: z.number().positive().default(80),
        })
        .default({}),
    })
    .default({}),
  // Delegation watch (H10 Stop seam, decision 8b00e77a — mechanical half of 677f1639):
  // fire the once-per-session advisory when (distinct Read files + Grep/Glob calls)
  // >= min_hand_work AND (Task/Agent dispatches) <= max_dispatches. Defaults
  // calibrated on the measured 2026-08-10 incident (~23 hand-reads, 0 dispatches).
  delegation_watch: z
    .object({
      min_hand_work: z.number().int().positive().default(15),
      max_dispatches: z.number().int().nonnegative().default(0),
      // H21 hand-work-streak advisory (decision 9042abeb): distinct read
      // paths + searches since the last Task/Agent dispatch crossing this
      // threshold injects ONE moment-3 advisory per streak episode.
      streak_threshold: z.number().int().positive().default(10),
    })
    .default({}),
  // §7.2 model + effort defaults (tunable config, not architecture).
  // Hard rule encoded here as data: no xhigh/max for subagents except
  // small-scoped hard phases (coder hard override); max never appears.
  models: z
    .object({
      test_writer: modelEffort.default({ model: 'claude-opus-5', effort: 'high' }),
      reviewers: modelEffort.default({ model: 'claude-opus-5', effort: 'low' }),
      implementation_architect: modelEffort.default({ model: 'claude-opus-5', effort: 'high' }),
      coder: modelEffort.default({ model: 'claude-sonnet-5', effort: 'high' }),
      coder_hard: modelEffort.default({ model: 'claude-opus-5', effort: 'xhigh' }),
      researcher: modelEffort.default({ model: 'claude-sonnet-5', effort: 'medium' }),
      explorer: modelEffort.default({ model: 'claude-sonnet-5', effort: 'low' }),
      classifiers: modelEffort.default({ model: 'claude-haiku-4-5', effort: 'low' }),
      // Conductor-direct agents (no agent_exit/handoff_write; final text is the
      // deliverable). librarian is mechanical clerking — cheap model, low effort
      // (P8); debugger is root-cause judgment — high effort.
      librarian: modelEffort.default({ model: 'claude-sonnet-5', effort: 'low' }),
      debugger: modelEffort.default({ model: 'claude-sonnet-5', effort: 'high' }),
    })
    .default({}),
  // §7.1 reviewer dispatch signal sets — start over-inclusive, tune down on
  // run data, never the reverse. Patterns are JS regex source strings.
  reviewer_selection: z
    .object({
      security_path_patterns: z.array(z.string()).default(['(^|/)auth/', 'token', 'secret', 'credential']),
      security_content_patterns: z
        .array(z.string())
        .default(["SELECT .*\\+", 'exec\\(', 'spawn\\(', 'process\\.env', '(^|\\W)eval\\(', 'router\\.(get|post|put|delete)']),
      perf_path_patterns: z.array(z.string()).default([]),
      perf_content_patterns: z.array(z.string()).default(['for\\s*\\(.*\\bawait\\b', '\\.map\\(.*await', 'SELECT \\*']),
      dependency_manifests: z.array(z.string()).default(['package.json', 'requirements.txt', 'pom.xml', '*.csproj']),
      skeptic_diff_size_threshold: z.number().int().positive().default(400),
      skeptic_new_export_threshold: z.number().int().positive().default(5),
    })
    .default({}),
  // §4 difficulty rubric — mechanical inputs. split_interface_threshold is the
  // SPLIT (bigness) threshold: a phase whose interface count strictly exceeds
  // it is over-wide and gets flagged for decomposition (P7) — it is NOT a
  // hardness input (hardness ownership is the planner's, per decision a48c74cf).
  difficulty: z
    .object({
      split_interface_threshold: z.number().int().positive().default(3),
      thin_knowledge_retrieval_threshold: z.number().int().nonnegative().default(2),
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
  // Board 0697c6bd: history is bounded AT THE WRITE — a feature_article landing
  // with more entries than this keeps only the newest N (rotation disclosed on
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
  // Machine-local role marker (todo cabbc10f, decision a9b98b7d) — DELIBERATELY
  // OPTIONAL with NO DEFAULT: absence is a meaningful state ('undeclared'), not
  // a value to infer. 'authoring' is declared once, by hand, on the machine
  // where Sterling work lands and merges; a successful /sterling:update stamps
  // 'consumer' into a clone that has it absent, and never overwrites an
  // existing value (so an authoring machine that occasionally pulls stays
  // 'authoring'). H1 reads this — never store_authority, whose 'primary'
  // default would mislabel every consumer that never opted in (the rejected
  // alternative in a9b98b7d) — and reports it only on a Sterling clone itself.
  machine_role: z.enum(['authoring', 'consumer']).optional(),
  // §6 H15 store write-path guard: shell commands referencing the store are
  // denied unless they invoke one of these sanctioned scripts/launchers —
  // tunable, grows incident-by-incident (the reviewer-selection precedent)
  store_guard: z
    .object({
      allow_scripts: z
        .array(z.string())
        .default(['scripts/dispose-run.mjs', 'scripts/init.mjs', 'scripts/consume-exit.mjs', 'scripts/architecture-projection.mjs', 'scripts/domain-doctor.mjs', 'sterling-tui.mjs']),
    })
    .default({}),
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
  // H19 knowledge delivery (decision 6dfbe675). injection_rung is PROBE-SET
  // per machine/CC version (verify-at-build 0956a464): 'prompt' (default,
  // platform-proven — enqueue at file-touch, inject at next UserPromptSubmit),
  // 'read' (PostToolUse injects directly at the touch), 'edit' (only
  // PreToolUse injection works; Read touches fall back to the queue).
  delivery: z
    .object({
      injection_rung: z.enum(['prompt', 'read', 'edit']).default('prompt'),
      payload_char_cap: z.number().int().positive().default(2400),
    })
    .default({}),
});

export type SterlingConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): SterlingConfig {
  return configSchema.parse(raw);
}
