import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLaunchArgs } from '../launch-args.js';
import { openDashboard } from '../controller.js';
import { SYSTEM_TAB } from '../state.js';

// The terminal TUI's command line (main.ts). The OpenCode launcher opens the
// side pane as `sterling-tui --store <db> --host opencode`; before this pin the
// parsed host reached only the Agents tab, openDashboard got no host, and the
// Overpass rows never showed on the side pane's System tab in a work-mode
// project (2026-10-21, CH.Hub on 0.19.93).

const VP = { width: 100, maxBodyLines: 60, showBanner: false };

test('launch args: --host opencode reaches openDashboard, so the side pane shows the Overpass rows in work mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-launch-args-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  // the shape of the reported project's config: work mode, no overpass key
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', tdd: { enabled: true } }, null, 2) + '\n');
  const parsed = parseLaunchArgs(['--store', join(dir, '.sterling', 'sterling.db'), '--host', 'opencode']);
  assert.ok(parsed);
  assert.equal(parsed.host, 'opencode');
  const ctl = openDashboard(parsed.storePath, { host: parsed.dashboardHost });
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    const text = ctl.state(VP).rows.filter((r) => r.id.startsWith('sys:overpass')).map((r) => r.lines[0].text).join('\n');
    assert.match(text, /Overpass: OFF/);
    assert.match(text, /Overpass provider: overpass/);
    assert.match(text, /Conductor bypass: OFF/);
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launch args: the Claude Code host (default, or --host claude) passes no dashboard host', () => {
  assert.deepEqual(parseLaunchArgs(['--store', 'x.db']), { storePath: 'x.db', host: 'claude', dashboardHost: undefined });
  assert.deepEqual(parseLaunchArgs(['--store', 'x.db', '--host', 'claude']), { storePath: 'x.db', host: 'claude', dashboardHost: undefined });
});

test('launch args: a missing store or an unknown host is refused', () => {
  assert.equal(parseLaunchArgs([]), null);
  assert.equal(parseLaunchArgs(['--store']), null);
  assert.equal(parseLaunchArgs(['--store', 'x.db', '--host', 'terminal']), null);
  assert.equal(parseLaunchArgs(['--store', 'x.db', '--host']), null);
});
