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
  // §12 ensure-manifest: declarations are read back from the recorded config on
  // re-runs (no flags required), so the project name is recorded alongside them.
  project_name: z.string().optional(),
  // §11 launcher split ratio
  tui_split_ratio: z.number().positive().max(1).default(0.35),
  prep_cap: z.number().int().positive().default(20),
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
    })
    .default({}),
  // §7.2 model + effort defaults (tunable config, not architecture).
  // Hard rule encoded here as data: no xhigh/max for subagents except
  // small-scoped hard phases (coder hard override); max never appears.
  models: z
    .object({
      test_writer: modelEffort.default({ model: 'claude-opus-4-8', effort: 'high' }),
      reviewers: modelEffort.default({ model: 'claude-opus-4-8', effort: 'low' }),
      implementation_architect: modelEffort.default({ model: 'claude-opus-4-8', effort: 'high' }),
      coder: modelEffort.default({ model: 'claude-sonnet-4-6', effort: 'high' }),
      coder_hard: modelEffort.default({ model: 'claude-opus-4-8', effort: 'xhigh' }),
      researcher: modelEffort.default({ model: 'claude-sonnet-4-6', effort: 'medium' }),
      explorer: modelEffort.default({ model: 'claude-haiku-4-5', effort: 'low' }),
      classifiers: modelEffort.default({ model: 'claude-haiku-4-5', effort: 'low' }),
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
  // §4 difficulty rubric — mechanical inputs
  difficulty: z
    .object({
      blast_radius_hard_threshold: z.number().int().positive().default(8),
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
  // §6 H15 store write-path guard: shell commands referencing the store are
  // denied unless they invoke one of these sanctioned scripts/launchers —
  // tunable, grows incident-by-incident (the reviewer-selection precedent)
  store_guard: z
    .object({
      allow_scripts: z
        .array(z.string())
        .default(['scripts/dispose-run.mjs', 'scripts/init.mjs', 'scripts/consume-exit.mjs', 'scripts/architecture-projection.mjs', 'sterling-tui.mjs']),
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
});

export type SterlingConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): SterlingConfig {
  return configSchema.parse(raw);
}
