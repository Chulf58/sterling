// §12 ensure-manifest semantics: per-item verify → create absent → skip
// matching → leave-and-report hand-edited; refusal only for destructive
// actions; every manifest artifact individually regenerable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry } from '@sterling/store';
import { findDeadTerms } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// fake Windows node path so the native launcher (sterling-windows.bat) generates
// deterministically without a real Windows node on PATH (mirrors STERLING_REGISTRY_DB).
const WIN_NODE_FAKE = 'C:\\TestNode\\node-v24-win-x64\\node.exe';

const fwdPath = (p) => String(p).replace(/\\/g, '/');

// =============================================================================
// CONTAINMENT: A SUITE RUN IS NOT A DEPLOYMENT
// (anti_pattern a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree,
//  severity BLOCK — knowledge_get 37b3cb0a-2e54-4ce2-99b9-45b68d6e6e0f)
//
// init resolves the plugin MCP config's PATH through STERLING_PLUGIN_ROOT_MATCH,
// whose PRODUCTION default is the real clone (`process.env.STERLING_PLUGIN_ROOT_MATCH
// || pluginRoot`, init-impl.mjs's STERLING_PLUGIN_ROOT_MATCH resolution — moved out of
// scripts/init.mjs by the bootstrap/impl split). So a spawn that leaves the seam unset points
// init's ensure at THIS repo's OWN .claude-plugin/sterling-mcp.json — the live config
// the running session's MCP client loads. It reports 'matches' today only because the
// suite happens to run under the same interpreter recorded in that file; under nvm, CI,
// a wrapper, or any other node install the managed command-refresh would REPOINT THE
// LIVE CONFIG AT THE TEST RUNNER'S NODE, mid-session — and the codex gate would re-probe
// (spawning a real `codex login status`) on any machine whose live config has no codex
// key. Both are the recorded anti-pattern exactly: writing into the shipped location.
//
// Therefore EVERY spawn helper below defaults the seam to its OWN disposable scratch
// directory. Three properties make that default correct, and each is load-bearing:
//   1. It is NOT the --target. init's plugin-repo branch is fwd(target) ===
//      fwd(pluginRootMatch); aiming the seam at the target would flip every
//      consuming-project fixture in this file into a clone-target fixture and silently
//      invert what it pins. A fresh third directory keeps the comparison FALSE, exactly
//      as the real-clone default did — so no existing verdict changes.
//   2. It is a real, writable, per-spawn directory, disposed with the rest.
//   3. An EXPLICIT extraEnv value still wins (it is spread last). Every case that
//      deliberately exercises the clone-target arm sets the seam itself and is untouched.
// The `undefined` deletion idiom this file uses for other seams is REFUSED here (see
// the throw below): deleting this key restores the live-clone default, which is the
// defect, so it must never be reachable by copying a nearby call site's style.
// =============================================================================
const scratchPluginRoots = new Set();
function scratchPluginRoot() {
  const d = mkdtempSync(join(tmpdir(), 'sterling-pluginroot-'));
  scratchPluginRoots.add(d);
  return d;
}
after(() => {
  for (const d of scratchPluginRoots) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// The two live artifacts whose path init derives from the plugin root. Stamped at MODULE
// LOAD (before the first test runs) and re-read by the Part H guard at the end of the
// file, so the containment claim covers the WHOLE suite run rather than one spawn.
// mtime+size, not bytes: a rewrite of a clean tree emits byte-identical output, so a
// content comparison passes while the file was in fact rewritten (a hollow pin — the
// anti-pattern's own recorded correction). ABSENT is a stamp too: creating a file that
// was not there is as much a deployment as changing one.
const LIVE_PLUGIN_ARTIFACTS = ['.claude-plugin/sterling-mcp.json', '.claude-plugin/sterling-mcp-win.json'];
const liveStamps = () => Object.fromEntries(LIVE_PLUGIN_ARTIFACTS.map((rel) => {
  try {
    const s = statSync(join(root, rel));
    return [rel, `${s.mtimeMs}:${s.size}`];
  } catch (e) {
    if (e.code === 'ENOENT') return [rel, 'ABSENT'];
    throw e;
  }
}));
const LIVE_STAMPS_AT_LOAD = liveStamps();

function init(dir, args = [], extraEnv = {}) {
  if ('STERLING_PLUGIN_ROOT_MATCH' in extraEnv && extraEnv.STERLING_PLUGIN_ROOT_MATCH === undefined) {
    throw new Error('init(): STERLING_PLUGIN_ROOT_MATCH must never be deleted — unset means init ensures THIS clone\'s live .claude-plugin/sterling-mcp.json (see the containment note above). Pass a scratch dir, or omit the key to take the helper default.');
  }
  const pluginRootMatch = extraEnv.STERLING_PLUGIN_ROOT_MATCH ?? scratchPluginRoot();
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    // isolate the machine-global project registry to this test's temp dir, so
    // init's registration never pollutes the real ~/.sterling/registry.db; pin
    // STERLING_WIN_NODE so the native launcher generates without a real Windows
    // node. STERLING_CODEX_PROBE_WIN defaults to 'absent' for the SAME reason
    // STERLING_WIN_NODE is pinned: every FRESH_FLAGS init generates
    // sterling-windows.bat (native launcher present), which per board 43051819
    // now also wires codex into .claude-plugin/sterling-mcp-win.json — LOAD-
    // BEARING, not cosmetic: without this default, every existing case in this
    // file that calls init() without overriding the win seam would incidentally
    // invoke the REAL unmocked probeCodexWin (a live where.exe + codex login
    // status through WSL interop), and their determinism would depend on this
    // machine's WSL interop being fast — a latent flake. A case that wants the
    // real or a different forced outcome overrides it via extraEnv.
    //
    // STERLING_CODEX_PROBE (the WSL twin) now defaults to 'absent' for the same
    // reason, and it became LOAD-BEARING with the containment fix above: aimed at
    // a fresh scratch plugin root, the plugin MCP config is CREATED on every spawn
    // instead of found already carrying a codex key, and init's codex gate probes
    // whenever the file lacks one. Unforced, that is a real `codex login status`
    // per test — determinism hostage to whether Codex is installed and logged in
    // on the running machine. Every case that cares about the WSL probe's outcome
    // already sets this seam explicitly, and that value still wins.
    env: {
      ...process.env,
      STERLING_REGISTRY_DB: join(dir, 'registry.db'),
      STERLING_WIN_NODE: WIN_NODE_FAKE,
      STERLING_PLUGIN_ROOT_MATCH: pluginRootMatch,
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CODEX_PROBE_WIN: 'absent',
      ...extraEnv,
    },
  });
  // pluginRootMatch is returned as a LOCATION TO LOOK IN, never as evidence in
  // itself: it is what this helper INTENDED, and it stays correct even if the key
  // never reaches the child. Part H reads it only to find the directory it then
  // checks for the artifact the SPAWNED init actually produced. Measured this slice:
  // asserting on the returned value alone did not redden when the env line was
  // deleted (53 pass / 0 fail) — a hollow pin.
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', pluginRootMatch };
}

const FRESH_FLAGS = ['--project-name', 'ensure-target', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'];
// .mcp.json is NOT a per-project artifact: the plugin declares the sterling
// server (bound per-project via ${CLAUDE_PROJECT_DIR}), so a consuming project
// never gets one. Its absence is asserted directly below.
const ARTIFACTS = ['.sterling/config.json', 'AGENTS.md', 'CLAUDE.md', 'sterling.bat', 'sterling-windows.bat', 'tui.bat', 'sterling-launch.sh', 'sterling-update.bat', '.gitignore'];
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
    for (const a of [...ARTIFACTS, '.sterling/sterling.db', '.sterling/runs', 'docs/briefs', '.claude/agents/librarian.md']) {
      assert.ok(existsSync(join(dir, a)), `created ${a}`);
    }
    // a consuming project gets NO per-project .mcp.json — the plugin declares sterling
    assert.ok(!existsSync(join(dir, '.mcp.json')), 'no per-project .mcp.json — the plugin declares the sterling server');
    assert.match(r.stdout, /^\.mcp\.json\s+matches\s+not written — the plugin declares sterling/m);
    // init never manages .claude/settings.local.json (decision foreign_097851ed, refined): the MCP
    // dual-role is gone (the plugin declares its server via plugin.json mcpServers, not a root
    // .mcp.json), so no enable-flag enforcement is needed — a consuming project keeps its own.
    assert.ok(!existsSync(join(dir, '.claude', 'settings.local.json')), 'consuming project: settings.local.json left to the user (init never writes it)');
    assert.match(r.stdout, /^AGENTS\.md\s+created\b/m);
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m);
    assert.match(r.stdout, /^\.sterling\/config\.json\s+created\b/m);
    // AGENTS.md/CLAUDE.md split (decision agents-md-is-the-instructions-file-claude-md-is-a-one-line-import,
    // 161e2972): CLAUDE.md is exactly the one-line import plus the Sterling layer; the
    // tool-agnostic content (project facts, conventions) renders into AGENTS.md instead.
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /^@AGENTS\.md\n/, 'CLAUDE.md opens with the @AGENTS.md import');
    assert.match(agentsMd, /^# AGENTS\.md — ensure-target\n/, 'AGENTS.md renders the project name');
    assert.ok(agentsMd.includes('Stack tags (= domain mount manifest): node, sterling'), 'AGENTS.md carries the project facts');
    assert.ok(!claudeMd.includes('{{'), 'no unresolved placeholder survives in CLAUDE.md');
    assert.ok(!agentsMd.includes('{{'), 'no unresolved placeholder survives in AGENTS.md');
    assert.match(r.stdout, /RESTART REQUIRED/, 'agents installed → restart instruction');
    const config = JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'));
    assert.equal(config.project_name, 'ensure-target', 'project name recorded for flagless re-runs');
    assert.ok(config.backup_path.endsWith('/backups'), 'backup path recorded absolute, forward slashes');
    assert.deepEqual(config.stack_tags, ['node', 'sterling'], 'fresh init gets the universal sterling domain on top of declared tags (decision 47be4388)'); // not-a-citation: fixture id
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

    // --- decision foreign_ffe7c416 / board 3873d33b: THE WSL BRIDGE IS GONE -------
    // WAS (P5, AC8): the native launcher shelled to wsl.exe EXACTLY ONCE, to
    // refresh a VACUUM-INTO snapshot of the WSL-resident domain stores before
    // launching the native panes — a native process cannot live-read WAL stores
    // over 9p (research_finding foreign_5c6437d8, `database is locked`). That bridge
    // served a MIXED host.
    //
    // NOW (ffe7c416, user-decided 2026-08-27; board 3873d33b): Sterling users
    // are EITHER 100% Windows OR 100% Linux, so a Windows installation invokes
    // WSL NOWHERE. packages/store/src/mounted.ts derives the domains root from
    // homedir(), so a Windows-only user's native MCP server and native TUI
    // already open their own %USERPROFILE%\.sterling\domains directly — there
    // is no boundary to cross, and for that user the bridge is a no-op that
    // FAILS, after which the absent snapshots vanish silently from the
    // Knowledge view (skipMissing, packages/tui/src/main.ts:67).
    //
    // The family below is the INVERSION of the old "EXACTLY ONE wsl.exe"
    // anchor, asserted over the WHOLE rendered file, COMMENTS INCLUDED — no
    // prose exception, which is possible because the template was deliberately
    // written to contain zero occurrences of the literal.

    // CONTROL, PLACED FIRST. Every arm below is a NEGATIVE, and a negative is
    // satisfied identically by a correct launcher and by an empty or
    // half-rendered one — a green with more than one possible cause, which is
    // the hollow shape ffe7c416's own evidence was collected against. The
    // positive assertions above are the real proof; this restates the
    // load-bearing half LOCALLY so a future edit cannot delete the evidence and
    // leave every arm below silently vacuous.
    assert.ok(
      /wt\.exe/.test(nat) && /claude\.exe/.test(nat) && nat.includes(`"${WIN_NODE_FAKE}"`),
      'CONTROL: the file under test is a real rendered native launcher (wt launch + native claude pane + Windows-node TUI pane), not empty or half-written'
    );

    // (a) THE ANCHOR, INVERTED: one usage -> ZERO, over the whole file.
    assert.ok(
      !/wsl\.exe/i.test(nat),
      'ffe7c416: a Windows installation invokes WSL NOWHERE — zero wsl.exe in the ENTIRE rendered launcher, comments included'
    );

    // (b) ...and not under the OTHER spelling. `wsl` without the extension is
    // an equally working Windows invocation, so an anchor keyed to the literal
    // "wsl.exe" alone stays green under a bridge re-added as
    // `wsl -- bash -lic "…"`. Restricted to COMMAND POSITION (line start, after
    // @, after a &/&&/|/( separator, or after call/start) and guarded with
    // \b(?!path), so an echoed or commented mention — "no WSL required",
    // "WSL-resident", wslpath inside prose — is not a false red; command
    // position is the only place an invocation can actually live.
    const statementLines = nat.split(/\r?\n/).filter((l) => !/^\s*(@?rem\b|::)/i.test(l));
    // SECOND CONTROL, for the FILTER itself. Two negative arms — (b) and (c) —
    // now read from statementLines, so a comment filter that over-matches (say
    // it grew to treat echo or any non-executing line as a comment, or the
    // template moved to `::` for statements) would empty the list and turn BOTH
    // arms vacuously green at once. The filter is therefore proven to still
    // retain the launcher's own executable line before anything is asserted
    // over it.
    assert.ok(
      statementLines.some((l) => /wt\.exe/.test(l)),
      'CONTROL: the comment filter still retains real statement lines (the wt.exe launch survives it) — arms (b) and (c) below read from this list and would pass vacuously if it were empty'
    );
    const wslInvocations = statementLines.filter((l) => /(^\s*@?|[&|(]\s*|\bcall\s+|\bstart\s+)wsl(\.exe)?\b(?!path)/i.test(l));
    assert.deepEqual(wslInvocations, [], 'no bare `wsl` invocation either — the extensionless spelling is the same WSL call');

    // (c) DELETED, NOT PORTED — board 3873d33b says so explicitly, and this is
    // the arm that makes (a) non-hollow against the obvious near-miss: a bridge
    // re-implemented through the Windows node (`"C:\…\node.exe"
    // snapshot-domains-for-windows.mjs …`) contains no wsl.exe at all and
    // passes (a) and (b) untouched. Under never-cross-usage the mechanism is
    // conceptually wrong, not merely wrongly hosted.
    //
    // STATEMENT LINES ONLY, unlike arm (a) — and the asymmetry is deliberate,
    // not an oversight. Arm (a) can be absolute because the template was
    // engineered to contain zero occurrences of the literal `wsl.exe` even in
    // prose. This arm cannot: the template's `rem` block RECORDS where the
    // bridge went ("stays on disk as a hand-run legacy tool for a mixed host;
    // no longer on any launch path") and names the file to do it. That
    // provenance is exactly what a future reader needs, and deleting real
    // information to satisfy a grep is the wrong trade — measured twice on this
    // template in one day, both times a whole-file grep catching prose instead
    // of behavior. What this arm pins is that the launcher does not INVOKE the
    // script; prose may still name it, in a comment.
    //
    // An `echo` naming the script WOULD still fire this arm, and that is
    // intended: an echo is a statement, provenance belongs in a `rem`, and a
    // launch-time reminder about a hand-run tool is noise on every launch. If
    // that red ever appears, move the text into a comment rather than widening
    // the exemption — the exemption is for comments, not for anything
    // non-executing.
    const snapshotRefs = statementLines.filter((l) => /snapshot-domains-for-windows/.test(l));
    assert.deepEqual(
      snapshotRefs,
      [],
      'the domain-snapshot bridge is DELETED from the native launcher, not ported to Windows node — no STATEMENT line references the script (board 3873d33b; a rem comment recording where it went is fine and deliberately exempt)'
    );

    // (d) RE-ANCHORED. CRLF used to be proven incidentally — the wsl.exe step
    // was FOUND by splitting on '\r\n', so the evidence died with the line.
    // Checked standalone now, depending on no particular line.
    assert.ok(nat.includes('\r\n'), 'native launcher keeps CRLF line endings');
    assert.ok(!/[^\r]\n/.test(nat), 'no bare LF — every line ending is CRLF');

    // (e) NEW. The placeholder set moved with this ruling ({{MCP_ARGS}} and
    // {{MCP_MODE_NOTE}} added; {{SNAPSHOT_SCRIPT}} and {{PROJECT_DIR_POSIX}}
    // removed), so a dropped replaceAll is a LIVE risk no existing pin covers:
    // an unrendered {{…}} in a .bat is not a syntax error, it just quietly
    // launches the wrong thing. Pinned by SHAPE, not by placeholder name, so it
    // keeps holding as the set moves again. Scoped to the native launcher
    // deliberately — the other rendered artifacts are outside this slice.
    assert.ok(!nat.includes('{{'), 'no unrendered {{PLACEHOLDER}} survives in the rendered native launcher');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// SABOTAGE (ffe7c416 wsl-bridge family, arms (a)-(e) above). NOT EXECUTED by
// the author — the test-writer role holds no Bash by design, so these are the
// mutations the red gate must run, with the assertion each one must turn red:
//   CONTROL: render an empty/stub sterling-windows.bat — the CONTROL assertion
//     goes red FIRST, so the negatives below can never pass vacuously.
//   (a) re-add the snapshot statement `wsl.exe -- bash -lic "node … "` to the
//     native-launcher template — 'zero wsl.exe in the ENTIRE rendered launcher'
//     goes red. Adding it inside a REM comment reddens it too (that is the
//     point of asserting over the whole file).
//   (b) re-add the same statement spelled `wsl -- bash -lic "…"` (no
//     extension) — (a) STAYS GREEN and the wslInvocations deepEqual goes red,
//     printing the offending line. (a) and (b) are not defense in depth: each
//     catches a spelling the other misses, and (b) is the one that carries the
//     verdict for the extensionless form.
//   (c) port the bridge to Windows node — `"%WIN_NODE%" "…\scripts\snapshot-
//     domains-for-windows.mjs" --target …` — (a) and (b) both STAY GREEN
//     (no wsl token at all) and only the 'DELETED, not ported' assertion goes
//     red, printing the offending statement line. This arm alone carries that
//     verdict.
//   (c') NEGATIVE CONTROL, must stay GREEN — the narrowing this arm was given
//     after it fired on prose (measured: 44/45, this arm the only red). Add or
//     keep a `rem` block naming scripts/snapshot-domains-for-windows.mjs as the
//     hand-run legacy tool: the suite must be GREEN. If (c) reddens on a
//     comment it has been widened back to a whole-file grep and is testing
//     documentation, not behavior.
//   FILTER CONTROL: make the comment filter over-match (e.g. also treat `echo`
//     or every non-executing line as a comment) so statementLines empties —
//     the 'comment filter still retains real statement lines' control goes red
//     BEFORE (b) and (c) can pass vacuously. Without it, one filter edit
//     silently hollows two arms at once.
//   (d) write the template/render with '\n' line endings (or emit one bare-LF
//     line) — 'no bare LF' goes red; strip CRLF entirely and 'keeps CRLF line
//     endings' goes red first.
//   (e) drop one replaceAll in native-launcher generation (e.g. leave
//     {{MCP_ARGS}} unsubstituted) — 'no unrendered {{PLACEHOLDER}} survives'
//     goes red.
test('native launcher SKIPPED loudly when no Windows node is resolvable (P5), without blocking init', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    // STERLING_WIN_NODE='' forces the no-node path regardless of the machine's Windows PATH
    const r = init(dir, FRESH_FLAGS, { STERLING_WIN_NODE: '' });
    assert.equal(r.code, 0, r.stderr); // the rest of init still completes
    assert.match(r.stdout, /^sterling-windows\.bat\s+skipped\b/m, 'reports skipped, not silently absent');
    // STILL CORRECT AFTER decision foreign_ffe7c416, and deliberately so — do not
    // "modernize" this into the host-native mode note. STERLING_WIN_NODE is
    // DEFINED here (empty string), which under ffe7c416's resolution order is an
    // EXPLICIT OVERRIDE that says "use this Windows node" and names nothing. That
    // is a user who wanted a native launcher and did not get one, so the report
    // owes them the actionable fix. It is the opposite case to Part F's
    // host-native arm below, where STERLING_WIN_NODE is ABSENT, no opt-in was
    // given, and the absent launcher is a deliberate MODE that must NOT print
    // PATH advice. The two are each other's control: this assertion and Part F's
    // negation of the same string cannot both be satisfied by one code path.
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
    assert.match(rerun.stdout, /^\.claude\/agents\/librarian\.md\s+matches\b/m);
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
    tuned.delegation.max_concurrent = 7;
    writeFileSync(configPath, JSON.stringify(tuned, null, 2));
    appendFileSync(join(dir, 'CLAUDE.md'), '\n## Local additions\n- the human wrote this\n');
    appendFileSync(join(dir, '.claude', 'agents', 'librarian.md'), '\nlocal tweak\n');
    const before = snapshot(dir);
    const agentBefore = readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8');

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+differs\s+left untouched/m);
    assert.match(rerun.stdout, /^AGENTS\.md\s+ok\s+present — project-editable, never compared byte-for-byte/m);
    assert.match(rerun.stdout, /^CLAUDE\.md\s+differs\s+left untouched — merge the Sterling layer by hand/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/librarian\.md\s+differs\s+locally modified/m);
    assert.deepEqual(snapshot(dir), before, 'hand-edited files untouched');
    assert.equal(readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8'), agentBefore, 'modified agent untouched');
    // tuned declarations still drive the run: delegation came from the recorded config
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).delegation.max_concurrent, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('universal sterling domain: a config lacking it gains it on re-init (refreshed), hand-tunings preserved (decision foreign_47be4388)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    assert.equal(init(dir, FRESH_FLAGS).code, 0);
    const configPath = join(dir, '.sterling', 'config.json');
    // simulate a project init'd by older code: strip the universal tag, AND tune a field
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.stack_tags = cfg.stack_tags.filter((t) => t !== 'sterling'); // → ['node']
    cfg.delegation.max_concurrent = 7; // a hand-tuning that MUST survive the managed add
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const rerun = init(dir); // flagless re-init
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^\.sterling\/config\.json\s+refreshed\s+added the universal 'sterling' domain/m);
    const after = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(after.stack_tags, ['node', 'sterling'], 'sterling appended; declared tag kept');
    assert.equal(after.delegation.max_concurrent, 7, 'hand-tuning preserved — managed add, not regenerate-from-defaults');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('never-clobber: a pre-existing hand-written CLAUDE.md survives the FIRST init byte-for-byte; AGENTS.md is reported manual, not guessed; init completes around both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    const ownContract = '# My project\n\nHand-written build contract. Sacred.\n';
    writeFileSync(join(dir, 'CLAUDE.md'), ownContract);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, `init completes around the existing CLAUDE.md, no refusal: ${r.stderr}`);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), ownContract, 'NEVER clobbered');
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'AGENTS.md never guessed into existence from an unrecognized head');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+head is not a pristine historical render of the Sterling template \(checked \d+ revision\(s\)\) — nothing written/m);
    assert.match(r.stdout, /^CLAUDE\.md\s+manual\s+left untouched pending AGENTS\.md migration/m);
    for (const a of ['.sterling/config.json', '.sterling/sterling.db', 'sterling.bat', '.claude/agents/librarian.md']) {
      assert.ok(existsSync(join(dir, a)), `the rest of the manifest still created: ${a}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('real-world gap (Dome Farmer): a legacy full CLAUDE.md beside an ALREADY-PRESENT AGENTS.md (e.g. a gitignored Codex-derived copy, unrelated to a real migration) is reported manual for BOTH rows — never silently treated as an interrupted-run continuation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const foreignAgentsMd = '# AGENTS.md\n\n<!-- identical to CLAUDE.md -->\n\nsome pre-existing content, not a real Sterling migration\n';
    writeFileSync(join(dir, 'AGENTS.md'), foreignAgentsMd);
    const legacy = legacyMonolithClaudeMd('ensure-target', '- a project convention.\n');
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), foreignAgentsMd, 'AGENTS.md untouched — nothing written (it does NOT byte-match what migration would produce)');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), legacy, 'CLAUDE.md untouched — nothing written');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+legacy CLAUDE\.md beside an existing AGENTS\.md/m, 'AGENTS.md reported manual, not ok');
    assert.match(r.stdout, /^CLAUDE\.md\s+manual\s+legacy CLAUDE\.md beside an existing AGENTS\.md/m, 'CLAUDE.md reported manual, not differs');
    assert.match(r.stdout, /Codex-derived copy of CLAUDE\.md \(gitignored, header 'identical to CLAUDE\.md'\), delete it and rerun/, 'the loud reason names the Codex-derived-copy remedy');
    const previewPath = join(dir, '.sterling', 'agents-md-migration-preview.diff');
    assert.ok(existsSync(previewPath), 'the same migration preview diff other manual branches write is written here too');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('real-world gap (Dome Farmer), control arm: a STUB CLAUDE.md (already the @AGENTS.md import — a genuine prior migration) beside an existing AGENTS.md is UNCHANGED behaviour — AGENTS.md ok, CLAUDE.md matches, both byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const realAgentsMd = '# AGENTS.md — ensure-target\n\nreal, previously migrated content\n';
    writeFileSync(join(dir, 'AGENTS.md'), realAgentsMd);
    const stubClaudeMd = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8').replaceAll('{{PROJECT_NAME}}', 'ensure-target');
    assert.equal(stubClaudeMd.split(/\r?\n/, 1)[0], '@AGENTS.md', 'fixture sanity: this IS the stub form');
    writeFileSync(join(dir, 'CLAUDE.md'), stubClaudeMd);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+ok\b/m, 'unchanged behaviour: AGENTS.md still ok, never manual');
    assert.match(r.stdout, /^CLAUDE\.md\s+matches\b/m, 'CLAUDE.md compared byte-for-byte and matches — never manual, never rewritten');
    assert.ok(!/^AGENTS\.md\s+manual/m.test(r.stdout), 'never manual when CLAUDE.md is already the stub');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), realAgentsMd, 'AGENTS.md left untouched — byte-identical, never compared');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), stubClaudeMd, 'CLAUDE.md left untouched — byte-identical');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('real-world gap (Dome Farmer), CRLF stub recognition: a CRLF stub CLAUDE.md is still recognized as already-migrated (first line is @AGENTS.md regardless of its own EOL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const realAgentsMd = '# AGENTS.md — ensure-target\r\n\r\nreal, previously migrated content\r\n';
    writeFileSync(join(dir, 'AGENTS.md'), realAgentsMd);
    const stubClaudeMd = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8').replaceAll('{{PROJECT_NAME}}', 'ensure-target').replace(/\n/g, '\r\n');
    writeFileSync(join(dir, 'CLAUDE.md'), stubClaudeMd);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/^AGENTS\.md\s+manual/m.test(r.stdout), 'a CRLF stub is still recognized — never manual');
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), realAgentsMd, 'AGENTS.md untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — interrupted-run continuation: AGENTS.md already holds exactly what migration would write, CLAUDE.md is still legacy → only CLAUDE.md is rewritten, reported migrated (resumed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '- Ship on Tuesdays only.\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail);
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    // First run: a real, successful migration produces the real AGENTS.md.
    const first = init(dir, FRESH_FLAGS);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^AGENTS\.md\s+migrated\b/m);
    const realAgentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    // Simulate an interrupted run: the AGENTS.md write landed but the CLAUDE.md write never did —
    // CLAUDE.md reverts to its legacy form, AGENTS.md keeps its real migrated content.
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const second = init(dir);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^AGENTS\.md\s+ok\s+already present — byte-identical to what migration would write; treated as an interrupted run, resumed/m);
    assert.match(second.stdout, /^CLAUDE\.md\s+migrated \(resumed\)/m);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), realAgentsMd, 'AGENTS.md untouched, byte-identical');
    assert.match(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md\n/, 'CLAUDE.md rewritten as the fresh Sterling-layer import');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// A real legacy pre-split CLAUDE.md, as init generated it before this project committed the
// AGENTS.md/CLAUDE.md split — rendered from a REAL historical (git-committed) revision of the
// monolithic templates/target-claude-md.md, the same source historicalHeadSegmentSets() in
// init-impl.mjs walks. NOT pinned to HEAD (Sol re-check finding 1): once the split lands, HEAD
// IS the split template and carries no {{CONVENTIONS_SECTION}} at all, so `git show HEAD:...`
// would silently stop testing anything. Instead walk `git log` NEWEST FIRST and take the first
// blob that still contains the {{CONVENTIONS_SECTION}} token — the same selection
// historicalHeadSegmentSets() makes for a real legacy project — and fail loudly if none exists.
// NO MARKER: the tail is whatever the project wrote where {{CONVENTIONS_SECTION}} was — nothing
// more is required of it (Sol re-spec, corrected after Dome Farmer's tail turned out to be a
// hand-written bold ruling, not a Sterling-emitted marker line).
function pristineMonolithBlob() {
  const log = spawnSync('git', ['log', '--format=%H', '--', 'templates/target-claude-md.md'], { cwd: root, encoding: 'utf8' });
  assert.equal(log.status, 0, `git log -- templates/target-claude-md.md: ${log.stderr}`);
  const shas = log.stdout.split('\n').filter(Boolean);
  for (const sha of shas) {
    const show = spawnSync('git', ['show', `${sha}:templates/target-claude-md.md`], { cwd: root, encoding: 'utf8' });
    if (show.status !== 0) continue;
    if (show.stdout.includes('{{CONVENTIONS_SECTION}}')) return { sha, text: show.stdout };
  }
  assert.fail('no historical revision of templates/target-claude-md.md contains {{CONVENTIONS_SECTION}} — the fixture has nothing pre-split to render from');
}
function legacyMonolithClaudeMd(projectName, tail, opts = {}) {
  const { sha, text } = pristineMonolithBlob();
  // PROOF this is picking a genuinely OLD blob, not silently falling back to the working tree
  // (Sol re-check finding 1): post-split, the working-tree template carries no
  // {{CONVENTIONS_SECTION}} at all, so the chosen historical blob MUST differ from it.
  const workingTree = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8');
  assert.notEqual(text, workingTree, `chosen historical blob (${sha}) must differ from the current working-tree template, which is the post-split one`);
  const filled = text
    .replaceAll('{{PROJECT_NAME}}', projectName)
    .replaceAll('{{STACK_TAGS}}', opts.stackTags ?? 'node, sterling')
    .replaceAll('{{TOOLCHAINS}}', opts.toolchains ?? 'node (**/*.mjs)')
    .replaceAll('{{DOMAINS}}', opts.domains ?? '~/.sterling/domains/node/, ~/.sterling/domains/sterling/ — created lazily on first need (§2.3)')
    .replaceAll('{{BACKUP_PATH}}', opts.backupPath ?? 'configured — see `.sterling/config.json` → `backup_path` (machine-local, deliberately not restated here)');
  assert.ok(filled.includes('{{CONVENTIONS_SECTION}}'), 'fixture sanity: the conventions placeholder is still there to replace');
  const eol = opts.eol ?? '\n';
  const body = filled.replace('{{CONVENTIONS_SECTION}}', tail);
  return eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
}

test('real-world gap (Dome Farmer): a legacy tail containing a dead-term word ("wave", as in enemy waves — project prose, not Sterling\'s retired codename) migrates cleanly; the dead-term lint never judges project text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '⚠ **EVERYTHING BELOW THIS LINE IS ABOUT ENSURE-TARGET, NEVER ABOUT STERLING** (user ruling).\n\n- Balance the next wave of enemies before shipping; a wave that spikes too hard is a defect.\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail);
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, `must not crash on a project's own "wave" text: ${r.stderr}`);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated\b/m, 'migration proceeds — the tail is exempt from the dead-term lint');
    assert.match(r.stdout, /^CLAUDE\.md\s+migrated\b/m);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes(tail), 'the tail carrying "wave" is byte-identical, untouched by the lint');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('dead-term lint still fails loudly on the TEMPLATE\'s own prose (unit-tested against the shared findDeadTerms helper init-impl.mjs\'s assertNoDeadTerms wraps: the real templates/target-agents-md.md and templates/target-claude-md.md heads are asserted clean, and a planted codename is still caught by the same function)', () => {
  // init resolves its own plugin root from import.meta.url, not from any env seam this test
  // harness exposes, so pointing a live init run at a doctored template dir is not available
  // here (documented, per the brief) — this covers the exact function init-impl.mjs's
  // assertNoDeadTerms wraps, against both the real shipped template text (must stay clean) and a
  // planted dead term (must be caught), rather than reimplementing the check's logic.
  const agentsTemplate = readFileSync(join(root, 'templates', 'target-agents-md.md'), 'utf8');
  const claudeTemplate = readFileSync(join(root, 'templates', 'target-claude-md.md'), 'utf8');
  assert.deepEqual(findDeadTerms(agentsTemplate), [], 'the real AGENTS.md template is currently clean');
  assert.deepEqual(findDeadTerms(claudeTemplate), [], 'the real CLAUDE.md template is currently clean');
  const doctored = agentsTemplate.replace('## Core principles', '## Core principles — brought to you by the Forge codename\n');
  const hits = findDeadTerms(doctored);
  assert.ok(hits.length > 0 && hits.some((h) => h.term === 'Forge'), 'a dead term planted in TEMPLATE prose is still caught');
});

test('boundary fix (Sol re-check): a historical head with an EXTRA LINE inserted right after a placeholder value (before the next literal) is refused as manual — never silently absorbed into the placeholder and migrated with that line lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    // Insert an extra line immediately after the rendered {{PROJECT_NAME}} value (the FIRST
    // placeholder in the template head) — indexOf-without-a-newline-guard would treat that
    // inserted line as if it were part of the placeholder's own value and still match.
    const injected = '\nA HUMAN-INSERTED LINE RIGHT AFTER THE PROJECT NAME PLACEHOLDER, BEFORE THE NEXT LITERAL.';
    const legacy = legacyMonolithClaudeMd('ensure-target', '- tail\n').replace('ensure-target', `ensure-target${injected}`);
    assert.ok(legacy.includes(injected), 'fixture sanity: the injected line landed in the rendered head');
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'never migrated — the inserted line must not be silently absorbed and dropped');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+head is not a pristine historical render/m);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), legacy, 'CLAUDE.md left untouched — the inserted line is preserved because nothing was migrated');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration, Dome-Farmer-shaped: a historical head with arbitrary project facts, followed by a hand-written BOLD RULING (never a marker line) as the tail — migrates, tail byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '⚠ **EVERYTHING BELOW THIS LINE IS ABOUT ENSURE-TARGET, NEVER ABOUT STERLING** (user ruling, 2026-09-01, verbatim: "keep this project instructions separate").\n\n- Uses `knowledge_query` before every design (mentions a Sterling tool on purpose, to prove the flag).\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail);
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated \(1 flagged\)/m, 'the knowledge_query line is flagged, migration still proceeds');
    assert.match(r.stdout, /^CLAUDE\.md\s+migrated\s+re-rendered as the Sterling layer/m);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(agentsMd.includes(tail), 'the bold ruling tail carried byte-identical — no marker involved');
    assert.match(claudeMd, /^@AGENTS\.md\n/, 'CLAUDE.md re-rendered as the fresh Sterling-layer import');
    assert.ok(!claudeMd.includes('EVERYTHING BELOW'), 'the project-owned tail moved to AGENTS.md, not duplicated into CLAUDE.md');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — a head that does NOT match any historical template render is refused (P5): nothing written, a preview diff is left for the human', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const handTuned = legacyMonolithClaudeMd('ensure-target', '- hand tuning\n').replace('Durable conventions and project facts.', 'Durable conventions and project facts (hand-edited preamble).');
    writeFileSync(join(dir, 'CLAUDE.md'), handTuned);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'never guessed a split from an unrecognized head');
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), handTuned, 'CLAUDE.md left untouched');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+head is not a pristine historical render of the Sterling template \(checked \d+ revision\(s\)\)/m);
    assert.match(r.stdout, /^CLAUDE\.md\s+manual\s+left untouched pending AGENTS\.md migration/m);
    const previewPath = join(dir, '.sterling', 'agents-md-migration-preview.diff');
    assert.ok(existsSync(previewPath), 'a preview diff is left for the human to review');
    const preview = readFileSync(previewPath, 'utf8');
    assert.ok(preview.length > 0, 'preview diff is non-empty');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — an OLDER rendering scheme (placeholder values differing from what this project declares today) still migrates: the boundary match is on prose structure, not on today\'s facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '- an older project fact set.\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail, {
      stackTags: 'python, sterling', // this project's OLD stack, before it moved to node
      toolchains: 'python (**/*.py)',
      domains: '~/.sterling/domains/python/, ~/.sterling/domains/sterling/ — created lazily on first need (§2.3)',
      backupPath: '(opted out — recorded)',
    });
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS); // FRESH_FLAGS declares node/sterling today — deliberately different
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated\b/m, 'migrates despite the value mismatch — only the prose structure had to match');
    assert.match(r.stdout, /^CLAUDE\.md\s+migrated\b/m);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('an older project fact set.'), 'tail carried');
    assert.ok(agentsMd.includes('node, sterling'), 'AGENTS.md renders TODAY\'S facts, not the legacy ones');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — CRLF: the tail bytes are unchanged (still CRLF) and the freshly-rendered head is converted to the legacy file\'s own EOL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tail = '⚠ **EVERYTHING BELOW THIS LINE IS ABOUT ENSURE-TARGET** (bold ruling, not a marker).\r\n\r\n- CRLF project convention.\r\n- second line.\r\n';
    const legacy = legacyMonolithClaudeMd('ensure-target', tail.replace(/\r\n/g, '\n'), { eol: '\r\n' });
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    const r = init(dir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AGENTS\.md\s+migrated\b/m);
    const agentsMdBytes = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMdBytes.includes(tail), 'tail carried with its ORIGINAL CRLF endings, byte-for-byte — no marker involved');
    const headPortion = agentsMdBytes.slice(0, agentsMdBytes.indexOf('⚠ **EVERYTHING BELOW'));
    assert.ok(headPortion.includes('\r\n'), 'the freshly-rendered head was converted to the legacy file\'s own CRLF convention');
    assert.ok(!/[^\r]\n/.test(headPortion), 'no bare LF survives in the head portion');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('legacy migration — git unavailable (no history to verify against): reported manual naming the missing history, never migrated blind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ensure-'));
  try {
    mkdirSync(dir, { recursive: true });
    const legacy = legacyMonolithClaudeMd('ensure-target', '- tail\n');
    writeFileSync(join(dir, 'CLAUDE.md'), legacy);
    // Hide `git` from the CHILD init process only — makes historicalHeadSegmentSets() fail to
    // resolve any history, which must never be silently treated as "no match".
    const r = init(dir, FRESH_FLAGS, { PATH: '/nonexistent-bin-dir-for-this-test-only' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'never migrated blind when history cannot be verified');
    assert.match(r.stdout, /^AGENTS\.md\s+manual\s+git log failed for templates\/target-claude-md\.md/m, 'the missing-history reason is named, not folded into the generic non-matching-head message');
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
    unlinkSync(join(dir, '.claude', 'agents', 'librarian.md'));

    const rerun = init(dir);
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /^sterling\.bat\s+created\b/m);
    assert.match(rerun.stdout, /^\.claude\/agents\/librarian\.md\s+created\b/m);
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
  const src = readFileSync(join(root, 'scripts', 'init-impl.mjs'), 'utf8');
  assert.ok(
    src.includes("args: [fwd(mcpServerEntry), '--store', '${CLAUDE_PROJECT_DIR}/.sterling/sterling.db']"),
    'plugin-scope entry keeps the bare form — plugin configs substitute it unconditionally'
  );
  assert.ok(
    src.includes("'--store', '${CLAUDE_PROJECT_DIR:-.}/.sterling/sterling.db'"),
    'the native-claude win config uses the ${CLAUDE_PROJECT_DIR:-.} default — bare form passes through --mcp-config literally (the phantom store)'
  );
});

test('init notes the project in the shared registry (decision foreign_8f9e6db2)', () => {
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
      assert.deepEqual(me.stack_tags, ['node', 'sterling'], 'declared tag + the auto-injected universal sterling domain (decision 47be4388)'); // not-a-citation: fixture id
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
    assert.ok(config.models && config.models.librarian, 'init wrote config.models with a librarian entry');

    for (const name of ['librarian.md', 'scout.md']) {
      const installed = readFileSync(join(dir, '.claude', 'agents', name), 'utf8');
      const fm = installed.match(/^---\n([\s\S]*?)\n---/)[1];
      assert.ok(!installed.includes('{{'), `${name}: no substitution token survives install`);
      assert.match(fm, /^model: claude-[a-z0-9.\-]+$/m, `${name}: model resolved to a concrete pinned claude- id`);
      assert.match(fm, /^effort: [a-z]+$/m, `${name}: effort resolved to a concrete value`);
    }

    // librarian resolves to the shipped-default librarian model — config.models is
    // the authoritative source at install (matches config.test.ts's shipped default).
    const librarianFm = readFileSync(join(dir, '.claude', 'agents', 'librarian.md'), 'utf8').match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(librarianFm, /^model: claude-sonnet-5$/m, 'librarian installs on the shipped-default librarian model (config.models authoritative)');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// =============================================================================
// Part C (sparring-partner slice 1) — codex MCP-server wiring through init's
// plugin-repo branch (decision foreign_cd019e0b, concept slug
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
//     CORRECTED (containment fix): this seam is no longer only a COMPARISON —
//     init also resolves the plugin MCP config's PATH from it (init-impl.mjs's
//     STERLING_PLUGIN_ROOT_MATCH resolution, moved out of scripts/init.mjs by the
//     bootstrap/impl split), so
//     leaving it unset does not merely close a branch, it aims the ensure at the
//     REAL clone. Every helper in this file therefore defaults it to a scratch
//     directory; see the containment note above the helpers.
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

// =============================================================================
// Part D (board 43051819, article sparring-partner) — native-Windows codex
// probe wiring into sterling-mcp-win.json. SPEC-ONLY: init.mjs's implementation
// body was NOT read to author these — it landed before its tests because H5
// correctly denied the implementing agent test-file writes; these pins are
// authored against the dispatch spec and must be honored as written.
//
// CORRECTED PREMISE: sterling-mcp-win.json is PLUGIN-REPO-ONLY, exactly like
// sterling-mcp.json — it is NOT generated whenever the native launcher is (an
// earlier version of this file's five probe-behavior pins below wrongly
// assumed a per-project copy; an implementer correctly refused to move
// production code to satisfy that error). templates/launcher-win-native.bat:34
// hardcodes --mcp-config against
// "{{WIN_PLUGIN_DIR}}\.claude-plugin\sterling-mcp-win.json" — the ONE
// plugin-repo clone's copy every project's native launcher points at (matches
// the standing architecture: every project launches with --plugin-dir pointing
// at the single clone). init.mjs correctly gates that file's generation to
// fwd(target) === fwd(pluginRootMatch), identical to how it gates
// sterling-mcp.json — a per-project copy would be dead weight nothing reads.
// Every probe-behavior case below therefore sets STERLING_PLUGIN_ROOT_MATCH:
// dir so the generation block actually runs; a dedicated pin (immediately
// after the control arm) proves the omission directly in an ordinary
// consuming project that never sets it.
//
// Seam: STERLING_CODEX_PROBE_WIN — unset/'' via the init() helper's own default
// = forced 'absent' (see the load-bearing default added to init() above); 'ok'
// = force probe success; 'absent' = force reason 'binary-absent'; 'not-logged-in'
// = force reason 'not-logged-in'; any other value = init fails loud (mirrors
// STERLING_CODEX_PROBE exactly).
// =============================================================================

test('CONTROL ARM — the WSL and native-Windows codex probes are independently keyed: forcing one to fail while the other succeeds in the SAME init run wires codex into exactly one file, never both/neither', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    const r = init(dir, FRESH_FLAGS, {
      STERLING_PLUGIN_ROOT_MATCH: dir, // generates sterling-mcp.json too, in the same run
      STERLING_CODEX_PROBE: 'ok', // WSL probe succeeds
      STERLING_CODEX_PROBE_WIN: 'absent', // native-Windows probe forced to fail
    });
    assert.equal(r.code, 0, r.stderr);
    const wsl = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'sterling-mcp.json'), 'utf8'));
    const win = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'sterling-mcp-win.json'), 'utf8'));
    assert.deepEqual(wsl.mcpServers.codex, { command: 'codex', args: ['mcp-server'] }, 'WSL file gets codex — its own probe (STERLING_CODEX_PROBE) succeeded');
    assert.ok(!('codex' in win.mcpServers), 'native-Windows file gets NO codex — its own probe (STERLING_CODEX_PROBE_WIN) was forced to fail, independent of the WSL probe succeeding in the SAME run');
    assert.ok(win.mcpServers.sterling, 'win file still generated sterling-only');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: make the win branch read STERLING_CODEX_PROBE (reusing the WSL
// seam/flag) instead of its own STERLING_CODEX_PROBE_WIN — the win file would
// then also gain a codex entry despite being forced absent, and the
// `!('codex' in win.mcpServers)` assertion goes red.

test('sparring-partner-win: outside the plugin repo (no STERLING_PLUGIN_ROOT_MATCH), sterling-mcp-win.json is NOT generated at all — plugin-repo-only, exactly like sterling-mcp.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    // No STERLING_PLUGIN_ROOT_MATCH: this fixture is an ordinary consuming
    // project, not the plugin-repo clone. The probe is forced 'ok' so the
    // omission below is provably the plugin-root gate, not a probe-driven
    // skip — if generation were probe-gated only, 'ok' would produce the file.
    const r = init(dir, FRESH_FLAGS, { STERLING_CODEX_PROBE_WIN: 'ok' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(dir, '.claude-plugin', 'sterling-mcp-win.json')), 'no per-project sterling-mcp-win.json — generation is gated to the plugin-repo branch (fwd(target) === fwd(pluginRootMatch)), identical to sterling-mcp.json; a per-project copy would be dead weight nothing reads (templates/launcher-win-native.bat:34 always points at the single plugin-repo clone)');
    // the native launcher itself is still produced — only the win MCP config is plugin-repo-only
    assert.ok(existsSync(join(dir, 'sterling-windows.bat')), 'native launcher still generated in an ordinary consuming project');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: gate sterling-mcp-win.json generation on "native launcher present"
// (STERLING_WIN_NODE resolvable, which the init() helper always sets) instead
// of fwd(target) === fwd(pluginRootMatch) — the file would be written in this
// ordinary consuming-project fixture and the `!existsSync(...)` assertion goes
// red.

test('sparring-partner-win case 1 (CONTROL ARM for case 9 below): probe OK with NO resolved path falls back to the bare CODEX_MCP_ENTRY — sterling entry preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    // Env note: STERLING_CODEX_WIN_PATH is pinned OFF here rather than merely
    // left unset — the init() helper spreads process.env into the child, so a
    // developer with that variable exported would otherwise silently turn this
    // control arm into a second copy of case 9. `undefined` is the deletion
    // form: node:child_process omits env keys whose value is undefined when it
    // builds the child's envPairs, so this removes the inherited key rather
    // than passing the string "undefined".
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'ok', STERLING_CODEX_WIN_PATH: undefined });
    assert.equal(r.code, 0, r.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    assert.ok(existsSync(mcpPath), 'native-Windows MCP config generated (plugin-repo branch)');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(mcp.mcpServers && mcp.mcpServers.sterling, 'sterling entry present alongside codex');
    // COMMENT CORRECTED per decision foreign_ffe7c416 (host-native init, user-decided
    // 2026-08-27). This assertion's original message claimed the win entry is
    // "the same entry object the WSL branch wires, not a win-specific variant".
    // That is now INVERTED: defect (2) of the ruling is that discarding the
    // resolved absolute path left codex-on-Windows unable to spawn after a
    // SUCCESSFUL probe (npm ships codex.cmd; research_finding foreign_0c712d94 measured
    // PATH to be an unreliable presence oracle on the target host). So the win
    // entry IS win-specific WHENEVER the probe resolved a path — case 9 below
    // pins exactly that. What survives is the FALLBACK: a probe that resolved
    // no path still yields the shipped bare entry, which is what this arm is
    // now for. It must pass for the OPPOSITE reason to case 9, and together
    // they forbid both defects — dropping the path, and stamping some path on
    // unconditionally.
    assert.deepEqual(mcp.mcpServers.codex, { command: 'codex', args: ['mcp-server'] }, 'no path resolved -> the bare CODEX_MCP_ENTRY fallback, unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: wire a different literal on the win branch (e.g. omit 'args', or
// hardcode a duplicated/altered command string) instead of reusing
// CODEX_MCP_ENTRY — the deepEqual against {command:'codex', args:['mcp-server']}
// goes red.
// SABOTAGE (the control-arm direction): make the win branch ALWAYS substitute
// some absolute path (e.g. default to a hardcoded %LOCALAPPDATA% codex path when
// the probe carried none) — case 9 would stay green while this arm goes red,
// which is the discrimination the pair exists to buy.

// -----------------------------------------------------------------------------
// WHY THE WSL PROBE IS FORCED 'ok' IN THIS FAMILY (cases 2, 3 and 2+3)
//
// These three read the codex skip line by FIRST MATCH — `report.match(/^codex mcp:
// skipped — .+/m)` — and every one of them opens the plugin-repo gate
// (STERLING_PLUGIN_ROOT_MATCH: dir), so the run ensures BOTH MCP configs and BOTH
// codex probes can emit a skip line, the WSL one first. Whenever the WSL probe also
// fails, first-match therefore captures the WSL line and the win line is never read:
// case 2+3 collapses to two identical strings (a red on notEqual), and — worse,
// because it is SILENT — cases 2 and 3 go green off a line the win branch did not
// write, so their stated sabotage (drop the win branch's codexSkipLine push) stops
// reddening them. That is the hollow shape, arrived at with no assertion changed.
//
// Forcing the WSL probe to SUCCEED removes its skip line entirely, so the run emits
// exactly ONE skip line and it is unambiguously the win one — the line these pins
// were written to read. This is a fix at the SEAM, not at the assertion: no
// assertion text, comparison or meaning below is altered.
//
// It is also strictly stronger than what stood here before. These tests previously
// left the WSL seam unset, i.e. ran the REAL `codex login status`, so the pins only
// discriminated on a machine where Codex happens to be installed AND logged in; on
// any other machine they were already collapsing or hollow, silently. Forcing 'ok'
// makes the discrimination machine-independent and spawns no real probe.
// -----------------------------------------------------------------------------
test('sparring-partner-win case 2: probe forced absent -> no codex entry; loud actionable skip line; file still generated sterling-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    // STERLING_CODEX_PROBE (the NON-win seam) is forced 'ok' here, and it is
    // LOAD-BEARING for the skip-line assertions below — see WHY THE WSL PROBE IS
    // FORCED 'ok' IN THIS FAMILY, above this test.
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'ok', STERLING_CODEX_PROBE_WIN: 'absent' });
    assert.equal(r.code, 0, r.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    assert.ok(existsSync(mcpPath), 'win MCP config still generated despite the codex skip — P5: a missing Codex is a loud probe absence, never a silent omission of the whole file');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(!('codex' in mcp.mcpServers), 'no codex key added when the win probe reports binary-absent');
    assert.ok(mcp.mcpServers.sterling, 'sterling entry still present — file generated sterling-only');
    const report = r.stdout + r.stderr;
    const line = report.match(/^codex mcp: skipped — .+/m);
    assert.ok(line, 'loud skip line present (reused codexSkipLine, not a bare prefix)');
    assert.ok(line[0].length > 'codex mcp: skipped — '.length, 'skip line carries actionable content beyond the bare prefix');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: drop the codexSkipLine push on the win branch's failure path (wire
// nothing, report nothing) — the skip-line `line` match goes null and the
// `assert.ok(line, ...)` goes red; or make the win branch bail out of writing
// the whole file on probe failure instead of emitting it sterling-only — the
// `existsSync(mcpPath)` assertion goes red.

test('sparring-partner-win case 3: probe forced not-logged-in -> no codex entry; loud actionable skip line; file still generated sterling-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    // WSL seam forced 'ok' — load-bearing, same reason as case 2 (see the note above it).
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE: 'ok', STERLING_CODEX_PROBE_WIN: 'not-logged-in' });
    assert.equal(r.code, 0, r.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    assert.ok(existsSync(mcpPath), 'win MCP config still generated despite the codex skip');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(!('codex' in mcp.mcpServers), 'no codex key added when the win probe reports not-logged-in');
    assert.ok(mcp.mcpServers.sterling, 'sterling entry still present — file generated sterling-only');
    const report = r.stdout + r.stderr;
    const line = report.match(/^codex mcp: skipped — .+/m);
    assert.ok(line, 'loud skip line present');
    assert.ok(line[0].length > 'codex mcp: skipped — '.length, 'skip line carries actionable content beyond the bare prefix');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: drop the codexSkipLine push on the win branch's not-logged-in path
// (report nothing) — the `line` match goes null and `assert.ok(line, ...)`
// goes red.

test('sparring-partner-win cases 2+3 together: the binary-absent and not-logged-in win skip lines are distinguishable from each other (never one generic message)', () => {
  const dirAbsent = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  const dirLogin = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    // WSL seam forced 'ok' on BOTH arms — load-bearing, same reason as case 2 (see the
    // note above it): it is the ONLY thing making the line read below the WIN line.
    // Identical on both arms, so it cannot itself be the source of the difference the
    // notEqual asserts — the arms differ in STERLING_CODEX_PROBE_WIN and nothing else.
    const rAbsent = init(dirAbsent, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dirAbsent, STERLING_CODEX_PROBE: 'ok', STERLING_CODEX_PROBE_WIN: 'absent' });
    const rLogin = init(dirLogin, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dirLogin, STERLING_CODEX_PROBE: 'ok', STERLING_CODEX_PROBE_WIN: 'not-logged-in' });
    assert.equal(rAbsent.code, 0, rAbsent.stderr);
    assert.equal(rLogin.code, 0, rLogin.stderr);
    const lineAbsent = (rAbsent.stdout + rAbsent.stderr).match(/^codex mcp: skipped — .+/m);
    const lineLogin = (rLogin.stdout + rLogin.stderr).match(/^codex mcp: skipped — .+/m);
    assert.ok(lineAbsent, 'binary-absent case reports a skip line');
    assert.ok(lineLogin, 'not-logged-in case reports a skip line');
    assert.notEqual(lineAbsent[0], lineLogin[0], 'the two win-probe failure reasons produce distinguishable skip lines, not one generic message');
  } finally {
    rmSync(dirAbsent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dirLogin, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: pass a single hardcoded reason (or the raw probe object without its
// discriminating `reason` field) into codexSkipLine on the win call site,
// regardless of which failure probeCodexWin actually returned — lineAbsent and
// lineLogin become byte-identical and the notEqual assertion goes red.

test('sparring-partner-win case 5: an unrecognized STERLING_CODEX_PROBE_WIN value fails init loud, never silently proceeding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'garbage' });
    assert.notEqual(r.code, 0, 'an unrecognized win-probe override value must fail init (nonzero exit), never proceed as if unset');
    assert.ok((r.stderr ?? '').length > 0, 'the loud failure is accompanied by a diagnostic on stderr, not a silent nonzero');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: treat any unrecognized STERLING_CODEX_PROBE_WIN value as equivalent
// to unset (fall through to the real probe or to a default forced outcome)
// instead of failing loud — r.code stays 0 and the notEqual assertion goes red.

test('sparring-partner-win case 6: managed refresh — a pre-existing sterling-only sterling-mcp-win.json gains a codex entry once the NATIVE-WINDOWS probe later succeeds; sterling entry unchanged; reported "refreshed" naming codex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    // Step 1: the fixture EVERY existing clone is actually in — a sterling-only
    // win config, as an earlier run (probe absent, e.g. no Windows codex install)
    // produced. This is not a hypothetical: the plugin repo's own checked-out
    // .claude-plugin/sterling-mcp-win.json is exactly this shape.
    const first = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'absent' });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    const before = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(before.mcpServers && before.mcpServers.sterling, 'precondition: sterling-only win config exists after the absent-probe fresh init');
    assert.ok(!('codex' in before.mcpServers), 'precondition: no codex entry yet');

    // Step 2: flagless re-run with the native-Windows probe now succeeding — the
    // managed refresh. WITHOUT it the arm is unreachable on every existing clone:
    // the compare reports 'differs — left untouched' forever and the only route to
    // a codex entry is deleting the file by hand.
    const rerun = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'ok' });
    assert.equal(rerun.code, 0, rerun.stderr);

    const after = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(after.mcpServers.sterling, before.mcpServers.sterling, 'sterling entry (Windows node command + store arg) unchanged by the managed refresh');
    assert.deepEqual(after.mcpServers.codex, { command: 'codex', args: ['mcp-server'] }, 'codex entry added, matching CODEX_MCP_ENTRY exactly — the same entry the WSL branch wires');

    const line = rerun.stdout.match(/^\.claude-plugin\/sterling-mcp-win\.json\s+.+$/m);
    assert.ok(line, 'a report line exists for the native-Windows MCP config on the managed-refresh re-run');
    assert.match(line[0], /\brefreshed\b/, "the report line says 'refreshed'");
    assert.ok(!/\bdiffers\b/.test(line[0]), "the report line does NOT say 'differs' on a managed refresh");
    assert.ok(!/\bcreated\b/.test(line[0]), "the report line does NOT say 'created' — the file already existed");
    assert.match(line[0], /codex/i, 'the refresh detail names codex');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (one line): delete the `isManagedCodexAddWin` branch in init.mjs's
// native-Windows else-block so it falls straight through to the 'differs' push —
// the codex deepEqual and the /refreshed/ match both go red. The guard carrying
// the verdict is `isManagedCodexAddWin` in scripts/init-impl.mjs, NOT the create-path
// `withCodexEntry` call (win case 1 already covers that one, and it stays green
// under this sabotage — which is how the two are told apart).

test('sparring-partner-win case 7: never-overwrite holds through the native-Windows codex refresh — a hand-edited sterling entry blocks the write; file untouched byte-for-byte, reported "differs"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    const first = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'absent' });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');

    const handEdited = JSON.parse(readFileSync(mcpPath, 'utf8'));
    handEdited.mcpServers.sterling.args = [...handEdited.mcpServers.sterling.args, '--hand-tuned-flag'];
    writeFileSync(mcpPath, JSON.stringify(handEdited, null, 2));
    const beforeBytes = readFileSync(mcpPath, 'utf8');

    const rerun = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'ok' });
    assert.equal(rerun.code, 0, rerun.stderr);

    assert.equal(readFileSync(mcpPath, 'utf8'), beforeBytes, 'never-overwrite: a hand-edited sterling entry blocks the managed codex refresh — file untouched byte-for-byte');
    const line = rerun.stdout.match(/^\.claude-plugin\/sterling-mcp-win\.json\s+.+$/m);
    assert.ok(line, 'a report line exists for the native-Windows MCP config on the guarded re-run');
    assert.match(line[0], /\bdiffers\b/, "the report line says 'differs' when the sterling entry was hand-edited");
    assert.ok(!/\brefreshed\b/.test(line[0]), "the report line does NOT say 'refreshed' when blocked by the never-overwrite guard");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: drop the `canonical(existingWin) === canonical(desiredWinMinusCodex)`
// conjunct from isManagedCodexAddWin (keep only the "codex key missing" test) —
// the hand-edited file gets clobbered and the byte-equality assertion goes red.

test('sparring-partner-win case 8 (CONTROL ARM for case 6): re-init with the win probe STILL absent leaves the sterling-only file reported "matches", never "refreshed" — the refresh is probe-driven, not an unconditional rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  try {
    const first = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'absent' });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    const beforeBytes = readFileSync(mcpPath, 'utf8');

    const rerun = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'absent' });
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.equal(readFileSync(mcpPath, 'utf8'), beforeBytes, 'no write at all when the probe still fails');
    const line = rerun.stdout.match(/^\.claude-plugin\/sterling-mcp-win\.json\s+.+$/m);
    assert.ok(line, 'a report line exists');
    assert.match(line[0], /\bmatches\b/, "an unchanged sterling-only file with a failing probe reports 'matches' — this arm must pass for the OPPOSITE reason to case 6");
    assert.ok(!/\brefreshed\b/.test(line[0]), "never 'refreshed' without a succeeding probe");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: drop the `codexProbeWin.ok` conjunct from isManagedCodexAddWin — with
// a failing probe desiredWin has no codex, so this case still reports 'matches'
// and stays green; it goes red only if the refresh becomes an unconditional
// rewrite. That is exactly the discrimination this control arm buys.

// =============================================================================
// Part F (decision foreign_ffe7c416 — host-native init with a dev-machine escape hatch,
// USER-DECIDED 2026-08-27; boards 99f53af8 / 4c3a8e59 / 3873d33b). SPEC-ONLY:
// scripts/init-impl.mjs's implementation body was NOT read to author these.
//
// THE RULING, in the two clauses these pins hold:
//
//   (1) HOST-NATIVE IS THE DEFAULT MODE, and a missing Windows launcher on a
//       non-Windows host is that MODE, not a broken PATH. ffe7c416 defect (1):
//       `where.exe node` gated BOTH the native launcher AND the Windows MCP
//       config, and research_finding foreign_0c712d94 MEASURED node to be absent from
//       the Windows PATH on the very host this must serve — so one PATH miss
//       cost a Windows user both artifacts. The resolution order is now
//       STERLING_WIN_NODE (honored on KEY PRESENCE, defined-even-empty) ->
//       process.platform === 'win32' ? process.execPath -> `where.exe node`
//       ONLY under an explicit opt-in -> otherwise nothing. "Otherwise nothing"
//       is a deliberate, reported outcome.
//
//   (2) THE ESCAPE HATCH IS EXPLICIT. The dual-context mode exists for THIS
//       authoring machine and is opted into deliberately (--dual-context or
//       STERLING_DUAL_CONTEXT=1) — ffe7c416 rejected "full host-native with no
//       exception" precisely because it would degrade the one machine Sterling
//       is built on.
//
// WHY THE MODE NOTE IS PINNED BY ITS MODE NAME. The ruling requires each init
// report to state which mode it ran in, exactly once. This suite therefore
// treats "a mode note" as a report line naming one of the ruling's OWN two mode
// names — `host-native` or `dual-context` (ffe7c416's title and statement). A
// note that does not name its mode is not a mode note: it leaves a user with a
// missing launcher unable to tell a deliberate mode from a failure, which is the
// entire user-visible point of the ruling. The literals come from the ruling and
// the dispatch spec, not from this file's invention; the surrounding wording is
// deliberately unpinned.
//
// WHAT IS NOT PINNED HERE, AND WHY — a documented coverage gap, not an oversight:
//   • The `process.platform === 'win32' -> process.execPath` arm has NO
//     injection seam by design, so it cannot be exercised from a Linux/WSL test
//     run. Faking one would test the fake. It is owed a real native-Windows
//     sitting; note that research_finding foreign_0c712d94 measured the h17 suite
//     returning 0 pass / 36 SKIP on that host, so a pin added "for Windows"
//     today would be permanently skipped, i.e. hollow by construction. The
//     host-native arms below are therefore explicitly skipped ON win32 rather
//     than silently passing for the wrong reason there.
//   • Whether a launcher actually APPEARS under the dual-context opt-in depends
//     on the running machine's Windows PATH (measured absent on this one), so
//     the opt-in arm pins the NOTE and never the artifact. An artifact assertion
//     there would be machine-dependent — green here, red on a colleague's box,
//     for reasons having nothing to do with the code.
// =============================================================================

// init() with STERLING_WIN_NODE genuinely ABSENT. Not the same thing as the
// ''-valued case at the top of this file: ffe7c416 honors STERLING_WIN_NODE on
// KEY PRESENCE, so '' is an EXPLICIT (empty) override and absence is the
// host-native default. Written as its own helper rather than by threading an
// undefined through init(), so the deletion is visible at the call site.
function initHostNative(dir, args = [], extraEnv = {}) {
  if ('STERLING_PLUGIN_ROOT_MATCH' in extraEnv && extraEnv.STERLING_PLUGIN_ROOT_MATCH === undefined) {
    throw new Error('initHostNative(): STERLING_PLUGIN_ROOT_MATCH must never be deleted — see the containment note at the top of this file.');
  }
  // Same containment default as init(): unset means init ensures THIS clone's live
  // .claude-plugin/sterling-mcp.json. Not the target (that would open the plugin-repo
  // branch and invert these mode fixtures), and an explicit value still wins.
  const pluginRootMatch = extraEnv.STERLING_PLUGIN_ROOT_MATCH ?? scratchPluginRoot();
  const env = {
    ...process.env,
    STERLING_REGISTRY_DB: join(dir, 'registry.db'),
    STERLING_PLUGIN_ROOT_MATCH: pluginRootMatch,
    STERLING_CODEX_PROBE: 'absent',
    STERLING_CODEX_PROBE_WIN: 'absent',
    ...extraEnv,
  };
  delete env.STERLING_WIN_NODE; // unconditional: this helper's whole purpose
  // Inherited-env hygiene: only the caller's explicit values survive, so a
  // developer with either variable exported cannot silently flip a mode arm.
  if (!('STERLING_DUAL_CONTEXT' in extraEnv)) delete env.STERLING_DUAL_CONTEXT;
  if (!('STERLING_CODEX_WIN_PATH' in extraEnv)) delete env.STERLING_CODEX_WIN_PATH;
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', pluginRootMatch };
}

// A mode note is a report line naming one of the ruling's two mode names —
// EXCLUDING the per-artifact status lines. An artifact line ("<path>  skipped
// …", "<path>  created …") reports on ONE ITEM; the mode note reports on the
// RUN, and "exactly one mode note per run" is a claim about the latter. Without
// the exclusion this helper would also count a mode word appearing legitimately
// inside a skip DETAIL, which turns the pin into "the string 'host-native'
// occurs on exactly one line of output" — a red on wording rather than on
// behavior. The exclusion costs the pin nothing it was written to catch: a
// dropped run-level note still counts 0, and a duplicated one still counts 2.
const ARTIFACT_STATUS_LINE = /^\S+\s+(created|skipped|matches|refreshed|differs|refused)\b/;
const modeNoteLines = (out) => out
  .split('\n')
  .filter((l) => !ARTIFACT_STATUS_LINE.test(l) && /\b(host-native|dual-context)\b/i.test(l));

// The single mode a run reported, or null when the report is missing,
// duplicated, or ambiguous (one line naming BOTH modes tells a user nothing, so
// it is deliberately not resolved to a winner).
const modeName = (out) => {
  const notes = modeNoteLines(out);
  if (notes.length !== 1) return null;
  const host = /host-native/i.test(notes[0]);
  const dual = /dual-context/i.test(notes[0]);
  if (host === dual) return null;
  return host ? 'host-native' : 'dual-context';
};

const HOST_NATIVE_ONLY = process.platform === 'win32'
  ? 'host-native arm: on a win32 host process.execPath resolves a native node, so there is no skip to observe — see Part F\'s documented gap'
  : false;

test('ffe7c416 (1): with NO Windows node and NO opt-in, the native launcher and the win MCP config are skipped AS A MODE — init exits 0, completes the rest, and never prints PATH advice', { skip: HOST_NATIVE_ONLY }, () => {
  const ctlDir = mkdtempSync(join(tmpdir(), 'sterling-hostnative-ctl-'));
  const dir = mkdtempSync(join(tmpdir(), 'sterling-hostnative-'));
  try {
    // ---- CONTROL ARM, PLACED FIRST -------------------------------------
    // The absences asserted below have THREE possible causes: the host-native
    // mode (what we mean), the plugin-repo gate that also governs
    // sterling-mcp-win.json, or init falling over early. This arm is the same
    // fixture with the SAME plugin-root gate open and a Windows node available:
    // both artifacts must APPEAR. Without it the pin below would be green under
    // an init that generates neither artifact ever, which is exactly the
    // hollow-pin shape ffe7c416's own evidence was collected against.
    const ctl = init(ctlDir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: ctlDir });
    assert.equal(ctl.code, 0, ctl.stderr);
    assert.ok(existsSync(join(ctlDir, 'sterling-windows.bat')), 'CONTROL: a resolvable Windows node DOES produce the native launcher in this fixture');
    assert.ok(existsSync(join(ctlDir, '.claude-plugin', 'sterling-mcp-win.json')), 'CONTROL: the plugin-root gate IS open in this fixture — the win MCP config DOES generate here');
    assert.equal(modeNoteLines(ctl.stdout).length, 1, 'CONTROL: exactly one mode note on this run too — every init run states its mode exactly once, including the explicit-override shape');

    // ---- THE PIN --------------------------------------------------------
    const r = initHostNative(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir });
    assert.equal(r.code, 0, `host-native is a MODE, not a failure — init still exits 0: ${r.stderr}`);

    assert.ok(!existsSync(join(dir, 'sterling-windows.bat')), 'no Windows launcher on disk — nothing half-written, no launcher pointing at a node that does not exist');
    assert.ok(!existsSync(join(dir, '.claude-plugin', 'sterling-mcp-win.json')), 'no Windows MCP config either — the same host-native decision governs both artifacts (ffe7c416 defect 1: one PATH lookup used to gate both)'); // not-a-citation: fixture id

    // Loud, per P5 — an absent artifact is REPORTED, never silently missing.
    assert.match(r.stdout, /^sterling-windows\.bat\s+skipped\b/m, 'the launcher skip is reported');
    assert.match(r.stdout, /^\.claude-plugin\/sterling-mcp-win\.json\s+skipped\b/m, 'the win MCP config skip is reported by name — silence here is how a Windows user loses a capability without being told');

    // MODE, not broken PATH. This exact string is REQUIRED by the ''-override
    // case near the top of this file and FORBIDDEN here; one code path cannot
    // satisfy both, which is what makes this assertion load-bearing rather than
    // decorative.
    assert.ok(!/add the node dir to the Windows PATH/.test(r.stdout + r.stderr), 'a deliberate host-native run never tells the user to fix their Windows PATH — there is nothing broken to fix');

    const notes = modeNoteLines(r.stdout);
    assert.equal(notes.length, 1, 'exactly one mode note line per init run');
    assert.match(notes[0], /host-native/i, 'and it names the host-native mode');
    assert.ok(!/dual-context/i.test(notes[0]), 'the single note names ONE mode, not both');

    // the rest of the manifest is untouched by the mode
    assert.match(r.stdout, /^CLAUDE\.md\s+created\b/m, 'init completed the rest of the manifest');
    assert.ok(existsSync(join(dir, 'sterling.bat')), 'the Linux/WSL launcher is still generated');
    assert.ok(existsSync(join(dir, '.sterling', 'config.json')), 'config still written');
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'librarian.md')), 'agents still installed');
  } finally {
    rmSync(ctlDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (the ruling's core): restore the pre-ruling order by falling through
// to `where.exe node` with no opt-in required — on a machine where that lookup
// happens to succeed the launcher reappears and the `!existsSync` assertions go
// red; on a machine where it fails the report reverts to the PATH-advice skip
// and the `add the node dir to the Windows PATH` negation goes red. One of the
// two fires on every machine, which is deliberate: the pin must not be silently
// unenforced on hosts where the lookup misses.
// SABOTAGE (the mode note): drop the note line, or print one that says only
// "skipped" without naming a mode — modeNoteLines() returns 0 and the
// exactly-one assertion goes red.
// SABOTAGE (loudness): skip the win MCP config silently instead of reporting it
// — the `sterling-mcp-win.json skipped` match goes red while everything else
// stays green, so the failure names the P5 violation precisely.
// WHICH GUARD CARRIES THE VERDICT: the Windows-node resolution order in
// scripts/init-impl.mjs. The artifact absences and the report wording are two
// INDEPENDENT layers over it — the report assertions stay green if only the
// artifacts break and vice versa, so this pin is defense-in-depth by design and
// a single-layer mutation reddening only part of it is the expected result, not
// evidence of hollowness.

test('ffe7c416 (2): the dual-context escape hatch is OPT-IN and named in the report — the mode note switches on STERLING_DUAL_CONTEXT=1 and on --dual-context, and only then', { skip: HOST_NATIVE_ONLY }, () => {
  // Pins the NOTE, never the artifact: whether `where.exe node` then resolves a
  // launcher depends on the running machine's Windows PATH (research_finding
  // 0c712d94 measured it absent on this one), so an artifact assertion would be
  // machine-dependent. What the ruling actually promises is that the opt-in is
  // explicit and disclosed.
  const dirOff = mkdtempSync(join(tmpdir(), 'sterling-dualctx-off-'));
  const dirEnv = mkdtempSync(join(tmpdir(), 'sterling-dualctx-env-'));
  const dirFlag = mkdtempSync(join(tmpdir(), 'sterling-dualctx-flag-'));
  try {
    // ---- CONTROL ARM, PLACED FIRST: identical env MINUS the opt-in ------
    // It must pass for the OPPOSITE reason — same fixture, same absent
    // STERLING_WIN_NODE, and the note reads host-native. Without it, "the note
    // says dual-context" could be satisfied by a build that prints
    // dual-context unconditionally, which is a mode label that tells the user
    // nothing.
    const off = initHostNative(dirOff, FRESH_FLAGS);
    assert.equal(off.code, 0, off.stderr);
    const offNotes = modeNoteLines(off.stdout);
    assert.equal(offNotes.length, 1, 'CONTROL: exactly one mode note with no opt-in');
    assert.match(offNotes[0], /host-native/i, 'CONTROL: no opt-in -> host-native');
    assert.ok(!/dual-context/i.test(offNotes[0]), 'CONTROL: the escape hatch is NOT entered by default — that is what makes it an escape hatch');

    // ---- ARM A: the environment opt-in ---------------------------------
    const viaEnv = initHostNative(dirEnv, FRESH_FLAGS, { STERLING_DUAL_CONTEXT: '1' });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    const envNotes = modeNoteLines(viaEnv.stdout);
    assert.equal(envNotes.length, 1, 'exactly one mode note under the env opt-in');
    assert.match(envNotes[0], /dual-context/i, 'STERLING_DUAL_CONTEXT=1 puts the run in dual-context mode and says so');

    // ---- ARM B: the flag opt-in ----------------------------------------
    // Asserted separately because the two opt-in forms are two code paths: a
    // build wiring only the env var passes ARM A and fails here, and that is a
    // real defect for the authoring machine, whose escape hatch the ruling says
    // must not be degraded.
    const viaFlag = initHostNative(dirFlag, [...FRESH_FLAGS, '--dual-context']);
    assert.equal(viaFlag.code, 0, `--dual-context is a recognized flag, not an unknown-arg failure: ${viaFlag.stderr}`);
    const flagNotes = modeNoteLines(viaFlag.stdout);
    assert.equal(flagNotes.length, 1, 'exactly one mode note under the flag opt-in');
    assert.match(flagNotes[0], /dual-context/i, '--dual-context puts the run in dual-context mode and says so');
  } finally {
    for (const d of [dirOff, dirEnv, dirFlag]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: honor the opt-in but never change the note (print host-native
// always) — both /dual-context/i assertions go red while the control arm stays
// green.
// SABOTAGE: enter dual-context unconditionally (drop the opt-in test) — the
// CONTROL arm's /host-native/i match goes red and its !dual-context negation
// goes red, while ARMs A and B stay green. This is the direction a
// success-only pin cannot see.
// SABOTAGE (flag arm only): wire STERLING_DUAL_CONTEXT but not --dual-context —
// ARM B's /dual-context/i match goes red (or, if the flag is rejected as an
// unknown argument, its exit-0 assertion does) while ARM A stays green.

test('ffe7c416 (2b): the dual-context opt-in is the VALUE "1", not mere presence — STERLING_DUAL_CONTEXT="0" and "" both stay host-native (the string-truthiness trap)', () => {
  // A BOUNDARY THE DISPATCH SPEC DID NOT NAME, and the one an implementer is
  // most likely to get wrong: in JavaScript the STRING '0' is TRUTHY, so the
  // natural `if (env.STERLING_DUAL_CONTEXT)` opts a user INTO the escape hatch
  // at the exact moment they explicitly turned it OFF — and `'X' in env` opts
  // them in merely for having the variable exported. ffe7c416 makes the hatch
  // DELIBERATE; a hatch you enter by accident is not one, and neither failure
  // is visible to the =1 arm above.
  //
  // Not skipped on win32: this arm asserts only the NOTE, and a win32 host
  // resolves process.execPath into the SAME host-native mode, so unlike the two
  // arms above there is nothing here that only a non-Windows host can observe.
  const dirOn = mkdtempSync(join(tmpdir(), 'sterling-dualctx-on-'));
  const dirZero = mkdtempSync(join(tmpdir(), 'sterling-dualctx-zero-'));
  const dirEmpty = mkdtempSync(join(tmpdir(), 'sterling-dualctx-empty-'));
  try {
    // ---- POSITIVE CONTROL, PLACED FIRST --------------------------------
    // "the note says host-native" has more than one cause: the value was
    // correctly rejected, OR this build never reaches dual-context at all. This
    // arm settles it in the same fixture before either negative is read.
    const on = initHostNative(dirOn, FRESH_FLAGS, { STERLING_DUAL_CONTEXT: '1' });
    assert.equal(on.code, 0, on.stderr);
    assert.equal(modeName(on.stdout), 'dual-context', 'CONTROL: "1" DOES reach dual-context in this exact fixture, so the negatives below discriminate the VALUE rather than an unreachable branch');

    for (const [label, value, dir] of [['"0"', '0', dirZero], ['empty string', '', dirEmpty]]) {
      const r = initHostNative(dir, FRESH_FLAGS, { STERLING_DUAL_CONTEXT: value });
      assert.equal(r.code, 0, `${label}: an explicit non-"1" value is an ordinary run, never an error: ${r.stderr}`);
      assert.equal(modeName(r.stdout), 'host-native', `${label}: STERLING_DUAL_CONTEXT=${JSON.stringify(value)} must NOT enter the escape hatch — got ${JSON.stringify(modeNoteLines(r.stdout))}`);
    }
  } finally {
    for (const d of [dirOn, dirZero, dirEmpty]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (truthiness): opt in with `if (env.STERLING_DUAL_CONTEXT)` — '0' is
// truthy, so the "0" arm's modeName goes dual-context and that assertion goes
// red, while the empty-string arm and the =1 control both stay green. That
// single-arm red is the discrimination this pin buys.
// SABOTAGE (key presence): opt in with `'STERLING_DUAL_CONTEXT' in env` — BOTH
// negative arms go red and the control stays green.
// SABOTAGE (never opt in): ignore the env var entirely — only the CONTROL arm
// goes red, which is the direction the two negatives cannot see.
// WHICH GUARD CARRIES THE VERDICT: the single equality against the literal '1'
// in init's opt-in test. There is no second layer, and the --dual-context flag
// is a SEPARATE path (ffe7c416 (2) ARM B) that this pin deliberately does not
// exercise, so nothing else can mask the mutation.

test('ffe7c416 (3): EVERY init run states its mode exactly once — ordinary consuming project, plugin-repo branch, and a flagless RE-RUN that writes nothing and still reports the same mode', () => {
  // "exactly one mode note line" is a per-RUN promise, so it is pinned across
  // the run SHAPES this suite already treats as distinct code paths: the
  // ordinary consuming project (plugin-root gate CLOSED), the plugin-repo
  // branch (gate OPEN — two extra MCP configs generated), and the ensure-
  // outcome-2 flagless re-run, where every artifact reports 'matches' and not a
  // byte is written. The re-run is the load-bearing one: it is exactly where a
  // note emitted from inside the create path disappears, and no other pin in
  // Part F exercises a no-op run.
  //
  // WHICH mode these runs report is deliberately NOT pinned. They all set
  // STERLING_WIN_NODE explicitly (the init() helper does), which ffe7c416 makes
  // an explicit OVERRIDE rather than an opt-in, and the ruling names no third
  // mode for that case — pinning a winner here would invent spec. What is
  // pinned is that one mode IS stated, that it is one of the ruling's two and
  // never both on one line, and that it does not CHANGE between a create run
  // and a no-op re-run of the same environment.
  const dirPlain = mkdtempSync(join(tmpdir(), 'sterling-modenote-plain-'));
  const dirPlugin = mkdtempSync(join(tmpdir(), 'sterling-modenote-plugin-'));
  try {
    const fresh = init(dirPlain, FRESH_FLAGS);
    assert.equal(fresh.code, 0, fresh.stderr);
    const freshMode = modeName(fresh.stdout);
    assert.ok(freshMode, `an ordinary consuming project states exactly one unambiguous mode — got ${JSON.stringify(modeNoteLines(fresh.stdout))}`);

    const rerun = init(dirPlain); // no flags: declarations read back from config
    assert.equal(rerun.code, 0, rerun.stderr);
    assert.match(rerun.stdout, /\bmatches\b/, 'precondition: this really is the no-op re-run shape (ensure outcome 2)');
    assert.equal(modeName(rerun.stdout), freshMode, 'a flagless re-run states the SAME single mode — the note reports the RUN, not whichever writes it happened to make');

    const plugin = init(dirPlugin, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dirPlugin });
    assert.equal(plugin.code, 0, plugin.stderr);
    assert.ok(modeName(plugin.stdout), `the plugin-repo branch states exactly one unambiguous mode too — got ${JSON.stringify(modeNoteLines(plugin.stdout))}`);
  } finally {
    for (const d of [dirPlain, dirPlugin]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (the one this pin exists for): emit the mode note from inside the
// launcher-CREATION branch rather than once per run — the fresh and plugin arms
// stay green and ONLY the re-run's modeName equality goes red, because a
// re-run creates nothing.
// SABOTAGE: print the note twice (e.g. once per Windows artifact decision) —
// modeNoteLines returns 2, modeName returns null, and all three arms go red.
// SABOTAGE: name both modes on one line ("host-native (dual-context available)")
// — modeName returns null on every arm; the note is then unreadable to a user
// deciding whether a missing launcher is deliberate, which is what it is for.

test('sparring-partner-win case 9 (ffe7c416 defect 2): the win MCP config carries the PROBED ABSOLUTE PATH as codex\'s command, not a bare "codex"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  const PROBED = 'C:\\p\\codex.exe';
  try {
    // STERLING_CODEX_WIN_PATH is the command seam: under the forced-'ok' probe
    // it is the path probeCodexWin reports having resolved. The end-to-end claim
    // is that init WRITES that path — a successful probe must prove the entry it
    // generates will actually spawn (npm ships codex.cmd, hostile to shell-less
    // spawning; PATH is a measured-unreliable oracle on the target host,
    // research_finding foreign_0c712d94).
    const r = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'ok', STERLING_CODEX_WIN_PATH: PROBED });
    assert.equal(r.code, 0, r.stderr);
    const mcp = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'sterling-mcp-win.json'), 'utf8'));
    assert.deepEqual(
      mcp.mcpServers.codex,
      { command: PROBED, args: ['mcp-server'] },
      'the resolved absolute path survives all the way into the generated config — this is the whole of ffe7c416 defect 2, end to end'
    );
    assert.ok(mcp.mcpServers.sterling, 'the sterling entry is untouched beside it');
    assert.equal(modeNoteLines(r.stdout).length, 1, 'exactly one mode note line on this run too');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// CONTROL ARM: win case 1 above, same file, earlier in the run order — probe OK
// with NO path seam yields the bare CODEX_MCP_ENTRY. It must pass for the
// OPPOSITE reason, and together the pair forbids both failure directions.
// SABOTAGE: keep writing CODEX_MCP_ENTRY on the win branch (the pre-ruling
// behavior) — the deepEqual goes red on command:'codex' while case 1 stays
// green, which is precisely how the pair localizes the defect.
// SABOTAGE: carry the path but lose the args (write `{command}` alone) — the
// deepEqual goes red on the missing args, catching a config entry that would be
// accepted and then never start a server.

test('sparring-partner-win case 10: the MANAGED REFRESH carries the probed path too — a pre-existing sterling-only win config gains a codex entry whose command is the ABSOLUTE path, reported "refreshed"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-codexwin-'));
  const PROBED = 'C:\\p\\codex.exe';
  try {
    // The upgrade path is where this defect actually bites: every existing clone
    // is already in the sterling-only shape, so if the refresh arm writes the
    // bare entry while only the CREATE arm carries the path, the fix reaches no
    // installed machine — a green suite over a defect that ships. Case 9 covers
    // the create arm; this covers the refresh arm; neither substitutes.
    const first = init(dir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'absent' });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dir, '.claude-plugin', 'sterling-mcp-win.json');
    const before = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(before.mcpServers && before.mcpServers.sterling, 'precondition: sterling-only win config exists');
    assert.ok(!('codex' in before.mcpServers), 'precondition: no codex entry yet');

    const rerun = init(dir, [], { STERLING_PLUGIN_ROOT_MATCH: dir, STERLING_CODEX_PROBE_WIN: 'ok', STERLING_CODEX_WIN_PATH: PROBED });
    assert.equal(rerun.code, 0, rerun.stderr);

    const after = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(after.mcpServers.sterling, before.mcpServers.sterling, 'sterling entry unchanged by the managed refresh');
    assert.deepEqual(
      after.mcpServers.codex,
      { command: PROBED, args: ['mcp-server'] },
      'the refresh arm carries the probed absolute path, exactly as the create arm does — one shared entry builder, not two literals that drift'
    );

    const line = rerun.stdout.match(/^\.claude-plugin\/sterling-mcp-win\.json\s+.+$/m);
    assert.ok(line, 'a report line exists for the win MCP config on the managed-refresh re-run');
    assert.match(line[0], /\brefreshed\b/, "reported 'refreshed'");
    assert.ok(!/\bdiffers\b/.test(line[0]), "not 'differs' — this is a managed field, not a hand edit");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: have the refresh arm splice in CODEX_MCP_ENTRY while the create arm
// uses withCodexEntry(probe) — case 9 stays green and ONLY this pin goes red,
// which is the drift this pair exists to catch.
// WHICH GUARD CARRIES THE VERDICT: two, and they are distinguishable.
// `isManagedCodexAddWin` decides whether the refresh happens at all — remove it
// and the /refreshed/ match goes red (win case 6 covers that). The entry builder
// decides what gets written — leave the refresh in place and swap only the entry
// and the /refreshed/ match stays GREEN while the codex deepEqual goes red. Do
// not report "the refresh guard is load-bearing" for this pin: it is the entry
// builder that carries this verdict.

// =============================================================================
// Part G — the FOUR review-driven fixes that landed on top of decision foreign_ffe7c416
// (slug host-native-init-with-dev-machine-escape-hatch) with NO frozen pin. A
// green suite over them proved only that nothing BROKE; every one of them is a
// behaviour a future edit can silently delete.
//
// SPEC-ONLY, and strictly so: scripts/init-impl.mjs's implementation body was NOT
// read to author this section (the test-writer read wall) — these pins are
// written against the dispatch spec and the ruling. Consequence for how they are
// written: where the spec quoted a report STRING, this file pins a TOKEN inside
// it (a variable name, a filename, a distinctive word) rather than the sentence,
// so a reworded report reds nothing while a deleted BEHAVIOUR still reds. Where
// a claim is about bytes on disk it is asserted on the bytes, never on prose.
//
//   F1  MANAGED REFRESH OF A STALE PLUGIN MCP COMMAND. An existing
//       .claude-plugin/sterling-mcp.json sterling entry whose args[0] equals the
//       generated server entry but whose `command` differs is PROVABLY OURS
//       (nobody else names this clone's dist/main.js), so init repoints it at the
//       running interpreter and reports 'refreshed'. The ownership boundary is
//       args[0], NOT the command. Why it matters: nvm-windows moves execPath on a
//       node upgrade, and before this fix sterling-mcp.json kept naming a deleted
//       node.exe forever while the launcher regenerated happily — native claude
//       got no Sterling MCP at all.
//   F1b under the host-native MODE a 'differs' on that same file also warns,
//       because there it is the ONLY source of Sterling MCP for native claude.
//   F2  AN INERT OPT-IN IS DISCLOSED, NOT REFUSED — --dual-context /
//       STERLING_DUAL_CONTEXT=1 cannot take effect where the launcher flags and
//       the win config are one mechanism keyed on the rendering host; init says
//       so, names what a genuine cross-host setup would need, and exits 0.
//   F3  MARKER-DRIVEN RE-BAKE of sterling-windows.bat: unmodified-but-stale
//       re-bakes as 'refreshed'; hand-edited or unmarked-legacy still 'differs'.
//   F4  STALE, NOT SILENTLY ABSENT: a skip whose artifact EXISTS reports 'stale'
//       and leaves the file alone; an artifact that never existed still reports
//       'skipped', verbatim as before.
//
// SEAMS USED (all pre-existing in this file except STERLING_NATIVE_MCP_MODE,
// which the dispatch declares): STERLING_PLUGIN_ROOT_MATCH, STERLING_WIN_NODE,
// STERLING_CODEX_PROBE / _WIN, STERLING_DUAL_CONTEXT, STERLING_NATIVE_MCP_MODE.
// =============================================================================

// Part G carries its OWN status-line regex rather than widening the Part F
// ARTIFACT_STATUS_LINE above. Deliberate: F4 introduces a status word ('stale')
// the Part F helper does not know, three live mode-note pins read from that
// helper, and silently changing what another pin counts as a status line is
// exactly how a passing test stops pinning anything.
const STATUS_LINE_G = /^\S+\s+(created|skipped|matches|refreshed|differs|refused|stale|exists)\b/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const statusLineFor = (out, path) => (out.match(new RegExp(`^${escapeRe(path)}\\s+.+$`, 'm')) ?? [null])[0];
// A WARN is a report line that names an artifact but is NOT that artifact's
// status line. Pinning warns this way (presence of a non-status line naming the
// file) rather than by their sentence keeps the pin behavioural: a reworded warn
// still counts, a DELETED warn counts zero, and the mode-note line — which names
// no file — can never be mistaken for one.
const nonStatusLinesNaming = (out, token) =>
  out.split('\n').filter((l) => l.trim() !== '' && l.includes(token) && !STATUS_LINE_G.test(l));

// Inherited-env hygiene for every Part G fixture, in the deletion form this file
// already uses (node:child_process omits env keys valued `undefined`). Codex
// probes are forced ABSENT throughout and that is LOAD-BEARING, not tidiness:
// with no probe able to succeed, the codex managed-refresh path cannot fire, so
// a 'refreshed' verdict on a plugin MCP config in this section can only have
// come from the behaviour under test.
const G_ENV = {
  STERLING_CODEX_PROBE: 'absent',
  STERLING_CODEX_PROBE_WIN: 'absent',
  STERLING_CODEX_WIN_PATH: undefined,
  STERLING_DUAL_CONTEXT: undefined,
  STERLING_NATIVE_MCP_MODE: undefined,
};
const PLUGIN_MCP = '.claude-plugin/sterling-mcp.json';
const PLUGIN_MCP_WIN = '.claude-plugin/sterling-mcp-win.json';

test('F1 (ffe7c416 review fix): a plugin MCP config whose sterling COMMAND drifted (node upgrade) is managed-refreshed back at this interpreter — args[0], not the command, is the ownership boundary', () => {
  const dirForeign = mkdtempSync(join(tmpdir(), 'sterling-repoint-foreign-'));
  const dirOurs = mkdtempSync(join(tmpdir(), 'sterling-repoint-ours-'));
  try {
    // ---- CONTROL, PLACED FIRST ------------------------------------------
    // 'refreshed' below has more than one possible cause: the args[0] ownership
    // proof (what we mean), or an init that repoints ANY sterling-keyed entry it
    // finds. This arm is the same fixture with a hand-written entry pointing at a
    // DIFFERENT SERVER — provably not ours — and it must come out the other way.
    // Without it, an implementation that rewrites `mcpServers.sterling.command`
    // unconditionally passes the pin while destroying a user's own config.
    const cFirst = init(dirForeign, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirForeign });
    assert.equal(cFirst.code, 0, cFirst.stderr);
    const cPath = join(dirForeign, '.claude-plugin', 'sterling-mcp.json');
    const cCfg = JSON.parse(readFileSync(cPath, 'utf8'));
    cCfg.mcpServers.sterling = { command: '/usr/bin/python3', args: ['/opt/other/server.py'] };
    writeFileSync(cPath, JSON.stringify(cCfg, null, 2));
    const cBefore = readFileSync(cPath, 'utf8');

    const cRerun = init(dirForeign, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirForeign });
    assert.equal(cRerun.code, 0, cRerun.stderr);
    const cLine = statusLineFor(cRerun.stdout, PLUGIN_MCP);
    assert.ok(cLine, 'CONTROL: a report line exists for the plugin MCP config');
    assert.match(cLine, /\bdiffers\b/, "CONTROL: args[0] names a foreign server, so the entry is NOT provably ours — 'differs', never repointed");
    assert.ok(!/\brefreshed\b/.test(cLine), 'CONTROL: a foreign entry is never managed-refreshed, whatever its command says');
    assert.equal(readFileSync(cPath, 'utf8'), cBefore, 'CONTROL: byte-identical — never-overwrite holds over somebody else\'s server');

    // ---- THE PIN ---------------------------------------------------------
    const first = init(dirOurs, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirOurs });
    assert.equal(first.code, 0, first.stderr);
    const mcpPath = join(dirOurs, '.claude-plugin', 'sterling-mcp.json');
    const generated = JSON.parse(readFileSync(mcpPath, 'utf8'));
    const generatedCommand = generated.mcpServers.sterling.command;
    const generatedArgs = [...generated.mcpServers.sterling.args];
    assert.ok(generatedArgs.length > 0, 'precondition: the generated sterling entry has args to preserve');

    // The nvm-windows upgrade, reproduced exactly: execPath moved, ARGS INTACT.
    const STALE_NODE = 'C:\\nvm\\v20.0.0\\node.exe';
    generated.mcpServers.sterling.command = STALE_NODE;
    writeFileSync(mcpPath, JSON.stringify(generated, null, 2));

    const rerun = init(dirOurs, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirOurs });
    assert.equal(rerun.code, 0, rerun.stderr);
    const line = statusLineFor(rerun.stdout, PLUGIN_MCP);
    assert.ok(line, 'a report line exists for the plugin MCP config on the repoint re-run');
    assert.match(line, /\brefreshed\b/, "a drifted command on OUR entry is a managed refresh — 'refreshed'");
    assert.ok(!/\bdiffers\b/.test(line), "not 'differs' — a stale interpreter is not a hand edit");
    assert.match(line, /repointed the sterling command/, 'the detail says what it did');
    assert.match(line, /nvm/, 'the detail names the OLD command it replaced — matched on a token, not a slash form, so a path normalization does not red this');

    const after = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.equal(after.mcpServers.sterling.command, generatedCommand, 'repointed back at exactly the command a fresh generation writes');
    assert.deepEqual(after.mcpServers.sterling.args, generatedArgs, 'ONLY the command moved — args[0] and the store arg are untouched');
    assert.equal(
      after.mcpServers.sterling.command.replace(/\\/g, '/'),
      process.execPath.replace(/\\/g, '/'),
      'and that command is THIS interpreter — ffe7c416 detects the runtime as process.execPath, never a PATH lookup'
    );

    // CONVERGENCE. Beyond the dispatch spec, and deliberately: a repoint that
    // does not converge reports 'refreshed' on every future run forever, which
    // is indistinguishable to a user from an init that cannot leave the file
    // alone. The whole managed-refresh vocabulary in this file assumes it.
    const third = init(dirOurs, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirOurs });
    assert.equal(third.code, 0, third.stderr);
    assert.match(statusLineFor(third.stdout, PLUGIN_MCP), /\bmatches\b/, "the repoint CONVERGES — the next run reports 'matches', not a second 'refreshed'");
  } finally {
    for (const d of [dirForeign, dirOurs]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (one line, the ownership boundary): force the ownership test
// `existingSterling.args[0] === fwd(mcpServerEntry)` to false (or key it on
// `command` instead of args[0]) — the /refreshed/ and /repointed the sterling
// command/ assertions go red while the CONTROL stays green.
// SABOTAGE (the opposite direction, which only the control can see): drop the
// args[0] conjunct so any `sterling` key is repointed — the CONTROL's 'differs'
// and byte-identical assertions go red while the pin stays green.
// SABOTAGE (silent detail): perform the repoint but report a bare 'refreshed'
// with no detail — /repointed the sterling command/ and /nvm/ go red.
// WHICH GUARD CARRIES THE VERDICT: the args[0] equality. The command inequality
// is NOT a second layer — it only selects between 'matches' and a refresh.

test('F1b (ffe7c416 review fix): under the host-native MODE a `differs` on the plugin MCP config also WARNS — the warn is mode-driven AND verdict-driven, neither alone', () => {
  const dirClean = mkdtempSync(join(tmpdir(), 'sterling-hnwarn-clean-'));
  const dirForeign = mkdtempSync(join(tmpdir(), 'sterling-hnwarn-foreign-'));
  try {
    // ---- CONTROL 1, PLACED FIRST: the MODE without the VERDICT -----------
    // "host-native printed a warn about sterling-mcp.json" is satisfied
    // identically by a mode BANNER that fires on every host-native run. This arm
    // forbids that: same mode, nothing wrong with the file, no warn.
    const cleanFirst = init(dirClean, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirClean });
    assert.equal(cleanFirst.code, 0, cleanFirst.stderr);
    const c1 = init(dirClean, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirClean, STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(c1.code, 0, c1.stderr);
    assert.match(
      statusLineFor(c1.stdout, PLUGIN_MCP) ?? '',
      /\bmatches\b/,
      'CONTROL 1 precondition: the host-native mode does not itself change the GENERATED plugin config — if this reds, the mode is rewriting the file and the whole pin below needs re-cutting'
    );
    assert.deepEqual(
      nonStatusLinesNaming(c1.stdout + c1.stderr, 'sterling-mcp.json'),
      [],
      'CONTROL 1: host-native ALONE never warns about this file — the warn is not a mode banner'
    );

    // ---- CONTROL 2: the VERDICT without the MODE -------------------------
    const foreignFirst = init(dirForeign, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirForeign });
    assert.equal(foreignFirst.code, 0, foreignFirst.stderr);
    const mcpPath = join(dirForeign, '.claude-plugin', 'sterling-mcp.json');
    const cfg = JSON.parse(readFileSync(mcpPath, 'utf8'));
    cfg.mcpServers.sterling = { command: '/usr/bin/python3', args: ['/opt/other/server.py'] };
    writeFileSync(mcpPath, JSON.stringify(cfg, null, 2));
    const beforeBytes = readFileSync(mcpPath, 'utf8');

    const c2 = init(dirForeign, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirForeign });
    assert.equal(c2.code, 0, c2.stderr);
    assert.match(statusLineFor(c2.stdout, PLUGIN_MCP) ?? '', /\bdiffers\b/, 'CONTROL 2 precondition: the foreign entry really does produce a differs');
    assert.deepEqual(
      nonStatusLinesNaming(c2.stdout + c2.stderr, 'sterling-mcp.json'),
      [],
      "CONTROL 2: a 'differs' OUTSIDE host-native prints no warn — in dual-context this file is not the only source of Sterling MCP, so there is no consequence to name"
    );

    // ---- THE PIN: same fixture, same verdict, mode flipped ---------------
    const pin = init(dirForeign, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirForeign, STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(pin.code, 0, pin.stderr);
    assert.match(statusLineFor(pin.stdout, PLUGIN_MCP) ?? '', /\bdiffers\b/, "still 'differs' — the warn discloses, it never licenses a write");
    const warns = nonStatusLinesNaming(pin.stdout + pin.stderr, 'sterling-mcp.json');
    assert.ok(
      warns.length >= 1,
      `host-native + differs must warn: this file is the ONLY source of Sterling MCP for native claude, so leaving it hand-edited silently costs the user every Sterling tool — got ${JSON.stringify(pin.stdout + pin.stderr)}`
    );
    assert.match(warns.join('\n'), /native/i, 'the warn names the consequence for NATIVE claude, not merely that a file differs (wording otherwise unpinned)');
    assert.equal(readFileSync(mcpPath, 'utf8'), beforeBytes, 'a warn, not a write — the hand-written file is byte-identical');
  } finally {
    for (const d of [dirClean, dirForeign]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (one line): delete the warn push on the host-native differs path —
// `warns.length >= 1` goes red and both controls stay green.
// SABOTAGE (unconditional banner): emit the warn on every host-native run
// regardless of verdict — CONTROL 1's deepEqual([]) goes red alone.
// SABOTAGE (mode-blind): emit the warn on every 'differs' regardless of mode —
// CONTROL 2's deepEqual([]) goes red alone. The two controls fail in opposite
// directions, which is what makes the green above mean one thing.
// WHICH GUARD CARRIES THE VERDICT: the conjunction of the host-native mode test
// and the differs branch. Neither is defense in depth for the other — each
// sabotage above reddens a different arm.

test('F2 (ffe7c416 review fix): an INERT dual-context opt-in is DISCLOSED, never refused — the warn fires only where the flag cannot take effect, for BOTH opt-in forms, and nothing is refused or missing', () => {
  const dirFlagOnly = mkdtempSync(join(tmpdir(), 'sterling-inert-flagonly-'));
  const dirModeOnly = mkdtempSync(join(tmpdir(), 'sterling-inert-modeonly-'));
  const dirFlag = mkdtempSync(join(tmpdir(), 'sterling-inert-flag-'));
  const dirEnv = mkdtempSync(join(tmpdir(), 'sterling-inert-env-'));
  // The warn is identified by the variable it names. STERLING_WSL_NODE is the
  // interpreter path a genuine cross-host dual-context would need and init
  // cannot invent — it appears nowhere else in any init report, so it
  // discriminates the warn without pinning a sentence.
  const NAMES_THE_HATCH = /STERLING_WSL_NODE/;
  try {
    // ---- CONTROL 1, PLACED FIRST: the opt-in WITHOUT the inert condition --
    // On this (non-win32) host with no host-native override the predicate's
    // second arm is false, so the flag is NOT inert and there is nothing to
    // disclose. Forbids a build that warns whenever --dual-context is passed —
    // which would be the same green with none of the meaning.
    const c1 = init(dirFlagOnly, [...FRESH_FLAGS, '--dual-context'], { ...G_ENV });
    assert.equal(c1.code, 0, c1.stderr);
    assert.ok(!NAMES_THE_HATCH.test(c1.stdout + c1.stderr), 'CONTROL 1: --dual-context where it CAN take effect prints no inert-flag warn');

    // ---- CONTROL 2: the inert condition WITHOUT the opt-in ---------------
    const c2 = init(dirModeOnly, FRESH_FLAGS, { ...G_ENV, STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(c2.code, 0, c2.stderr);
    assert.ok(!NAMES_THE_HATCH.test(c2.stdout + c2.stderr), 'CONTROL 2: host-native without any opt-in prints no inert-flag warn — a user who asked for nothing is told nothing');

    // ---- ARM A: the FLAG opt-in, inert ----------------------------------
    const flagArm = init(dirFlag, [...FRESH_FLAGS, '--dual-context'], { ...G_ENV, STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(flagArm.code, 0, `an inert opt-in is DISCLOSED, never refused — init still exits 0: ${flagArm.stderr}`);
    const flagReport = flagArm.stdout + flagArm.stderr;
    assert.match(flagReport, NAMES_THE_HATCH, 'the warn names STERLING_WSL_NODE — the second interpreter path a genuine cross-host dual-context needs and init cannot invent');
    assert.match(flagReport, /no effect/i, 'and says the flag has no effect here, rather than leaving the user to infer it from a missing artifact');
    assert.ok(!/REFUSED/i.test(flagReport), 'nothing was refused — P5 loud, not fatal');
    assert.match(flagArm.stdout, /^CLAUDE\.md\s+created\b/m, 'init completed the rest of the manifest around the disclosure');
    assert.ok(existsSync(join(dirFlag, '.sterling', 'config.json')), 'and nothing is missing — the run is an ordinary complete init');

    // ---- ARM B: the ENV opt-in, inert -----------------------------------
    // Asserted separately because the two opt-in forms are two code paths: a
    // build that disclosed only the flag would pass ARM A and leave every
    // STERLING_DUAL_CONTEXT=1 user with an unexplained no-op.
    const envArm = init(dirEnv, FRESH_FLAGS, { ...G_ENV, STERLING_DUAL_CONTEXT: '1', STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(envArm.code, 0, envArm.stderr);
    assert.match(envArm.stdout + envArm.stderr, NAMES_THE_HATCH, 'STERLING_DUAL_CONTEXT=1 is disclosed as inert too, not only the flag form');
  } finally {
    for (const d of [dirFlagOnly, dirModeOnly, dirFlag, dirEnv]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (the reachability one, one character): change the predicate's `||` to
// `&&` so it reads `dualContext && (platform === 'win32' && override ===
// 'host-native')` — unreachable from a Linux run, so ARMs A and B both go red
// while both controls stay green. This is why the override arm exists at all: a
// win32-only predicate would make this pin permanently skipped, i.e. hollow.
// SABOTAGE (refuse instead of disclose): exit non-zero on the inert opt-in — ARM
// A's exit-0 assertion goes red first.
// SABOTAGE (warn always): drop the `dualContext &&` conjunct — CONTROL 2 goes
// red alone. Drop the platform/override conjunct instead — CONTROL 1 goes red
// alone.
// NOTE ON INTERFERENCE: this warn names 'dual-context' on a line that is not an
// artifact status line, so it would be counted by Part F's modeNoteLines(). No
// Part F arm can reach it — every one of them runs without
// STERLING_NATIVE_MCP_MODE on a non-win32 host — but if a future Part F fixture
// adopts the override, that pin's "exactly one mode note" count is where it will
// surface.

test('F3a (ffe7c416 review fix): the generated sterling-windows.bat carries a verifiable stamp on LINE 2 — after @echo off, so the marker never echoes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stamp-'));
  try {
    const r = init(dir, FRESH_FLAGS, { ...G_ENV });
    assert.equal(r.code, 0, r.stderr);
    const lines = readFileSync(join(dir, 'sterling-windows.bat'), 'utf8').split(/\r?\n/);
    assert.match(lines[0], /^@echo off/i, 'line 1 still turns echo off — the stamp must sit AFTER it, or every launch prints the marker');
    assert.match(
      lines[1],
      /^rem sterling-generated\b.*\bcontent_hash=[0-9a-f]{64}\s*$/,
      'line 2 is the rem-commented stamp carrying a sha256 content hash — this is the only thing that lets a later init tell "stale but unmodified" from "hand-edited"'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: drop the stampBody(…, 'rem') call from native-launcher generation —
// the line-2 assertion goes red (and F3b's re-bake falls back to 'differs').
// SABOTAGE (placement): stamp on line 1, ahead of @echo off — the line-0
// assertion goes red, catching a launcher that echoes its own marker at every
// start. The two assertions are NOT defense in depth: each catches a defect the
// other cannot see.

test('F3b (ffe7c416 review fix): an UNMODIFIED but stale native launcher is re-baked from its stamp (refreshed); a hand-edited one and an unmarked-legacy one both still differ, byte-identical', () => {
  const NODE_A = 'C:\\NodeA\\node.exe';
  const NODE_B = 'C:\\NodeB\\node.exe';
  const dirHand = mkdtempSync(join(tmpdir(), 'sterling-rebake-hand-'));
  const dirLegacy = mkdtempSync(join(tmpdir(), 'sterling-rebake-legacy-'));
  const dirStale = mkdtempSync(join(tmpdir(), 'sterling-rebake-stale-'));
  try {
    // ---- CONTROL 1, PLACED FIRST: HAND-EDITED, and stale ----------------
    // 'refreshed' below has more than one cause: the stamp verified and the body
    // was stale (what we mean), or init simply rewrites this launcher whenever
    // the resolved node changes. This arm is the same staleness with a broken
    // stamp — the never-overwrite floor must hold.
    assert.equal(init(dirHand, FRESH_FLAGS, { ...G_ENV, STERLING_WIN_NODE: NODE_A }).code, 0);
    const handBat = join(dirHand, 'sterling-windows.bat');
    appendFileSync(handBat, 'rem hand\r\n');
    const handBefore = readFileSync(handBat, 'utf8');
    const handRerun = init(dirHand, [], { ...G_ENV, STERLING_WIN_NODE: NODE_B });
    assert.equal(handRerun.code, 0, handRerun.stderr);
    const handLine = statusLineFor(handRerun.stdout, 'sterling-windows.bat');
    assert.match(handLine ?? '', /\bdiffers\b/, "CONTROL 1: a hand-edited launcher fails verifyStamp — 'differs', even though it is also stale");
    assert.ok(!/\brefreshed\b/.test(handLine ?? ''), 'CONTROL 1: never re-baked over a human edit');
    assert.equal(readFileSync(handBat, 'utf8'), handBefore, 'CONTROL 1: byte-identical');

    // ---- CONTROL 2: UNMARKED LEGACY (a pre-stamp launcher), and stale ----
    // The upgrade shape every already-initialised machine is in. The spec is
    // explicit that these are NOT auto-replaced: no marker, no proof of
    // authorship, so the never-overwrite floor governs and the user deletes the
    // file by hand. Pinned because it is the exact boundary a re-bake is most
    // likely to be widened past.
    assert.equal(init(dirLegacy, FRESH_FLAGS, { ...G_ENV, STERLING_WIN_NODE: NODE_A }).code, 0);
    const legacyBat = join(dirLegacy, 'sterling-windows.bat');
    const legacyParts = readFileSync(legacyBat, 'utf8').split('\r\n');
    assert.match(legacyParts[1], /^rem sterling-generated\b/, 'precondition: line 2 is the stamp we are about to strip');
    legacyParts.splice(1, 1); // strip the marker -> an unmarked legacy launcher
    writeFileSync(legacyBat, legacyParts.join('\r\n'));
    const legacyBefore = readFileSync(legacyBat, 'utf8');
    const legacyRerun = init(dirLegacy, [], { ...G_ENV, STERLING_WIN_NODE: NODE_B });
    assert.equal(legacyRerun.code, 0, legacyRerun.stderr);
    const legacyLine = statusLineFor(legacyRerun.stdout, 'sterling-windows.bat');
    assert.match(legacyLine ?? '', /\bdiffers\b/, "CONTROL 2: an unmarked legacy launcher is not provably ours — 'differs', never silently replaced");
    assert.equal(readFileSync(legacyBat, 'utf8'), legacyBefore, 'CONTROL 2: byte-identical');

    // ---- THE PIN: UNMODIFIED and stale ----------------------------------
    assert.equal(init(dirStale, FRESH_FLAGS, { ...G_ENV, STERLING_WIN_NODE: NODE_A }).code, 0);
    const staleBat = join(dirStale, 'sterling-windows.bat');
    assert.ok(readFileSync(staleBat, 'utf8').includes(NODE_A), 'precondition: the first bake pinned NODE_A');

    const rebake = init(dirStale, [], { ...G_ENV, STERLING_WIN_NODE: NODE_B });
    assert.equal(rebake.code, 0, rebake.stderr);
    const line = statusLineFor(rebake.stdout, 'sterling-windows.bat');
    assert.match(line ?? '', /\brefreshed\b/, "an unmodified launcher whose content_hash still verifies is OURS — re-baked and reported 'refreshed'");
    assert.ok(!/\bdiffers\b/.test(line ?? ''), "not 'differs' — this is exactly the case that used to strand the old --strict + wsl.exe launcher on every initialised machine");
    const rebaked = readFileSync(staleBat, 'utf8');
    assert.ok(rebaked.includes(NODE_B), 'the re-baked body carries the NEW node');
    assert.ok(!rebaked.includes(NODE_A), 'and no trace of the old one — a re-bake, not a patch');
    assert.match(rebaked.split(/\r?\n/)[1], /^rem sterling-generated\b.*\bcontent_hash=[0-9a-f]{64}\s*$/, 're-stamped, so the NEXT stale re-bake is still possible');

    const settled = init(dirStale, [], { ...G_ENV, STERLING_WIN_NODE: NODE_B });
    assert.equal(settled.code, 0, settled.stderr);
    assert.match(statusLineFor(settled.stdout, 'sterling-windows.bat') ?? '', /\bmatches\b/, "the re-bake CONVERGES — the hash is over the NEW body, so the next run reports 'matches'");
  } finally {
    for (const d of [dirHand, dirLegacy, dirStale]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (one line): drop the verifyStamp branch so the compare falls straight
// through to 'differs' — the pin's /refreshed/ and NODE_B assertions go red
// while both controls stay green (they already expect 'differs').
// SABOTAGE (the opposite direction, which only the controls can see): re-bake
// whenever the body is stale, without checking the stamp — CONTROL 1 and
// CONTROL 2 both go red on byte-equality while the pin stays green. That is a
// launcher-clobbering regression a success-only pin cannot see.
// SABOTAGE (hash over the wrong bytes): compute content_hash over the PRE-render
// template instead of the emitted body — the convergence assertion goes red
// ('refreshed' forever), and nothing else does.
// WHICH GUARD CARRIES THE VERDICT: verifyStamp. The staleness compare is a
// separate layer — remove IT and the pin goes red for a different reason (no
// re-bake at all) while the controls stay green, so a partial red here localizes
// which of the two broke.

test('F4a (ffe7c416 review fix): a skip whose artifact EXISTS reports `stale` and deletes nothing; an artifact that never existed still reports `skipped`', () => {
  const dirFresh = mkdtempSync(join(tmpdir(), 'sterling-stale-fresh-'));
  const dirExisting = mkdtempSync(join(tmpdir(), 'sterling-stale-existing-'));
  try {
    // ---- CONTROL, PLACED FIRST: never existed ---------------------------
    // 'stale' below has more than one cause: the file was found on disk (what we
    // mean), or the skip reporter simply renamed itself. This arm holds the
    // OTHER half of staleOrSkipped — the absent case must still say 'skipped',
    // verbatim as it did before the fix, or the change silently rewrote an
    // unrelated report a user already knows how to read.
    const fresh = init(dirFresh, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirFresh, STERLING_WIN_NODE: '' });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stdout, /^sterling-windows\.bat\s+skipped\b/m, "CONTROL: an artifact that never existed reports 'skipped'");
    assert.ok(!/^sterling-windows\.bat\s+stale\b/m.test(fresh.stdout), "CONTROL: never 'stale' for a file that was never written");
    assert.ok(!existsSync(join(dirFresh, 'sterling-windows.bat')), 'CONTROL: and it really is absent');
    assert.match(fresh.stdout, new RegExp(`^${escapeRe(PLUGIN_MCP_WIN)}\\s+skipped\\b`, 'm'), "CONTROL: same for the win MCP config skip site — 'skipped' when absent");
    assert.ok(!existsSync(join(dirFresh, '.claude-plugin', 'sterling-mcp-win.json')), 'CONTROL: and it really is absent');

    // ---- THE PIN: both artifacts exist, then the same skip fires ---------
    const first = init(dirExisting, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirExisting });
    assert.equal(first.code, 0, first.stderr);
    const bat = join(dirExisting, 'sterling-windows.bat');
    const win = join(dirExisting, '.claude-plugin', 'sterling-mcp-win.json');
    assert.ok(existsSync(bat) && existsSync(win), 'precondition: both Windows artifacts were generated');
    const batBefore = readFileSync(bat, 'utf8');
    const winBefore = readFileSync(win, 'utf8');

    // STERLING_WIN_NODE='' — an explicit override naming nothing, which fires
    // the launcher skip site AND the "no Windows node resolved" win-config skip
    // site in one run. Both files are already on disk.
    const rerun = init(dirExisting, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirExisting, STERLING_WIN_NODE: '' });
    assert.equal(rerun.code, 0, rerun.stderr);

    const batLine = statusLineFor(rerun.stdout, 'sterling-windows.bat');
    assert.match(batLine ?? '', /^sterling-windows\.bat\s+stale\b/, "the launcher EXISTS and is no longer maintained — 'stale', not 'skipped': silence here reads as 'this file is fine'");
    assert.ok((batLine ?? '').replace(/^sterling-windows\.bat\s+stale\s*/, '').trim().length > 0, 'the stale status carries a reason beyond the bare word (wording unpinned)');
    assert.ok(existsSync(bat), 'nothing was deleted');
    assert.equal(readFileSync(bat, 'utf8'), batBefore, 'and nothing was rewritten — byte-identical');

    const winLine = statusLineFor(rerun.stdout, PLUGIN_MCP_WIN);
    assert.match(winLine ?? '', new RegExp(`^${escapeRe(PLUGIN_MCP_WIN)}\\s+stale\\b`), "the win MCP config EXISTS and is no longer maintained — 'stale' at the no-Windows-node skip site too");
    assert.ok(existsSync(win), 'nothing was deleted');
    assert.equal(readFileSync(win, 'utf8'), winBefore, 'byte-identical');
  } finally {
    for (const d of [dirFresh, dirExisting]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (one line): make staleOrSkipped ignore existsSync and always report
// 'skipped' — both /stale/ assertions go red while the CONTROL stays green.
// SABOTAGE (the opposite direction): always report 'stale' — the CONTROL's
// 'skipped' match and its !stale negation go red while the pin stays green,
// which is the direction the pin alone cannot see.
// SABOTAGE (destructive "tidying"): unlink the unmaintained file instead of
// reporting it — the existsSync/byte-equality assertions go red. That is the
// failure mode the status word exists to make unnecessary.
// SABOTAGE (one site only): wire staleOrSkipped at the launcher site and leave
// the win-config site on the old skip — only the winLine assertion goes red,
// naming the unwired site precisely. The two sites are separate call sites, not
// two layers over one guard.

test('F4b (ffe7c416 review fix): the MODE-driven skip site behaves the same way — under host-native an existing win MCP config is `stale`, an absent one `skipped`, and the launcher is not dragged in', () => {
  const dirFresh = mkdtempSync(join(tmpdir(), 'sterling-stalehn-fresh-'));
  const dirExisting = mkdtempSync(join(tmpdir(), 'sterling-stalehn-existing-'));
  try {
    // ---- CONTROL, PLACED FIRST: host-native from the very first run ------
    const fresh = init(dirFresh, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirFresh, STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stdout, new RegExp(`^${escapeRe(PLUGIN_MCP_WIN)}\\s+skipped\\b`, 'm'), "CONTROL: host-native with no pre-existing file reports 'skipped'");
    assert.ok(!existsSync(join(dirFresh, '.claude-plugin', 'sterling-mcp-win.json')), 'CONTROL: the mode really did suppress generation — otherwise the pin below proves nothing');

    // ---- THE PIN: generated first, then the mode flips -------------------
    // The real upgrade shape: a clone that already has the win config, re-inited
    // after the host-native ruling. The file stays on disk pointing at a config
    // nothing maintains any more, and the user is told so.
    const first = init(dirExisting, FRESH_FLAGS, { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirExisting });
    assert.equal(first.code, 0, first.stderr);
    const win = join(dirExisting, '.claude-plugin', 'sterling-mcp-win.json');
    assert.ok(existsSync(win), 'precondition: the win MCP config was generated');
    const winBefore = readFileSync(win, 'utf8');

    const rerun = init(dirExisting, [], { ...G_ENV, STERLING_PLUGIN_ROOT_MATCH: dirExisting, STERLING_NATIVE_MCP_MODE: 'host-native' });
    assert.equal(rerun.code, 0, rerun.stderr);
    const winLine = statusLineFor(rerun.stdout, PLUGIN_MCP_WIN);
    assert.match(winLine ?? '', new RegExp(`^${escapeRe(PLUGIN_MCP_WIN)}\\s+stale\\b`), "'stale' at the MODE-driven skip site — the file exists, the mode no longer maintains it, and nothing was deleted");
    assert.ok(existsSync(win), 'nothing deleted');
    assert.equal(readFileSync(win, 'utf8'), winBefore, 'byte-identical');

    // The mode governs the win MCP config, not the launcher: STERLING_WIN_NODE
    // is an explicit override and still resolves, so the launcher stays a
    // maintained artifact in the same run.
    const batLine = statusLineFor(rerun.stdout, 'sterling-windows.bat');
    assert.ok(batLine, 'the launcher is still reported');
    assert.ok(!/\b(stale|skipped)\b/.test(batLine), 'a host-native MCP-mode override does not strand the launcher — an explicitly overridden Windows node still keeps it maintained');
  } finally {
    for (const d of [dirFresh, dirExisting]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE: wire staleOrSkipped at the two node-resolution sites but leave the
// host-native site on the old skip reporter — only this pin's /stale/ match goes
// red; F4a stays fully green. Three call sites, three independent verdicts.
// SABOTAGE (over-reach): let the host-native mode also skip the native launcher
// — the last assertion goes red, catching a mode that silently withdraws an
// artifact the ruling keys on node resolution instead.

// =============================================================================
// PART H — CONTAINMENT GUARD: RUNNING THIS SUITE IS NOT AN ACT OF DEPLOYMENT
//
// anti_pattern a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree
// (severity BLOCK, knowledge_get 37b3cb0a-2e54-4ce2-99b9-45b68d6e6e0f). Its
// recorded correction has two halves and BOTH are needed: redirect the write to a
// temp dir (the helper defaults at the top of this file), and then PIN that the
// live artifact was untouched — because a redirect that silently regresses looks
// exactly like a passing suite. This is that second half.
//
// DECLARED LAST ON PURPOSE. LIVE_STAMPS_AT_LOAD is captured at module load, before
// the first test runs, and node:test executes top-level synchronous tests in
// declaration order — so the equality below spans EVERY init spawn in this file,
// not merely the two made here. A future case that forgets the seam is caught by
// this pin even though it lives hundreds of lines away.
// =============================================================================

test('H containment: the whole suite leaves THIS clone\'s live plugin MCP configs untouched — a test run never repoints the running session\'s MCP config', () => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'sterling-containment-plugin-'));
  const plainDir = mkdtempSync(join(tmpdir(), 'sterling-containment-plain-'));
  try {
    // ---- CONTROL ARM, PLACED FIRST ---------------------------------------
    // "the live config is unchanged" has more than one possible cause: the scratch
    // default worked (what we mean), or init writes no plugin MCP config at all in
    // this fixture / fell over early — under which the pin below is green and
    // proves nothing. This arm must pass for the OPPOSITE reason: the SAME fixture
    // shape with the seam aimed at a disposable clone-target really does emit a
    // plugin MCP config, with a codex entry, i.e. the write this pin contains is a
    // write that genuinely happens.
    // WHICH LINE CARRIES THE CONTROL'S VERDICT: `existsSync(ctlMcp)` below, and only
    // it. The config appears under the caller's EXPLICIT seam value, and only the
    // spawned init could have put it there — so that one line proves both halves of
    // this arm: init really does write a plugin MCP config in this fixture shape, AND
    // an explicit seam still wins over the containment default (the clone-target arms
    // throughout Parts C/F depend on that and would otherwise be silently redirected).
    // DO NOT RESTORE the `assert.equal(ctl.pluginRootMatch, pluginDir)` line deleted
    // here: the helper returns `extraEnv.STERLING_PLUGIN_ROOT_MATCH ?? scratch`, so
    // that comparison is true BY CONSTRUCTION whatever the child received — a
    // tautology wearing the message of a delivered behaviour, the same hollow shape
    // as the returned-value assertions recorded in the sabotage note at the end of
    // this Part.
    const ctl = init(pluginDir, FRESH_FLAGS, { STERLING_PLUGIN_ROOT_MATCH: pluginDir, STERLING_CODEX_PROBE: 'ok' });
    assert.equal(ctl.code, 0, ctl.stderr);
    const ctlMcp = join(pluginDir, '.claude-plugin', 'sterling-mcp.json');
    assert.ok(existsSync(ctlMcp), 'CONTROL: init DOES write a plugin MCP config in this fixture shape, and it wrote it under the EXPLICIT seam value — so the untouched live file below is containment rather than an init that writes nothing, and an explicit seam still overrides the containment default');
    assert.ok(JSON.parse(readFileSync(ctlMcp, 'utf8')).mcpServers.sterling, 'CONTROL: and it is a real generated config, not an empty placeholder');

    // ---- THE PIN: a representative CONSUMING-TARGET init -----------------
    // The exact shape of the dozens of legacy `init(dir, FRESH_FLAGS)` calls in
    // this file: no seam set by the caller, so the helper default is the only thing
    // standing between the suite and the live clone.
    const r = init(plainDir, FRESH_FLAGS);
    assert.equal(r.code, 0, r.stderr);

    // ---- THE VERDICT-CARRYING ASSERTION: THE DELIVERED EFFECT ------------
    // Assert WHERE THE SPAWNED init ACTUALLY AIMED, by looking for the artifact it
    // produced — never the helper's returned intent.
    //
    // This replaces three assertions over `r.pluginRootMatch` that were HOLLOW, and
    // the record matters more than the fix: `pluginRootMatch` is computed in the
    // helper and returned, so it describes what the helper MEANT, not the env the
    // child received. MEASURED (conductor, this slice): deleting the
    // `STERLING_PLUGIN_ROOT_MATCH: pluginRootMatch` line from the spawn env — the
    // exact regression this Part exists to catch, after which init falls back to
    // init-impl.mjs's STERLING_PLUGIN_ROOT_MATCH fallback (this clone) — left the
    // returned variable untouched and the suite
    // at 53 pass / 0 fail. The mtime layer below stayed green too, for the reason
    // already disclosed: on a machine whose interpreter matches the one recorded in
    // the live config, init reports 'matches' and writes nothing.
    //
    // The artifact's LOCATION has no such second cause. With the default delivered,
    // init ensures into the scratch root and the file is there. With it missing, the
    // ensure goes to the clone and the scratch root stays EMPTY — red on every
    // machine, whatever that clone's config happens to contain.
    assert.ok(
      existsSync(join(r.pluginRootMatch, '.claude-plugin', 'sterling-mcp.json')),
      'the DEFAULT-path init must have aimed its plugin-MCP ensure at the scratch plugin root: the artifact is the only evidence of the env the child actually received, and its absence here means the seam was not delivered and init fell back to init.mjs:51 — this clone'
    );

    // Documentation of intent, NOT the verdict. Each states a property the default
    // must have; none of them can detect the default failing to REACH the child,
    // which is the failure mode this Part is for. Kept because a future reader
    // changing the default needs them, deliberately placed after the pin so nobody
    // mistakes them for it.
    assert.notEqual(fwdPath(r.pluginRootMatch), fwdPath(root), 'INTENT: the plugin-root-match is not this clone');
    assert.notEqual(fwdPath(r.pluginRootMatch), fwdPath(plainDir), 'INTENT: nor the --target — init\'s plugin-repo branch is fwd(target) === fwd(pluginRootMatch), so a target-valued default would flip every consuming-project fixture in this file into a clone-target one');

    // A consuming project keeps no per-project copy of the plugin MCP config: the
    // ensure is plugin-root-derived, so redirecting the root must not smuggle the
    // artifact into the target instead (the same plugin-repo-only property Part C
    // pins for sterling-mcp-win.json).
    assert.ok(!existsSync(join(plainDir, '.claude-plugin', 'sterling-mcp.json')), 'no per-project sterling-mcp.json in a consuming target — the containment default redirects the ensure, it does not relocate the artifact into the project');

    // ---- CONTAINMENT ITSELF ----------------------------------------------
    // mtime+size across the whole run, and ABSENT counts as a stamp: creating a
    // file that was not there is as much a deployment as rewriting one. Bytes would
    // be hollow — an in-place rewrite on a clean tree is byte-identical.
    assert.deepEqual(
      liveStamps(),
      LIVE_STAMPS_AT_LOAD,
      'this clone\'s live .claude-plugin/sterling-mcp{,-win}.json must be byte-and-timestamp untouched across the entire suite: they are the MCP config the running session loads, and a suite that rewrites them repoints the live session at the test runner\'s interpreter (anti_pattern 37b3cb0a, severity block)' // not-a-citation: fixture id
    );
  } finally {
    for (const d of [pluginDir, plainDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
// SABOTAGE (the one this pin exists for): remove the containment default so the
// seam is not delivered to the child and init falls back to init-impl.mjs's
// STERLING_PLUGIN_ROOT_MATCH fallback (this clone) — in EITHER of its two forms, which are not equivalent:
//   (i)  drop `STERLING_PLUGIN_ROOT_MATCH: pluginRootMatch` from the spawn env while
//        the helper still computes and returns the value;
//   (ii) remove the scratch default outright.
// The delivered-effect assertion (the artifact under r.pluginRootMatch) goes red
// under BOTH, on every machine: the ensure lands on the clone and the scratch root
// is empty. The liveStamps deepEqual goes red IN ADDITION only where init would
// actually rewrite the clone's config — a different interpreter than the one
// recorded there, or a live config with no codex key (the gate re-probes and
// managed-refreshes). Two layers, unequal reach, and the reach is stated because it
// is the difference between a guard and a comfort.
//
// HONEST RECORD — DO NOT RE-READ THE OLD FORMULATION AS VERIFIED. Before this
// revision the machine-independent half of that claim was carried by three
// assertions over the RETURNED `r.pluginRootMatch`. The conductor RAN form (i) and
// measured 53 pass / 0 fail: the return value is the helper's INTENT, not the env
// the child received, so nothing reddened and the guard did not catch its own named
// sabotage. The lesson generalizes past this file: a pin over a value the test
// harness computed proves what the harness meant; only an artifact the CHILD
// produced proves what the child was given.
//
// SABOTAGE (the inversion the brief warns about): default the seam to `dir` instead
// of a third directory. The INTENT assertion `!== plainDir` goes red — and note that
// this one IS a harness-side check, adequate here only because that mutation is in
// the harness itself; it would not survive the child not receiving the value.
// SABOTAGE (control-only): make the plugin MCP config generation unconditional-skip.
// The CONTROL's existsSync goes red alone, exposing a green pin that would otherwise
// mean only "init writes nothing anywhere".
// WHICH GUARD CARRIES THE VERDICT: the delivered-effect assertion — the generated
// config's presence under the scratch plugin root. The mtime/absence stamp is a real
// second layer (it alone covers every OTHER spawn in the file, including ones this
// test never makes), not defense in depth for the same mutation: they redden under
// different conditions, and only the first is machine-independent. The `after()`
// cleanup and the returned value are plumbing, not layers.
