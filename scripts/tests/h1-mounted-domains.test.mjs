// H1 SessionStart — MOUNTED DOMAIN LINES (board c10f139b, decision
// projects-mount-domains-and-sibling-projects: "knowledge_promote, the promotion
// review item, knowledge_create and H1 show it"). One line per mounted domain with
// its description; a loud line for a domain whose store is missing and for one
// whose store has no description. The lines come from
// scripts/hooks/lib/operating-state.mjs, so the OpenCode context renders the same text.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
let createDomain;
let lib;
let contextMod;
before(async () => {
  ({ SterlingStore, createDomain } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  lib = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'operating-state.mjs')).href);
  contextMod = await import(pathToFileURL(join(root, 'packages', 'opencode-plugin', 'src', 'context.mjs')).href);
});

/** A project mounting alpha (described), bare (a store with no description) and ghost (no store). */
function project({ withDomains = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-domains-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const domain_paths = { alpha: join(dir, 'd', 'alpha', 'sterling.db'), bare: join(dir, 'd', 'bare', 'sterling.db'), ghost: join(dir, 'd', 'ghost', 'sterling.db') };
  const config = withDomains ? { stack_tags: ['alpha', 'bare', 'ghost'], domain_paths } : {};
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (withDomains) {
    mkdirSync(dirname(domain_paths.alpha), { recursive: true });
    createDomain('alpha', 'Alpha engine facts that hold in any project using it', domain_paths.alpha);
    mkdirSync(dirname(domain_paths.bare), { recursive: true });
    new SterlingStore(domain_paths.bare).close();
  }
  return { dir, config, domain_paths };
}

const domainLines = (text) => text.split('\n').filter((l) => /domain/i.test(l) && /^(⚠ )?(Mounted domain|sterling: domain)/.test(l));

function assertThreeLines(lines, p) {
  assert.equal(lines.length, 3, `one line per configured domain:\n${lines.join('\n')}`);
  assert.equal(lines[0], "Mounted domain 'alpha': Alpha engine facts that hold in any project using it");
  assert.match(lines[1], /^⚠ Mounted domain 'bare' has NO description/);
  assert.ok(lines[1].includes(p.domain_paths.bare), 'the undescribed line names the store');
  assert.match(lines[2], /^⚠ sterling: domain 'ghost' is configured but has no store at /, 'the missing line is the shared missingDomainWarning');
}

test('shared lib: described, undescribed and missing domains each get their line, in manifest order', () => {
  const p = project();
  try {
    assertThreeLines(lib.mountedDomainLines({ config: p.config, configUnreadable: false }), p);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('shared lib: no mounted domain means no line; an unreadable or malformed config is UNKNOWN, never silence', () => {
  assert.deepEqual(lib.mountedDomainLines({ config: null, configUnreadable: false }), []);
  assert.deepEqual(lib.mountedDomainLines({ config: {}, configUnreadable: false }), []);
  const [unreadable] = lib.mountedDomainLines({ config: null, configUnreadable: true });
  assert.match(unreadable, /^⚠ Mounted domains: UNKNOWN — the project config could not be read/);
  const [malformed] = lib.mountedDomainLines({ config: { stack_tags: 'alpha' }, configUnreadable: false });
  assert.match(malformed, /^⚠ Mounted domains: UNKNOWN — config\.stack_tags or config\.domain_paths is malformed/);
});

test('H1 prints the mounted domain lines', () => {
  const p = project();
  try {
    const input = { session_id: 's1', transcript_path: join(p.dir, 't', 's1.jsonl'), cwd: p.dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' };
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
      input: JSON.stringify(input), encoding: 'utf8', cwd: p.dir, timeout: 60_000,
      env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root },
    });
    assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assertThreeLines(domainLines(JSON.parse(r.stdout).hookSpecificOutput.additionalContext), p);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('the OpenCode root context carries the same domain lines, opened through its own opener', async () => {
  const p = project();
  try {
    const opened = [];
    const h = contextMod.createContextHandler({
      openStore: (dbPath) => (opened.push(dbPath), new SterlingStore(dbPath)),
      now: () => '2026-10-03T12:00:00.000Z',
      rootOf: () => p.dir,
      fenced: async (_name, _root, fn) => fn(),
      rotationRestore: async () => '',
      sessionSync: async () => {},
      pluginRoot: join(p.dir, 'no-such-plugin-root'),
      getSession: () => ({ get: async ({ sessionID }) => ({ id: sessionID }) }),
    });
    const i = { sessionID: 'ses_root', agent: 'build', system: [{ type: 'text', text: 'base' }], messages: [], tools: {} };
    await h.onContext(i);
    assertThreeLines(domainLines(i.system.map((x) => x.text).join('\n')), p);
    assert.ok(opened.includes(p.domain_paths.alpha), "the domain store was opened through the plugin's opener");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});
