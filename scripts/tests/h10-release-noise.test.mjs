// H10 capture duty skips release mechanics (decision gap-hunt-2026-09-28-rulings,
// items 4+5; evidence: finding sterling-gap-hunt-ranked-ideas-september-2026 —
// 11 of 23 no_capture calls across 8 sessions answered a nag raised by a
// release bump or a regenerated projection).
//
//   (1) a version-only bump of package.json / package-lock.json (the shared
//       proof in scripts/lib/version-only.mjs, against the settled snapshot's
//       commit) and a path listed in config.generated_projections arm NO
//       capture duty;
//   (2) CONTROL: a real dependency edit in the lockfile still arms it;
//   (3) CONTROL: the same projection file NOT listed in config still arms it,
//       so the skip is config-driven, not a hardcoded name.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeGitProject(generated) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-release-noise-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = { toolchains: [], context_watch: { windows: { default: 200_000 } } };
  if (generated) config.generated_projections = generated;
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  return {
    dir,
    store,
    g,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const pkg = (v) => JSON.stringify({ name: 'fixture', version: v, scripts: { test: 'node --test' } }, null, 2) + '\n';
function lock(v, dep = '1.0.0', integrity = 'sha512-aaa') {
  return (
    JSON.stringify(
      {
        name: 'fixture',
        version: v,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'fixture', version: v },
          'node_modules/dep': { version: dep, resolved: 'https://registry.example/dep.tgz', integrity },
        },
      },
      null,
      2
    ) + '\n'
  );
}

function seed(dir, g) {
  writeFileSync(join(dir, 'package.json'), pkg('0.1.0'));
  writeFileSync(join(dir, 'package-lock.json'), lock('0.1.0'));
  writeFileSync(join(dir, 'architecture.md'), '<!-- GENERATED -->\nv1\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
}

function runStop(dir) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ownAll(store, paths) {
  const at = '2026-09-28T12:00:00.000Z';
  store.create({
    id: randomUUID(),
    type: 'feature_article',
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    slug: 'release-manifests',
    title: 'release manifests',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: paths.map((path) => ({ path, role: 'manifest' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'fixture' }],
    live_test_refs: [],
  });
}

const captureOwed = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'capture_owed');

test('(1) a version-only package.json + lockfile bump and a configured generated projection arm no capture duty', () => {
  const { dir, store, g, cleanup } = makeGitProject(['architecture.md']);
  try {
    seed(dir, g);
    // Owned, as they are in a real project: the ARTICLE demand is a separate
    // lane this change leaves alone, and it would fire on three unowned files.
    ownAll(store, ['package.json', 'package-lock.json', 'architecture.md']);
    assert.equal(runStop(dir).code, 0, 'seed Stop on a clean tree releases');
    writeFileSync(join(dir, 'package.json'), pkg('0.1.1'));
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.1'));
    writeFileSync(join(dir, 'architecture.md'), '<!-- GENERATED -->\nv2\n');
    const r = runStop(dir);
    assert.equal(r.code, 0, `release mechanics must not nag — stderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /capture · /);
    assert.equal(captureOwed(store).length, 0);
  } finally {
    cleanup();
  }
});

test('(2) CONTROL: a real dependency edit in the lockfile alongside the bump still arms the capture duty', () => {
  const { dir, g, cleanup } = makeGitProject(['architecture.md']);
  try {
    seed(dir, g);
    assert.equal(runStop(dir).code, 0, 'seed Stop');
    writeFileSync(join(dir, 'package.json'), pkg('0.1.1'));
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.1', '2.0.0', 'sha512-bbb'));
    const r = runStop(dir);
    assert.equal(r.code, 2, `a dependency edit is real work — stderr=${r.stderr}`);
    assert.match(r.stderr, /capture · 1 file/, 'only the lockfile counts; the version-only package.json does not');
  } finally {
    cleanup();
  }
});

test('(3) CONTROL: a projection file NOT listed in config.generated_projections still arms the capture duty', () => {
  const { dir, g, cleanup } = makeGitProject();
  try {
    seed(dir, g);
    assert.equal(runStop(dir).code, 0, 'seed Stop');
    writeFileSync(join(dir, 'architecture.md'), '<!-- GENERATED -->\nv2\n');
    const r = runStop(dir);
    assert.equal(r.code, 2, `an unlisted file is ordinary work — stderr=${r.stderr}`);
    assert.match(r.stderr, /capture · 1 file/);
  } finally {
    cleanup();
  }
});
