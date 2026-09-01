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
//     [--backup-path <p> | --backup-opt-out]
//   (stack tags ARE the domain mount manifest — §3.3; no separate domains flag)
//   (declaration flags are required only when no recorded config exists)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@sterling/schemas';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { arg, argAll, fail } from './lib/project.mjs';
import { backupPathForRuntime } from './lib/wsl-path.mjs';
import { resolveToolchains } from './adapters/resolve.mjs';
import { syncAgents, findDeadTerms, RESTART_INSTRUCTION } from './lib/agent-distribution.mjs';
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from './lib/update-launcher.mjs';
import { stampBody, verifyStamp } from './lib/generated-marker.mjs';
import { ensureConsumerCheckLauncher, CONSUMER_CHECK_LAUNCHER_NAME } from './lib/consumer-checks.mjs';
import { probeCodex, probeCodexWin, withCodexEntry, codexSkipLine } from './lib/codex-mcp.mjs';
import { appendMissingSanctioned } from './lib/store-remediation.mjs';
import { renderUnavailable } from './hooks/lib/undeclared-source.mjs';
import { computeUndeclaredSourceDisclosure } from './hooks/lib/undeclared-source-scan.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test-isolation seam (mirrors STERLING_REGISTRY_DB/STERLING_WIN_NODE): the
// plugin-repo branch below (codex probe + .claude-plugin/sterling-mcp*.json
// ensure) only fires when target === pluginRoot — running init with
// --target <the real pluginRoot> for real would write into THIS live repo's
// generated, gitignored MCP config (the one this very session's connection
// may be using), which is unsafe to exercise from an automated test. A test
// instead sets STERLING_PLUGIN_ROOT_MATCH to its own --target temp dir, so
// the branch's ensure logic runs against a disposable directory while every
// OTHER pluginRoot-derived path (templates, dist, hooks) still resolves to
// the REAL plugin root. Unset in every real run — behavior is unchanged.
// '' must behave as unset too (matches STERLING_CODEX_PROBE's falsy convention) —
// ?? alone would let '' survive and silently disable the plugin-repo branch.
const pluginRootMatch = process.env.STERLING_PLUGIN_ROOT_MATCH || pluginRoot;
const target = resolve(arg('--target') ?? process.cwd());
const projectNameFlag = arg('--project-name');
const stackTagsFlag = (arg('--stack-tags') ?? '').split(',').filter(Boolean);
const backupPathFlag = arg('--backup-path');
const backupOptOutFlag = process.argv.includes('--backup-opt-out');
const declaredToolchains = argAll('--toolchain').map((spec) => {
  const [adapter, globs] = spec.split(':');
  return { adapter, path_globs: (globs ?? '').split(',').filter(Boolean) };
});

const fwd = (p) => p.replace(/\\/g, '/');
const normalize = (s) => s.replace(/\r\n/g, '\n');
// canonical compare: key order must not decide "hand-edited"
const canonical = (v) =>
  JSON.stringify(v, (_, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val
  );

// ---- verify pass: every refusal happens BEFORE any write ----
if (!existsSync(target)) fail(`init REFUSED: target '${target}' does not exist`, 2);
const mcpServerEntry = join(pluginRoot, 'packages', 'mcp-server', 'dist', 'main.js');
if (!existsSync(mcpServerEntry)) fail('init REFUSED: MCP server not built — run `npm run build` in the plugin first', 2);
// The launchers below bake the TUI bundle path; generating them against a
// missing bundle ships a launcher that dies on double-click (board 16783088,
// outside-family review 2026-08-29 — this check existed for the MCP entry but
// not for the second shipped executable).
const tuiBundleEntry = join(pluginRoot, 'packages', 'tui', 'bundle', 'sterling-tui.mjs');
if (!existsSync(tuiBundleEntry)) fail('init REFUSED: TUI bundle not built — run `npm run build:tui` in the plugin first', 2);
for (const rel of ['.sterling', '.sterling/runs', 'docs', 'docs/briefs', '.claude', '.claude/agents']) {
  const p = join(target, rel);
  if (existsSync(p) && !statSync(p).isDirectory()) {
    fail(`init REFUSED (destructive): '${rel}' exists as a file but the manifest requires a directory — refusing to replace it`, 2);
  }
}

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
// using Sterling itself) is shared across ALL projects (decision 47be4388). It
// is force-added to the §3.3 mount manifest regardless of what the project
// declares — deduped, ordered AFTER the project's own tags so project/tech
// knowledge still ranks ahead of the shared tooling domain.
const UNIVERSAL_DOMAIN = 'sterling';
eff.stackTags = [...eff.stackTags.filter((t) => t !== UNIVERSAL_DOMAIN), UNIVERSAL_DOMAIN];

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
});
if (eff.splitRatio === undefined) eff.splitRatio = expectedConfig.tui_split_ratio;

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
}

// ---- §12 manifest, in order: per-item verify → create absent → skip matching → leave-and-report ----
const items = []; // { item, status: created|matches|differs|exists|refused|refreshed|stale|skipped, detail }
const warns = [];

// directories: a present directory is simply `exists` (a dir cannot be hand-edited)
for (const [label, leaf] of [['.sterling/ (+runs/)', '.sterling/runs'], ['docs/briefs/', 'docs/briefs']]) {
  const existed = existsSync(join(target, leaf));
  mkdirSync(join(target, leaf), { recursive: true });
  items.push({ item: label, status: existed ? 'exists' : 'created', detail: '' });
}

// config: created from declarations | matches defaults+declarations | tuned/hand-edited → left
const backupDetail = eff.backupPath ? eff.backupPath : 'OPTED OUT (recorded; snapshots will skip loudly)';
if (!recorded) {
  writeFileSync(configPath, JSON.stringify(expectedConfig, null, 2));
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

  // managed mutation (decision 47be4388): every project mounts the universal
  // `sterling` domain. Surgically ADD it, preserving every hand-tuned field —
  // NOT a regenerate-from-defaults (that would clobber tunings).
  if (!recorded.stack_tags.includes(UNIVERSAL_DOMAIN)) {
    mutated = { ...mutated, stack_tags: eff.stackTags };
    mutationNotes.push(`added the universal '${UNIVERSAL_DOMAIN}' domain to stack tags (now [${eff.stackTags.join(', ')}])`);
  }

  // Sanctioned-script reach (board 52c1d504; original trap: decision bc0f81e3,
  // board 1b3c7bf3): a config frozen with an EXPLICIT store_guard.allow_scripts
  // before the schema default grew never gains newly-sanctioned scripts,
  // because an explicit array REPLACES the zod default rather than extending
  // it — measured for the mandated migration scripts (the one thing an
  // H15-denied consumer could never run to escape a read-only store) and again
  // for the TUI launcher. The merge carries exactly what config.ts SHIPS as
  // sanctioned, so it changes which projects that list reaches, never what is
  // on it. Additive-only, disclosed below (never silent — anti_pattern
  // 94f16632); a wrong-shaped store_guard/allow_scripts is warned about and
  // left alone, never replaced.
  const rawGuard = mutated.store_guard;
  if (rawGuard !== undefined) {
    if (rawGuard === null || typeof rawGuard !== 'object' || Array.isArray(rawGuard)) {
      warns.push('warn: .sterling/config.json store_guard is not an object — skipping the sanctioned-script reach merge (board 52c1d504); its shape was not written by init and will not be replaced');
    } else if (rawGuard.allow_scripts !== undefined && !Array.isArray(rawGuard.allow_scripts)) {
      warns.push('warn: .sterling/config.json store_guard.allow_scripts is not an array — skipping the sanctioned-script reach merge (board 52c1d504); its shape was not written by init and will not be replaced');
    } else if (Array.isArray(rawGuard.allow_scripts)) {
      const { next, added } = appendMissingSanctioned(rawGuard.allow_scripts);
      if (added.length) {
        mutated = { ...mutated, store_guard: { ...rawGuard, allow_scripts: next } };
        mutationNotes.push(`store_guard.allow_scripts gained script(s) Sterling ships as sanctioned that this explicit array was missing: ${added.join(', ')}`);
      }
    }
    // allow_scripts absent on an explicit store_guard object: the schema
    // default already supplies the grown list — nothing to merge.
  }

  if (mutationNotes.length) {
    // parseConfig is a VALIDATION GATE only — it throws (refuses the write) if
    // the merged config is invalid, but its RETURN value is discarded. Zod
    // materializes every absent default and STRIPS tolerated unknown/future
    // keys, so serializing its return would silently rewrite policy the merge
    // never touched (additive-only violation, anti_pattern 94f16632). Serialize
    // the RAW `mutated` object instead — rawRecorded plus only the additive
    // changes above — so unknown keys survive and no defaults are materialized
    // beyond what was already recorded on disk.
    parseConfig(mutated);
    writeFileSync(configPath, JSON.stringify(mutated, null, 2));
    items.push({ item: '.sterling/config.json', status: 'refreshed', detail: mutationNotes.join('; ') });
  } else if (canonical(recorded) === canonical(expectedConfig)) {
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

const expectedClaudeMd = assertNoDeadTerms('CLAUDE.md', readFileSync(join(pluginRoot, 'templates', 'target-claude-md.md'), 'utf8')
  .replaceAll('{{PROJECT_NAME}}', eff.projectName)
  .replaceAll('{{STACK_TAGS}}', eff.stackTags.join(', '))
  .replaceAll('{{TOOLCHAINS}}', baked.map((t) => `${t.adapter} (${t.path_globs.join(', ')})`).join('; '))
  .replaceAll('{{DOMAINS}}', eff.stackTags.length
    ? eff.stackTags.map((t) => eff.domainPaths[t] ?? `~/.sterling/domains/${t}/`).join(', ') + ' — created lazily on first need (§2.3)'
    : '(none — declare stack tags to mount domain stores)')
  // WHETHER backups are on is a project fact; WHERE they go is a machine fact,
  // and this file is tracked. Baking the absolute path made CLAUDE.md differ per
  // machine forever — on the self-hosted clone, shared between two machines, that
  // is a permanently dirty tracked file, which `update.mjs` refuses on (exit 2)
  // before it does anything. So /sterling:update could never run without first
  // stashing this one line by hand. Config holds the value; this states the fact.
  .replaceAll('{{BACKUP_PATH}}', eff.backupPath
    ? 'configured — see `.sterling/config.json` → `backup_path` (machine-local, deliberately not restated here)'
    : '(opted out — recorded)')
  .replaceAll('{{CONVENTIONS_SECTION}}', '(grows only via architecture-altering decision records — nothing yet)'));
const claudeMdPath = join(target, 'CLAUDE.md');
if (!existsSync(claudeMdPath)) {
  writeFileSync(claudeMdPath, expectedClaudeMd);
  items.push({ item: 'CLAUDE.md', status: 'created', detail: 'from templates/target-claude-md.md' });
} else if (normalize(readFileSync(claudeMdPath, 'utf8')) === normalize(expectedClaudeMd)) {
  items.push({ item: 'CLAUDE.md', status: 'matches', detail: 'generated content, unmodified' });
} else {
  items.push({ item: 'CLAUDE.md', status: 'differs', detail: 'left untouched — merge the conductor contract by hand (template: templates/target-claude-md.md)' });
}

// WSL/tmux launchers (§11, decision bb5e25cd): all projects are WSL (company
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
const tuiBundle = fwd(join(pluginRoot, 'packages', 'tui', 'bundle', 'sterling-tui.mjs'));
// Native-Windows launcher (decision: revive the native split as a SECOND launcher).
// The Windows node path used to come ONLY from `where.exe node` (WSL interop), which
// required the node dir to be on the Windows PATH. HOST-NATIVE since decision
// host-native-init-with-dev-machine-escape-hatch: that PATH lookup is measured to find
// NOTHING on the real native-Windows host (research_finding
// native-windows-platform-measurements-2026-08-27 — node runs there only by absolute
// path), and the same lookup gated BOTH this launcher AND the native MCP config, so one
// PATH miss cost a Windows user both. A native-Windows init instead uses process.execPath:
// the interpreter already executing this script is by definition runnable, and PATH
// membership adds no evidence on top of that.
const whereWin = (exe) => {
  const r = spawnSync('where.exe', [exe], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return undefined;
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0];
};
// DUAL-CONTEXT ESCAPE HATCH (decision host-native-init-with-dev-machine-escape-hatch):
// host-native is the DEFAULT and dual-context is EXPLICIT + OPT-IN, never inferred. A
// non-Windows host emits Windows artifacts only when the operator says so, because the
// ruling's users are 100% one host or the other and only THIS authoring machine really
// runs both. Two equivalent spellings, no config field: --dual-context on the command
// line, or STERLING_DUAL_CONTEXT=1 in the environment (a durable .sterling/config.json
// field would need a packages/schemas change — deliberately not taken here).
const dualContext = process.argv.includes('--dual-context') || process.env.STERLING_DUAL_CONTEXT === '1';
// ONE HOST-APPROPRIATE MCP ENTRY (decision host-native-init-with-dev-machine-escape-hatch,
// AMENDING decision native-claude-mcp-via-strict-win-config). That decision's CAVEAT 1 —
// `--strict-mcp-config` suppresses EVERY other MCP server in the native session — was
// accepted because the plugin's own sterling entry named a WSL node that native claude
// cannot execute, so both entries would load and collide on the name 'sterling' (-32000).
// That premise holds ONLY when the two are generated on different hosts. The plugin entry's
// command is `process.execPath`, so on a win32 host it IS the Windows node: there is exactly
// one host-appropriate entry, nothing to collide with, and the native launcher can inherit
// it through --plugin-dir alone. Dropping --strict there is what restores codex — the
// DEFAULT independent reviewer (decision codex-preferred-for-read-shaped-analysis) — to a
// 100%-Windows user, who under --strict had no outside-family review at all.
// The predicate is the HOST, not `winNodeSource`: an STERLING_WIN_NODE override on win32
// still leaves the plugin entry runnable by native claude, so it needs no second config.
// This one flag governs BOTH the launcher flags and whether sterling-mcp-win.json is
// generated, because they are one mechanism — the config exists only to be passed by the
// launcher, and an unreferenced copy is the second entry this ruling exists to remove.
// STERLING_NATIVE_MCP_MODE: test seam, same precedent and shape as STERLING_WIN_NODE /
// STERLING_CODEX_PROBE — honored at THIS call site only. unset/'' -> the real host
// predicate; 'host-native' / 'dual-context' force the arm. It exists because the
// host-native arm is otherwise unreachable from the Linux host the suite runs on, and a
// permanently-skipped pin is a hollow pin (research_finding 0c712d94, M6: 36 tests that
// reported 0 failures by running none). Unknown value halts loud (P5).
const nativeMcpModeOverride = process.env.STERLING_NATIVE_MCP_MODE;
const nativeMcpNeedsWinConfig = !nativeMcpModeOverride
  ? process.platform !== 'win32'
  : nativeMcpModeOverride === 'dual-context'
    ? true
    : nativeMcpModeOverride === 'host-native'
      ? false
      : fail(`STERLING_NATIVE_MCP_MODE must be 'host-native' or 'dual-context' (got '${nativeMcpModeOverride}')`, 2);
// STERLING_WIN_NODE, when DEFINED (even empty), still bypasses detection entirely:
// a path forces that path; '' forces the skip path. Naming a Windows node path from a
// non-Windows host IS an explicit dual-context declaration, so it needs no second flag.
// Otherwise: native-Windows host -> process.execPath (existence-validated; no --version
// probe, since this interpreter IS the running process); non-Windows host -> the
// where.exe cross-detection ONLY under the opt-in above; otherwise nothing, reported
// loudly below as a host-native skip rather than a failure.
let winNodeSource;
let winNode;
if (process.env.STERLING_WIN_NODE !== undefined) {
  winNode = process.env.STERLING_WIN_NODE;
  winNodeSource = 'override';
} else if (process.platform === 'win32') {
  winNode = existsSync(process.execPath) ? process.execPath : undefined;
  winNodeSource = 'host-native';
} else if (dualContext) {
  winNode = whereWin('node');
  winNodeSource = 'dual-context';
} else {
  winNode = undefined;
  winNodeSource = 'host-native-elsewhere';
}
// A REQUESTED-BUT-INERT DUAL-CONTEXT OPT-IN IS DISCLOSED, NOT REFUSED (P5; decision
// host-native-init-with-dev-machine-escape-hatch). On a win32 host the MCP mode keys on
// the RENDERING host and the node resolution keys on `process.platform === 'win32'`
// BEFORE it ever consults `dualContext` — so --dual-context / STERLING_DUAL_CONTEXT=1
// changes nothing there. The predicate is deliberately kept as-is: keying on the
// rendering host is what makes the launcher's flags and the win config's existence one
// mechanism that cannot disagree with itself. But a flag that is silently ignored is the
// defect (unknown signals halt; ignored ones at least speak), so the run says so out
// loud. NOT a refusal: refusing would block a legitimate host-native init merely because
// the operator passed a flag that does nothing, and the artifacts this run produced are
// correct for this host either way.
// REACHABLE FROM THE SUITE, deliberately: the second arm is the STERLING_NATIVE_MCP_MODE
// seam that forces the same host-native MCP arm — a win32-only predicate would be a
// permanently-skipped pin on the Linux host the suite runs on (research_finding
// 0c712d94, M6). Both arms describe the same fact: dual-context was asked for and the
// run resolved host-native MCP anyway.
if (dualContext && (process.platform === 'win32' || nativeMcpModeOverride === 'host-native')) {
  warns.push(
    `warn: --dual-context / STERLING_DUAL_CONTEXT=1 has NO effect on the MCP mode of this run — it resolved HOST-NATIVE MCP regardless ` +
      (process.platform === 'win32'
        ? '(win32 host: the MCP mode and the Windows node both key on the rendering host, which wins over the flag)'
        : "(STERLING_NATIVE_MCP_MODE='host-native' forced the arm)") +
      '. Why: the launcher flags and sterling-mcp-win.json are ONE mechanism keyed on the rendering host, so they can never disagree about which node native claude runs. ' +
      'Genuine cross-host dual-context FROM a Windows host would need a second interpreter path (e.g. a STERLING_WSL_NODE naming the Linux node) that init cannot invent — it is not built. ' +
      // "nothing was BLOCKED", not "nothing was refused": init reserves the word
      // REFUSED for its actual refusal paths (`init REFUSED: …`, exit 2), and this
      // sentence exists to say the opposite happened. Reusing the reserved word inside
      // a success message makes the report un-greppable for the condition it names.
      'Nothing was blocked and nothing is missing: the host-native artifacts reported above are the correct ones for this host.',
  );
}
// The mode and its default are LOUD in every report — a Windows-artifact decision the
// user never sees is exactly the silent degradation this ruling exists to end (P5).
// EXACTLY ONE MODE, NAMED UNAMBIGUOUSLY (decision host-native-init-with-dev-machine-
// escape-hatch): every run states one of the ruling's two mode names, and a single note
// naming BOTH tells a user nothing about which mode they are in — so the default arm
// spells its opt-in as the ENV form only (STERLING_DUAL_CONTEXT=1, complete and
// sufficient on its own); the `--dual-context` flag spelling stays in the per-artifact
// skip detail below, where it is attached to the artifact the user is missing.
notes.push(
  winNodeSource === 'host-native-elsewhere'
    ? `note: host-native init (default) on ${process.platform} — Windows launcher/MCP artifacts are NOT generated; set STERLING_DUAL_CONTEXT=1 to also emit them from this host (the skip lines below name the flag form too)`
    : winNodeSource === 'dual-context'
      ? `note: DUAL-CONTEXT mode (explicitly opted in) — Windows artifacts generated beside the ${process.platform} ones; Windows node resolved via \`where.exe node\`${winNode ? ` -> ${winNode}` : ' -> not found'}`
      : winNodeSource === 'host-native'
        ? `note: host-native init on win32 — Windows node is this interpreter (process.execPath -> ${winNode ?? 'MISSING'}), no PATH lookup`
        // The explicit override still owes the run a MODE name. Which one is already
        // settled by the resolution-order comment above: naming a Windows node path from
        // a non-Windows host IS an explicit dual-context declaration, while on win32 the
        // override just renames this host's own node. That is the same HOST predicate
        // that governs nativeMcpNeedsWinConfig, so the note and the artifacts it explains
        // can never disagree. The STERLING_WIN_NODE provenance is kept — it is what makes
        // an unexpected path (or the '' skip) diagnosable.
        : `note: ${process.platform === 'win32' ? 'host-native' : 'DUAL-CONTEXT'} mode (explicit STERLING_WIN_NODE override) — Windows node taken from STERLING_WIN_NODE${winNode ? ` -> ${winNode}` : " -> '' (Windows artifacts skipped)"}`,
);
// Skip detail for the two winNode-gated artifacts. A host-native skip is a MODE, not a
// failure — it must not read as "your PATH is broken"; an unresolved Windows node under
// an explicit override or the dual-context hatch still gets the actionable PATH advice.
const winSkipDetail = (what) =>
  winNodeSource === 'host-native-elsewhere'
    ? `host-native init (default) on ${process.platform}: ${what} is a Windows-only artifact and is not generated here — pass --dual-context (or STERLING_DUAL_CONTEXT=1) and re-run to also emit it`
    : `Windows node not resolved — ${what} not generated; add the node dir to the Windows PATH, or set STERLING_WIN_NODE to the absolute node.exe path, and re-run init`;
// STALE-ARTIFACT DISCLOSURE (decision host-native-init-with-dev-machine-escape-hatch).
// A skip line describes an artifact as ABSENT. After a MODE FLIP it may not be: flip a
// clone from dual-context back to host-native (drop the flag) and sterling-windows.bat
// and sterling-mcp-win.json both stay on disk, the launcher still passing --strict
// --mcp-config at a config init has stopped maintaining — while the report says "not
// generated". A file that exists must never be reported as one that does not (P5).
// DISCLOSURE ONLY, never deletion: init's ensure semantics reserve destruction for the
// refusal paths, and a leftover launcher may be exactly what a mixed host still wants.
const staleOrSkipped = (path, detail, why) =>
  existsSync(path)
    ? { status: 'stale', detail: `${detail}. STILL ON DISK, no longer maintained by init: ${basename(path)} was generated by an earlier run in a different mode and ${why}. Nothing was deleted — delete it by hand if you do not want it, or re-run with the other mode to bring it back under management` }
    : { status: 'skipped', detail };
const winTuiBundle = toWindowsPath(tuiBundle);
const winPluginDir = toWindowsPath(fwd(pluginRoot));
const winMcpServerEntry = toWindowsPath(fwd(mcpServerEntry)); // Windows path to dist/main.js for native-claude MCP
const splitRatio01 = String(eff.splitRatio); // wt split-pane --size wants a 0–1 float
// the .sh is bash — ALWAYS LF (a CRLF shebang/line breaks bash); the .bat files
// are ALWAYS CRLF (cmd.exe misparses LF-only batch files), regardless of eol config
const lf = (s) => s.replace(/\r\n/g, '\n');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// (1) the tmux launcher — the actual split lives here; both .bat files call it
const expectedTmuxLauncher = assertNoDeadTerms('sterling-launch.sh', lf(
  readFileSync(join(pluginRoot, 'templates', 'launcher-tmux.sh'), 'utf8')
    .replaceAll('{{SESSION}}', sessionName)
    .replaceAll('{{PLUGIN_DIR}}', fwd(pluginRoot))
    .replaceAll('{{TUI_BUNDLE}}', tuiBundle)
    .replaceAll('{{SPLIT_RATIO}}', String(splitPercent))
));
const tmuxLauncherPath = join(target, 'sterling-launch.sh');
if (!existsSync(tmuxLauncherPath)) {
  writeFileSync(tmuxLauncherPath, expectedTmuxLauncher);
  items.push({ item: 'sterling-launch.sh', status: 'created', detail: `tmux session ${sessionName}, ${splitPercent}% TUI pane` });
} else if (normalize(readFileSync(tmuxLauncherPath, 'utf8')) === normalize(expectedTmuxLauncher)) {
  items.push({ item: 'sterling-launch.sh', status: 'matches', detail: 'generated content unchanged' });
} else {
  items.push({ item: 'sterling-launch.sh', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
}

// (2) the double-click Windows entry: Windows Terminal -> WSL -> the tmux launcher
const expectedLauncher = assertNoDeadTerms('sterling.bat', crlf(
  readFileSync(join(pluginRoot, 'templates', 'launcher-win.bat'), 'utf8')
    .replaceAll('{{WIN_PROJECT_DIR}}', winProjectDir)
));
const launcherPath = join(target, 'sterling.bat');
if (!existsSync(launcherPath)) {
  writeFileSync(launcherPath, expectedLauncher);
  items.push({ item: 'sterling.bat', status: 'created', detail: `double-click -> wsl ${winProjectDir}` });
} else if (normalize(readFileSync(launcherPath, 'utf8')) === normalize(expectedLauncher)) {
  items.push({ item: 'sterling.bat', status: 'matches', detail: 'unchanged' });
} else {
  items.push({ item: 'sterling.bat', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
}

// (3) the §13 dashboard re-opener: re-adds the TUI pane to the running session
const expectedTuiLauncher = assertNoDeadTerms('tui.bat', crlf(
  readFileSync(join(pluginRoot, 'templates', 'tui-win.bat'), 'utf8')
    .replaceAll('{{WIN_PROJECT_DIR}}', winProjectDir)
));
const tuiLauncherPath = join(target, 'tui.bat');
if (!existsSync(tuiLauncherPath)) {
  writeFileSync(tuiLauncherPath, expectedTuiLauncher);
  items.push({ item: 'tui.bat', status: 'created', detail: 'double-click -> ./sterling-launch.sh tui' });
} else if (normalize(readFileSync(tuiLauncherPath, 'utf8')) === normalize(expectedTuiLauncher)) {
  items.push({ item: 'tui.bat', status: 'matches', detail: 'unchanged' });
} else {
  items.push({ item: 'tui.bat', status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' });
}

// (4) the FULLY-NATIVE Windows entry (decision: a SECOND launcher beside the WSL
// sterling.bat — partially reverses bb5e25cd): a wt split running native claude.exe
// (left) + the TUI on native Windows node (right), no WSL. Needs the Windows node
// path; when init can't resolve it (node not on the Windows PATH), the launcher is
// SKIPPED loudly (P5) without blocking the rest of init.
let expectedNativeLauncher;
const nativeLauncherPath = join(target, 'sterling-windows.bat');
if (winNode) {
  // MCP flags are MODE-DEPENDENT (see nativeMcpNeedsWinConfig above): host-native adds
  // NOTHING, so native claude loads sterling from the plugin and keeps every other MCP
  // server the user has; dual-context still elects the Windows-node config strictly,
  // because the plugin's own entry names this Linux interpreter.
  // The WSL domain-snapshot bridge that used to be rendered here is GONE in BOTH modes
  // (board 3873d33b): homedir()-derived domain roots make it a no-op for a Windows-only
  // user, and the ruling's "a Windows installation invokes WSL nowhere" is unconditional.
  // scripts/snapshot-domains-for-windows.mjs stays on disk as a hand-run legacy tool.
  const mcpArgs = nativeMcpNeedsWinConfig
    ? ` --mcp-config "${winPluginDir}\\.claude-plugin\\sterling-mcp-win.json" --strict-mcp-config`
    : '';
  const mcpModeNote = nativeMcpNeedsWinConfig
    ? `rem MODE: dual-context — generated from ${process.platform}, so the Windows-node MCP config is elected strictly (other MCP servers ARE suppressed here).`
    : 'rem MODE: host-native — sterling comes from --plugin-dir; no --strict, so other MCP servers (codex) still load.';
  // GENERATED MARKER (generated-marker.mjs, board bb3aa162) — applied here for the
  // same reason it was applied to sterling-update.bat, and load-bearing for decision
  // host-native-init-with-dev-machine-escape-hatch specifically: without a marker this
  // launcher's bare content compare reports `differs — left untouched` on EVERY machine
  // that ever ran init, so the OLD `--strict --mcp-config` + wsl.exe-bridge launcher
  // survives the upgrade and codex stays suppressed for exactly the Windows-only users
  // this ruling exists to serve. Marker semantics are unchanged: an unmodified-since-
  // generation body re-bakes freely, a hand-edited (or unmarked legacy) one is still
  // refused. `rem` is this file's comment syntax; the marker lands on line 2, after
  // `@echo off`, which must stay line 1.
  expectedNativeLauncher = assertNoDeadTerms('sterling-windows.bat', crlf(stampBody(
    readFileSync(join(pluginRoot, 'templates', 'launcher-win-native.bat'), 'utf8')
      .replaceAll('{{WIN_PLUGIN_DIR}}', winPluginDir)
      .replaceAll('{{WIN_NODE}}', winNode)
      .replaceAll('{{WIN_TUI_BUNDLE}}', winTuiBundle)
      .replaceAll('{{SPLIT_RATIO}}', splitRatio01)
      .replaceAll('{{MCP_ARGS}}', mcpArgs)
      .replaceAll('{{MCP_MODE_NOTE}}', mcpModeNote),
    'rem',
  )));
  if (!existsSync(nativeLauncherPath)) {
    writeFileSync(nativeLauncherPath, expectedNativeLauncher);
    items.push({
      item: 'sterling-windows.bat',
      status: 'created',
      detail: `native claude.exe + Windows-node TUI, ${splitRatio01} split; MCP ${nativeMcpNeedsWinConfig ? 'via the strict Windows config (dual-context — other MCP servers suppressed)' : 'via --plugin-dir (host-native — other MCP servers preserved)'}`,
    });
  } else if (normalize(readFileSync(nativeLauncherPath, 'utf8')) === normalize(expectedNativeLauncher)) {
    items.push({ item: 'sterling-windows.bat', status: 'matches', detail: 'unchanged' });
  } else {
    const nativeStamp = verifyStamp(normalize(readFileSync(nativeLauncherPath, 'utf8')), 'rem');
    if (nativeStamp && nativeStamp.unmodified) {
      writeFileSync(nativeLauncherPath, expectedNativeLauncher);
      items.push({
        item: 'sterling-windows.bat',
        status: 'refreshed',
        detail: `regenerated: unmodified since last generation, but this machine now renders it differently (mode/clone/template change) — MCP ${nativeMcpNeedsWinConfig ? 'via the strict Windows config (dual-context — other MCP servers suppressed)' : 'via --plugin-dir (host-native — other MCP servers preserved)'}`,
      });
    } else if (nativeStamp) {
      // A marker IS present and its hash no longer matches the body: something touched
      // the file after generation. Never re-baked — that is the never-clobber floor.
      items.push({ item: 'sterling-windows.bat', status: 'differs', detail: 'left untouched — it carries a sterling-generated stamp but its body no longer matches it, so it was edited after generation; delete and re-run init to regenerate' });
    } else {
      // NO MARKER AT ALL. verifyStamp returns null here, which distinguishes this from
      // the edited-after-generation case above — but NOT pre-stamp legacy from a
      // hand-authored file, since neither carries a stamp, so the wording accuses
      // nobody of an edit they may not have made. The verdict stays `differs` and
      // nothing is deleted or rewritten: an unmarked file is indistinguishable from a
      // hand-edited one, and re-baking it would clobber real user edits.
      // WHY THIS MESSAGE EXISTS (final-review addition to decision
      // host-native-init-with-dev-machine-escape-hatch): every launcher on a machine
      // initialized BEFORE the stamp is unmarked, so this branch is exactly where the
      // users this ruling exists to serve land — and a generic "delete to regenerate"
      // never tells them why they should want to.
      items.push({
        item: 'sterling-windows.bat',
        status: 'differs',
        detail:
          'left untouched — UNMARKED (no sterling-generated stamp), so init cannot prove it generated this file: either it PREDATES the host-native change (any init before the stamp) or it was hand-authored. ' +
          'If it predates the change it is still the OLD launcher: it passes --strict-mcp-config, which suppresses every other MCP server in the native session (codex, your default independent reviewer, included), and it still calls the WSL snapshot bridge — the two things the host-native launcher removes. ' +
          'Nothing here is deleted. If you have not hand-edited it, delete sterling-windows.bat and re-run init to get the host-native launcher; if you HAVE, port your edits onto a freshly generated one',
      });
    }
  }
} else {
  items.push({ item: 'sterling-windows.bat', ...staleOrSkipped(nativeLauncherPath, winSkipDetail('the native launcher'), 'it still launches native claude with whatever MCP flags were baked when it was written — in host-native mode that can mean --strict --mcp-config pointing at a config init no longer maintains') });
}

// (5) the double-click updater entry: brings the machine's Sterling CLONE to
// origin's default branch with NO Claude session in the loop (the updater is
// deterministic; a session interpreting its refusals is what kept going wrong).
// Ensure logic shared with /sterling:update's project fan-out, which delivers
// this launcher to projects whose init predates it.
items.push({ item: UPDATE_LAUNCHER_NAME, ...ensureUpdateLauncher(target, pluginRoot) });

// (6) the consumer-runnable checks entry (board 4ccf0644): check-record-citations
// + check-stale-claims were registered only in the CLONE's own `npm run check` —
// nothing shipped a way to run them against a CONSUMING project's own tree/store,
// which is exactly where the incidents they exist to catch happened. Ensure logic
// shared with /sterling:update's project fan-out (scripts/lib/consumer-checks.mjs),
// same delivery precedent as the updater launcher above.
items.push({ item: CONSUMER_CHECK_LAUNCHER_NAME, ...ensureConsumerCheckLauncher(target, pluginRoot) });

// agent installation (§2.2) via the §13 sync semantics: installed | refreshed |
// up_to_date | locally-modified left | refuse-on-local-modification
// GIT_RO is the plugin-owned read-only git wrapper, baked as an absolute
// forward-slash path exactly like HOOKS_DIR: H14 grants ONLY that exact file
// identity, so a template must name it absolutely (decision
// `git-ro-wrapper-fixed-recipes-no-caller-flags`).
const vars = {
  NODE: `"${fwd(process.execPath)}"`,
  HOOKS_DIR: fwd(join(pluginRoot, 'hooks')),
  GIT_RO: fwd(join(pluginRoot, 'scripts', 'git-ro.mjs')),
};
const { report: agentReport } = syncAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(target, '.claude', 'agents'),
  pluginVersion: JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version,
  now: new Date().toISOString(),
  vars,
  // config.models is authoritative (98064d77): the config init just wrote/read
  // resolves {{MODEL}}/{{EFFORT}} per agent. `recorded` on a re-run, else the
  // freshly written `expectedConfig` — both are parsed SterlingConfig with .models.
  config: recorded ?? expectedConfig,
});
const agentInstructions = [];
for (const a of agentReport) {
  const map = {
    installed: { status: 'created', detail: 'installed with version/hash header' },
    refreshed: { status: 'refreshed', detail: 'clean install, newer template — regenerated' },
    up_to_date: { status: 'matches', detail: 'template hash + content hash match' },
    locally_modified_up_to_date: { status: 'differs', detail: 'locally modified, template unchanged — left untouched' },
    refused_local_modification: { status: 'refused', detail: 'locally modified AND template changed — overwrite refused (see /sterling:sync-agents guidance below)' },
    foreign_file: { status: 'refused', detail: 'not Sterling-generated — never overwritten (see guidance below)' },
  }[a.status];
  items.push({ item: `.claude/agents/${a.name}.md`, status: map.status, detail: map.detail });
  if (a.instruction) agentInstructions.push(a.instruction);
}
const restartNeeded = agentReport.some((a) => a.status === 'installed' || a.status === 'refreshed');

// MCP packaging (decision 097851ed, refined): the Sterling MCP server is declared
// ONCE as the PLUGIN's server — but NOT via a root .mcp.json. A root .mcp.json is
// BOTH auto-discovered by the plugin AND read as Sterling-self's project-scope config
// (the dual-role), and bare ${CLAUDE_PROJECT_DIR} does not substitute in project scope
// → a second, empty-store server. Instead the plugin manifest (.claude-plugin/plugin.json
// mcpServers) references .claude-plugin/sterling-mcp.json, read ONLY through the manifest
// and never as a project config — so the dual-role cannot exist. The store stays
// ${CLAUDE_PROJECT_DIR}/.sterling/sterling.db, substituted at server spawn to EACH
// consuming project's own store. command + server entry are absolute (machine-detected)
// → that file is gitignored + regenerable; the manifest reference is portable + committed.
// A consuming project still gets NO .mcp.json (the plugin carries the declaration).
const mcpPath = join(target, '.mcp.json');
// WHERE THE PLUGIN-LOCAL ARTIFACTS LIVE vs WHAT THIS RUN'S --target IS: two different
// questions since board 2a6b45c2. `initIsPluginRepo` still answers "is --target the
// clone itself" (it governs the clone's OWN project-shaped artifacts: the root
// .mcp.json cleanup and the plugin-repo-only .gitignore entries). `pluginArtifactRoot`
// answers "which directory holds .claude-plugin/" — always the clone, whatever
// --target says. It resolves through pluginRootMatch, not pluginRoot, because that env
// seam's purpose is exactly this: point the plugin-local ensure at a disposable
// directory so a test never writes into the live clone (see its comment at the top).
const initIsPluginRepo = fwd(target) === fwd(pluginRootMatch);
const pluginArtifactRoot = pluginRootMatch;
const pluginMcpConfigPath = join(pluginArtifactRoot, '.claude-plugin', 'sterling-mcp.json');
const pluginMcpEntry = {
  command: process.execPath,
  args: [fwd(mcpServerEntry), '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db'],
};
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
// THE CLONE'S PLUGIN MCP CONFIG — ENSURED ON EVERY RUN, WHATEVER --target SAYS
// (board 2a6b45c2). It used to be generated ONLY when --target was the clone itself,
// while /sterling:init is documented (commands/init.md) to run with the CONSUMING
// project as --target — so a fresh clone carried a TRACKED plugin.json whose
// `mcpServers` pointed at a GITIGNORED file nothing ever created, on both platforms,
// and the updater's re-bake could only repair a clone that was already repaired.
// The file is PER-CLONE MACHINE TRUTH, not per-project: it names THIS clone's
// packages/mcp-server/dist/main.js and THIS machine's interpreter, and
// ${CLAUDE_PROJECT_DIR} already binds the store per-project at server spawn. So its
// home is the clone and its write moment is every init.
// SIDE EFFECT, DISCLOSED, NEVER SILENT (the note pushed after this block): an init run
// from a consuming project writes into the plugin directory. That is a real reach
// outside --target; it is machine-local, gitignored and regenerable, and the ensure
// semantics are exactly as before — created / matches / refreshed / differs, never
// clobbering content init cannot prove it generated.
//
// WHO OWNS THE CODEX KEY (sparring-partner auto-wire, decision
// sparring-partner-partnership-shape). The probe — official codex mcp-server, binary on
// PATH + `codex login status` exit 0 — is machine truth, so its result belongs in this
// gitignored file and never in committed config. But a CONSUMING-project init has no
// business rewriting that key: it would spawn `codex login status` on every unrelated
// init, making an ordinary project's init depend on this machine's Codex login state,
// and never-clobber gives it no evidence to change a key it did not just verify. So a
// consuming run ensures the STERLING entry and INHERITS whatever codex entry is on disk.
// TWO EXCEPTIONS, and they are the point of this whole section: when the file does not
// exist yet, THIS run is the bootstrap — nothing else generates it any more — and when
// the file exists but carries NO codex key, so there is nothing to re-confirm and the
// entry is still owed (see the third-arm comment at the gate below). In both the probe
// runs and codex is wired exactly as an init against the clone would wire it. On probe failure
// (binary absent, not logged in, timeout) a loud skip line and nothing wired, never
// blocking the rest of init (P5 degraded-loud). The native-Windows sterling-mcp-win.json
// is untouched by THIS probe — it has its own Windows-node probe (probeCodexWin /
// STERLING_CODEX_PROBE_WIN) in the plugin-repo branch further down.
// STERLING_CODEX_PROBE: test-isolation seam mirroring STERLING_WIN_NODE — honored
// at THIS call site (not inside probeCodex), same precedent as `winNode` above.
// unset/'' -> real probe; 'ok' -> force success; 'absent' -> force binary-absent;
// 'not-logged-in' -> force not-logged-in. Any other value fails loud (unknown
// signals halt, P5) rather than silently falling back to a real probe — and it is
// validated EAGERLY, even on a run that will not probe, so an unknown signal still halts.
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
const pluginMcpExists = existsSync(pluginMcpConfigPath);
let existingPluginMcp;
if (pluginMcpExists) {
  try { existingPluginMcp = JSON.parse(readFileSync(pluginMcpConfigPath, 'utf8')); } catch { existingPluginMcp = undefined; }
}
const existingPluginMcpServers =
  existingPluginMcp && typeof existingPluginMcp === 'object' && existingPluginMcp.mcpServers && typeof existingPluginMcp.mcpServers === 'object'
    ? existingPluginMcp.mcpServers
    : undefined;
const inheritedCodex = existingPluginMcpServers ? existingPluginMcpServers.codex : undefined;
// THE THIRD ARM — A FILE THAT EXISTS BUT CARRIES NO CODEX KEY IS STILL THIS RUN'S
// CONCERN (final-review defect 1 on decision host-native-init-with-dev-machine-escape-hatch).
// The two-arm gate (`clone target || file absent`) made the codex entry a ONE-SHOT
// BOOTSTRAP: on a consumer machine --target is never the clone, so the first consuming
// init that ran while codex was missing or logged out wrote a sterling-only file, and
// every later init saw the file present, skipped the probe, inherited the absence and
// reported `matches`. The recovery path the skip line itself prescribes — install codex,
// `codex login`, re-run init — was DEAD, because `codexProbe` stayed undefined and the
// managed codex ADD below is gated on `codexProbe?.ok`. The default independent reviewer
// (decision codex-preferred-for-read-shaped-analysis) stayed permanently unwired with
// nothing disclosing it. So: re-probe on every run where the key is ABSENT, which makes
// the managed add reachable from a consuming init and lets a user who followed the
// warning get wired on their very next init.
// THE GATE'S ORIGINAL REASON STILL HOLDS AND IS WHY THIS IS NOT "always": an unrelated
// consuming init must not spawn `codex login status` merely to re-confirm a codex entry
// that is already on disk. Key PRESENT -> no probe, inherit, exactly as before. Only the
// absent-key case, which is monotone (it stops probing the moment it succeeds) and is
// readable off disk with no spawn, is added. A file that does not PARSE also has no
// readable codex key and therefore probes: it is a broken state that reports `differs`
// either way, and the probe result is what makes the eventual delete-and-re-run wire codex.
const existingHasCodexKey = existingPluginMcpServers ? 'codex' in existingPluginMcpServers : false;
const codexIsThisRunsConcern = initIsPluginRepo || !pluginMcpExists || !existingHasCodexKey;
// WHICH PROBE: the one whose SIDE will actually spawn this entry. On win32 THIS file is
// what native claude reads (host-native mode generates no sterling-mcp-win.json), and a
// bare spawnSync('codex') there resolves npm's codex.cmd — which node cannot spawn
// shell-lessly — against a PATH measured unreliable on the native host
// (research_finding native-windows-platform-measurements-2026-08-27). probeCodexWin
// resolves through `where.exe codex` and returns the absolute command it actually
// spawned, so the written entry is the thing the probe proved (board 4c3a8e59).
// The predicate is the HOST, not the MCP mode: it answers which binary will be spawned,
// not which config file the launcher elects.
const codexProbe = !codexIsThisRunsConcern
  ? undefined
  : (forcedCodexProbe ?? (process.platform === 'win32' ? probeCodexWin() : probeCodex()));
if (codexProbe && !codexProbe.ok) warns.push(codexSkipLine(codexProbe.reason));
const desired = {
  mcpServers: codexProbe
    ? withCodexEntry({ sterling: pluginMcpEntry }, codexProbe)
    : { sterling: pluginMcpEntry, ...(inheritedCodex !== undefined ? { codex: inheritedCodex } : {}) },
};
// GUARDED WRITE — THIS PATH REACHES OUTSIDE --target (final-review defect 2 on decision
// host-native-init-with-dev-machine-escape-hatch). Before board 2a6b45c2 a consuming init
// never touched the clone at all; now every consuming init ensures a file in it. A clone
// on a read-only mount, or owned by another user, would therefore turn an UNRELATED
// project's init into an uncaught EACCES abort — a failure with nothing to do with the
// project being initialized. So the write degrades LOUDLY instead of throwing: the item
// reports `differs` (nothing of ours is on disk / nothing was changed) and a warning names
// the clone path and the errno. P5 — loud, never silent, and never fatal to work that
// would otherwise succeed. Returns the error (falsy on success) so each call site can say
// what it failed to do.
const writePluginMcpConfig = () => {
  try {
    mkdirSync(dirname(pluginMcpConfigPath), { recursive: true });
    writeFileSync(pluginMcpConfigPath, JSON.stringify(desired, null, 2));
    return undefined;
  } catch (err) {
    warns.push(
      `warn: could NOT write the plugin MCP config at ${fwd(pluginMcpConfigPath)} (${err?.code ?? err?.message ?? String(err)}) — nothing was changed there and the rest of this init completed. ` +
        (initIsPluginRepo
          ? ''
          : 'That path is the Sterling CLONE, OUTSIDE this --target: this project is initialized correctly regardless. ') +
        'A read-only mount or a clone owned by another user is the usual cause. Until it is writable, Sterling MCP (and codex, if a probe wired one) comes from whatever that file already says — fix the permissions and re-run init to bring it back under management.',
    );
    return err;
  }
};
if (!pluginMcpExists) {
  const writeErr = writePluginMcpConfig();
  items.push(
    writeErr
      ? {
          item: '.claude-plugin/sterling-mcp.json',
          status: 'differs',
          detail: `NOT generated — the write into the Sterling clone failed (${writeErr?.code ?? 'write error'}); no file was created and nothing was changed (see the warning naming the path)`,
        }
      : {
          item: '.claude-plugin/sterling-mcp.json',
          status: 'created',
          detail: `plugin MCP config (referenced by plugin.json mcpServers) — binds each project to its own store via \${CLAUDE_PROJECT_DIR}${codexProbe?.ok ? '; codex mcp-server wired (probe succeeded)' : ''}`,
        },
  );
} else {
  const existing = existingPluginMcp;
  if (existing && canonical(existing) === canonical(desired)) {
    items.push({ item: '.claude-plugin/sterling-mcp.json', status: 'matches', detail: 'plugin MCP config as generated' });
  } else {
    // Managed refresh (mirrors sterling-init's universal-stack-tag re-init add):
    // an EXISTING config whose sterling entry — and every OTHER key — already
    // matches what init would generate, missing ONLY the codex entry this probe
    // just proved wire-eligible, is a pure ADDITIVE delta. Never-overwrite guards
    // against clobbering content init cannot prove it generated, not against
    // adding a key init just verified is its own. Any OTHER difference (a
    // hand-edited sterling entry, unknown keys, a missing sterling entry) still
    // reports 'differs — left untouched'.
    const desiredMinusCodex = {
      mcpServers: Object.fromEntries(Object.entries(desired.mcpServers).filter(([k]) => k !== 'codex')),
    };
    // STALE-COMMAND REFRESH (decision host-native-init-with-dev-machine-escape-hatch).
    // The second managed-delta case, and the one the ruling made load-bearing: an
    // entry whose args[0] is OUR generated server entry but whose `command` is a
    // DIFFERENT interpreter is still provably ours — nobody else writes a config
    // naming this clone's dist/main.js — it is just pointing at a node that moved
    // (an nvm-windows upgrade, a runtime relocation). Before this ruling that was
    // harmless: sterling-windows.bat elected its own sterling-mcp-win.json strictly,
    // so a rotten plugin command never reached native claude. In HOST-NATIVE mode
    // there is no second config and no --strict — this file is the ONLY thing that
    // gives native claude the Sterling MCP server, and `differs — left untouched`
    // would strand a Windows user with a deleted node.exe and NO repair path short
    // of deleting the file by hand.
    // THE BOUNDARY IS args[0], NOT command: a hand-written entry pointing at some
    // OTHER server is not ours and is still left alone. Only the command is rebased;
    // every other key must already equal what init would generate.
    const existingSterling = existing && typeof existing === 'object' && existing.mcpServers && existing.mcpServers.sterling;
    const isOurServerEntryPath =
      existingSterling &&
      typeof existingSterling === 'object' &&
      Array.isArray(existingSterling.args) &&
      existingSterling.args[0] === fwd(mcpServerEntry);
    const staleCommand = isOurServerEntryPath && existingSterling.command !== process.execPath ? existingSterling.command : undefined;
    const rebased =
      staleCommand === undefined
        ? existing
        : { ...existing, mcpServers: { ...existing.mcpServers, sterling: { ...existingSterling, command: process.execPath } } };
    // `codexProbe?.ok` — a consuming run does not probe, so it can never perform the
    // codex ADD (it inherits the key instead, see the section comment). The COMMAND
    // refresh below is probe-independent and stays available to every run: it is what
    // repairs a clone whose node moved, and after board 2a6b45c2 a consuming init is
    // the only run that reliably happens on a consumer machine.
    const isManagedCodexAdd =
      codexProbe?.ok &&
      existing &&
      typeof existing === 'object' &&
      existing.mcpServers &&
      !('codex' in existing.mcpServers) &&
      canonical(rebased) === canonical(desiredMinusCodex);
    const isManagedCommandRefresh = staleCommand !== undefined && canonical(rebased) === canonical(desired);
    if (isManagedCodexAdd || isManagedCommandRefresh) {
      const reasons = [
        ...(staleCommand !== undefined ? [`repointed the sterling command at this interpreter (was '${staleCommand}' — a moved or upgraded node; args[0] still names this clone's server entry, so the entry is ours)`] : []),
        ...(isManagedCodexAdd ? ['added generated codex entry (probe succeeded)'] : []),
      ];
      // Same guarded write as the create path above — the managed refresh reaches into
      // the clone from a consuming init too, so an unwritable clone degrades loudly here
      // rather than aborting an otherwise-successful init (P5).
      const writeErr = writePluginMcpConfig();
      items.push(
        writeErr
          ? {
              item: '.claude-plugin/sterling-mcp.json',
              status: 'differs',
              detail: `refresh NOT applied — the write into the Sterling clone failed (${writeErr?.code ?? 'write error'}); the file is unchanged (would have ${reasons.join('; ')})`,
            }
          : {
              item: '.claude-plugin/sterling-mcp.json',
              status: 'refreshed',
              detail: `refreshed — ${reasons.join('; ')}; all other keys unchanged`,
            },
      );
    } else {
      items.push({ item: '.claude-plugin/sterling-mcp.json', status: 'differs', detail: 'differs from generated — left untouched (delete to regenerate)' });
      // HOST-NATIVE HAS NO FALLBACK, so an untouched `differs` here is not cosmetic:
      // sterling-windows.bat passes no --mcp-config in that mode, so whatever this
      // file says IS native claude's Sterling MCP server. Never let the report leave
      // that connection for the reader to make (P5).
      // GATED ON THE STERLING ENTRY, NOT THE FILE'S VERDICT (final-review defect 3).
      // The file's overall `differs` has more than one cause. A codex-only delta — the
      // probe dropped the key on a win32 clone-init, or an inherited entry is not what
      // this run would generate — leaves the STERLING entry perfectly correct, and
      // warning then that native claude "may get no Sterling MCP" is simply false. The
      // warning's whole subject is the Sterling entry, so that is what must mismatch.
      const sterlingEntryMatches = existingSterling !== undefined && canonical(existingSterling) === canonical(pluginMcpEntry);
      if (!nativeMcpNeedsWinConfig && !sterlingEntryMatches) {
        warns.push(
          'warn: host-native MCP mode, and .claude-plugin/sterling-mcp.json reports `differs` — it was left untouched, and in this mode it is the ONLY source of the Sterling MCP server for native claude (sterling-windows.bat passes no --mcp-config, and no sterling-mcp-win.json is generated). ' +
            'If its sterling entry names a node or a server entry that no longer exists, native claude will start with NO Sterling MCP and nothing else will report it. Inspect the file; delete it and re-run init to regenerate.',
        );
      }
    }
  }
}
// THE SIDE-EFFECT DISCLOSURE (board 2a6b45c2). A run whose --target is a consuming
// project just ensured a file in ANOTHER directory — the Sterling clone. Machine-local,
// gitignored and regenerable, but a reach outside --target is never something the reader
// should have to infer from an item name (P5). Named unconditionally on such runs, not
// only when something was written: "matches" is also information about the clone.
if (!initIsPluginRepo) {
  notes.push(
    `note: .claude-plugin/sterling-mcp.json is PER-CLONE machine truth, so this run ensured it in the Sterling clone at ${fwd(pluginArtifactRoot)} — a write OUTSIDE this --target (gitignored, machine-local, regenerable; its status line above says what this run actually did to it). This is what gives a freshly cloned Sterling a working MCP server without a separate bootstrap step.`,
  );
}

if (initIsPluginRepo) {
  // ALSO — IN DUAL-CONTEXT MODE ONLY — the native-claude Windows MCP config (option B,
  // decision a756e5d9 / native-claude-mcp-via-strict-win-config): sterling-windows.bat
  // launches claude.exe with `--mcp-config <this> --strict-mcp-config` so NATIVE claude
  // runs the MCP server on the WINDOWS node, because the plugin's sterling-mcp.json names
  // THIS (non-Windows) interpreter and cannot run under native claude (-32000). Generated
  // only here (the plugin repo), referenced by every project's launcher.
  // On a win32 host it is NOT generated at all (decision
  // host-native-init-with-dev-machine-escape-hatch): the plugin entry is already the
  // Windows node, so a second file would be the duplicate sterling entry the ruling
  // removes — dead weight nothing reads, whose only historical purpose was to be elected
  // by the --strict flag the launcher no longer passes there. Skipped loudly (P5) in that
  // mode and when no Windows node resolved — the two skips read differently on purpose.
  // STORE ARG EXPANSION differs by scope (verified 2026-07-12, code.claude.com/docs/en/mcp):
  // a --mcp-config file gets project-scope ${VAR} env expansion — CLAUDE_PROJECT_DIR is set
  // in the SERVER's env, not the parse-time shell, so the bare form passes through literally
  // and the server mkdirs a literal '${CLAUDE_PROJECT_DIR}/' store at its cwd (the phantom
  // store, 2026-06-24). The documented idiom is the ${CLAUDE_PROJECT_DIR:-.} default: '.'
  // resolves against the server's cwd = the project dir. The PLUGIN config (above) keeps the
  // bare form — plugin-scope configs substitute it unconditionally, no default needed.
  // Sparring-partner auto-wire for NATIVE Windows claude (board 43051819 slice B,
  // decision sparring-partner-partnership-shape) — this config's codex story needed
  // its own Windows-node probe (native `codex.exe`/login state differ from the WSL
  // probe above the plugin config uses) because a bare spawnSync('codex') here would
  // resolve under WSL's own PATH, not the Windows one native claude actually runs in.
  // probeCodexWin (scripts/lib/codex-mcp.mjs) resolves via `where.exe codex` instead.
  // On failure, report a loud skip line — never silently omitted, and distinguishable
  // from the feature being off in config (P5 degraded-loud). Reuses the SAME
  // CODEX_MCP_ENTRY (via withCodexEntry) as the WSL branch — the entry itself is
  // identical; only the PROBE differs.
  // DELIBERATELY STILL CLONE-INIT-SCOPED, unlike sterling-mcp.json above (board
  // 2a6b45c2). This file is a DUAL-CONTEXT-ONLY artifact under decision
  // host-native-init-with-dev-machine-escape-hatch: a Windows-only consumer runs
  // HOST-NATIVE, where the launcher passes no --mcp-config and this file is not
  // generated at all, and a Linux-only consumer has no native-Windows launch path —
  // so neither consumer shape can be stranded by its absence. The one shape that
  // needs it is the dual-context authoring machine, which is by definition the
  // machine whose --target IS the clone. If a dual-context consumer ever becomes
  // real, this arm moves out beside the plugin config (see the report note there).
  const winMcpConfigPath = join(pluginArtifactRoot, '.claude-plugin', 'sterling-mcp-win.json');
  if (!nativeMcpNeedsWinConfig) {
    items.push({
      item: '.claude-plugin/sterling-mcp-win.json',
      ...staleOrSkipped(
        winMcpConfigPath,
        'not generated in host-native MCP mode: .claude-plugin/sterling-mcp.json already names the node native claude runs (process.execPath on a Windows host), so sterling-windows.bat inherits it via --plugin-dir — one host-appropriate entry, no --strict, and the user\'s other MCP servers (codex, the default independent reviewer) keep loading',
        'nothing on the host-native launch path reads it any more, so its sterling entry (and any codex entry beside it) will silently rot as node paths move',
      ),
    });
  } else if (winNode) {
    // STERLING_CODEX_PROBE_WIN: test-isolation seam mirroring STERLING_CODEX_PROBE
    // above (same enum), scoped to this native-Windows probe. unset/'' -> real
    // probeCodexWin(); 'ok'/'absent'/'not-logged-in' force the outcome; any other
    // value fails init loud (unknown signals halt, P5).
    // A forced 'ok' carries STERLING_CODEX_WIN_PATH as the resolved command when that
    // seam names one, mirroring what a real probeCodexWin success now returns (board
    // 4c3a8e59: the written entry is the exact command the probe succeeded with). With
    // no path seam set, 'ok' still yields the bare CODEX_MCP_ENTRY spelling.
    const codexProbeWinOverride = process.env.STERLING_CODEX_PROBE_WIN;
    const codexProbeWin = !codexProbeWinOverride
      ? probeCodexWin()
      : codexProbeWinOverride === 'ok'
        ? { ok: true, command: process.env.STERLING_CODEX_WIN_PATH || undefined }
        : codexProbeWinOverride === 'absent'
          ? { ok: false, reason: 'binary-absent' }
          : codexProbeWinOverride === 'not-logged-in'
            ? { ok: false, reason: 'not-logged-in' }
            : fail(`STERLING_CODEX_PROBE_WIN must be 'ok', 'absent', or 'not-logged-in' (got '${codexProbeWinOverride}')`, 2);
    if (!codexProbeWin.ok) warns.push(codexSkipLine(codexProbeWin.reason));
    const desiredWin = {
      mcpServers: withCodexEntry(
        { sterling: { command: winNode, args: [winMcpServerEntry, '--store', '${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db'] } },
        codexProbeWin,
      ),
    };
    if (!existsSync(winMcpConfigPath)) {
      mkdirSync(dirname(winMcpConfigPath), { recursive: true });
      writeFileSync(winMcpConfigPath, JSON.stringify(desiredWin, null, 2));
      items.push({
        item: '.claude-plugin/sterling-mcp-win.json',
        status: 'created',
        detail: `native-claude MCP config (Windows node) — referenced by sterling-windows.bat --mcp-config${codexProbeWin.ok ? '; codex mcp-server wired (probe succeeded)' : ''}`,
      });
    } else {
      let existingWin;
      try { existingWin = JSON.parse(readFileSync(winMcpConfigPath, 'utf8')); } catch { existingWin = undefined; }
      if (existingWin && canonical(existingWin) === canonical(desiredWin)) {
        items.push({ item: '.claude-plugin/sterling-mcp-win.json', status: 'matches', detail: 'native-claude MCP config as generated' });
      } else {
        // Managed refresh — the EXACT mirror of the WSL branch above (review D1's
        // upgrade path), and load-bearing for THIS arm rather than a nicety: every
        // clone that ever ran init already carries a sterling-only
        // sterling-mcp-win.json (this repo's own copy does), so without the refresh
        // the codex entry could never arrive once a native-Windows codex install
        // makes probeCodexWin succeed — the compare would report 'differs — left
        // untouched' forever and the only route would be deleting the file by hand.
        // Additive-only and provably ours: the sterling entry and every OTHER key
        // must already equal what init would generate, and ONLY the codex key may be
        // missing. Any other difference still reports 'differs — left untouched'.
        const desiredWinMinusCodex = {
          mcpServers: Object.fromEntries(Object.entries(desiredWin.mcpServers).filter(([k]) => k !== 'codex')),
        };
        const isManagedCodexAddWin =
          codexProbeWin.ok &&
          existingWin &&
          typeof existingWin === 'object' &&
          existingWin.mcpServers &&
          !('codex' in existingWin.mcpServers) &&
          canonical(existingWin) === canonical(desiredWinMinusCodex);
        if (isManagedCodexAddWin) {
          writeFileSync(winMcpConfigPath, JSON.stringify(desiredWin, null, 2));
          items.push({
            item: '.claude-plugin/sterling-mcp-win.json',
            status: 'refreshed',
            detail: 'refreshed — added generated codex entry (native-Windows probe succeeded; sterling entry and all other keys unchanged)',
          });
        } else {
          items.push({ item: '.claude-plugin/sterling-mcp-win.json', status: 'differs', detail: 'differs from generated — left untouched (delete to regenerate)' });
        }
      }
    }
  } else {
    items.push({
      item: '.claude-plugin/sterling-mcp-win.json',
      ...staleOrSkipped(
        winMcpConfigPath,
        winSkipDetail('the native-claude MCP config'),
        'no Windows node resolved this run, so init could not verify or refresh the sterling entry it names',
      ),
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
    items.push({ item: '.mcp.json', status: 'matches', detail: 'not written — the plugin declares sterling, bound to this project via ${CLAUDE_PROJECT_DIR}' });
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
items.push({ item: 'hooks (§6 set)', status: 'matches', detail: 'active via the plugin (hooks/hooks.json) — not duplicated into the project' });

// gitignore entries (§2.3/§11/§12): per-entry ensure — appending is non-destructive
const gitignorePath = join(target, '.gitignore');
const existingIgnore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
const entries = ['.sterling/', 'sterling.bat', 'sterling-windows.bat', 'tui.bat', 'sterling-launch.sh', UPDATE_LAUNCHER_NAME, CONSUMER_CHECK_LAUNCHER_NAME, '.claude/agents/'];
// the SOURCE/plugin repo's generated MCP config is machine-specific → gitignore it
// (consuming projects never get one — the plugin carries its own declaration).
// (still keyed on --target: this ensures the TARGET's .gitignore, and a consuming
// project must not gain ignore entries for a directory it does not contain. The
// clone's own .gitignore already carries both, committed.)
if (initIsPluginRepo) entries.push('.claude-plugin/sterling-mcp.json', '.claude-plugin/sterling-mcp-win.json');
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

// shared project registry (decision 8f9e6db2): note this project in the
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

if (restartNeeded) {
  console.log('\n' + RESTART_INSTRUCTION);
} else {
  console.log('\nno agent changes — no restart required');
}
