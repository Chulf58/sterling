// The subject fan (board c10f139b, decision projects-mount-domains-and-sibling-projects):
// scripts/hooks/lib/subject-fan.mjs opens the project store plus the domains the
// project config mounts (config.stack_tags, config.domain_paths), skipping a domain
// whose store does not exist and never creating one. Subject queries split the cap
// with the D1 read shares; a path-keyed query (file_keys present) reads the project
// store ONLY, because a domain record's file_keys belong to other repos. Every
// returned record carries source_store. H20, H23 and the H19 staging subject arm
// read through it; H19 file-touch delivery does not.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-10-03T12:00:00.000Z';

let SterlingStore;
let createDomain;
let fanLib;
let stageLib;
before(async () => {
  ({ SterlingStore, createDomain } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  fanLib = await import(pathToFileURL(join(HOOKS, 'lib', 'subject-fan.mjs')).href);
  stageLib = await import(pathToFileURL(join(HOOKS, 'lib', 'stage-brief.mjs')).href);
});

const envelope = (type, scope = 'project') => ({ id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope, stack_tags: [] });

const TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const MATCHING = 'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';

const antiPattern = (title, scope = 'project', file_keys = []) => ({
  ...envelope('anti_pattern', scope),
  title,
  trigger: TRIGGER,
  guidance: 'guidance',
  wrong_way: 'wrong way',
  right_way: 'right way text',
  source_evidence: 'evidence',
  basis: 'codebase',
  file_keys,
});

/** A project whose config mounts `domains` ({name: description|null}); null = configured but never created. */
function makeProject(domains = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-fan-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const domain_paths = {};
  for (const name of Object.keys(domains)) domain_paths[name] = join(dir, 'domains', name, 'sterling.db');
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ stack_tags: Object.keys(domains), domain_paths }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  for (const [name, description] of Object.entries(domains)) {
    if (description === null) continue;
    mkdirSync(dirname(domain_paths[name]), { recursive: true });
    createDomain(name, description, domain_paths[name]);
  }
  const withStore = (name, fn) => {
    const s = new SterlingStore(name === 'project' ? join(dir, '.sterling', 'sterling.db') : domain_paths[name]);
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  return { dir, domain_paths, withStore, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const terms = ['breach', 'countdown', 'widget', 'flywheel'];

test('fan: no project store means no fan, and nothing is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-fan-none-'));
  try {
    assert.equal(fanLib.openSubjectFan(dir), null);
    assert.equal(existsSync(join(dir, '.sterling')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fan: with no mounted domain it reads the project store alone, each record tagged project', () => {
  const p = makeProject();
  try {
    p.withStore('project', (s) => s.create(antiPattern('PROJECT breach hazard')));
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      const out = fan.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 });
      assert.deepEqual(out.map((r) => [r.title, r.source_store]), [['PROJECT breach hazard', 'project']]);
      assert.deepEqual(fan.missingDomains, []);
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('fan: a subject query reads every mounted domain, tags the source, and skips a missing domain without creating it', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge', ghost: null });
  try {
    p.withStore('project', (s) => s.create(antiPattern('PROJECT breach hazard')));
    p.withStore('alpha', (s) => s.create(antiPattern('ALPHA domain breach hazard', 'domain:alpha')));
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      const out = fan.query({ types: ['anti_pattern'], rank_terms: terms, cap: 40 });
      assert.deepEqual(out.map((r) => [r.title, r.source_store]), [['PROJECT breach hazard', 'project'], ['ALPHA domain breach hazard', 'alpha']], 'project first, then domains in manifest order');
      assert.deepEqual(fan.missingDomains.map((m) => m.name), ['ghost']);
      assert.equal(fan.missingDomains[0].dbPath, p.domain_paths.ghost);
    } finally {
      fan.close();
    }
    assert.equal(existsSync(p.domain_paths.ghost), false, 'a missing domain store is never created');
  } finally {
    p.cleanup();
  }
});

test('fan: a path-keyed query reads the project store ONLY, even when a domain record carries the same file_key', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    p.withStore('project', (s) => s.create(antiPattern('PROJECT path hazard', 'project', ['src/x.ts'])));
    p.withStore('alpha', (s) => s.create(antiPattern('FOREIGN path hazard', 'domain:alpha', ['src/x.ts'])));
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      const out = fan.query({ types: ['anti_pattern'], file_keys: ['src/x.ts'], cap: 100 });
      assert.deepEqual(out.map((r) => [r.title, r.source_store]), [['PROJECT path hazard', 'project']]);
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('fan: the cap is split with the D1 read shares, never by comparing scores across stores', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    p.withStore('project', (s) => { for (let i = 0; i < 12; i++) s.create(antiPattern(`PROJECT hazard ${i}`)); });
    p.withStore('alpha', (s) => { for (let i = 0; i < 12; i++) s.create(antiPattern(`ALPHA hazard ${i}`, 'domain:alpha')); });
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      const out = fan.query({ types: ['anti_pattern'], rank_terms: terms, cap: 10 });
      assert.equal(out.filter((r) => r.source_store === 'project').length, 6, 'the project gets ceil(0.6 x 10)');
      assert.equal(out.filter((r) => r.source_store === 'alpha').length, 4, 'the domain gets the rest');
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('fan: inboundSupersedes reads the domain stores too, so a domain decision\'s supersession is not missed', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    const [target, source] = p.withStore('alpha', (s) => {
      const old = s.create(antiPattern('ALPHA retired hazard', 'domain:alpha'));
      const survivor = s.create(antiPattern('ALPHA surviving hazard', 'domain:alpha'));
      s.retireInFavorOf(old.id, survivor.id, NOW);
      return [old, survivor];
    });
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      assert.deepEqual(fan.inboundSupersedes(target.id).map((r) => [r.id, r.source_store]), [[source.id, 'alpha']]);
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('fan: every store is opened through the given opener, and close closes them all', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge', beta: 'Beta subject knowledge' });
  try {
    const opened = [];
    const fan = fanLib.openSubjectFan(p.dir, {
      opener: (dbPath) => {
        const s = new SterlingStore(dbPath);
        const close = s.close.bind(s);
        const entry = { dbPath, closed: false };
        s.close = () => { entry.closed = true; close(); };
        opened.push(entry);
        return s;
      },
    });
    assert.deepEqual(opened.map((o) => o.dbPath), [join(p.dir, '.sterling', 'sterling.db'), p.domain_paths.alpha, p.domain_paths.beta]);
    fan.close();
    assert.ok(opened.every((o) => o.closed), 'every opened store is closed');
  } finally {
    p.cleanup();
  }
});

test('fan: a malformed stack_tags is a loud config error, never a silent "no domains"', () => {
  // Was: openSubjectFan threw, which took the project store's delivery down with it
  // (task-end review 2026-10-03). It now mounts the project store only and the
  // error rides configError, which every caller prints through fanDegradedLine.
  const p = makeProject();
  try {
    writeFileSync(join(p.dir, '.sterling', 'config.json'), JSON.stringify({ stack_tags: 'node' }));
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      assert.deepEqual(fan.domainNames, []);
      assert.ok(fan.configError, 'the malformed field is recorded');
      assert.match(fanLib.fanDegradedLine(fan, 'H20'), /^H20: DEGRADED subject fan: config\.json unreadable/);
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('fan: a domain file that is not SQLite is dropped and listed unreadable; the project store still answers', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge', junk: 'placeholder' });
  try {
    writeFileSync(p.domain_paths.junk, 'this is not a sqlite database, just text '.repeat(50));
    for (const ext of ['-wal', '-shm']) rmSync(p.domain_paths.junk + ext, { force: true });
    p.withStore('project', (s) => s.create(antiPattern('PROJECT breach countdown hazard')));
    p.withStore('alpha', (s) => s.create(antiPattern('ALPHA breach countdown hazard', 'domain:alpha')));
    const fan = fanLib.openSubjectFan(p.dir);
    try {
      assert.deepEqual(fan.domainNames, ['alpha']);
      assert.deepEqual(fan.unreadableDomains.map((d) => [d.name, d.dbPath]), [['junk', p.domain_paths.junk]]);
      assert.ok(fan.unreadableDomains[0].error, 'the error is recorded');
      assert.deepEqual(fan.query({ rank_terms: terms }).map((r) => r.source_store).sort(), ['alpha', 'project']);
      assert.match(fanLib.fanDegradedLine(fan, 'H23'), /domain 'junk' unreadable at .*junk/);
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('fan: a domain whose query throws is dropped from the fan and reported; the project and other domains still answer', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge', beta: 'Beta subject knowledge' });
  try {
    p.withStore('project', (s) => s.create(antiPattern('PROJECT breach countdown hazard')));
    p.withStore('alpha', (s) => s.create(antiPattern('ALPHA breach countdown hazard', 'domain:alpha')));
    const fan = fanLib.openSubjectFan(p.dir, {
      opener: (dbPath) => {
        const s = new SterlingStore(dbPath);
        if (dbPath === p.domain_paths.beta) {
          s.query = () => { throw new Error('database is locked'); };
          s.inboundSupersedes = () => { throw new Error('database is locked'); };
        }
        return s;
      },
    });
    try {
      assert.deepEqual(fan.query({ rank_terms: terms }).map((r) => r.source_store).sort(), ['alpha', 'project']);
      assert.deepEqual(fan.domainNames, ['alpha'], 'beta is dropped after its query threw');
      assert.deepEqual(fan.unreadableDomains.map((d) => [d.name, d.error]), [['beta', 'database is locked']]);
      assert.deepEqual(fan.inboundSupersedes(randomUUID()), [], 'later reads skip the dropped domain');
      assert.equal(fan.unreadableDomains.length, 1, 'a dropped domain is reported once');
    } finally {
      fan.close();
    }
  } finally {
    p.cleanup();
  }
});

test('mounted domain description: described, undescribed and missing domains are each reported', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge', bare: 'placeholder', ghost: null });
  try {
    // createDomain always records a description, so an undescribed store is made by hand.
    rmSync(dirname(p.domain_paths.bare), { recursive: true, force: true });
    mkdirSync(dirname(p.domain_paths.bare), { recursive: true });
    new SterlingStore(p.domain_paths.bare).close();
    const config = { stack_tags: ['alpha', 'bare', 'ghost'], domain_paths: p.domain_paths };
    const out = fanLib.describeMountedDomains(config);
    assert.deepEqual(out.map((d) => [d.name, d.state, d.description]), [['alpha', 'described', 'Alpha subject knowledge'], ['bare', 'undescribed', undefined], ['ghost', 'missing', undefined]]);
    assert.equal(existsSync(p.domain_paths.ghost), false, 'describing never creates a store');
  } finally {
    p.cleanup();
  }
});

// ---- the hooks read through the fan -------------------------------------------

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('H20: a dispatch whose subject matches a MOUNTED DOMAIN hazard gets it delivered', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    p.withStore('alpha', (s) => s.create(antiPattern('ALPHA domain breach countdown hazard', 'domain:alpha')));
    const r = runHook('h20-mechanism-axis.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'implementor', prompt: `Fix the breach alarm: ${MATCHING}` }, session_id: 's1', cwd: p.dir }, p.dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /MECHANISM-AXIS DELIVERY \(H20\)/);
    assert.match(ctx, /ALPHA domain breach countdown hazard/, 'the domain hazard reaches the conductor');
  } finally {
    p.cleanup();
  }
});

test('H23: tool output matching a MOUNTED DOMAIN hazard gets the advisory pointer', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    p.withStore('alpha', (s) => s.create(antiPattern('ALPHA domain output hazard', 'domain:alpha')));
    const r = runHook('h23-output-axis.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node scripts/reactor.mjs' }, tool_response: { stdout: MATCHING }, session_id: 's1', cwd: p.dir }, p.dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING OUTPUT-AXIS DELIVERY \(H23\)/);
    assert.match(ctx, /ALPHA domain output hazard/);
  } finally {
    p.cleanup();
  }
});

test('H19 staging: the subject arm reads a mounted domain while the path arm stays project-only', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    p.withStore('alpha', (s) => {
      s.create(antiPattern('ALPHA subject staging hazard', 'domain:alpha'));
      s.create({ ...antiPattern('FOREIGN path staging hazard', 'domain:alpha', ['src/x.ts']), trigger: 'an unrelated quarterly invoice export header row' });
    });
    const fan = fanLib.openSubjectFan(p.dir);
    let staged;
    try {
      staged = stageLib.stageBrief({ store: fan, cwd: p.dir, prompts: [`Edit src/x.ts. Fix the breach alarm: ${MATCHING}`], guardId: { agentId: 'a1', sessionId: 's1' }, hazardMode: 'whole' });
    } finally {
      fan.close();
    }
    assert.ok(staged, 'something is staged');
    assert.match(staged.text, /ALPHA subject staging hazard/, 'the subject arm reads the domain');
    assert.doesNotMatch(staged.text, /FOREIGN path staging hazard/, "a domain record's file_keys never drive path delivery");
  } finally {
    p.cleanup();
  }
});

// ---- a degraded fan never takes the project store's delivery down -------------
// Task-end review 2026-10-03: one bad domain file, or a truncated config.json, made
// openSubjectFan throw, so H20/H23/H19 lost the PROJECT hazard too.

const H20_INPUT = (dir) => ({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'implementor', prompt: `Fix the breach alarm: ${MATCHING}` }, session_id: 's1', cwd: dir });

function projectWithBadDomain() {
  const p = makeProject({ junk: 'placeholder' });
  writeFileSync(p.domain_paths.junk, 'this is not a sqlite database, just text '.repeat(50));
  for (const ext of ['-wal', '-shm']) rmSync(p.domain_paths.junk + ext, { force: true });
  p.withStore('project', (s) => s.create(antiPattern('PROJECT breach countdown hazard')));
  return p;
}

test('H20: a configured domain file that is not SQLite still delivers the project hazard, with one stderr line', () => {
  const p = projectWithBadDomain();
  try {
    const r = runHook('h20-mechanism-axis.mjs', H20_INPUT(p.dir), p.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PROJECT breach countdown hazard/);
    const lines = r.stderr.split('\n').filter((l) => l.includes('DEGRADED subject fan'));
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^H20: DEGRADED subject fan: domain 'junk' unreadable at .*junk/);
  } finally {
    p.cleanup();
  }
});

test('H20: a truncated config.json still delivers the project hazard, with one stderr line naming the config error', () => {
  const p = makeProject({ alpha: 'Alpha subject knowledge' });
  try {
    p.withStore('project', (s) => s.create(antiPattern('PROJECT breach countdown hazard')));
    writeFileSync(join(p.dir, '.sterling', 'config.json'), '{"stack_tags": ["al');
    const r = runHook('h20-mechanism-axis.mjs', H20_INPUT(p.dir), p.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PROJECT breach countdown hazard/);
    const lines = r.stderr.split('\n').filter((l) => l.includes('DEGRADED subject fan'));
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^H20: DEGRADED subject fan: config\.json unreadable, no domains mounted \(/);
  } finally {
    p.cleanup();
  }
});

test('H23: a configured domain file that is not SQLite still points at the project hazard, with one stderr line', () => {
  const p = projectWithBadDomain();
  try {
    const r = runHook('h23-output-axis.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node scripts/reactor.mjs' }, tool_response: { stdout: MATCHING }, session_id: 's1', cwd: p.dir }, p.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PROJECT breach countdown hazard/);
    assert.equal(r.stderr.split('\n').filter((l) => /^H23: DEGRADED subject fan: domain 'junk'/.test(l)).length, 1, r.stderr);
  } finally {
    p.cleanup();
  }
});

test('H19 staging: a configured domain file that is not SQLite prints one stderr line and the hook exits 0', () => {
  const p = projectWithBadDomain();
  try {
    const r = runHook('h19-dispatch-staging.mjs', { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'implementor', session_id: 's1', cwd: p.dir }, p.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr.split('\n').filter((l) => /^H19: DEGRADED subject fan: domain 'junk'/.test(l)).length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /dispatch staging failed/, 'the fan degraded; staging itself did not fail');
  } finally {
    p.cleanup();
  }
});
