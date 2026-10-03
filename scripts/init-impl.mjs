// /sterling:init [S] (spec §12, FULL PRECISION except store internals).
// The conductor runs the mini-grill (stack tags, toolchains, backup path —
// ask, don't guess); this script is the deterministic manifest executor.
//
// ENSURE-MANIFEST SEMANTICS (§12, adjudicated): init is an ensure operation,
// not a one-shot. Every manifest item is verified individually:
//   absent            → created
//   matches expected  → skipped, reported as `matches`
//   differs           → left untouched, reported (`differs`) — init never
//                       overwrites content it cannot prove it generated
// Refusal is reserved for destructive actions only (a file occupying a path
// the manifest requires as a directory; an unparseable config it would have
// to clobber). "Already initialized" is NOT a refusal. Every artifact is
// individually regenerable: delete it and re-run — declarations are read
// back from the recorded config, so re-runs need no flags.
//
//   node scripts/init.mjs --target <dir> [--project-name <name>]
//     [--stack-tags a,b] [--toolchain <adapter>:<glob>[,<glob>...]]
//     [--backup-path <p> | --backup-opt-out] [--mode hobby|work]
//     [--domain-description <domain>=<text>]...   (repeatable; one per NEW domain store)
//     [--update-ensure]   (set only by /sterling:update's re-bake step)
//   (stack tags ARE the domain mount manifest — §3.3; no separate domains flag)
//   (init creates each declared domain's store that does not exist yet, with a
//   description: --domain-description <domain>=<text>, split at the first '='. The
//   forced 'sterling' domain ships a default. A domain with no description refuses
//   before any write. An existing store is never touched. On the update ensure
//   pass (--update-ensure) a recorded domain with no store and no description is
//   skipped with a loud line instead, so it cannot fail the whole re-bake.)
//   (declaration flags are required only when no recorded config exists)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, unreadConfigKeys, describeUnreadConfigKeys } from '@sterling/schemas';
import { ProjectRegistry, registryPath, createDomain, resolveDomainMounts } from '@sterling/store';
import { arg, argAll, hasFlag, fail } from './lib/project.mjs';
import { backupPathForRuntime } from './lib/wsl-path.mjs';
import { DEFAULT_DOMAIN_DESCRIPTIONS } from './lib/domain-defaults.mjs';
import { resolveToolchains } from './adapters/resolve.mjs';
import { syncAgents, findDeadTerms, RESTART_INSTRUCTION, agentChangesRequireRestart, ensureConductorActivation, describeConfigDrift } from './lib/agent-distribution.mjs';
import { syncOpenCodeAgents, OPENCODE_AGENTS_DIR } from './lib/opencode-agents.mjs';
import { isSterlingClone, isOwnedExport, HANDOFF_DIRS, readHandoffEnabled, HandoffSettingError, HANDOFF_OFF_DETAIL, trackedHandoffFiles, PROJECT_MODES } from './lib/handoff-projection.mjs';
import { ContainmentError } from './lib/contained-fs.mjs';
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from './lib/update-launcher.mjs';
import { ensureConsumerCheckLauncher, CONSUMER_CHECK_LAUNCHER_NAME } from './lib/consumer-checks.mjs';
import { probeCodex, userScopeCodexServer, codexUserScopeLine } from './lib/codex-mcp.mjs';
import { renderTmuxLauncher } from './lib/launcher-tmux.mjs';
import { historicalLauncherTemplates, olderGeneratedLauncher, replayFailureLine } from './lib/launcher-history.mjs';
import { isInstalledCopy } from './lib/installed-copy.mjs';
import { cloneLauncherTarget, marketplaceAutoUpdate, autoUpdateWarning, cloneCleanupLines } from './lib/consumer-cutover.mjs';
import { renderUnavailable } from './hooks/lib/undeclared-source.mjs';
import { setupOpenCode } from './lib/opencode-install.mjs';
import { probeClaude } from './lib/claude-probe.mjs';
import { renderClaudeText } from './lib/agent-fences.mjs';
import { computeUndeclaredSourceDisclosure } from './hooks/lib/undeclared-source-scan.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test-isolation seam (mirrors STERLING_REGISTRY_DB): the
// plugin-repo branch below (the root .mcp.json cleanup, the plugin-repo-only
// .gitignore entries and the retired sterling-mcp-win.json report) only fires when
// target === pluginRoot. A test instead sets STERLING_PLUGIN_ROOT_MATCH to its own
// --target temp dir, so the branch's logic runs against a disposable directory while
// every OTHER pluginRoot-derived path (templates, hooks) still resolves to the REAL
// plugin root. Init writes nothing into the plugin directory (slice S2), so this
// seam is about branch selection, not containment. Unset in every real run.
// '' must behave as unset too (matches STERLING_CODEX_PROBE's falsy convention) —
// ?? alone would let '' survive and silently disable the plugin-repo branch.
const pluginRootMatch = process.env.STERLING_PLUGIN_ROOT_MATCH || pluginRoot;
const target = resolve(arg('--target') ?? process.cwd());
const projectNameFlag = arg('--project-name');
const stackTagsFlag = (arg('--stack-tags') ?? '').split(',').filter(Boolean);
const backupPathFlag = arg('--backup-path');
const backupOptOutFlag = process.argv.includes('--backup-opt-out');
// the project mode the /sterling:init SOP asked for on a NEW project (decision
// project-mode-hobby-work-toggle-decides-flow). It seeds a fresh config only; an
// existing config's mode is switched in the TUI System tab, never by this flag.
// A malformed --mode (given twice, or followed by another flag) makes the parser
// throw; it is a refusal like an invalid value (exit 2), never a stack trace.
let modeFlagGiven;
let modeFlag;
try {
  modeFlagGiven = hasFlag('--mode');
  modeFlag = arg('--mode');
} catch (e) {
  fail(`init REFUSED: ${e.message}`, 2);
}
const declaredToolchains = argAll('--toolchain').map((spec) => {
  const [adapter, globs] = spec.split(':');
  return { adapter, path_globs: (globs ?? '').split(',').filter(Boolean) };
});

// --domain-description <domain>=<text>, repeatable: the description a NEW domain store is
// created with (split at the first '='). A flag with no value, a malformed pair or a repeated
// domain refuses (exit 2) rather than being dropped or silently resolved.
const DOMAIN_DESCRIPTION_FLAG = '--domain-description';
const domainDescriptionFlags = argAll(DOMAIN_DESCRIPTION_FLAG);
if (process.argv.filter((a) => a === DOMAIN_DESCRIPTION_FLAG).length !== domainDescriptionFlags.length) {
  fail(`init REFUSED: ${DOMAIN_DESCRIPTION_FLAG} needs a value of the form <domain>=<description>`, 2);
}
const domainDescriptions = new Map();
for (const spec of domainDescriptionFlags) {
  const eq = spec.indexOf('=');
  const name = eq === -1 ? '' : spec.slice(0, eq).trim();
  const text = eq === -1 ? '' : spec.slice(eq + 1).trim();
  if (!name || !text) {
    fail(`init REFUSED: ${DOMAIN_DESCRIPTION_FLAG} ${JSON.stringify(spec)} must be <domain>=<description> with a non-blank description`, 2);
  }
  if (domainDescriptions.has(name)) fail(`init REFUSED: ${DOMAIN_DESCRIPTION_FLAG} was given twice for domain '${name}'`, 2);
  domainDescriptions.set(name, text);
}

const fwd = (p) => p.replace(/\\/g, '/');
const normalize = (s) => s.replace(/\r\n/g, '\n');
// canonical compare: key order must not decide "hand-edited"
// The handoff projection registers its own files in config.generated_projections
// (a managed write, like the universal-domain add below), so those entries never
// read as a hand edit when init compares the recorded config with the defaults.
const withoutHandoffEntries = (c) => ({ ...c, generated_projections: (c.generated_projections ?? []).filter((p) => !isOwnedExport(target, p)) });
const canonical = (v) =>
  JSON.stringify(v, (_, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val
  );

// ---- verify pass: every refusal happens BEFORE any write ----
if (!existsSync(target)) fail(`init REFUSED: target '${target}' does not exist`, 2);
if (modeFlagGiven && !PROJECT_MODES.includes(modeFlag)) {
  fail(`init REFUSED: --mode must be 'hobby' or 'work' — got ${JSON.stringify(modeFlag ?? '')}`, 2);
}
// The runtime server and the TUI are COMMITTED bundles (gated by check-bundles-fresh), so
// nothing is built on an installed copy; a missing one is a broken checkout and refuses
// here, before any write (the launchers point at the TUI bundle — board 16783088).
if (!existsSync(join(pluginRoot, 'mcp', 'sterling-mcp.mjs'))) fail('init REFUSED: MCP server bundle missing (mcp/sterling-mcp.mjs) — the plugin checkout is incomplete; on the authoring clone run `npm run build:bundles`', 2);
if (!existsSync(join(pluginRoot, 'tui', 'sterling-tui.mjs'))) fail('init REFUSED: TUI bundle missing (tui/sterling-tui.mjs) — the plugin checkout is incomplete; on the authoring clone run `npm run build:bundles`', 2);
// The LEGACY per-project server entry an earlier init wrote into a project's .mcp.json
// (command = this node, args[0] = the clone's built server). It is only a recognizer for
// the stale-entry cleanup below.
const mcpServerEntry = join(pluginRoot, 'packages', 'mcp-server', 'dist', 'main.js');
// .opencode, .opencode/agents and the handoff projection's directories joined the
// list with the OpenCode handoff (Sol review): a file sitting where one must be
// is refused here, before anything is written, not half-way through init.
for (const rel of ['.sterling', '.sterling/runs', 'docs', 'docs/briefs', '.claude', '.claude/agents', '.opencode', OPENCODE_AGENTS_DIR, ...HANDOFF_DIRS]) {
  const p = join(target, rel);
  if (existsSync(p) && !statSync(p).isDirectory()) {
    fail(`init REFUSED (destructive): '${rel}' exists as a file but the manifest requires a directory — refusing to replace it`, 2);
  }
}

// CLAUDE CODE PROBE (decision init-without-claude-code-probes-and-skips-claude-artifacts-
// loudly): the launchers, .claude/agents, the conductor activation and the ~/.claude.json
// Codex check are Claude-only, so on a machine without `claude` they are not written (one
// loud line, below, names them). STERLING_CLAUDE_PROBE is the test-isolation seam, honored
// at THIS call site: unset/'' -> the real probe; 'ok' -> force present; 'absent' -> force
// absent. Any other value fails loud (P5), validated before any write.
const claudeProbeOverride = process.env.STERLING_CLAUDE_PROBE;
const claudeProbe = !claudeProbeOverride
  ? probeClaude()
  : claudeProbeOverride === 'ok'
    ? { installed: true, version: 'forced' }
    : claudeProbeOverride === 'absent'
      ? { installed: false, reason: 'STERLING_CLAUDE_PROBE=absent' }
      : fail(`STERLING_CLAUDE_PROBE must be 'ok' or 'absent' (got '${claudeProbeOverride}')`, 2);
const claudeHost = claudeProbe.installed;

// recorded config = the declaration source on re-runs (§12 ensure-manifest)
const configPath = join(target, '.sterling', 'config.json');
let recorded;
// the RAW parsed JSON, pre-schema — kept alongside `recorded` (which is
// schema-EXPANDED, i.e. carries every default) so a managed mutation below
// can be applied to what the config actually says on disk, never to a
// defaults-materialized copy that would clobber an intentionally-absent field.
let rawRecorded;
if (existsSync(configPath)) {
  try {
    rawRecorded = JSON.parse(readFileSync(configPath, 'utf8'));
    recorded = parseConfig(rawRecorded);
  } catch (e) {
    fail(`init REFUSED (destructive to fix): .sterling/config.json exists but does not validate — cannot verify, will not overwrite. Repair or delete it first. ${e.message}`, 2);
  }
}
if (!recorded) {
  const noConfigAt = `no recorded config found at '${target}' (.sterling/config.json absent) — these declarations are required only on a first init; if this target is wrong, pass the intended --target`;
  if (!backupPathFlag && !backupOptOutFlag) {
    fail(`init REFUSED: a backup path is required, or an EXPLICIT opt-out (--backup-opt-out) — ${noConfigAt}. The knowledge base must not live in exactly one gitignored file (§2.3)`, 2);
  }
  if (!declaredToolchains.length) fail(`init REFUSED: at least one --toolchain <adapter>:<globs> declaration is required — ${noConfigAt} (§9.1)`, 2);
  if (!stackTagsFlag.length) fail(`init REFUSED: --stack-tags is required — ${noConfigAt} (ask, don’t guess — §12 mini-grill)`, 2);
}

// effective declarations: recorded config wins; flags only seed a fresh config
const baked = recorded ? recorded.toolchains : await resolveToolchains(declaredToolchains); // throws loudly on unregistered adapters
const eff = recorded
  ? {
      stackTags: recorded.stack_tags,
      domainPaths: recorded.domain_paths, // §3.3 line 94 per-tag path overrides
      backupPath: recorded.backup_path, // stored absolute
      backupOptOut: recorded.backup_opt_out,
      projectName: recorded.project_name ?? projectNameFlag ?? 'project',
      splitRatio: recorded.tui_split_ratio,
    }
  : {
      stackTags: stackTagsFlag,
      domainPaths: {}, // default per-user root; overrides are a hand-edited config concern
      // stored ABSOLUTE: disposal must hit the same place regardless of caller cwd.
      // backupPathForRuntime first rewrites a Windows drive path (C:\.../C:/...)
      // to /mnt form under WSL, so resolve() treats it as absolute instead of as
      // a relative path that lands inside the repo (the r-dd88 junk-dir bug).
      backupPath: backupPathFlag ? fwd(resolve(target, backupPathForRuntime(backupPathFlag))) : undefined,
      backupOptOut: backupOptOutFlag,
      projectName: projectNameFlag ?? 'project',
      splitRatio: undefined, // default from schema below
    };

// Every Sterling-initialized project mounts a universal `sterling` domain so
// general Sterling-tooling knowledge (gotchas, conventions, anti_patterns about
// using Sterling itself) is shared across ALL projects (decision foreign_47be4388). It
// is force-added to the §3.3 mount manifest regardless of what the project
// declares — deduped, ordered AFTER the project's own tags so project/tech
// knowledge still ranks ahead of the shared tooling domain.
const UNIVERSAL_DOMAIN = 'sterling';
eff.stackTags = [...eff.stackTags.filter((t) => t !== UNIVERSAL_DOMAIN), UNIVERSAL_DOMAIN];

const freshTracked = recorded ? null : trackedHandoffFiles(target);
const expectedConfig = parseConfig({
  ...JSON.parse(readFileSync(join(pluginRoot, 'templates', 'default-config.json'), 'utf8')),
  toolchains: baked,
  stack_tags: eff.stackTags,
  domain_paths: eff.domainPaths,
  // mirror the recorded name on re-runs so a pre-project_name config can still match
  ...((recorded ? recorded.project_name : eff.projectName) !== undefined
    ? { project_name: recorded ? recorded.project_name : eff.projectName }
    : {}),
  ...(eff.backupPath ? { backup_path: eff.backupPath } : { backup_opt_out: eff.backupOptOut }),
  // the project mode (decision project-mode-hobby-work-toggle-decides-flow) is a
  // recorded declaration like the ones above, switched in the TUI System tab: a
  // work project's config is not "hand-edited" for carrying it. A fresh config
  // takes --mode, else the explicit 'hobby' default.
  mode: recorded ? recorded.mode : (modeFlag ?? 'hobby'),
  // the handoff setting (decision
  // project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting) is
  // a recorded declaration too, switched in the TUI System tab. A fresh config
  // starts with it off, unless the project already has handoff files tracked
  // in git (a clone of a project that commits them): then it starts on, so the
  // first init on a new machine does not stop maintaining committed files. When
  // git cannot say what is tracked the key is left out of the written config
  // (below), never recorded as off from a failed read.
  handoff: recorded ? recorded.handoff : { enabled: freshTracked.files.length > 0 },
});
if (eff.splitRatio === undefined) eff.splitRatio = expectedConfig.tui_split_ratio;

// DOMAIN STORES: each declared domain (stack tags plus the forced 'sterling') whose store
// does not exist is created with a description; one with none refuses HERE, before any write.
// An existing store is never touched, and a description offered for one is reported, not applied.
const domainMounts = resolveDomainMounts({ stack_tags: eff.stackTags, domain_paths: eff.domainPaths });
const domainsToCreate = [];
const domainsExisting = [];
for (const m of domainMounts) {
  if (existsSync(m.dbPath)) domainsExisting.push(m);
  else domainsToCreate.push({ ...m, description: domainDescriptions.get(m.name) ?? DEFAULT_DOMAIN_DESCRIPTIONS[m.name] });
}
for (const name of domainDescriptions.keys()) {
  if (!domainMounts.some((m) => m.name === name)) {
    fail(`init REFUSED: ${DOMAIN_DESCRIPTION_FLAG} names '${name}', which is not a declared domain (declared: ${domainMounts.map((m) => m.name).join(', ')})`, 2);
  }
}
let undescribed = domainsToCreate.filter((d) => !d.description);
// THE UPDATE ENSURE PASS (/sterling:update re-bakes with --update-ensure, tolerate
// mode) never refuses on a recorded domain whose store is gone: nothing can be
// asked there, and a refusal would skip every other ensure item. The domain is
// not created and not mounted, and one stderr line per domain says so and names
// the remedy. An interactive init still refuses below.
const skippedDomains = [];
if (hasFlag('--update-ensure') && recorded) {
  for (const d of undescribed) {
    if (!recorded.stack_tags.includes(d.name)) continue;
    skippedDomains.push(d);
    process.stderr.write(
      `init: domain '${d.name}' is recorded but has no store at '${d.dbPath}' and no description; SKIPPED on the update ensure pass ` +
        `(not created, not mounted). Run /sterling:init with ${DOMAIN_DESCRIPTION_FLAG} ${d.name}=<description> to create it.\n`
    );
  }
  undescribed = undescribed.filter((d) => !skippedDomains.includes(d));
  domainsToCreate.splice(0, domainsToCreate.length, ...domainsToCreate.filter((d) => !skippedDomains.includes(d)));
}
if (undescribed.length) {
  fail(
    `init REFUSED: ${undescribed.length === 1 ? 'domain' : 'domains'} ${undescribed.map((d) => `'${d.name}'`).join(', ')} ` +
      `${undescribed.length === 1 ? 'has' : 'have'} no store yet and no description. A new domain is created with a description of which knowledge belongs in it; pass ` +
      undescribed.map((d) => `${DOMAIN_DESCRIPTION_FLAG} ${d.name}=<description>`).join(' ') +
      '. Nothing was written.',
    2
  );
}

// flags passed on a re-run that contradict the recorded config are reported,
// never silently applied — the config may be tuned; editing it is the owner's act
const notes = [];
if (recorded) {
  const flagDiffs = [];
  // ignore the init-managed universal domain on both sides — omitting `sterling` is not a contradiction
  const stripUniversal = (tags) => tags.filter((t) => t !== UNIVERSAL_DOMAIN);
  if (stackTagsFlag.length && canonical(stripUniversal(stackTagsFlag)) !== canonical(stripUniversal(recorded.stack_tags))) flagDiffs.push('--stack-tags');
  if (declaredToolchains.length && canonical(declaredToolchains) !== canonical(recorded.toolchains.map((t) => ({ adapter: t.adapter, path_globs: t.path_globs })))) flagDiffs.push('--toolchain');
  if (backupPathFlag && fwd(resolve(target, backupPathForRuntime(backupPathFlag))) !== recorded.backup_path) flagDiffs.push('--backup-path');
  if (backupOptOutFlag && !recorded.backup_opt_out) flagDiffs.push('--backup-opt-out');
  if (projectNameFlag && recorded.project_name && projectNameFlag !== recorded.project_name) flagDiffs.push('--project-name');
  if (flagDiffs.length) {
    notes.push(`note: ${flagDiffs.join(', ')} differ(s) from the recorded config — NOT applied; edit .sterling/config.json directly if the change is intended`);
  }
  // Keys the schema strips on parse are never read (decision
  // gap-hunt-2026-09-28-rulings item 12). Disclosure only: init never deletes
  // one — the same rendering /sterling:update prints.
  const unread = unreadConfigKeys(rawRecorded);
  if (unread.length) notes.push(`note: .sterling/config.json carries ${describeUnreadConfigKeys(unread)}`);
}

// the summary's mode line: set (a fresh config took --mode), defaulted (a fresh
// config with no --mode) or kept (an existing config's mode always wins; a
// differing --mode is a loud notice, never a write)
const modeLines = [];
if (!recorded) {
  modeLines.push(modeFlagGiven
    ? `mode: ${modeFlag} (set by --mode)`
    : 'mode: hobby (defaulted — no --mode was given; change it in the TUI System tab)');
} else {
  const recordedMode = PROJECT_MODES.includes(recorded.mode) ? recorded.mode : JSON.stringify(recorded.mode);
  modeLines.push(`mode: ${recordedMode} (kept — the recorded config wins)`);
  if (modeFlagGiven && modeFlag !== recorded.mode) {
    modeLines.push(`⚠ --mode ${modeFlag} NOT applied: this project's recorded mode is ${recordedMode} — switch it in the TUI System tab, then rerun init or /sterling:update`);
  }
}

// ---- §12 manifest, in order: per-item verify → create absent → skip matching → leave-and-report ----
const items = []; // { item, status: created|matches|differs|exists|refused|refreshed|stale|skipped|failed, detail }
const warns = [];
if (!claudeHost) {
  warns.push(`\n⚠ Claude Code not found (${claudeProbe.reason}) — skipped the Claude-only files: sterling-launch.sh, sterling.bat, tui.bat, .claude/agents/, .claude/settings.json and the codex user-scope check. Wrote the OpenCode side only; install Claude Code and re-run /sterling:init to add them.`);
}

// directories: a present directory is simply `exists` (a dir cannot be hand-edited)
for (const [label, leaf] of [['.sterling/ (+runs/)', '.sterling/runs'], ['docs/briefs/', 'docs/briefs']]) {
  const existed = existsSync(join(target, leaf));
  mkdirSync(join(target, leaf), { recursive: true });
  items.push({ item: label, status: existed ? 'exists' : 'created', detail: '' });
}

// domain stores: created with their description | left alone when they already exist
for (const d of domainsToCreate) {
  createDomain(d.name, d.description, d.dbPath);
  items.push({ item: `domain '${d.name}'`, status: 'created', detail: `${d.dbPath} — ${d.description}` });
}
for (const d of skippedDomains) {
  items.push({ item: `domain '${d.name}'`, status: 'skipped', detail: `${d.dbPath} — no store and no description; not created on the update ensure pass` });
}
for (const m of domainsExisting) {
  items.push({ item: `domain '${m.name}'`, status: 'exists', detail: `${m.dbPath} — already has a store; its description is untouched${domainDescriptions.has(m.name) ? ` (the --domain-description given for it was NOT applied)` : ''}` });
}

// config: created from declarations | matches defaults+declarations | tuned/hand-edited → left
const backupDetail = eff.backupPath ? eff.backupPath : 'OPTED OUT (recorded; snapshots will skip loudly)';
if (!recorded) {
  if (freshTracked.unknown === null) {
    writeFileSync(configPath, JSON.stringify(expectedConfig, null, 2));
  } else {
    const withoutHandoff = { ...expectedConfig };
    delete withoutHandoff.handoff;
    writeFileSync(configPath, JSON.stringify(withoutHandoff, null, 2));
    notes.push(`note: config.handoff.enabled was left out of the new .sterling/config.json — git could not say whether handoff files are committed (${freshTracked.unknown}); once git answers, the setting follows what is tracked, or set it in the TUI System tab`);
  }
  items.push({ item: '.sterling/config.json', status: 'created', detail: `${baked.map((t) => t.adapter).join(', ')} toolchain(s); stack tags [${eff.stackTags.join(', ')}]; backup ${backupDetail}` });
  for (const tc of baked) {
    for (const [cap, present] of Object.entries(tc.capabilities ?? {})) {
      if (!present) warns.push(`warn: ${tc.adapter}: no ${cap} capability — ${cap} checks will skip loudly (§9.1)`);
    }
  }
} else {
  // Independent managed mutations, applied to the RAW parsed JSON (never the
  // schema-expanded `recorded`, which would materialize every default and
  // clobber an intentionally-absent field) — validated ONCE with parseConfig
  // before a single write. Folded together when more than one applies.
  let mutated = rawRecorded;
  const mutationNotes = [];

  // managed mutation (decision foreign_47be4388): every project mounts the universal
  // `sterling` domain. Surgically ADD it, preserving every hand-tuned field —
  // NOT a regenerate-from-defaults (that would clobber tunings).
  if (!recorded.stack_tags.includes(UNIVERSAL_DOMAIN)) {
    mutated = { ...mutated, stack_tags: eff.stackTags };
    mutationNotes.push(`added the universal '${UNIVERSAL_DOMAIN}' domain to stack tags (now [${eff.stackTags.join(', ')}])`);
  }

  if (mutationNotes.length) {
    // parseConfig is a VALIDATION GATE only — it throws (refuses the write) if
    // the merged config is invalid, but its RETURN value is discarded. Zod
    // materializes every absent default and STRIPS tolerated unknown/future
    // keys, so serializing its return would silently rewrite policy the merge
    // never touched (additive-only violation, anti_pattern foreign_94f16632). Serialize
    // the RAW `mutated` object instead — rawRecorded plus only the additive
    // changes above — so unknown keys survive and no defaults are materialized
    // beyond what was already recorded on disk.
    parseConfig(mutated);
    writeFileSync(configPath, JSON.stringify(mutated, null, 2));
    items.push({ item: '.sterling/config.json', status: 'refreshed', detail: mutationNotes.join('; ') });
  } else if (canonical(withoutHandoffEntries(recorded)) === canonical(withoutHandoffEntries(expectedConfig))) {
    items.push({ item: '.sterling/config.json', status: 'matches', detail: 'defaults + recorded declarations' });
  } else {
    items.push({ item: '.sterling/config.json', status: 'differs', detail: 'left untouched (tuned or hand-edited) — declarations were read from it' });
  }
}

// store: data, never recreated or compared — present means leave it alone
const dbPath = join(target, '.sterling', 'sterling.db');
if (existsSync(dbPath)) {
  items.push({ item: '.sterling/sterling.db', status: 'exists', detail: 'data store — left as-is, never recreated' });
} else {
  const { SterlingStore } = await import('@sterling/store');
  new SterlingStore(dbPath).close();
  items.push({ item: '.sterling/sterling.db', status: 'created', detail: 'WAL, FTS5' });
}

// CLAUDE.md from the shipped template — specified content, never improvised,
// NEVER clobbered: a differing CLAUDE.md is the human's; merging is their act.
// Dead-term check runs on each generated render IMMEDIATELY before its write, so
// a rotted template refuses BEFORE the poisoned file lands on disk (audit finding
// 22/43 — the check formerly ran after every write). The header's "every refusal
// happens BEFORE any write" now holds for this check too.
const assertNoDeadTerms = (label, content) => {
  const hits = findDeadTerms(content);
  if (hits.length) fail(`init dead-term check FAILED in generated ${label}: ${hits.map((h) => h.match).join(', ')}`, 1);
  return content;
};

// AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
// 161e2972): AGENTS.md is the tool-agnostic layer (read natively by Codex/OpenCode); CLAUDE.md is
// `@AGENTS.md` plus the Sterling-bound layer. Project facts/conventions placeholders now render into
// AGENTS.md only — CLAUDE.md's template carries just {{PROJECT_NAME}}.
//
// Dead-term check is scoped to STERLING'S OWN TEMPLATE PROSE ONLY — never the conventions/tail
// text spliced into it. That text can be a fresh-init project's own conventions or a migrated
// legacy tail (real-world gap: Dome Farmer's tail says "enemy waves", which is project prose, not
// Sterling's retired codename). Checked ONCE, up front, against the template with the
// {{CONVENTIONS_SECTION}} placeholder cut OUT — not against any rendered conventions value —
// so the lint judges only what Sterling ships, and `renderAgentsMd` itself never re-checks.
const agentsMdTemplateRaw = readFileSync(join(pluginRoot, 'templates', 'target-agents-md.md'), 'utf8')
  .replaceAll('{{PROJECT_NAME}}', eff.projectName)
  .replaceAll('{{STACK_TAGS}}', eff.stackTags.join(', '))
  .replaceAll('{{TOOLCHAINS}}', baked.map((t) => `${t.adapter} (${t.path_globs.join(', ')})`).join('; '))
  .replaceAll('{{DOMAINS}}', eff.stackTags.length
    ? eff.stackTags.map((t) => eff.domainPaths[t] ?? `~/.sterling/domains/${t}/`).join(', ') + ' — each created by init with a description of what belongs in it (§2.3)'
    : '(none — declare stack tags to mount domain stores)')
  // WHETHER backups are on is a project fact; WHERE they go is a machine fact, and this file
  // is tracked — see the CLAUDE.md-era comment this carries forward (`update.mjs` refuses on a
  // dirty tracked file before doing anything; config holds the value, this states the fact).
  .replaceAll('{{BACKUP_PATH}}', eff.backupPath
    ? 'configured — see `.sterling/config.json` → `backup_path` (machine-local, deliberately not restated here)'
    : '(opted out — recorded)');
const CONVENTIONS_TOKEN = '{{CONVENTIONS_SECTION}}';
const agentsMdConventionsIdx = agentsMdTemplateRaw.indexOf(CONVENTIONS_TOKEN);
if (agentsMdConventionsIdx === -1) fail('templates/target-agents-md.md lost its {{CONVENTIONS_SECTION}} placeholder — refusing (P5)', 1);
assertNoDeadTerms(
  'AGENTS.md (template)',
  agentsMdTemplateRaw.slice(0, agentsMdConventionsIdx) + agentsMdTemplateRaw.slice(agentsMdConventionsIdx + CONVENTIONS_TOKEN.length),
);
const renderAgentsMd = (conventionsSection) => agentsMdTemplateRaw.replace(CONVENTIONS_TOKEN, conventionsSection);
const DEFAULT_CONVENTIONS = '(grows only via architecture-altering decision records — nothing yet)';
const expectedAgentsMd = renderAgentsMd(DEFAULT_CONVENTIONS);

// CLAUDE.md is the template's CLAUDE render (decision sterling-layer-is-one-source-with-host-blocks):
// claude-only lines kept, opencode-only blocks and every fence marker dropped. The OpenCode
// plugin renders the same file for OpenCode from the template's block pairs.
const expectedClaudeMd = assertNoDeadTerms('CLAUDE.md', renderClaudeText(readFileSync(join(pluginRoot, 'templates', 'target-claude-md.md'), 'utf8'), 'templates/target-claude-md.md')
  .replaceAll('{{PROJECT_NAME}}', eff.projectName));

const agentsMdPath = join(target, 'AGENTS.md');
const claudeMdPath = join(target, 'CLAUDE.md');
const writeAtomic = (p, content) => {
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
};

// Legacy pre-split projects carry a single CLAUDE.md whose project-owned tail begins wherever
// the pre-split template's own head ends. NO MARKER EXISTS OR IS NEEDED (Sol re-spec, corrected
// from an earlier marker-line design after Dome Farmer proved wrong: its "marker-looking" line
// was a hand-written bold ruling, not a Sterling artefact — neither template ever emitted one).
// Every pre-split revision of templates/target-claude-md.md ends its head with the literal
// "## Conventions (lean — grows only via architecture-altering decision records)" heading, a
// blank line, then {{CONVENTIONS_SECTION}} — whatever init rendered there, plus anything the
// project appended, is the tail. Migration never guesses: the legacy CLAUDE.md is matched
// against each HISTORICAL segment set (newest first; see headSegments below) — segment 0 must
// match at offset 0, every following segment is found in order, and the LAST segment (also
// non-empty) must match; its END is the boundary. Nothing after the boundary is inspected, so
// the tail can be anything, including a hand-written bold ruling like Dome Farmer's. The match
// runs on a CR-stripped copy but the boundary is mapped back to the RAW text (buildLineMap /
// mapNormToRaw) so a CRLF file splits at the right byte; the tail is carried as the raw
// substring, original line endings intact — only the freshly-rendered head is converted to the
// legacy file's own EOL convention.
const SENTINEL_VOCAB = [
  { re: /\bknowledge_\w+/, label: 'a knowledge_ tool name' },
  { re: /\bboard_\w+/, label: 'a board_ tool name' },
  { re: /\bpreflight\b/i, label: '"preflight"' },
  { re: /\breconcile\b/i, label: '"reconcile"' },
  { re: /\bH([1-9]|[12]\d|3[01])\b/, label: 'a hook id (H1-H31)' },
  { re: /\bhook\b/i, label: '"hook"' },
  { re: /\.sterling\//, label: '".sterling/"' },
];

// Splits RAW text into {content, eol} per line, content NEVER carrying a trailing \r (so a
// whole-line equality check on `content` is CR-stripped for free) while `eol` ('\n' | '\r\n' |
// '' for a final line with no trailing newline) lets the original bytes be reconstructed exactly.
function splitKeepingEol(text) {
  const out = [];
  let start = 0;
  const re = /\r\n|\n/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ content: text.slice(start, m.index), eol: m[0] });
    start = re.lastIndex;
  }
  out.push({ content: text.slice(start), eol: '' });
  return out;
}
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (lfText, eol) => (eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText);
// Converts only the portion of `fullText` BEFORE `tailRaw` to `eol`, leaving the tail's own
// bytes (and its own line endings) completely untouched.
const spliceEol = (fullText, tailRaw, eol) => {
  if (eol === '\n') return fullText;
  const idx = fullText.lastIndexOf(tailRaw);
  if (idx === -1) return fullText;
  return withEol(fullText.slice(0, idx), eol) + fullText.slice(idx);
};
// A historical head (the template's prose above {{CONVENTIONS_SECTION}}, still carrying its OWN
// unsubstituted {{TOKEN}} placeholders) becomes an ordered list of LITERAL segments split at
// every placeholder — so a legacy file rendered with ANY prior set of project facts still
// matches; only the prose structure has to be a pristine, unmodified historical render.
// A regex-based wildcard (`[\s\S]*?` per placeholder) was tried first and dropped: V8 throws
// "Regular expression too large" from `RegExp.prototype.test` (not at construction — only once
// tested against a real multi-KB legacy head) once a pattern mixes enough lazy wildcards with an
// input that long. A segment scan has the identical match semantics with none of that ceiling.
const headSegments = (headText) => headText.split(/\{\{[A-Z_]+\}\}/);
// Finds where `segments` (a historical head split at {{TOKEN}} boundaries) matches the START of
// `text`: segment 0 anchors at offset 0, every following segment is found in order, and the LAST
// segment (non-empty) — the literal text right before where {{CONVENTIONS_SECTION}} began — has
// its match END returned as the boundary. Nothing after the boundary is inspected, so it makes
// no difference what the project's own tail contains.
function matchBoundary(text, segments) {
  if (!segments.length || !segments[0].length) return null;
  if (!text.startsWith(segments[0])) return null;
  let pos = segments[0].length;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (isLast && !seg.length) return null;
    if (!seg.length) continue; // an empty MIDDLE segment (two placeholders back-to-back) matches trivially
    // The gap between the previous segment's end and this one's start IS a placeholder's
    // rendered value — every historical placeholder above {{CONVENTIONS_SECTION}} ({{PROJECT_NAME}},
    // {{STACK_TAGS}}, {{TOOLCHAINS}}, {{DOMAINS}}, {{BACKUP_PATH}}, any other in older revisions)
    // renders on ONE line. An unbounded `indexOf` would silently absorb a line a human inserted
    // right after the placeholder as if it were that value — a multi-line gap is REJECTED, and
    // the search keeps trying LATER occurrences of the same literal segment (Sol re-check).
    let idx = text.indexOf(seg, pos);
    while (idx !== -1 && text.slice(pos, idx).includes('\n')) {
      idx = text.indexOf(seg, idx + 1);
    }
    if (idx === -1) return null;
    pos = idx + seg.length;
  }
  return pos;
}
// Maps a RAW (possibly CRLF) text's normalized (LF-only, CR-stripped) offsets back to raw byte
// offsets, so matchBoundary can run on a CR-stripped copy while the head/tail split happens on
// the RAW bytes — a CRLF legacy file splits at the right byte, not one shifted by dropped \r's.
function buildLineMap(rawLines) {
  let normalizedText = '';
  const lineBoundaries = [];
  let normPos = 0;
  let rawPos = 0;
  for (const l of rawLines) {
    const normStart = normPos;
    const rawStart = rawPos;
    const hasEol = l.eol !== '';
    normalizedText += hasEol ? `${l.content}\n` : l.content;
    normPos += l.content.length + (hasEol ? 1 : 0);
    rawPos += l.content.length + l.eol.length;
    lineBoundaries.push({ normStart, normEnd: normPos, rawStart, rawEnd: rawPos });
  }
  return { normalizedText, lineBoundaries };
}
function mapNormToRaw(lineBoundaries, normOffset) {
  for (const lb of lineBoundaries) {
    if (normOffset <= lb.normEnd) return normOffset === lb.normEnd ? lb.rawEnd : lb.rawStart + (normOffset - lb.normStart);
  }
  return null;
}
// Newest-first (git log's default order). A revision that predates or postdates the
// {{CONVENTIONS_SECTION}}-placeholder shape contributes no pattern — it cannot anchor a match.
// git being unavailable, or having no usable history at all, is reported by name rather than
// silently treated as "no match" (P5: never migrate blind on an unverifiable absence).
function historicalHeadSegmentSets() {
  const log = spawnSync('git', ['log', '--format=%H', '--', 'templates/target-claude-md.md'], { cwd: pluginRoot, encoding: 'utf8' });
  if (log.error || log.status !== 0) {
    const stderrTrimmed = (log.stderr || '').trim();
    const cause = log.error?.message ?? (stderrTrimmed || `exit ${log.status}`);
    return { segmentSets: [], unavailableReason: `git log failed for templates/target-claude-md.md (${cause})` };
  }
  const shas = log.stdout.split('\n').filter(Boolean);
  if (!shas.length) return { segmentSets: [], unavailableReason: 'templates/target-claude-md.md has no git history in this clone' };
  const segmentSets = [];
  for (const sha of shas) {
    const show = spawnSync('git', ['show', `${sha}:templates/target-claude-md.md`], { cwd: pluginRoot, encoding: 'utf8' });
    if (show.status !== 0) continue;
    const idx = show.stdout.indexOf('{{CONVENTIONS_SECTION}}');
    if (idx === -1) continue;
    segmentSets.push(headSegments(normalize(show.stdout.slice(0, idx))));
  }
  if (!segmentSets.length) return { segmentSets: [], unavailableReason: 'no historical revision of templates/target-claude-md.md contains a {{CONVENTIONS_SECTION}} placeholder to anchor the match against' };
  return { segmentSets, unavailableReason: null };
}

// Shared by every `manual` outcome — a non-matching head, an unverifiable head (git
// unavailable), and a legacy file beside an existing AGENTS.md all leave the same preview behind.
function writeMigrationPreview(rawClaudeText, tailForPreview) {
  mkdirSync(join(target, '.sterling'), { recursive: true });
  const previewRel = join('.sterling', 'agents-md-migration-preview.diff');
  const previewPath = join(target, previewRel);
  const oldTmp = `${previewPath}.old.tmp`;
  const newTmp = `${previewPath}.new.tmp`;
  writeFileSync(oldTmp, rawClaudeText);
  const previewAgents = tailForPreview != null ? renderAgentsMd(tailForPreview) : expectedAgentsMd;
  writeFileSync(newTmp, `${expectedClaudeMd}\n\n<!-- AGENTS.md would carry: -->\n\n${previewAgents}`);
  const diff = spawnSync('diff', ['-u', oldTmp, newTmp], { encoding: 'utf8' });
  writeFileSync(previewPath, diff.stdout || '(no textual diff produced)');
  unlinkSync(oldTmp);
  unlinkSync(newTmp);
  return previewRel;
}

// Attempts the boundary match against every historical segment set (newest first) and, on a hit,
// builds the would-be AGENTS.md/CLAUDE.md — used both to actually migrate and to detect an
// interrupted-run continuation (AGENTS.md already holds exactly what this would produce).
function computeMigration(rawText) {
  const { segmentSets, unavailableReason } = historicalHeadSegmentSets();
  if (unavailableReason) return { matched: false, reason: unavailableReason };
  const { normalizedText, lineBoundaries } = buildLineMap(splitKeepingEol(rawText));
  let boundaryNorm = null;
  for (const segs of segmentSets) {
    const b = matchBoundary(normalizedText, segs);
    if (b !== null) { boundaryNorm = b; break; }
  }
  if (boundaryNorm === null) {
    return { matched: false, reason: `head is not a pristine historical render of the Sterling template (checked ${segmentSets.length} revision(s))` };
  }
  const rawBoundary = mapNormToRaw(lineBoundaries, boundaryNorm);
  const rawTail = rawText.slice(rawBoundary);
  const eol = detectEol(rawText);
  const flagged = [];
  rawTail.split(/\r\n|\n/).forEach((line, i) => {
    for (const { re, label } of SENTINEL_VOCAB) {
      if (re.test(line)) { flagged.push(`tail line ${i + 1} mentions ${label} — Sterling-bound text now sits in the tool-agnostic file; move it to CLAUDE.md by hand if it is a rule`); break; }
    }
  });
  return {
    matched: true,
    rawTail,
    eol,
    flagged,
    agentsMd: spliceEol(renderAgentsMd(rawTail), rawTail, eol),
    claudeMd: withEol(expectedClaudeMd, eol),
  };
}

const agentsMdExists = existsSync(agentsMdPath);
const claudeMdExists = existsSync(claudeMdPath);
const claudeMdRaw = claudeMdExists ? readFileSync(claudeMdPath, 'utf8') : '';
// A "stub" CLAUDE.md is the already-migrated Sterling-layer render: its first line is the
// `@AGENTS.md` import. Real-world gap (Dome Farmer): a project can carry BOTH a legacy full
// CLAUDE.md AND a pre-existing AGENTS.md that is NOT the product of a real migration — most
// often a gitignored Codex-derived copy of the old CLAUDE.md. Silently treating that as an
// interrupted-run continuation would hide an un-migrated project.
const claudeMdIsStub = claudeMdExists && claudeMdRaw.split(/\r?\n/, 1)[0] === '@AGENTS.md';

if (agentsMdExists && claudeMdExists && !claudeMdIsStub) {
  const agentsMdRaw = readFileSync(agentsMdPath, 'utf8');
  const result = computeMigration(claudeMdRaw);
  if (result.matched && result.agentsMd === agentsMdRaw) {
    // Interrupted-run continuation: the existing AGENTS.md is BYTE-IDENTICAL to what this
    // migration would produce — not merely present, actually proven — so only CLAUDE.md needs
    // rewriting (Sol re-check finding 4a).
    writeAtomic(claudeMdPath, result.claudeMd);
    items.push({ item: 'AGENTS.md', status: 'ok', detail: 'already present — byte-identical to what migration would write; treated as an interrupted run, resumed' });
    items.push({ item: 'CLAUDE.md', status: 'migrated (resumed)', detail: 're-rendered as the Sterling layer (AGENTS.md migration already completed)' });
  } else {
    const previewRel = writeMigrationPreview(claudeMdRaw, result.matched ? result.rawTail : null);
    const reason = `legacy CLAUDE.md beside an existing AGENTS.md — if AGENTS.md is a Codex-derived copy of CLAUDE.md (gitignored, header 'identical to CLAUDE.md'), delete it and rerun; if it is authored, merge by hand: ${previewRel}`;
    items.push({ item: 'AGENTS.md', status: 'manual', detail: reason });
    items.push({ item: 'CLAUDE.md', status: 'manual', detail: reason });
  }
} else if (!agentsMdExists && claudeMdExists) {
  const result = computeMigration(claudeMdRaw);
  if (result.matched) {
    writeAtomic(agentsMdPath, result.agentsMd);
    writeAtomic(claudeMdPath, result.claudeMd);
    items.push({ item: 'AGENTS.md', status: result.flagged.length ? `migrated (${result.flagged.length} flagged)` : 'migrated', detail: result.flagged.length ? result.flagged.join('; ') : 'legacy CLAUDE.md tail carried below the historical boundary, original line endings preserved' });
    items.push({ item: 'CLAUDE.md', status: 'migrated', detail: 're-rendered as the Sterling layer; project-owned tail moved to AGENTS.md' });
  } else {
    const previewRel = writeMigrationPreview(claudeMdRaw, null);
    items.push({ item: 'AGENTS.md', status: 'manual', detail: `${result.reason} — nothing written; preview at ${previewRel}` });
    items.push({ item: 'CLAUDE.md', status: 'manual', detail: 'left untouched pending AGENTS.md migration (see AGENTS.md row)' });
  }
} else {
  if (!agentsMdExists) {
    writeAtomic(agentsMdPath, expectedAgentsMd);
    items.push({ item: 'AGENTS.md', status: 'created', detail: 'from templates/target-agents-md.md' });
  } else {
    items.push({ item: 'AGENTS.md', status: 'ok', detail: 'present — project-editable, never compared byte-for-byte' });
  }

  if (!claudeMdExists) {
    writeAtomic(claudeMdPath, expectedClaudeMd);
    items.push({ item: 'CLAUDE.md', status: 'created', detail: 'from templates/target-claude-md.md' });
  } else if (normalize(claudeMdRaw) === normalize(expectedClaudeMd)) {
    items.push({ item: 'CLAUDE.md', status: 'matches', detail: 'generated content, unmodified' });
  } else {
    items.push({ item: 'CLAUDE.md', status: 'differs', detail: 'left untouched — merge the Sterling layer by hand (template: templates/target-claude-md.md)' });
  }
}

// S6 consumer cutover (decision s6-consumer-cutover-init-on-installed-copy-fixes-
// launchers): on an installed copy, a launcher that starts claude with --plugin-dir keeps
// the project on its old clone (--plugin-dir overrides the installed plugin), so it is
// replaced even without a stamp. The clones that launcher and sterling-update.bat named
// are collected for the manual deletion step printed at the end; nothing deletes them.
const installedCopy = isInstalledCopy(pluginRoot);
const oldClonePaths = [];

// Claude-only (decision init-without-claude-code-probes-and-skips-claude-artifacts-loudly):
// sterling-launch.sh starts `claude`, and the .bat files only call it.
if (claudeHost) {
  // WSL/tmux launchers (§11, decision foreign_bb5e25cd): all projects are WSL (company
  // policy), so init generates the new-way launchers — a thin Windows .bat that
  // double-clicks into `wt -> wsl --cd <project> -> bash -lic ./sterling-launch.sh`,
  // plus the per-project tmux launcher sterling-launch.sh (claude left, TUI right).
  // node/claude are detected at RUNTIME inside the .sh; the .bat needs no exe paths.
  const toWindowsPath = (p) => {
    // /mnt/c/Users/cuj/X -> C:\Users\cuj\X (WSL drvfs); else just backslash-ize
    const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
    return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
  };
  // tmux session names forbid '.'/':' and choke on spaces — bake a sanitized,
  // per-project name so multiple projects run at once but never the same one twice
  const sanitizeSession = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const winProjectDir = toWindowsPath(fwd(target));
  const sessionName = `sterling-${sanitizeSession(basename(target))}`;
  const splitPercent = Math.round(eff.splitRatio * 100);
  // the .sh is bash — ALWAYS LF (a CRLF shebang/line breaks bash); the .bat files
  // are ALWAYS CRLF (cmd.exe misparses LF-only batch files), regardless of eol config
  const lf = (s) => s.replace(/\r\n/g, '\n');
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  // Older generated launchers (decision init-and-update-refresh-an-older-generated-
  // launcher): a launcher that is a pristine render of an EARLIER template version is
  // rewritten and reported `refreshed`; one matching no version is a hand edit, left
  // untouched with a loud line. The /sterling:update ensure pass runs this same code.
  // The versions (git on a clone, bin/launcher-history.json on an installed copy;
  // scripts/lib/launcher-history.mjs) are read only once a launcher differs.
  let launcherHistory = null;
  const olderGenerated = (text, templateName) => {
    if (!launcherHistory) {
      launcherHistory = historicalLauncherTemplates({ repoRoot: pluginRoot });
      if (launcherHistory.replayFailures.length) {
        warns.push(`\n⚠ ${replayFailureLine(launcherHistory.replayFailures, 'a launcher rendered by one of them is left untouched as if hand-edited. Fix or report the renderer commit named above.')}`);
      }
    }
    return olderGeneratedLauncher(text, templateName, launcherHistory);
  };
  const refreshedDetail = (oldPath, newPath) =>
    'an earlier generated version of the template; rewritten from the current one' +
    (oldPath && oldPath !== newPath ? ` (it was rendered for ${oldPath}, now ${newPath})` : '');
  const leftUntouched = (file) => {
    if (launcherHistory.degraded) {
      warns.push(`\n⚠ ${file} differs from the current render and could not be checked against earlier versions (no template history: ${launcherHistory.degraded}), so it was left untouched. To refresh it, delete it and re-run /sterling:init.`);
      return { item: file, status: 'differs', detail: 'left untouched — could not be checked (no template history); delete it and re-run /sterling:init to regenerate' };
    }
    warns.push(`\n⚠ ${file} differs from the current render and matches no earlier version of its template (hand-edited, or rendered for another path), so it was left untouched. To refresh it, delete it and re-run /sterling:init.`);
    return { item: file, status: 'differs', detail: 'left untouched (matches no generated version: hand-edited or another path) — delete it and re-run /sterling:init to regenerate' };
  };
  // sterling.bat and tui.bat: created, matches, refreshed or (hand-edited) differs
  const ensureBat = (file, path, expected, templateName, createdDetail) => {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (existing === null) {
      writeFileSync(path, expected);
      items.push({ item: file, status: 'created', detail: createdDetail });
      return;
    }
    if (normalize(existing) === normalize(expected)) {
      items.push({ item: file, status: 'matches', detail: 'unchanged' });
      return;
    }
    const old = olderGenerated(existing, templateName);
    if (old) {
      writeFileSync(path, expected);
      items.push({ item: file, status: 'refreshed', detail: refreshedDetail(old.WIN_PROJECT_DIR, winProjectDir) });
    } else {
      items.push(leftUntouched(file));
    }
  };

  // (1) the tmux launcher — the actual split lives here; both .bat files call it
  // (an installed plugin copy gets NO --plugin-dir and resolves the TUI at run time;
  // the authoring clone keeps both — see scripts/lib/launcher-tmux.mjs)
  const expectedTmuxLauncher = assertNoDeadTerms('sterling-launch.sh', lf(
    renderTmuxLauncher(pluginRoot, { session: sessionName, splitPercent })
  ));
  const tmuxLauncherPath = join(target, 'sterling-launch.sh');
  const existingTmuxLauncher = existsSync(tmuxLauncherPath) ? readFileSync(tmuxLauncherPath, 'utf8') : null;
  const cloneLauncher = installedCopy && existingTmuxLauncher !== null ? cloneLauncherTarget(existingTmuxLauncher) : null;
  if (existingTmuxLauncher === null) {
    writeFileSync(tmuxLauncherPath, expectedTmuxLauncher);
    items.push({ item: 'sterling-launch.sh', status: 'created', detail: `tmux session ${sessionName}, ${splitPercent}% TUI pane` });
  } else if (normalize(existingTmuxLauncher) === normalize(expectedTmuxLauncher)) {
    items.push({ item: 'sterling-launch.sh', status: 'matches', detail: 'generated content unchanged' });
  } else if (cloneLauncher) {
    writeFileSync(tmuxLauncherPath, expectedTmuxLauncher);
    if (cloneLauncher.clonePath) oldClonePaths.push(cloneLauncher.clonePath);
    const from = cloneLauncher.clonePath ? `the clone ${cloneLauncher.clonePath}` : 'a clone (the old launcher does not record its path)';
    items.push({ item: 'sterling-launch.sh', status: 'replaced', detail: `the old launcher started claude with --plugin-dir pointing at ${from}, which overrides the installed plugin; regenerated in the installed-copy shape` });
  } else {
    const old = olderGenerated(existingTmuxLauncher, 'launcher-tmux.sh');
    if (old) {
      writeFileSync(tmuxLauncherPath, expectedTmuxLauncher);
      const oldPluginDir = old.PLUGIN_DIR ?? /^PLUGIN_DIR="([^"]+)"/.exec(old.PLUGIN_PATHS ?? '')?.[1];
      const newPluginDir = installedCopy ? 'the installed copy, resolved at run time' : fwd(pluginRoot);
      items.push({ item: 'sterling-launch.sh', status: 'refreshed', detail: refreshedDetail(oldPluginDir, newPluginDir) });
    } else {
      items.push(leftUntouched('sterling-launch.sh'));
    }
  }

  // (2) the double-click Windows entry: Windows Terminal -> WSL -> the tmux launcher
  const expectedLauncher = assertNoDeadTerms('sterling.bat', crlf(
    readFileSync(join(pluginRoot, 'templates', 'launcher-win.bat'), 'utf8')
      .replaceAll('{{WIN_PROJECT_DIR}}', winProjectDir)
  ));
  ensureBat('sterling.bat', join(target, 'sterling.bat'), expectedLauncher, 'launcher-win.bat', `double-click -> wsl ${winProjectDir}`);

  // (3) the §13 dashboard re-opener: re-adds the TUI pane to the running session
  const expectedTuiLauncher = assertNoDeadTerms('tui.bat', crlf(
    readFileSync(join(pluginRoot, 'templates', 'tui-win.bat'), 'utf8')
      .replaceAll('{{WIN_PROJECT_DIR}}', winProjectDir)
  ));
  ensureBat('tui.bat', join(target, 'tui.bat'), expectedTuiLauncher, 'tui-win.bat', 'double-click -> ./sterling-launch.sh tui');
}

// (4) the native-Windows launcher (sterling-windows.bat) is RETIRED — decision
// native-windows-launcher-retired-wsl2-only: Sterling runs WSL2-only, so init no
// longer generates it. A copy an earlier init wrote is left on disk for the user
// to delete (never deleted or migrated here) and reported, so it is not silent.
const nativeLauncherPath = join(target, 'sterling-windows.bat');
if (existsSync(nativeLauncherPath)) {
  items.push({
    item: 'sterling-windows.bat',
    status: 'stale',
    detail:
      'retired (decision native-windows-launcher-retired-wsl2-only) — init no longer generates or maintains it; Sterling runs under WSL2 via sterling.bat. Left on disk untouched: delete it yourself when you no longer want it',
  });
}

// (5) the double-click updater entry: brings the machine's Sterling CLONE to
// origin's default branch with NO Claude session in the loop (the updater is
// deterministic; a session interpreting its refusals is what kept going wrong).
// Ensure logic shared with /sterling:update's project fan-out, which delivers
// this launcher to projects whose init predates it.
// On an installed copy a clone-updater shape is deleted (S6); its clone joins the
// manual deletion step.
const { clonePath: updaterClonePath, ...updateLauncherRow } = ensureUpdateLauncher(target, pluginRoot);
if (updaterClonePath) oldClonePaths.push(updaterClonePath);
items.push({ item: UPDATE_LAUNCHER_NAME, ...updateLauncherRow });

// (6) the consumer-runnable checks entry (board 4ccf0644): check-record-citations
// + check-stale-claims were registered only in the CLONE's own `npm run check` —
// nothing shipped a way to run them against a CONSUMING project's own tree/store,
// which is exactly where the incidents they exist to catch happened. Ensure logic
// shared with /sterling:update's project fan-out (scripts/lib/consumer-checks.mjs),
// same delivery precedent as the updater launcher above.
items.push({ item: CONSUMER_CHECK_LAUNCHER_NAME, ...ensureConsumerCheckLauncher(target, pluginRoot) });

// Claude-only (decision init-without-claude-code-probes-and-skips-claude-artifacts-loudly):
// without Claude Code there is no .claude/ tree to sync agents into or activate a conductor in.
const agentInstructions = [];
let restartNeeded = false;
let conductorActivation = { activation: 'skipped', autoMemory: 'skipped' };
if (claudeHost) {
  // agent installation (§2.2) via the §13 sync semantics: installed | refreshed |
  // up_to_date | locally-modified left | refuse-on-local-modification
  // No machine vars are baked: the only template tokens are {{MODEL}}/{{EFFORT}}, resolved
  // from config below (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-
  // keeps-its-clone, design point C: nothing an installed agent says names a plugin path).
  const installedPluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const { report: agentReport } = syncAgents({
    templatesDir: join(pluginRoot, 'agent-templates'),
    registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
    targetAgentsDir: join(target, '.claude', 'agents'),
    pluginVersion: installedPluginVersion,
    now: new Date().toISOString(),
    // config.models is authoritative (98064d77): the config init just wrote/read
    // resolves {{MODEL}}/{{EFFORT}} per agent. `recorded` on a re-run, else the
    // freshly written `expectedConfig` — both are parsed SterlingConfig with .models.
    config: recorded ?? expectedConfig,
  });
  for (const a of agentReport) {
    const map = {
      installed: { status: 'created', detail: 'installed with version/hash header' },
      refreshed: { status: 'refreshed', detail: 'clean install, newer template — regenerated' },
      header_repaired: { status: 'refreshed', detail: 'Sterling header repaired in place — content unchanged' },
      machine_rebaked: { status: 'refreshed', detail: 'machine-specific paths re-baked for this host (node/hooks dir), template unchanged' },
      up_to_date: { status: 'matches', detail: 'template hash + content hash match' },
      config_drift: {
        status: 'differs',
        detail: a.status === 'config_drift'
          ? `${[a.installed.model !== a.configured.model || a.installed.effort !== a.configured.effort ? 'model/effort' : null, a.tools ? 'tools' : null].filter(Boolean).join(' + ')} drift — ${describeConfigDrift(a)}; not rewritten — realize it with ${a.fix}`
          : '',
      },
      locally_modified_up_to_date: { status: 'differs', detail: 'locally modified, template unchanged — left untouched' },
      refused_local_modification: { status: 'refused', detail: 'locally modified AND template changed — overwrite refused (see /sterling:sync-agents guidance below)' },
      foreign_file: { status: 'refused', detail: 'not Sterling-generated — never overwritten (see guidance below)' },
      retired: { status: 'retired', detail: 'removed a clean Sterling-generated agent no longer in the registry' },
      retired_unrecognized: { status: 'refused', detail: 'Sterling-marked retired agent has an unrecognized header — left untouched (see guidance below)' },
      retired_but_modified: { status: 'refused', detail: 'retired Sterling agent was locally modified — left untouched (see guidance below)' },
      retired_identity_mismatch: { status: 'refused', detail: 'retired Sterling agent identity is ambiguous — left untouched (see guidance below)' },
      retired_read_failed: { status: 'refused', detail: 'retired Sterling agent could not be read — left untouched (see guidance below)' },
      retired_delete_failed: { status: 'refused', detail: 'retired Sterling agent could not be deleted (see guidance below)' },
      retired_scan_failed: { status: 'refused', detail: 'agent directory could not be scanned for retired Sterling agents (see guidance below)' },
    }[a.status];
    items.push({ item: `.claude/agents/${a.name}.md`, status: map.status, detail: map.detail });
    if (a.instruction) agentInstructions.push(a.instruction);
  }
  restartNeeded = agentChangesRequireRestart(agentReport);

  // H1's post-update sync marker (.sterling/synced-version, keyed on plugin.json's
  // version): the agents were just synced at THIS version, so record it and the first
  // session after init does not sync them again. Written only when no agent was
  // refused — the same bar H1 sets before it writes the marker (sync-agents exit 2 is
  // not a sync), so a refusal keeps H1 retrying and surfacing it.
  const agentRefused = agentReport.some((a) => items.find((i) => i.item === `.claude/agents/${a.name}.md`)?.status === 'refused');
  if (!agentRefused) {
    writeFileSync(join(target, '.sterling', 'synced-version'), `${installedPluginVersion}\n`);
  }

  // Route A (decision conductor-instructions-via-main-session-agent-route-a): init installs
  // the conductor like every other agent above, then activates it the same way
  // install-agents/sync-agents do — a settings-only write also needs a restart.
  conductorActivation = ensureConductorActivation(target, agentReport);
  items.push({
    item: '.claude/settings.json (conductor activation)',
    status: { written: 'created', already: 'matches', refused: 'refused', skipped: 'skipped' }[conductorActivation.activation],
    detail: conductorActivation.reason ?? (conductorActivation.activation === 'written' ? `wrote "agent": "conductor" to ${conductorActivation.path}` : 'already "agent": "conductor"'),
  });
  items.push({
    item: '.claude/settings.json (auto-memory off)',
    status: { written: 'created', already: 'matches', kept: 'notice', wrong_type: 'notice', skipped: 'skipped' }[conductorActivation.autoMemory],
    detail: conductorActivation.autoMemoryNotice ?? {
      written: `wrote "autoMemoryEnabled": false to ${conductorActivation.path}`,
      already: 'already "autoMemoryEnabled": false',
      skipped: 'settings.json is not a valid JSON object — not touched',
    }[conductorActivation.autoMemory],
  });
}

// Sterling on OpenCode 2 (decision
// sterling-on-opencode-installs-global-plugins-plus-untracked-project-config): global
// shims, this project's untracked .opencode/opencode.json and the Sterling-full roster.
// Before the portable copies, so the exclude block never hides them.
const opencodeSetup = setupOpenCode({ projectDir: target, pluginRoot });
if (opencodeSetup.skipped) items.push({ item: 'Sterling on OpenCode 2', status: 'skipped', detail: opencodeSetup.skipped });
for (const r of opencodeSetup.rows ?? []) {
  items.push({ item: `OpenCode ${r.item}`, status: r.status, detail: r.detail ?? '' });
  if (r.instruction) agentInstructions.push(r.instruction);
}

// OpenCode handoff (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections): portable
// .opencode/agents/ copies and the architecture.md / rulings.md / docs/sterling/
// projection of THIS project's store, all committed, for engineers without
// Sterling. Neither applies to the Sterling clone itself (said, not silent). The
// projection runs as its own process: its guards (secondary, missing or empty
// store; a foreign file in the way) refuse by exit code, and init reports them as
// rows like every other refusal instead of stopping.
// The clone probe reads target paths through contained-fs; a symlinked manifest
// is a refused row, never a guessed "clone" or "not a clone".
let handoffCloneTarget;
try {
  handoffCloneTarget = isSterlingClone(target, pluginRoot);
} catch (err) {
  if (!(err instanceof ContainmentError)) throw err;
  handoffCloneTarget = null;
  items.push({ item: `${OPENCODE_AGENTS_DIR}/ + handoff projection`, status: 'refused', detail: `${err.message} — nothing written` });
}
// The handoff setting (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// both follow config.handoff.enabled, read from this target's own config, in
// hobby and work mode alike. Off is a loud skip row that deletes nothing; every
// init run provisions a target that has it on, so re-running init after turning
// it on writes the files.
let handoffEnabled = null;
if (handoffCloneTarget === false) {
  try {
    handoffEnabled = readHandoffEnabled(target);
  } catch (err) {
    if (!(err instanceof HandoffSettingError) && !(err instanceof ContainmentError)) throw err;
    items.push({ item: `${OPENCODE_AGENTS_DIR}/ + handoff projection`, status: 'refused', detail: `${err.message} — nothing written` });
  }
}
if (handoffCloneTarget === true) {
  items.push({ item: `${OPENCODE_AGENTS_DIR}/ + handoff projection`, status: 'skipped', detail: 'the target is a Sterling clone — it has its own projections and is not a handoff target' });
} else if (handoffEnabled === false) {
  items.push({ item: `${OPENCODE_AGENTS_DIR}/ + handoff projection`, status: 'skipped', detail: HANDOFF_OFF_DETAIL });
} else if (handoffEnabled === true) {
  const { report: opencodeReport } = syncOpenCodeAgents({
    templatesDir: join(pluginRoot, 'agent-templates'),
    registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
    targetDir: target,
  });
  const opencodeRows = {
    installed: ['created', 'portable OpenCode agent (committed; no model pin)'],
    refreshed: ['refreshed', 'clean copy, newer render — regenerated'],
    header_repaired: ['refreshed', 'portable header repaired in place — content unchanged'],
    up_to_date: ['matches', 'content hash matches a fresh render'],
    locally_modified_up_to_date: ['differs', 'locally modified, render unchanged — left untouched'],
    refused_local_modification: ['refused', 'locally modified AND render changed — overwrite refused (see guidance below)'],
    foreign_file: ['refused', 'not Sterling-generated — never overwritten (see guidance below)'],
    refused_unsafe_path: ['refused', 'a symlink or non-directory on the way — nothing written (see guidance below)'],
    refused_ignored: ['refused', 'ignored by git — this file is meant to be committed; nothing written (see guidance below)'],
  };
  for (const r of opencodeReport) {
    const [status, detail] = opencodeRows[r.status];
    items.push({ item: `${OPENCODE_AGENTS_DIR}/${r.name}.md`, status, detail });
    if (r.instruction) agentInstructions.push(r.instruction);
  }
  // the committed bundle runs without node_modules (an installed plugin copy has none);
  // the source script is the fallback for a tree where the bundle is absent
  const handoffBundle = join(pluginRoot, 'bin', 'handoff-projection.mjs');
  const handoffScript = existsSync(handoffBundle) ? handoffBundle : join(pluginRoot, 'scripts', 'handoff-projection.mjs');
  const handoff = spawnSync(process.execPath, [handoffScript, target], { cwd: target, encoding: 'utf8' });
  const handoffOut = `${handoff.stdout ?? ''}${handoff.stderr ?? ''}${handoff.error ? handoff.error.message : ''}`.trim();
  const handoffLine = handoffOut.split('\n')[0].replace(/^handoff projection: /, '');
  const handoffStatus = handoff.status === 0
    ? (handoffLine.startsWith('unchanged') ? 'matches' : handoffLine.startsWith('SKIPPED') ? 'skipped' : 'refreshed')
    : handoff.status === 2 || handoff.status === 3 ? 'refused' : 'failed';
  items.push({ item: 'architecture.md + rulings.md + docs/sterling/ (handoff projection)', status: handoffStatus, detail: handoffLine });
  if (handoffStatus === 'failed') {
    warns.push(`\n⚠ handoff projection FAILED (exit ${handoff.status}) — the export may be INCOMPLETE; rerun init:\n${handoffOut}`);
    process.exitCode = 1;
  }
}

// MCP packaging (decision foreign_097851ed, refined): the Sterling MCP server is declared
// ONCE as the PLUGIN's server — but NOT via a root .mcp.json. A root .mcp.json is
// BOTH auto-discovered by the plugin AND read as Sterling-self's project-scope config
// (the dual-role), and bare ${CLAUDE_PROJECT_DIR} does not substitute in project scope
// → a second, empty-store server. Instead the plugin manifest (.claude-plugin/plugin.json
// mcpServers) references .claude-plugin/sterling-mcp.json, read ONLY through the manifest
// and never as a project config — so the dual-role cannot exist. That file is COMMITTED
// and machine-independent (decision sterling-ships-as-a-marketplace-plugin-authoring-
// machine-keeps-its-clone, slice S2): it names the bundled server through
// ${CLAUDE_PLUGIN_ROOT} and the store through ${CLAUDE_PROJECT_DIR}, both substituted by
// Claude Code at spawn, so init NEVER writes into the plugin directory any more — a run
// from a consuming project touches nothing outside --target. A consuming project still
// gets NO .mcp.json (the plugin carries the declaration).
const mcpPath = join(target, '.mcp.json');
// `initIsPluginRepo` answers "is --target the clone itself" (it governs the clone's OWN
// project-shaped artifacts: the root .mcp.json cleanup and the plugin-repo-only
// .gitignore entries). `pluginArtifactRoot` answers "which directory holds
// .claude-plugin/"; it resolves through pluginRootMatch, the env seam that lets a test
// point the retired-artifact report at a disposable directory.
const initIsPluginRepo = fwd(target) === fwd(pluginRootMatch);
const pluginArtifactRoot = pluginRootMatch;
const isOurMcpEntry = (e) =>
  e && typeof e === 'object' && e.command === process.execPath && Array.isArray(e.args) && e.args[0] === fwd(mcpServerEntry);
const readMcp = () => {
  try {
    const m = JSON.parse(readFileSync(mcpPath, 'utf8'));
    if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new Error('not an object');
    return m;
  } catch {
    return undefined;
  }
};

// CODEX MCP LIVES AT USER SCOPE (decision sterling-ships-as-a-marketplace-plugin-
// authoring-machine-keeps-its-clone, ruling point 2; finding
// codex-mcp-bridge-needs-codex-0-153-4-pinned-side-install): the codex server is
// machine truth, so it is registered in the user-level Claude config, never in the
// plugin's committed file. Init only CHECKS for it and, when it is missing, prints ONE
// loud line carrying the exact `claude mcp add --scope user ...` command — never
// blocking the rest of init (P5 degraded-loud). The probe (binary on PATH, the
// `codex mcp-server --help` capability check, `codex login status`) only chooses WHICH
// line to print, so it runs solely when the server is missing: an unrelated init
// never spawns `codex` on a machine that is already wired.
// STERLING_CODEX_PROBE: test-isolation seam — honored at THIS call site (not inside
// probeCodex). unset/'' -> real probe; 'ok' -> force success; 'absent' -> force
// binary-absent; 'not-logged-in' -> force not-logged-in. Any other value fails loud
// (unknown signals halt, P5) — validated EAGERLY, even on a run that will not probe.
const codexProbeOverride = process.env.STERLING_CODEX_PROBE;
const forcedCodexProbe = !codexProbeOverride
  ? undefined
  : codexProbeOverride === 'ok'
    ? { ok: true }
    : codexProbeOverride === 'absent'
      ? { ok: false, reason: 'binary-absent' }
      : codexProbeOverride === 'not-logged-in'
        ? { ok: false, reason: 'not-logged-in' }
        : fail(`STERLING_CODEX_PROBE must be 'ok', 'absent', or 'not-logged-in' (got '${codexProbeOverride}')`, 2);
if (claudeHost) {
  const codexUserScope = userScopeCodexServer();
  if (codexUserScope.found) {
    items.push({ item: 'codex MCP (user scope)', status: 'matches', detail: `a codex server is registered in ${fwd(codexUserScope.path)}` });
  } else {
    const codexProbe = forcedCodexProbe ?? probeCodex();
    warns.push(codexUserScopeLine(codexProbe, { nodeBinDir: fwd(dirname(process.execPath)), unreadable: codexUserScope.unreadable }));
    items.push({ item: 'codex MCP (user scope)', status: 'skipped', detail: 'no codex server in the user-level Claude config — see the codex mcp line below for the command' });
  }
}

// PLUGIN AUTO-UPDATE (S6, decision s6-consumer-cutover-init-on-installed-copy-fixes-
// launchers, ruling point 3): a third-party marketplace does not auto-update by default
// (finding plugin-github-source-install-copies-tracked-head-tree-october-2026), so an
// installed copy warns with the exact settings JSON. Same pattern as the codex check
// above: init only READS the user-level file, and a missing or unparseable one is a
// warning, never a crash.
if (claudeHost && installedCopy) {
  const autoUpdateLine = autoUpdateWarning(marketplaceAutoUpdate());
  if (autoUpdateLine) warns.push(autoUpdateLine);
}

if (initIsPluginRepo) {
  // The native-claude Windows MCP config (.claude-plugin/sterling-mcp-win.json) is
  // RETIRED with the native launcher, its only reader (decision
  // native-windows-launcher-retired-wsl2-only): init no longer generates or
  // maintains it. A copy an earlier init wrote is left on disk and reported.
  const winMcpConfigPath = join(pluginArtifactRoot, '.claude-plugin', 'sterling-mcp-win.json');
  if (existsSync(winMcpConfigPath)) {
    items.push({
      item: '.claude-plugin/sterling-mcp-win.json',
      status: 'stale',
      detail:
        'retired (decision native-windows-launcher-retired-wsl2-only) — its only reader was the retired sterling-windows.bat; init no longer generates or maintains it. Left on disk untouched: delete it yourself when you no longer want it',
    });
  }
  // a root .mcp.json must NOT exist in the plugin repo: it would be auto-discovered by
  // the plugin (double-declaring sterling) AND read as project scope (the empty-store
  // dual-role). Remove our own generated one; report anything else loudly.
  if (existsSync(mcpPath)) {
    const mcp = readMcp();
    if (mcp && mcp.mcpServers && isOurMcpEntry(mcp.mcpServers.sterling) && Object.keys(mcp.mcpServers).length === 1) {
      unlinkSync(mcpPath);
      items.push({ item: '.mcp.json', status: 'created', detail: 'removed — the plugin now references .claude-plugin/sterling-mcp.json; a root .mcp.json reintroduces the empty-store dual-role' });
    } else {
      items.push({ item: '.mcp.json', status: 'differs', detail: 'unexpected root .mcp.json in the plugin repo — remove by hand (it reintroduces the empty-store project server)' });
    }
  }
} else {
  // a consuming project: the plugin already declares sterling, bound to THIS
  // project's store via ${CLAUDE_PROJECT_DIR}. Never write a per-project entry
  // (it double-registers); remove a stale init-generated one, keep foreign servers.
  const mcp = existsSync(mcpPath) ? readMcp() : undefined;
  if (!existsSync(mcpPath)) {
    items.push(claudeHost
      ? { item: '.mcp.json', status: 'matches', detail: 'not written — the plugin declares sterling, bound to this project via ${CLAUDE_PROJECT_DIR}' }
      : { item: '.mcp.json', status: 'skipped', detail: 'not applicable — Claude Code is not installed on this machine, and the Claude Code plugin is what declares sterling there' });
  } else if (!mcp) {
    items.push({ item: '.mcp.json', status: 'differs', detail: 'exists but is not a parseable object — left untouched' });
  } else if (isOurMcpEntry(mcp.mcpServers?.sterling)) {
    delete mcp.mcpServers.sterling;
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));
    items.push({ item: '.mcp.json', status: 'created', detail: 'removed the redundant per-project sterling entry — the plugin now declares it (other servers preserved)' });
  } else if (mcp.mcpServers?.sterling) {
    items.push({ item: '.mcp.json', status: 'differs', detail: 'a hand-edited sterling entry exists — left untouched (the plugin also declares sterling; reconcile by hand)' });
  } else {
    items.push({ item: '.mcp.json', status: 'matches', detail: 'no per-project sterling entry — the plugin declares it' });
  }
}

// hook registrations: the project-level §6 set ships in the PLUGIN's
// hooks.json and activates with the plugin — init does not duplicate it.
items.push(claudeHost
  ? { item: 'hooks (§6 set)', status: 'matches', detail: 'active via the plugin (hooks/hooks.json) — not duplicated into the project' }
  : { item: 'hooks (§6 set)', status: 'skipped', detail: 'not applicable — Claude Code is not installed on this machine, and the Claude Code plugin is what activates these hooks (OpenCode runs its own plugin hooks)' });

// gitignore entries (§2.3/§11/§12): per-entry ensure — appending is non-destructive
const gitignorePath = join(target, '.gitignore');
const existingIgnore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
const entries = ['.sterling/', 'sterling.bat', 'sterling-windows.bat', 'tui.bat', 'sterling-launch.sh', UPDATE_LAUNCHER_NAME, CONSUMER_CHECK_LAUNCHER_NAME, '.claude/agents/'];
// the SOURCE/plugin repo's generated MCP config is machine-specific → gitignore it
// (consuming projects never get one — the plugin carries its own declaration).
// (still keyed on --target: this ensures the TARGET's .gitignore, and a consuming
// project must not gain ignore entries for a directory it does not contain. The
// clone's own .gitignore already carries both, committed.)
if (initIsPluginRepo) entries.push('.claude-plugin/sterling-mcp-win.json');
if (eff.backupPath) {
  const root = fwd(target);
  if (eff.backupPath === root || eff.backupPath.startsWith(root + '/')) {
    entries.push(eff.backupPath === root ? '/' : eff.backupPath.slice(root.length + 1) + '/');
  }
}
const missing = entries.filter((e) => !existingIgnore.split(/\r?\n/).includes(e));
if (missing.length) {
  appendFileSync(gitignorePath, (existingIgnore && !existingIgnore.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  items.push({ item: '.gitignore', status: 'created', detail: `appended: ${missing.join(', ')}` });
} else {
  items.push({ item: '.gitignore', status: 'matches', detail: 'all entries present' });
}

// (dead-term check now runs per-render before each write — see assertNoDeadTerms,
// audit finding 22/43 — so no poisoned file reaches disk before the refusal.)

// shared project registry (decision foreign_8f9e6db2): note this project in the
// machine-global registry so the others are aware it exists. Upsert by repo_path,
// bound to the init event (P4); the H1 hook later touches last_seen_at per session.
const pluginPkg = (() => {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const registry = new ProjectRegistry(registryPath());
let liveProjectPaths = null; // a registry failure stops init before the hint; null (every clone treated as live) is for a caller that could not read it
try {
  const already = registry.list().some((p) => p.repo_path === fwd(target));
  registry.register({
    repo_path: fwd(target),
    name: eff.projectName,
    stack_tags: eff.stackTags,
    toolchains: baked.map((t) => t.adapter),
    sterling_version: typeof pluginPkg.version === 'string' ? pluginPkg.version : null,
    at: new Date().toISOString(),
  });
  liveProjectPaths = [target, ...registry.list().map((p) => p.repo_path)];
  const siblings = registry.list().filter((p) => p.repo_path !== fwd(target)).length;
  items.push({
    item: 'project registry',
    status: already ? 'refreshed' : 'created',
    detail: `${already ? 'refreshed' : 'noted'} '${eff.projectName}' in the shared registry — ${siblings} sibling project${siblings === 1 ? '' : 's'}`,
  });
} finally {
  registry.close();
}

// ---- the per-item report table ----
const width = Math.max(...items.map((i) => i.item.length));
const statusWidth = Math.max(...items.map((i) => i.status.length));
console.log('item'.padEnd(width) + '  ' + 'status'.padEnd(statusWidth) + '  detail');
for (const i of items) {
  console.log(i.item.padEnd(width) + '  ' + i.status.padEnd(statusWidth) + '  ' + i.detail);
}
console.log('\n' + modeLines.join('\n'));
console.log('\ndead-term check: clean');
for (const line of warns) console.log(line);
for (const line of notes) console.log(line);
for (const instruction of agentInstructions) console.log('\n' + instruction);

// UNDECLARED-SOURCE DISCLOSURE (decision undeclared-source-disclosure-per-
// file-coverage-live-h1-scan, board 44ef6838): the SAME shared ladder
// scripts/hooks/h1-session-start.mjs calls — computeUndeclaredSourceDisclosure
// in scripts/hooks/lib/undeclared-source-scan.mjs (fix-round MED-2/MED-3: one
// function, one semantics, instead of two independently-drifting copies) —
// rendered ONCE here so a fresh project sees its coverage gaps immediately,
// not only at its first session start. Never a refusal (P1 — disclosure
// only, no gate) and never silent on an abnormal shape (P5) — git absent,
// spawn failure, timeout, output cap, or an unparseable/malformed effective
// config (including a malformed per-entry toolchain shape) each print the
// bounded UNAVAILABLE line instead of vanishing.
try {
  const effectiveConfig = recorded ?? expectedConfig;
  const report = computeUndeclaredSourceDisclosure({ cwd: target, config: effectiveConfig });
  if (report) console.log('\n' + report);
} catch (err) {
  // Last-resort fail-open (P1): computeUndeclaredSourceDisclosure already
  // catches internally, so this is truly last-resort (e.g. renderUnavailable
  // itself throwing).
  console.log('\n' + renderUnavailable(`unexpected error: ${err?.message ?? err}`));
}

if (conductorActivation.activation === 'written') {
  console.log(`\nEXIT AND RELAUNCH: conductor activation newly written in ${conductorActivation.path}`);
} else if (conductorActivation.autoMemory === 'written') {
  console.log(`\nEXIT AND RELAUNCH: "autoMemoryEnabled": false newly written in ${conductorActivation.path}`);
}

if (restartNeeded || conductorActivation.activation === 'written' || conductorActivation.autoMemory === 'written') {
  console.log('\n' + RESTART_INSTRUCTION);
} else {
  console.log('\nno agent changes — no restart required');
}

// S6 ruling point 4: deleting the old clone stays a manual step, printed last.
const cleanupLines = cloneCleanupLines(oldClonePaths, liveProjectPaths);
if (cleanupLines.length) console.log('\n' + cleanupLines.join('\n'));
