// §12 ensure-manifest semantics: per-item verify → create absent → skip
// matching → leave-and-report hand-edited; refusal only for destructive
// actions; every manifest artifact individually regenerable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProjectRegistry, SterlingStore } from '@sterling/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// fake Windows node path so the native launcher (sterling-windows.bat) generates
// deterministically without a real Windows node on PATH (mirrors STERLING_REGISTRY_DB).
const WIN_NODE_FAKE = 'C:\\TestNode\\node-v24-win-x64\\node.exe';

function init(dir, args = [], extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    // isolate the machine-global project registry to this test's temp dir, so
    // init's registration never pollutes the real ~/.sterling/registry.db; pin
    // STERLING_WIN_NODE so the native launcher generates without a real Windows node.
    env: { ...process.env, STERLING_REGISTRY_DB: join(dir, 'registry.db'), STERLING_WIN_NODE: WIN_NODE_FAKE, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const FRESH_FLAGS = ['--project-name', 'ensure-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'];
// .mcp.json is NOT a per-project artifact: the plugin declares the sterling
// server (bound per-project via ${CLAUDE_PROJECT_DIR}), so a consuming project
// never gets one. Its absence is asserted directly below.
const ARTIFACTS = ['.sterling/config.json', 'CLAUDE.md', 'sterling.bat', 'sterling-windows.bat', 'tui.bat', 'sterling-launch.sh', 'sterling-update.bat', '.gitignore'];
const snapshot = (dir) => Object.fromEntries(ARTIFACTS.map((a) => [a, readFileSync(join(dir, a), 'utf8')]));

test('init records a Windows-drive --backup-path in WSL /mnt form (r-dd88 backup_path bug)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-bkp-'));
  try {
    // A Windows-form backup path is how pre-WSL-migration configs were recorded.
    // Under WSL it must be stored as /mnt/<d>/... so dispose-run resolves it
    // absolute, not as a junk relative dir inside the repo (resolve treats
    // 'C:/...' as relative on POSIX). On native Windows the drive path is kept.
    const r = init(dir, ['--project-name', 'bkp', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'C:/Users/test/.sterling-backups/bkp']);
    assert.equal(r.code, 0, r.stderr);
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    const expected = process.platform === 'win32' ? 'C:/Users/test/.sterling-backups/bkp' : '/mnt/c/Users/test/.sterling-backups/bkp';
    assert.equal(config.backup_path, expected, 'Windows drive backup_path recorded in the runtime-correct form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensure outcome 1 — create absent: fresh init creates every manifest item and records declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    for (const a of [...ARTIFACTS, '.sterling/sterling.db', '.sterling/runs', 'docs/briefs', '.claude/agents/coder.md']) {
      assert.ok(existsSync(join(dir, a)), `created ${a}`);
    }
    // a consuming project gets NO per-project .mcp.json — the plugin declares sterling
    assert.ok(!existsSync(join(dir, '.mcp.json')), 'no per-project .mcp.json — the plugin declares the sterling server');
    assert.match(r.stdout, /^\.mcp\.json\s+matches\s+not written — the plugin declares sterling/m);
    // init never manages .claude/settings.local.json (decision 097851ed, refined): the MCP
    // dual-role is gone (the plugin declares its server via plugin.json mcpServers, not a root
    // .mcp.json), so no enable-flag enforcement is needed — a consuming project keeps its own.
    assert.ok(!existsSync(join(dir, '.claude', 'settings.local.json')), 'consuming project: settings.local.json left to the user (init never writes it)');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m);
    assert.match(r.stdout, /^\.sterling\/config\.json\s+created\b/m);
    assert.match(r.stdout, /RESTART REQUIRED/, 'agents installed → restart instruction');
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(config.project_name, 'ensure-target', 'project name recorded for flagless re-runs');
    assert.ok(config.backup_path.endsWith('/backups'), 'backup path recorded absolute, forward slashes');
    assert.deepEqual(config.stack_tags, ['node', 'sterling'], 'fresh init gets the universal sterling domain on top of declared tags (decision 47be4388)');
    // native-Windows launcher (sterling-windows.bat): fully native, generated from the fake win-node
    assert.match(r.stdout, /^sterling-windows\.bat\s+created\b/m);
    const nat = readFileSync(join(dir, 'sterling-windows.bat'), 'utf8');
    assert.match(nat, /%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt\.exe/, 'calls wt by absolute WindowsApps path');
    assert.match(nat, /%USERPROFILE%\\\.local\\bin\\claude\.exe" --plugin-dir/, 'left pane runs native claude with --plugin-dir');
    assert.ok(nat.includes(`"${WIN_NODE_FAKE}"`), 'right pane runs the detected Windows node (quoted)');
    assert.match(nat, /--size 0\.35\b/, 'wt split uses a 0–1 float, not a percent');
    assert.ok(!/35%/.test(nat), 'native launcher does NOT use the tmux percent unit');
    // option B: native claude loads the Windows MCP config and strictly ignores the plugin's WSL server
    assert.match(nat, /--mcp-config "[^"]*\\\.claude-plugin\\sterling-mcp-win\.json" --strict-mcp-config/, 'native claude loads the Windows MCP config strictly');

    // --- P5: the domain-knowledge snapshot bridge (AC8) -------------------
    // A native-Windows process cannot live-read the WSL-resident WAL domain
    // stores (research_finding 5c6437d8: WAL-over-9p `database is locked`). The
    // native launcher first refreshes a VACUUM-INTO snapshot of each WSL domain
    // store into the Windows-local default path via a WSL-side run of
    // `node snapshot-domains-for-windows.mjs`, THEN launches the native panes
    // that open those snapshots read-only.
    //
    // P5 REWORK: the prior assertion `assert.ok(!/wsl\.exe/.test(nat), …)` is
    // intentionally REPLACED — P5 introduces EXACTLY ONE wsl.exe usage (the
    // snapshot step). The assertions below pin that the only wsl.exe IS the
    // snapshot step and that the claude / TUI panes themselves remain native.
    const crlfLines = nat.split('\r\n'); // CRLF split — every .bat statement line
    const wslLines = crlfLines.filter((l) => /wsl\.exe/.test(l));
    assert.equal(wslLines.length, 1, 'P5 introduces EXACTLY ONE wsl.exe usage — the snapshot step, and no more');
    const snapLine = wslLines[0];
    // CRLF preserved: the wsl.exe step was found by splitting on \r\n, proving
    // the snapshot line is CRLF-terminated like the rest of the .bat.
    assert.ok(nat.includes('\r\n'), 'native launcher keeps CRLF line endings');
    assert.ok(!/[^\r]\n/.test(nat), 'no bare LF — every line ending is CRLF');

    // wsl.exe is called BARE — it lives in System32, reliably on PATH
    // (anti_pattern e7a46e35); unlike wt.exe it must NOT be given an absolute path.
    assert.match(snapLine, /(^|[^\\\w])wsl\.exe\b/, 'wsl.exe is invoked BARE (relies on PATH)');
    assert.ok(!/[A-Za-z]:\\[^\n]*wsl\.exe/.test(snapLine), 'wsl.exe is NOT given a drive-absolute path');
    assert.ok(!/%[^%\n]+%\\[^\n]*wsl\.exe/.test(snapLine), 'wsl.exe is NOT given an env-var-rooted absolute path (cf. wt.exe via %LOCALAPPDATA%)');

    // the snapshot step runs node on the snapshot script (resolved on the WSL side)
    assert.match(snapLine, /\bnode\b/, 'the snapshot step runs node inside WSL');
    assert.match(snapLine, /snapshot-domains-for-windows\.mjs/, 'the wsl.exe step runs the snapshot script');

    // positioned BEFORE the wt.exe native launch
    const snapIdx = crlfLines.findIndex((l) => /wsl\.exe/.test(l));
    const wtIdx = crlfLines.findIndex((l) => /wt\.exe/.test(l));
    assert.ok(snapIdx >= 0 && wtIdx >= 0, 'both the snapshot step and the wt launch are present');
    assert.ok(snapIdx < wtIdx, 'snapshot refresh runs BEFORE the wt.exe native launch');

    // the panes themselves remain NATIVE — wsl.exe never wraps claude.exe nor the
    // Windows-node TUI (the single wsl.exe line is the snapshot step, nothing more).
    assert.ok(!/wsl\.exe[^\r\n]*claude\.exe/.test(nat), 'claude pane is native — never wrapped by wsl.exe');
    const winNodeRe = new RegExp('wsl\\.exe[^\\r\\n]*' + WIN_NODE_FAKE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.ok(!winNodeRe.test(nat), 'the Windows-node TUI pane is native — never wrapped by wsl.exe');

    // FAIL-SOFT: a snapshot failure must NOT prevent the native panes launching.
    // The snapshot is a SEPARATE statement, not a hard `&&` gate onto the launch.
    assert.ok(!/wsl\.exe[^\r\n]*&&[^\r\n]*wt\.exe/.test(nat), 'snapshot+launch are not chained with && on one line (fail-soft)');
    assert.ok(!/&&\s*$/.test(snapLine), 'the snapshot line does not && the launch onto its own success (fail-soft)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('native launcher SKIPPED loudly when no Windows node is resolvable (P5), without blocking init', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    // STERLING_WIN_NODE='' forces the no-node path regardless of the machine's Windows PATH
    const r = init(dir, FRESH_FLAGS, { STERLING_WIN_NODE: '' });
    assert.equal(r.code, 0, r.stderr); // the rest of init still completes
    assert.match(r.stdout, /^sterling-windows\.bat\s+skipped\b/m, 'reports skipped, not silently absent');
    assert.match(r.stdout, /add the node dir to the Windows PATH/, 'skip reason is actionable');
    assert.ok(!existsSync(join(dir, 'sterling-windows.bat')), 'no native launcher written when node is unresolved');
    // the WSL launcher and the rest are unaffected
    assert.ok(existsSync(join(dir, 'sterling.bat')), 'WSL launcher still generated');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init completed the rest of the manifest');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('ensure outcome 2 — skip matching: a flagless re-run reports matches and changes no byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const before = snapshot(dir);
    const rerun = init(dir); // NO flags: declarations read back from the recorded config
    assert.equal(rerun.code, 0, rerun.stderr);
    for (const item of ['\\.sterling/config\\.json', 'CLAUDE\\.md', 'sterling\\.bat', 'sterling-windows\\.bat', 'tui\\.bat', 'sterling-launch\\.sh', 'sterling-update\\.bat', '\\.mcp\\.json', '\\.gitignore']) {
      assert.match(rerun.stdout, new RegExp(`^${item}\\s+matches\\b`, 'm'), `${item} reported as matching`);
    }
    assert.match(rerun.stdout, /^\.claude\/agents\/coder\.md\s+matches\b/m);
    assert.match(rerun.stdout, /^\.sterling\/sterling\.db\s+exists\b/m, 'store is data — exists, never compared or recreated');
    assert.match(rerun.stdout, /no agent changes — no restart required/);
    assert.ok(!/RESTART REQUIRED/.test(rerun.stdout), 'no restart demanded when nothing changed');
    assert.deepEqual(snapshot(dir), before, 'matching re-run is byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('ensure outcome 3 — leave-and-report: hand-edited config, CLAUDE.md, and agent are left untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    // tune the config, edit the contract, modify an installed agent body
    const configPath = join(dir, '.sterling', 'config.json');
    const tuned = JSON.parse(readFileSync(configPath, 'utf8'));
    tuned.caps.inner_loop_n = 7;
    writeFileSync(configPath, JSON.stringify(tuned, null, 2));
    appendFileSync(join(dir, 'CLAUDE.md'), '\n## Local additions\n- the human wrote this\n');
    appendFileSync(join(dir, '.claude', 'agents', 'coder.md'), '\nlocal tweak\n');
    const before = snapshot(dir);
    const agentBefore = readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+differs\s+left untouched/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+differs\s+left untouched — merge the conductor contract by hand/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/coder\.md\s+differs\s+locally modified/m);
    assert.deepEqual(snapshot(dir), before, 'hand-edited files untouched');
    assert.equal(readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8'), agentBefore, 'modified agent untouched');
    // tuned declarations still drive the run: caps came from the recorded config
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).caps.inner_loop_n, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('universal sterling domain: a config lacking it gains it on re-init (refreshed), hand-tunings preserved (decision 47be4388)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    // simulate a project init'd by older code: strip the universal tag, AND tune a field
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.stack_tags = cfg.stack_tags.filter((t) => t !== 'sterling'); // → ['node']
    cfg.caps.inner_loop_n = 7; // a hand-tuning that MUST survive the managed add
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir); // flagless re-init
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+refreshed\s+added the universal 'sterling' domain/m);
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(after.stack_tags, ['node', 'sterling'], 'sterling appended; declared tag kept');
    assert.equal(after.caps.inner_loop_n, 7, 'hand-tuning preserved — managed add, not regenerate-from-defaults');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// Board 1b3c7bf3 — config-space remediation-script merge (decision bc0f81e3
// supersession). SPEC-ONLY: init.mjs's implementation was NOT read to author
// these — only the dispatch SPEC and store-remediation.mjs's declared exports
// (REMEDIATION_SCRIPTS, appendMissingRemediation) were used, mirroring the
// universal-domain managed-refresh test above (same 'refreshed' vocabulary,
// same read-modify-write-then-still-validates shape).
//
// SPEC: a recorded config whose store_guard.allow_scripts is missing one or
// both of REMEDIATION_SCRIPTS gains EXACTLY the missing ones on a flagless
// re-run, reported 'refreshed' with the added scripts disclosed in the detail
// text; existing entries/order preserved; the merged raw JSON still validates
// via parseConfig. Already-has-both is NOT rewritten for this reason (falls
// through to the normal matches/differs outcome). A wrong-shaped store_guard
// or allow_scripts skips the merge with a warning, field left untouched.
// =============================================================================

test('store_guard remediation merge: a config missing ONE remediation script gains exactly that one on re-init (refreshed), hand-tunings and existing allow_scripts entries/order preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    // simulate a config frozen before migrate-stores.mjs was added to the
    // schema default: only migration-preflight.mjs present, in a store_guard
    // that also carries an unrelated admin-sanctioned entry.
    cfg.store_guard = { allow_scripts: ['scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs'] };
    cfg.caps.inner_loop_n = 7; // a hand-tuning that MUST survive the managed add
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir); // flagless re-init
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+refreshed\b/m, 'reported refreshed, not differs/created');
    const line = rerun.stdout.match(/^\.sterling\/config\.json\s+refreshed\s+.+$/m)[0];
    assert.match(line, /scripts\/migrate-stores\.mjs/, 'the added script is disclosed by name in the detail text');

    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(
      after.store_guard.allow_scripts,
      ['scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs'],
      'only the missing script is appended; existing entries and their order are untouched'
    );
    assert.equal(after.caps.inner_loop_n, 7, 'hand-tuning preserved — managed add, not regenerate-from-defaults');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: have the merge regenerate store_guard.allow_scripts from the
// schema default instead of read-modify-write appending onto the recorded
// array — the caps.inner_loop_n hand-tuning assertion goes red (or the
// 'scripts/some-admin-script.mjs' entry vanishes from `after`).
// SABOTAGE (order): reorder allow_scripts into REMEDIATION_SCRIPTS canonical
// order on merge — the deepEqual on `after.store_guard.allow_scripts` goes red
// because 'scripts/some-admin-script.mjs' would no longer lead the array.

test('store_guard remediation merge: a config missing BOTH remediation scripts gains both, in order, appended after existing entries; both disclosed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.store_guard = { allow_scripts: ['scripts/some-admin-script.mjs'] };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    const line = rerun.stdout.match(/^\.sterling\/config\.json\s+refreshed\s+.+$/m);
    assert.ok(line, 'refreshed line present');
    assert.match(line[0], /scripts\/migration-preflight\.mjs/, 'migration-preflight.mjs disclosed');
    assert.match(line[0], /scripts\/migrate-stores\.mjs/, 'migrate-stores.mjs disclosed');

    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(
      after.store_guard.allow_scripts,
      ['scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs'],
      'both missing scripts appended, in REMEDIATION_SCRIPTS order, after the pre-existing entry'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: append the two missing scripts in reversed order (migrate-stores
// before migration-preflight) — the `after.store_guard.allow_scripts` deepEqual
// goes red on element order.
// SABOTAGE (silent): perform the merge but never mention the added script
// names in the report line (e.g. print a bare "refreshed" with no detail) —
// both `assert.match(line[0], ...)` disclosure assertions go red.

test('store_guard remediation merge: already has both — NOT rewritten for this reason; a flagless re-run of a TUNED config (custom allow_scripts) reports differs (not refreshed), byte-identical, order untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    // both present, deliberately in NON-canonical order with an admin entry
    // between them — presence, not canonical order, is what must be checked.
    // This 3-element allow_scripts no longer equals the schema default (which
    // carries more entries), so the config as a whole is a TUNED config: the
    // correct overall outcome is 'differs' (hand-tuned, left untouched) — the
    // remediation-specific claim under test is narrower: it must NOT be
    // 'refreshed' for the remediation reason, and must be byte-identical.
    cfg.store_guard = { allow_scripts: ['scripts/migrate-stores.mjs', 'scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs'] };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const before = readFileSync(configPath, 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+differs\b/m, 'a tuned allow_scripts makes the whole config differ from the schema default — reported differs');
    assert.ok(!/^\.sterling\/config\.json\s+refreshed\b/m.test(rerun.stdout), 'never reported refreshed for the remediation reason — both scripts are already present');
    assert.equal(readFileSync(configPath, 'utf8'), before, 'byte-identical — the non-canonical order is left exactly as recorded, never touched by the remediation merge');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: check presence via a strict canonical-order subsequence match
// instead of plain membership — this non-canonical-order fixture would then
// be (wrongly) treated by the remediation merge as missing something, and
// the byte-identical assertion goes red (the merge would rewrite the file
// even though both scripts are already present).

// =============================================================================
// Round 2 (board 1b3c7bf3 supersession) — RAW-SERIALIZE preserves unknown keys.
// SPEC-ONLY: init.mjs's implementation was NOT read to author this — only the
// dispatch SPEC. parseConfig's own non-strict-object behavior (unknown keys
// STRIP from its parsed/returned value — pinned independently in
// packages/schemas/src/tests/config.test.ts, e.g. the legacy
// blast_radius_hard_threshold-stripped case) is a sibling-test-verified fact,
// not an implementation read. The merge must therefore serialize the RAW
// mutated JSON object back to disk — using parseConfig only as a
// throws-or-not validation gate — or any unknown top-level key present in a
// recorded config (a future field this init build doesn't know about yet)
// would silently vanish on the very re-init that also performs the
// remediation-script merge.
// =============================================================================

test('config raw-serialize: an unknown/future top-level key survives byte-for-byte through a re-init that ALSO performs the remediation-script merge (parseConfig is a validation gate only, never the serialized shape)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    // an unknown top-level key this build's schema does not declare — schema-valid
    // overall because unrecognized keys are tolerated (non-strict), not rejected.
    cfg.future_policy = { some_future_field: 'x', nested: { a: 1, b: [1, 2, 3] } };
    // AND, in the same write, a missing remediation script — so the merge path
    // that writes the file back is actually exercised, not just the load gate.
    cfg.store_guard = { allow_scripts: ['scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs'] };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir); // flagless re-init
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+refreshed\b/m, 'the remediation merge fired — refreshed, not matches/differs');

    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(
      after.future_policy,
      { some_future_field: 'x', nested: { a: 1, b: [1, 2, 3] } },
      'the unknown top-level key survives the write byte-for-byte-equivalent (raw serialize) even though this build\'s schema does not declare it'
    );
    assert.deepEqual(
      after.store_guard.allow_scripts,
      ['scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs'],
      'the remediation merge itself still ran correctly in the same write'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: serialize parseConfig(mutated)'s RETURN value instead of the raw
// mutated object (e.g. `writeFileSync(configPath, JSON.stringify(parseConfig(cfg), ...))`)
// — parseConfig's non-strict object strips future_policy on output, so
// after.future_policy is undefined and the first deepEqual goes red.

test('a schema-invalid store_guard makes init REFUSE outright (exit 2, "does not validate") — the anti-destructive load gate, not the remediation merge, is what actually guards this path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.store_guard = 'not-an-object'; // schema-invalid shape
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const before = readFileSync(configPath, 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 2, 'a schema-invalid recorded config refuses rather than being silently merged or regenerated');
    assert.match(rerun.stderr, /does not validate/i, 'the refusal names the reason');
    assert.equal(readFileSync(configPath, 'utf8'), before, 'the refusal happens before any write — the malformed file is left byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: move the parseConfig validation gate to AFTER an attempted
// remediation-merge (or drop it and let the merge code's own typeof guard be
// the only line of defense) — init would then exit 0 and either leave a
// still-invalid file in place or attempt to interpret 'not-an-object', so the
// exit-2 assertion goes red.

test('never-clobber: a pre-existing CLAUDE.md survives the FIRST init byte-for-byte; init completes around it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const ownContract = '# My project\n\nHand-written build contract. Sacred.\n';
    writeFileSync(join(dir, 'CLAUDE.md'), ownContract);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, `init completes around the existing CLAUDE.md, no refusal: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), ownContract, 'NEVER clobbered');
    assert.match(r.stdout, /^CLAUDE\.md\s+differs\s+left untouched — merge the conductor contract by hand/m);
    for (const a of ['.sterling/config.json', '.sterling/sterling.db', 'sterling.bat', '.claude/agents/coder.md']) {
      assert.ok(existsSync(join(dir, a)), `the rest of the manifest still created: ${a}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('refusal only for destructive actions: a FILE where .sterling/ must be a directory refuses before any write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    writeFileSync(join(dir, '.sterling'), 'not a directory');
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /REFUSED \(destructive\)/);
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'refusal happened before any write');
    assert.ok(!existsSync(join(dir, '.sterling', 'config.json')), 'refusal happened before any write');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('individually regenerable: deleted artifacts are recreated by a flagless re-run; the rest still match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const launcherBefore = readFileSync(join(dir, 'sterling.bat'), 'utf8');
    unlinkSync(join(dir, 'sterling.bat'));
    unlinkSync(join(dir, '.claude', 'agents', 'coder.md'));

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^sterling\.bat\s+created\b/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/coder\.md\s+created\b/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+matches\b/m, 'untouched items still match');
    assert.match(rerun.stdout, /RESTART REQUIRED/, 'reinstalled agent → restart instruction again');
    assert.equal(readFileSync(join(dir, 'sterling.bat'), 'utf8'), launcherBefore, 'regenerated identically');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('contradicting flags on a re-run are reported, never applied; consuming .mcp.json is left to the plugin (no sterling added; a stale entry is removed, foreign servers kept)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configBefore = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
    const rerun = init(dir, ['--stack-tags', 'python', '--project-name', 'other-name']);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /note: --stack-tags, --project-name differ\(s\) from the recorded config — NOT applied/);
    assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), configBefore, 'config untouched by contradicting flags');

    // a foreign server is preserved and NO sterling entry is added — the plugin
    // declares sterling (bound to this project via ${CLAUDE_PROJECT_DIR})
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2));
    assert.equal(init(dir).code, 0);
    let mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.other, 'foreign server preserved');
    assert.ok(!mcp.mcpServers.sterling, 'no per-project sterling entry added — the plugin declares it');

    // a STALE init-generated sterling entry (legacy per-project form) is removed; foreign kept
    const stale = { command: process.execPath, args: [join(root, 'packages', 'mcp-server', 'dist', 'main.js').replace(/\\/g, '/'), '--store', join(dir, '.sterling', 'sterling.db').replace(/\\/g, '/')] };
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] }, sterling: stale } }, null, 2));
    const cleaned = init(dir);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    assert.match(cleaned.stdout, /^\.mcp\.json\s+created\s+removed the redundant per-project sterling entry/m);
    mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.other, 'foreign server preserved through cleanup');
    assert.ok(!mcp.mcpServers.sterling, 'stale init-generated sterling entry removed');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// The plugin-repo branch (win MCP config generation) only runs when target ===
// pluginRoot, which no temp-dir fixture can reach — pin the two store-arg forms
// at the source instead. The asymmetry is deliberate (verified 2026-07-12,
// code.claude.com/docs/en/mcp): plugin-scope configs substitute
// ${CLAUDE_PROJECT_DIR} unconditionally (bare form correct), but a --mcp-config
// file gets project-scope env expansion where the var is unset at parse time —
// without the :-. default the literal passes through and the server mkdirs a
// phantom '${CLAUDE_PROJECT_DIR}/' store at its cwd (observed 2026-06-24).
test('MCP store args: plugin config stays bare ${CLAUDE_PROJECT_DIR}; the --mcp-config win config carries the :-. default (phantom-store regression)', () => {
  const src = readFileSync(join(root, 'scripts', 'init.mjs'), 'utf8');
  assert.ok(
    src.includes("args: [fwd(mcpServerEntry), '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db']"),
    'plugin-scope entry keeps the bare form — plugin configs substitute it unconditionally'
  );
  assert.ok(
    src.includes("'--store', '${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db'"),
    'the native-claude win config uses the ${CLAUDE_PROJECT_DIR:-.} default — bare form passes through --mcp-config literally (the phantom store)'
  );
});

test('init notes the project in the shared registry (decision 8f9e6db2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^project registry\s+created\s+noted 'ensure-target'/m);
    const reg = new ProjectRegistry(join(dir, 'registry.db'));
    try {
      const me = reg.list().find((p) => p.repo_path === dir.replace(/\\/g, '/'));
      assert.ok(me, 'this project is registered, keyed by its absolute POSIX repo path');
      assert.equal(me.name, 'ensure-target');
      assert.deepEqual(me.stack_tags, ['node', 'sterling'], 'declared tag + the auto-injected universal sterling domain (decision 47be4388)');
      assert.deepEqual(me.toolchains, ['node']);
      assert.equal(me.first_init_at, me.last_init_at, 'fresh init: first_init_at == last_init_at');
      assert.equal(me.last_seen_at, null, 'no session-start touch yet');
    } finally {
      reg.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// Phase 2 (r-ea9e) — config.models wiring end-to-end through init.
//
// init writes .sterling/config.json (carrying config.models, shipped defaults),
// THEN installs the agents; the phase goal requires init to thread that PARSED
// CONFIG through the render path so {{MODEL}}/{{EFFORT}} resolve per agent via
// AGENT_MODEL_KEY. Observable contract: every installed agent frontmatter carries
// a CONCRETE pinned model/effort (no surviving token), and coder resolves to the
// shipped-default coder model — proving config.models is authoritative at install.
// =============================================================================

test('phase-2 wiring: fresh init resolves {{MODEL}}/{{EFFORT}} in the installed agents from its own config.models (no token survives; concrete pinned ids)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);

    // config.models is present and pinned in the config init just wrote.
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.ok(config.models && config.models.coder, 'init wrote config.models with a coder entry');

    for (const name of ['coder.md', 'reviewer-correctness.md']) {
      const installed = readFileSync(join(dir, '.claude', 'agents', name), 'utf8');
      const fm = installed.match(/^---\n([\s\S]*?)\n---/)[1];
      assert.ok(!installed.includes('{{'), `${name}: no substitution token survives install`);
      assert.match(fm, /^model: claude-[a-z0-9.\-]+$/m, `${name}: model resolved to a concrete pinned claude- id`);
      assert.match(fm, /^effort: [a-z]+$/m, `${name}: effort resolved to a concrete value`);
    }

    // coder resolves to the shipped-default coder model — config.models is the
    // authoritative source at install (matches config.test.ts's shipped default).
    const coderFm = readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(coderFm, /^model: claude-sonnet-5$/m, 'coder installs on the shipped-default coder model (config.models authoritative)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// P5 — domain-knowledge snapshot bridge: scripts/snapshot-domains-for-windows.mjs
//
// AC8: the native-Windows launcher refreshes a VACUUM-INTO snapshot of each WSL
// domain store into the Windows-local default path at startup; the native TUI
// opens those read-only and shows their records (stale-as-of-launch). The WSL
// side of that bridge is this script. A native process cannot live-read the
// WSL-resident WAL stores (research_finding 5c6437d8) — so the source domain
// stores are snapshotted (VACUUM INTO, reusing SterlingStore.snapshot /
// MountedStores.snapshotAll) into the Windows-local default path read-only.
//
// CONTRACT pinned here (behavioral, via spawnSync — NEVER import: a missing
// script must yield a non-zero EXIT we assert on, never a thrown import error):
//   node scripts/snapshot-domains-for-windows.mjs \
//        --target <projectDir> --win-domains-root <destDir>
//   • reads <projectDir>/.sterling/config.json, resolves the project's mounted
//     domain stores (honoring config.domain_paths via resolveDomainMounts),
//   • for each domain store that EXISTS on disk, VACUUM-INTOs it to
//     <destDir>/<tag>/sterling.db,
//   • a domain whose SOURCE store does not exist is SKIPPED LOUDLY (reported,
//     never created, never crashes),
//   • prints a summary INCLUDING the snapshot time (staleness surfaced honestly),
//   • exits 0 on success.
// --win-domains-root is an override that exists FOR TESTABILITY; in production
// it defaults to the /mnt/c translation of the Windows homedir's ~/.sterling/domains.
// =============================================================================

const SNAPSHOT_SCRIPT = join(root, 'scripts', 'snapshot-domains-for-windows.mjs');

// envelope/record-builder mirroring packages/store/src/tests/store.test.ts so a
// seeded domain record is schema-valid and provably round-trips through the snapshot.
function envelope(type, over = {}) {
  const at = '2026-06-26T12:00:00.000Z';
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'domain:node', // a DOMAIN-scoped record, so it lives in the domain store
    stack_tags: ['node'],
    ...over,
  };
}

function domainDecision(over = {}) {
  return {
    ...envelope('decision'),
    title: 'Domain-shared decision',
    statement: 'A cross-project decision that lives in the node domain store.',
    alternatives_rejected: [{ option: 'project-only', reason: 'not shareable' }],
    rationale: 'Shared across every node project.',
    file_keys: ['packages/store/src/index.ts'],
    ...over,
  };
}

// Write a minimal, schema-valid .sterling/config.json whose `node` domain is
// path-overridden to our temp source store (all other config fields default).
function writeProject(dir, domainPaths) {
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = { project_name: 'snapshot-fixture', stack_tags: Object.keys(domainPaths), domain_paths: domainPaths };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config, null, 2));
}

function runSnapshot(projectDir, destDir) {
  const r = spawnSync(process.execPath, [SNAPSHOT_SCRIPT, '--target', projectDir, '--win-domains-root', destDir], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, STERLING_REGISTRY_DB: join(projectDir, 'registry.db') },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('P5 snapshot script: VACUUM-INTOs each EXISTING domain store to <win-root>/<tag>/sterling.db; the snapshot opens read-only and returns the seeded record (AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-snap-'));
  try {
    // a REAL source domain store with a seeded domain-scoped record
    const srcDb = join(dir, 'src-domains', 'node', 'sterling.db');
    mkdirSync(dirname(srcDb), { recursive: true });
    const src = new SterlingStore(srcDb);
    let seededId;
    try {
      seededId = src.create(domainDecision()).id;
    } finally {
      src.close();
    }
    writeProject(dir, { node: srcDb });

    const dest = join(dir, 'win-domains');
    const r = runSnapshot(dir, dest);
    assert.equal(r.code, 0, `snapshot script exits 0: ${r.stderr}`);

    // the snapshot landed at the Windows-local default layout <root>/<tag>/sterling.db
    const snapDb = join(dest, 'node', 'sterling.db');
    assert.ok(existsSync(snapDb), 'VACUUM-INTO snapshot written at <win-root>/node/sterling.db');

    // opening the snapshot returns the seeded domain record (provably the SAME data)
    const snap = new SterlingStore(snapDb);
    try {
      const got = snap.get(seededId);
      assert.ok(got, 'seeded domain record present in the snapshot');
      assert.equal(got.id, seededId, 'snapshot round-trips the exact record');
      assert.equal(got.type, 'decision');
    } finally {
      snap.close();
    }

    // staleness is surfaced honestly: the summary names the node domain and a time
    assert.match(r.stdout, /node/, 'summary reports the node domain that was snapshotted');
    assert.match(r.stdout, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'summary includes the snapshot time (ISO-ish) — staleness surfaced');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('P5 snapshot script: a configured domain whose SOURCE db is ABSENT is SKIPPED LOUDLY — still exits 0, reports the skip, never creates that tag\'s snapshot dir (AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-snap-'));
  try {
    // 'node' has a real source store; 'ghost' is configured but its source db is absent
    const srcDb = join(dir, 'src-domains', 'node', 'sterling.db');
    mkdirSync(dirname(srcDb), { recursive: true });
    const src = new SterlingStore(srcDb);
    try {
      src.create(domainDecision());
    } finally {
      src.close();
    }
    const ghostDb = join(dir, 'src-domains', 'ghost', 'sterling.db'); // intentionally NOT created
    assert.ok(!existsSync(ghostDb), 'precondition: the ghost source store does not exist');
    writeProject(dir, { node: srcDb, ghost: ghostDb });

    const dest = join(dir, 'win-domains');
    const r = runSnapshot(dir, dest);

    // a missing source is non-fatal: the script still completes
    assert.equal(r.code, 0, `missing source is non-fatal — still exits 0: ${r.stderr}`);
    // the present domain WAS snapshotted
    assert.ok(existsSync(join(dest, 'node', 'sterling.db')), 'the present node domain is still snapshotted');
    // the absent domain is SKIPPED LOUDLY: reported, and its snapshot dir never created
    assert.match(r.stdout + r.stderr, /ghost/, 'the skipped ghost domain is reported by name (loud, not silent)');
    assert.match(r.stdout + r.stderr, /skip/i, 'the report uses skip wording');
    assert.ok(!existsSync(join(dest, 'ghost')), 'no snapshot dir created for the absent source domain');
    assert.ok(!existsSync(join(dest, 'ghost', 'sterling.db')), 'no snapshot db fabricated for the absent source');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('P5 snapshot script: refreshes over an existing snapshot — a second run reflects the LATEST source and still exits 0 (startup refresh, AC8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-snap-'));
  try {
    const srcDb = join(dir, 'src-domains', 'node', 'sterling.db');
    mkdirSync(dirname(srcDb), { recursive: true });
    const src = new SterlingStore(srcDb);
    let firstId, secondId;
    try {
      firstId = src.create(domainDecision({ title: 'first' })).id;
    } finally {
      src.close();
    }
    writeProject(dir, { node: srcDb });
    const dest = join(dir, 'win-domains');

    // first refresh
    assert.equal(runSnapshot(dir, dest).code, 0, 'first snapshot succeeds');

    // the source grows, then we refresh AGAIN at the next "startup"
    const src2 = new SterlingStore(srcDb);
    try {
      secondId = src2.create(domainDecision({ title: 'second' })).id;
    } finally {
      src2.close();
    }
    const r2 = runSnapshot(dir, dest);
    assert.equal(r2.code, 0, `re-running over an existing snapshot still succeeds (startup refresh): ${r2.stderr}`);

    // the refreshed snapshot reflects the LATEST source (both records present)
    const snap = new SterlingStore(join(dest, 'node', 'sterling.db'));
    try {
      assert.ok(snap.get(firstId), 'original record still present after refresh');
      assert.ok(snap.get(secondId), 'the record added before the second run is present — snapshot was refreshed, not stale-kept');
    } finally {
      snap.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// Part C (sparring-partner slice 1) — codex MCP-server wiring through init's
// plugin-repo branch (decision cd019e0b, concept slug
// sparring-partner-partnership-shape). Spec only, per the dispatch — init.mjs's
// implementation body was NOT read to author these.
//
// Two testability seams:
//   STERLING_CODEX_PROBE — unset/'' = real probe; 'ok' = force probe success;
//     'absent' = force failure reason 'binary-absent'; 'not-logged-in' = force
//     failure reason 'not-logged-in'; any other value = init fails loud.
//   STERLING_PLUGIN_ROOT_MATCH — a target equal to this value is treated as
//     the plugin repo for the two branch-selection comparisons (MCP-config
//     generation + plugin-repo-only .gitignore entries); every other
//     pluginRoot-derived path (templates, dist, hooks) stays real. Pointing it
//     at the fixture --target lets the plugin-repo ensure logic run safely
//     against a disposable temp dir instead of this actual working tree.
//
// Env vars below are passed ONLY through the init() helper's extraEnv (merged
// into the spawned child's own environment) — never assigned onto this test
// process's own process.env — so each case's env is scoped to its own
// spawnSync call and nothing needs unsetting between cases.
// =============================================================================

test('sparring-partner case 1: plugin-repo branch + codex probe OK generates BOTH sterling and codex mcpServers entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'ok' });
    assert.equal(r.code, 0, r.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp.json');
    assert.ok(existsSync(mcpPath), 'plugin-repo MCP config generated when target matches STERLING_PLUGIN_ROOT_MATCH');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(mcp.mcpServers && mcp.mcpServers.sterling, 'sterling entry present alongside codex');
    assert.deepEqual(mcp.mcpServers.codex, { command: 'codex', args: ['mcp-server'] }, 'codex entry matches the declared CODEX_MCP_ENTRY exactly — no extra fields, no altered command/args');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner case 2: codex probe forced absent ⇒ no codex entry; skip line reported; init still completes its other artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'absent' });
    assert.equal(r.code, 0, r.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp.json');
    assert.ok(existsSync(mcpPath), 'plugin-repo MCP config still generated despite the codex skip');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(!('codex' in mcp.mcpServers), 'no codex key added when the probe is forced to report binary-absent');
    assert.ok(mcp.mcpServers.sterling, 'sterling entry still present');
    const report = r.stdout + r.stderr;
    assert.match(report, /^codex mcp: skipped — .+/m, 'report carries an actionable "codex mcp: skipped — " line (not a bare prefix)');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init still completes its other artifacts around the codex skip');
    assert.match(r.stdout, /^\.sterling\/config\.json\s+created\b/m, 'init still completes its other artifacts around the codex skip');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner case 3: codex probe forced not-logged-in ⇒ no codex entry; skip line reported; init still completes its other artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'not-logged-in' });
    assert.equal(r.code, 0, r.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp.json');
    assert.ok(existsSync(mcpPath), 'plugin-repo MCP config still generated despite the codex skip');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(!('codex' in mcp.mcpServers), 'no codex key added when the probe is forced to report not-logged-in');
    assert.ok(mcp.mcpServers.sterling, 'sterling entry still present');
    const report = r.stdout + r.stderr;
    assert.match(report, /^codex mcp: skipped — .+/m, 'report carries an actionable "codex mcp: skipped — " line (not a bare prefix)');
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init still completes its other artifacts around the codex skip');
    assert.match(r.stdout, /^\.sterling\/config\.json\s+created\b/m, 'init still completes its other artifacts around the codex skip');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner cases 2+3 together: the binary-absent and not-logged-in skip lines are distinguishable from each other', () => {
  const dirAbsent = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  const dirLogin = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const rAbsent = init(dirAbsent, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dirAbsent, STERLING_CODEX_PROBE: 'absent' });
    const rLogin = init(dirLogin, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dirLogin, STERLING_CODEX_PROBE: 'not-logged-in' });
    assert.equal(rAbsent.code, 0, rAbsent.stderr);
    assert.equal(rLogin.code, 0, rLogin.stderr);
    const prefix = 'codex mcp: skipped — ';
    const lineAbsent = (rAbsent.stdout + rAbsent.stderr).match(/^codex mcp: skipped — .+/m);
    const lineLogin = (rLogin.stdout + rLogin.stderr).match(/^codex mcp: skipped — .+/m);
    assert.ok(lineAbsent, 'binary-absent case reports a skip line');
    assert.ok(lineLogin, 'not-logged-in case reports a skip line');
    assert.notEqual(lineAbsent[0], lineLogin[0], 'the two failure reasons produce distinguishable skip lines, not one generic message');
    assert.ok(lineAbsent[0].length > prefix.length, 'binary-absent skip line carries content beyond the bare prefix (actionable)');
    assert.ok(lineLogin[0].length > prefix.length, 'not-logged-in skip line carries content beyond the bare prefix (actionable)');
  } finally {
    rmSync(dirAbsent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dirLogin, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner case 4: an unchanged re-run reports the plugin MCP config as matches (idempotent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const env = { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'ok' };
    const first = init(dir, FRESH_FLAGS, env);
    assert.equal(first.code, 0, first.stderr);
    const before = readFileSync(join(dir, '.claude-plugin', 'sterling-mcp.json'), 'utf8');

    const rerun = init(dir, [], env); // flagless — declarations read back from the recorded config; same env
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.claude-plugin\/sterling-mcp\.json\s+matches\b/m, 'unchanged plugin MCP config reports matches, not created/refreshed, on a repeat run');
    assert.equal(readFileSync(join(dir, '.claude-plugin', 'sterling-mcp.json'), 'utf8'), before, 'byte-identical on the matching re-run');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner case 5: an unrecognized STERLING_CODEX_PROBE value fails init loud, never silently proceeding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'garbage' });
    assert.notEqual(r.code, 0, 'an unrecognized probe override value must fail init (nonzero exit), never proceed as if unset');
    assert.ok((r.stderr ?? '').length > 0, 'the loud failure is accompanied by a diagnostic on stderr, not a silent nonzero');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// Review addendum (mechanical blind spot 1, spec-only — init.mjs's implementation
// was NOT read to author these): UPGRADE PATH for an existing sterling-only
// plugin MCP config (.claude-plugin/sterling-mcp.json).
//
// SPEC: a project that already has a sterling-only plugin MCP config (e.g.
// written by an earlier init that ran before codex became probe-able, or by a
// run where the probe was absent at the time) gets a MANAGED REFRESH on a later
// run where the probe now succeeds — the file gains a codex entry alongside the
// unchanged sterling entry, reported as 'refreshed' (matching the existing
// 'refreshed' vocabulary used for the universal-domain managed-add case above),
// never 'created' (the file already existed) and never 'differs' (this is a
// managed field the ensure logic owns, not a hand edit). The never-overwrite
// guard still holds: if the existing sterling entry was hand-modified, the
// managed refresh must decline to touch the file at all and report 'differs'.
// =============================================================================

test('sparring-partner case 6: managed refresh — a pre-existing sterling-only plugin MCP config gains a codex entry once the probe later succeeds; sterling entry unchanged; reported "refreshed" naming codex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    // Step 1: build the fixture — a sterling-only plugin MCP config, as an
    // earlier run (probe forced absent) would have produced.
    const first = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'absent' });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp.json');
    const before = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(before.mcpServers && before.mcpServers.sterling, 'precondition: sterling-only config exists after the absent-probe fresh init');
    assert.ok(!('codex' in before.mcpServers), 'precondition: no codex entry yet');

    // Step 2: re-run flagless (declarations read back from the recorded config),
    // now with the probe forced to succeed — this is the managed refresh.
    const rerun = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'ok' });
    assert.equal(rerun.code, 0, rerun.stderr);

    const after = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(after.mcpServers.sterling, before.mcpServers.sterling, 'sterling entry unchanged by the managed refresh');
    assert.deepEqual(after.mcpServers.codex, { command: 'codex', args: ['mcp-server'] }, 'codex entry added, matching CODEX_MCP_ENTRY exactly');

    const line = rerun.stdout.match(/^\.claude-plugin\/sterling-mcp\.json\s+.+$/m);
    assert.ok(line, 'a report line exists for the plugin MCP config on the managed-refresh re-run');
    assert.match(line[0], /\brefreshed\b/, "the report line says 'refreshed'");
    assert.ok(!/\bdiffers\b/.test(line[0]), "the report line does NOT say 'differs' on a managed refresh");
    assert.ok(!/\bcreated\b/.test(line[0]), "the report line does NOT say 'created' — the file already existed");
    assert.match(line[0], /codex/i, 'the refresh detail names codex');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sparring-partner case 7: never-overwrite guard holds through the codex managed refresh — a hand-edited sterling entry blocks the write; file untouched byte-for-byte, reported "differs"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codex-'));
  try {
    const first = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'absent' });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp.json');

    // hand-edit the existing sterling entry (simulating a local tuning)
    const handEdited = JSON.parse(readFileSync(mcpPath, 'utf8'));
    handEdited.mcpServers.sterling.args = [...handEdited.mcpServers.sterling.args, '--hand-tuned-flag'];
    writeFileSync(mcpPath, JSON.stringify(handEdited, null, 2));
    const beforeBytes = readFileSync(mcpPath, 'utf8');

    // re-run with the probe now succeeding — the managed refresh must decline
    const rerun = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'ok' });
    assert.equal(rerun.code, 0, rerun.stderr);

    assert.equal(readFileSync(mcpPath, 'utf8'), beforeBytes, 'never-overwrite: a hand-edited sterling entry blocks the managed codex refresh — file untouched byte-for-byte');
    const line = rerun.stdout.match(/^\.claude-plugin\/sterling-mcp\.json\s+.+$/m);
    assert.ok(line, 'a report line exists for the plugin MCP config on the guarded re-run');
    assert.match(line[0], /\bdiffers\b/, "the report line says 'differs' when the sterling entry was hand-edited — never-overwrite holds");
    assert.ok(!/\brefreshed\b/.test(line[0]), "the report line does NOT say 'refreshed' when blocked by the never-overwrite guard");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
