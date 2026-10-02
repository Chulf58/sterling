// H10's context-window lookup reads ONE table shipped in the plugin
// (templates/context-windows.json); a project's context_watch.windows only
// overrides it. Board shared-model-context-window-table-for-h10-s-context-warning
// (user-stated 2026-10-01: "...a shared file for all projects with model's
// context window, so we only have to maintain it one place").
//
// Lookup order pinned here: project windows[model] -> project windows[baseModel]
// -> shared[model] -> shared[baseModel] -> project windows.default -> shared
// default. A shared file that is missing, unreadable or invalid is announced
// once ("shared context-window table unavailable: <reason>") and lookup
// continues with the project table (P5).
//
// The source hook and the committed bundle both resolve the shared file through
// the plugin-root walk-up. The missing/invalid cases need a plugin tree WITHOUT
// the file, so they spawn a fresh bundle from a marker-free temp dir and point
// the (test-only) STERLING_PLUGIN_ROOT seam at a fixture tree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_HOOK = join(root, 'scripts', 'hooks', 'h10-direct-capture.mjs');
const BUNDLED_HOOK = join(root, 'hooks', 'h10-direct-capture.mjs');
const SHARED = JSON.parse(readFileSync(join(root, 'templates', 'context-windows.json'), 'utf8'));

let SterlingStore;
let seam;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  seam = await buildSeamHook('h10-direct-capture.mjs');
});
after(() => seam?.cleanup());

function makeProject(windows) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-shared-windows-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [], context_watch: { windows, conductor: { soft_pct: 35, hard_pct: 50 } } }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init: ${r.stderr}`);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeTranscript(dir, inputTokens, model) {
  const p = join(dir, 't', 's1.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: inputTokens, cache_read_input_tokens: 0 } } }) + '\n');
}

function runStop(dir, hook = SOURCE_HOOK, env = {}) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  const message = r.stdout?.trim() ? JSON.parse(r.stdout).systemMessage ?? '' : '';
  return { code: r.status, message, stderr: r.stderr ?? '' };
}

const pressureSample = (dir) => JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'conductor-pressure.json'), 'utf8'));

/** A plugin tree the walk-up and the layout markers accept, with an optional shared file body. */
function fakePluginRoot(sharedBody) {
  const fake = mkdtempSync(join(tmpdir(), 'sterling-fake-plugin-'));
  mkdirSync(join(fake, '.claude-plugin'), { recursive: true });
  mkdirSync(join(fake, 'hooks'), { recursive: true });
  mkdirSync(join(fake, 'templates'), { recursive: true });
  writeFileSync(join(fake, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fake', version: '0.0.0' }));
  writeFileSync(join(fake, 'hooks', 'hooks.json'), '{}');
  if (sharedBody !== undefined) writeFileSync(join(fake, 'templates', 'context-windows.json'), sharedBody);
  return { fake, cleanup: () => rmSync(fake, { recursive: true, force: true }) };
}

test('the shipped shared table maps the models the old per-project seed carried, plus claude-fable-5', () => {
  assert.equal(SHARED.windows['claude-fable-5'], 1_000_000);
  assert.equal(SHARED.windows['claude-fable-5-1'], 1_000_000);
  assert.equal(SHARED.windows['claude-opus-5'], 1_000_000);
  assert.equal(SHARED.windows['claude-sonnet-5'], 1_000_000);
  assert.equal(SHARED.windows['claude-haiku-4-5'], 200_000);
});

test('templates/default-config.json no longer seeds per-model windows into new projects, and keeps the real default', () => {
  const windows = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')).context_watch.windows;
  assert.deepEqual(windows, { default: 1_000_000 });
});

test('shared hit: a model absent from the project table is measured against the shared window, and the line names the shared file', () => {
  const { dir, cleanup } = makeProject({ default: 200_000 });
  try {
    writeTranscript(dir, 600_000, 'claude-fable-5-1');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    const s = pressureSample(dir);
    assert.equal(s.window, 1_000_000, 'the shared 1M window wins over the project 200k default');
    assert.equal(s.window_source, 'shared');
    assert.ok(Math.abs(s.fill_pct - 60) < 0.01, `fill 60%, got ${s.fill_pct}`);
    assert.match(r.message, /60\.0%/);
    assert.match(r.message, /templates\/context-windows\.json/, 'the pressure line names the shared file as the source');
    assert.doesNotMatch(r.message, /context_watch\.windows\.default/, 'not reported as the project default');
  } finally {
    cleanup();
  }
});

test('project override: a project entry for the model wins over the shared table and the line carries no shared note', () => {
  const { dir, cleanup } = makeProject({ default: 200_000, 'claude-fable-5-1': 400_000 });
  try {
    writeTranscript(dir, 240_000, 'claude-fable-5-1');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    const s = pressureSample(dir);
    assert.equal(s.window, 400_000, 'the project override, not the shared 1,000,000');
    assert.equal(s.window_source, undefined, 'a project per-model entry is the existing, unflagged case');
    assert.match(r.message, /60\.0%/);
    assert.doesNotMatch(r.message, /context-windows\.json/);
  } finally {
    cleanup();
  }
});

test('base-model stripping: "claude-opus-5[1m]" resolves to the shared claude-opus-5 entry, not the project default', () => {
  const { dir, cleanup } = makeProject({ default: 200_000 });
  try {
    writeTranscript(dir, 600_000, 'claude-opus-5[1m]');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    const s = pressureSample(dir);
    assert.equal(s.window, 1_000_000);
    assert.equal(s.window_source, 'shared');
    assert.match(r.message, /templates\/context-windows\.json/);
  } finally {
    cleanup();
  }
});

test('a project entry for the BASE model beats the shared table for the [1m] variant', () => {
  const { dir, cleanup } = makeProject({ default: 200_000, 'claude-opus-5': 500_000 });
  try {
    writeTranscript(dir, 100_000, 'claude-opus-5[1m]');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(pressureSample(dir).window, 500_000);
  } finally {
    cleanup();
  }
});

test('the committed bundle hooks/h10-direct-capture.mjs resolves the shared file through the plugin-root walk-up', () => {
  const { dir, cleanup } = makeProject({ default: 200_000 });
  try {
    writeTranscript(dir, 600_000, 'claude-fable-5-1');
    const r = runStop(dir, BUNDLED_HOOK);
    assert.equal(r.code, 0, r.stderr);
    const s = pressureSample(dir);
    assert.equal(s.window, 1_000_000, 'the bundle found templates/context-windows.json above hooks/');
    assert.equal(s.window_source, 'shared');
    assert.match(r.message, /templates\/context-windows\.json/);
    assert.doesNotMatch(r.message, /shared context-window table unavailable/);
  } finally {
    cleanup();
  }
});

for (const [label, body] of [
  ['missing', undefined],
  ['not JSON', '{ this is not json'],
  ['wrong shape (no windows object)', JSON.stringify({ models: {} })],
  ['an invalid window size', JSON.stringify({ windows: { 'claude-fable-5-1': -5 } })],
]) {
  test(`a ${label} shared file is announced once and lookup falls back to the project table`, () => {
    const { dir, cleanup } = makeProject({ default: 200_000 });
    const plugin = fakePluginRoot(body);
    try {
      writeTranscript(dir, 100_000, 'claude-fable-5-1');
      const env = { STERLING_PLUGIN_ROOT: plugin.fake };
      const first = runStop(dir, seam.hookPath, env);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.message, /shared context-window table unavailable: \S/, 'the degradation is announced, never silent');
      const s = pressureSample(dir);
      assert.equal(s.window, 200_000, 'fell back to the project default');
      assert.equal(s.window_source, 'default');
      const second = runStop(dir, seam.hookPath, env);
      assert.equal(second.code, 0, second.stderr);
      assert.doesNotMatch(second.message, /shared context-window table unavailable/, 'announced once per session');
    } finally {
      plugin.cleanup();
      cleanup();
    }
  });
}

test('an unavailable shared file does not hide a project per-model entry, and says nothing when it was not needed', () => {
  const { dir, cleanup } = makeProject({ default: 200_000, 'claude-fable-5-1': 400_000 });
  const plugin = fakePluginRoot(undefined);
  try {
    writeTranscript(dir, 100_000, 'claude-fable-5-1');
    const r = runStop(dir, seam.hookPath, { STERLING_PLUGIN_ROOT: plugin.fake });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(pressureSample(dir).window, 400_000);
    assert.doesNotMatch(r.message, /shared context-window table unavailable/);
  } finally {
    plugin.cleanup();
    cleanup();
  }
});

test('the project default beats the shared default; the shared default is the last resort', () => {
  const plugin = fakePluginRoot(JSON.stringify({ windows: { default: 500_000 } }));
  const withDefault = makeProject({ default: 200_000 });
  const noDefault = makeProject({});
  try {
    const env = { STERLING_PLUGIN_ROOT: plugin.fake };
    writeTranscript(withDefault.dir, 100_000, 'claude-novel-9');
    assert.equal(runStop(withDefault.dir, seam.hookPath, env).code, 0);
    assert.equal(pressureSample(withDefault.dir).window, 200_000, 'project default first');

    writeTranscript(noDefault.dir, 250_000, 'claude-novel-9');
    const r = runStop(noDefault.dir, seam.hookPath, env);
    assert.equal(r.code, 0, r.stderr);
    const s = pressureSample(noDefault.dir);
    assert.equal(s.window, 500_000, 'shared default when the project has none');
    assert.equal(s.window_source, 'default');
    assert.match(r.message, /50\.0%/);
    assert.match(r.message, /templates\/context-windows\.json/, 'the line names the shared file as the default source');
  } finally {
    plugin.cleanup();
    withDefault.cleanup();
    noDefault.cleanup();
  }
});

test('window_unmapped gauge text points at templates/context-windows.json in the Sterling plugin, not the project config', () => {
  const { dir, cleanup } = makeProject({});
  try {
    writeTranscript(dir, 132_400, 'claude-novel-9');
    const r = runStop(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.message, /claude-novel-9/);
    assert.match(r.message, /UNRELIABLE/i);
    assert.match(r.message, /templates\/context-windows\.json/);
    assert.match(r.message, /Sterling plugin/);
    assert.doesNotMatch(r.message, /\.sterling\/config\.json/, 'no longer sends the user to the project config');
  } finally {
    cleanup();
  }
});
