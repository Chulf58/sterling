import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  lintAgentPrompt,
  checkSpawnContract,
  lintSkill,
  PROMPT_CONTRACT_SECTIONS,
  collectRecordCitations,
  lintRecordCitations,
  CITED_RECORD_WORDS,
  UNCITED_RECORD_WORDS,
} from '../lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const GOOD_PROMPT = `---
name: reviewer-skeptic
required_inputs:
  - brief
  - diff
---
# Role & owned judgment
x
# Inputs it will receive
x
# Rubric / priorities
x
# Worked example
x
# Output contract
x
# Scope boundaries (negatives)
x
# Exit signals it may emit
x
`;

test('prompt linter: all seven §7.3 sections required, in order', () => {
  assert.deepEqual(lintAgentPrompt(GOOD_PROMPT, 'good.md'), []);
  assert.equal(PROMPT_CONTRACT_SECTIONS.length, 7);
  const missing = lintAgentPrompt(GOOD_PROMPT.replace('# Worked example\nx\n', ''), 'bad.md');
  assert.deepEqual(missing.map((v) => v.kind), ['missing_section']);
  assert.match(missing[0].detail, /worked_example/);
  const reordered = GOOD_PROMPT.replace('# Role & owned judgment\nx\n', '') + '# Role & owned judgment\nx\n';
  assert.ok(lintAgentPrompt(reordered, 'reordered.md').some((v) => v.kind === 'section_out_of_order'));
});

test('spawn-contract check: required-inputs manifest must be in frontmatter (§7.4)', () => {
  assert.deepEqual(checkSpawnContract(GOOD_PROMPT, 'good.md'), []);
  const noManifest = GOOD_PROMPT.replace(/required_inputs:[\s\S]*?- diff\n/, '');
  assert.deepEqual(checkSpawnContract(noManifest, 'bad.md').map((v) => v.kind), ['missing_required_inputs']);
});

test('skill linter: flags stale file references, accepts live ones', () => {
  assert.deepEqual(lintSkill('Run scripts/dispose-run.mjs then check templates/default-config.json.', 's', root), []);
  const stale = lintSkill('See scripts/does-not-exist.mjs for details.', 'debug/SKILL.md', root);
  assert.deepEqual(stale.map((v) => v.kind), ['stale_file_reference']);
  // R2 72807b1f: the grammar covers skills/ + commands/ prefixes (cross-skill
  // references were previously unlinted) and sh/bat extensions
  assert.deepEqual(lintSkill('See skills/drain/SKILL.md and commands/merge.md.', 's', root), []);
  const staleSkill = lintSkill('See skills/gone/SKILL.md and templates/gone.sh.', 's', root);
  assert.equal(staleSkill.length, 2, 'skills/ and .sh references are existence-checked');
});

// -- record-id citation check (board 10668ae3) ------------------------------

test('citation grammar: the NEAREST preceding record word owns the id', () => {
  assert.deepEqual(
    collectRecordCitations('see decision 6dfbe675 for the fork').map((c) => [c.word, c.id]),
    [['decision', '6dfbe675']]
  );
  // a slug may sit between the word and the id
  assert.deepEqual(collectRecordCitations('article stale-server-guard 8f48f67c').map((c) => c.id), ['8f48f67c']);
  // several ids after one word all count
  assert.deepEqual(collectRecordCitations('decisions a127e6e1, 5a992de5 apply').map((c) => c.id), [
    'a127e6e1',
    '5a992de5',
  ]);
  // full uuids are cited too
  assert.deepEqual(
    collectRecordCitations('research_finding 5c1a824d-d182-4a1f-92d5-e6837dd1de09').map((c) => c.id),
    ['5c1a824d-d182-4a1f-92d5-e6837dd1de09']
  );
  // REGRESSION (both live false positives on a clean tree): the window must not
  // leak past a nearer word, or an excluded BOARD id gets blamed on 'finding'
  assert.deepEqual(collectRecordCitations('audit finding 4/43, board 1aba8ace'), []);
  assert.deepEqual(collectRecordCitations('H3/H8 fail-closed (audit finding 5/43, board ea2742e0)'), []);
  // excluded words own their ids outright
  assert.deepEqual(collectRecordCitations('R2 board 2e443375 did it'), []);
  // an id on the next line belongs to no word
  assert.deepEqual(collectRecordCitations('decision\n6dfbe675'), []);
  // the two word lists must stay disjoint — a word cannot be both
  const overlap = CITED_RECORD_WORDS.filter((w) => UNCITED_RECORD_WORDS.includes(w));
  assert.deepEqual(overlap, [], 'a record word is either citation-checked or excluded, never both');
});

test('citation lint: fails on nothing, passes on a TOMBSTONE, flags an ambiguous prefix', () => {
  const text = 'decision aaaaaaaa and decision bbbbbbbb and decision cccccccc'; // not-a-citation: fixture ids
  const violations = lintRecordCitations(text, 'x.mjs', (id) => {
    if (id === 'aaaaaaaa') return { status: 'active' };
    if (id === 'bbbbbbbb') return { status: 'superseded' }; // citing history is legitimate
    if (id === 'cccccccc') return 'ambiguous';
    return undefined;
  });
  assert.deepEqual(violations.map((v) => v.kind), ['citation_ambiguous']);

  const dangling = lintRecordCitations('decision deadbeef', 'y.mjs', () => undefined); // not-a-citation: fixture
  assert.deepEqual(dangling.map((v) => v.kind), ['citation_unresolved']);
  assert.match(dangling[0].detail, /y\.mjs:1/);
});

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

test('check-record-citations resolves across MOUNTED stores and at ANY status; fails only on nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-citations-'));
  try {
    const NOW = '2026-06-10T12:00:00.000Z';
    const rec = (type, id, extra = {}) => ({
      id, type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [], ...extra,
    });
    const decision = (id, scope = 'project') => ({
      ...rec('decision', id),
      scope,
      title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [],
    });

    mkdirSync(join(dir, '.sterling'), { recursive: true });
    // stack_tags is the mount manifest; domain_paths keeps the fixture's domain
    // store INSIDE the temp dir so the test never touches the user's real ones.
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ stack_tags: ['fixturedomain'], domain_paths: { fixturedomain: join(dir, 'domain.db') } })
    );

    const activeId = randomUUID();
    const oldId = randomUUID();
    const domainId = randomUUID();

    const project = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    project.create(decision(activeId));
    project.create(decision(oldId));
    // supersede leaves oldId as a TOMBSTONE — query() stops serving it, and
    // citing it must still pass
    project.supersede(oldId, { ...decision(randomUUID()), created_at: NOW, updated_at: '2026-06-10T13:00:00.000Z' });
    project.close();

    const domain = new SterlingStore(join(dir, 'domain.db'));
    domain.create(decision(domainId, 'domain:fixturedomain'));
    domain.close();

    const write = (body) => writeFileSync(join(dir, 'src.mjs'), body);
    const run = () =>
      spawnSync(process.execPath, [join(root, 'scripts', 'check-record-citations.mjs'), dir], {
        encoding: 'utf8', cwd: dir, timeout: 120_000,
      });

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    write(
      `// decision ${activeId.slice(0, 8)} active\n` +
        `// decision ${oldId.slice(0, 8)} superseded tombstone\n` +
        `// decision ${domainId.slice(0, 8)} lives in a mounted domain store\n` +
        `// board 00000000 excluded by design\n`
    );
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' }).status, 0);

    const clean = run();
    assert.equal(clean.status, 0, `expected pass, got: ${clean.stdout}${clean.stderr}`);

    // ... and it must actually CATCH one, or it passes vacuously (P5)
    write(`// decision ${activeId.slice(0, 8)} fine\n// research_finding deadbeef came from another machine\n`); // not-a-citation: fixture
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
    const dirty = run();
    assert.equal(dirty.status, 1, 'a citation resolving to nothing must fail the check');
    assert.match(dirty.stderr, /citation_unresolved/);
    assert.match(dirty.stderr, /deadbeef/);
    assert.doesNotMatch(dirty.stderr, new RegExp(activeId.slice(0, 8)), 'resolvable citations are not reported');

    // untracked files are out of scope: the check reads git ls-files
    writeFileSync(join(dir, 'untracked.mjs'), '// decision cafebabe\n'); // not-a-citation: fixture
    write('// decision nothing-to-see\n');
    spawnSync('git', ['add', 'src.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run().status, 0, 'an untracked file is not scanned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Consumer-machine shape (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89): the
// clone HAS a store — init creates it — but no project-scoped records, because
// .sterling/ is gitignored and knowledge never travels with the repo. Every
// citation in the tree then "fails" for want of knowledge, which aborted
// /sterling:update at its check step. The DOMAIN store here is deliberately
// populated: the mounted fan is per-machine and non-empty on any machine with
// other Sterling projects, so the emptiness probe must read the PROJECT store —
// the first version of this guard probed the fan and never fired.
test('consumer clone: an empty PROJECT store skips the citation check even when a mounted domain store is full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-citations-consumer-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ stack_tags: ['fixturedomain'], domain_paths: { fixturedomain: join(dir, 'domain.db') } })
    );

    const NOW = '2026-06-10T12:00:00.000Z';
    const domain = new SterlingStore(join(dir, 'domain.db'));
    domain.create({
      id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'domain:fixturedomain', stack_tags: [],
      title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [],
    });
    domain.close();
    new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // project store: created, empty

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    writeFileSync(join(dir, 'src.mjs'), '// decision deadbeef from the authoring machine\n'); // not-a-citation: fixture
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' }).status, 0);

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-record-citations.mjs'), dir], {
      encoding: 'utf8', cwd: dir, timeout: 120_000,
    });
    assert.equal(r.status, 0, `an empty project store must skip, not fail: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /skipped \(project store holds no records/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The OTHER shape the same cause produces, and the one the empty-store skip above
// misses: a store holding plenty of records under ITS OWN ids while the tree cites
// another store's. Knowledge crosses machines as an export payload whose ids the
// receiving server re-mints, so the citing tree is shared while the id namespace
// is not — and the arm cannot tell a foreign id from a typo. Only the minting
// store can, so only it fails (config `citations.id_authority`).
test("store_authority: 'secondary' reports unresolved citations and passes; 'primary' fails on the same tree", () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-citations-authority-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    const writeConfig = (authority) =>
      writeFileSync(
        join(dir, '.sterling', 'config.json'),
        JSON.stringify({
          stack_tags: ['fixturedomain'],
          domain_paths: { fixturedomain: join(dir, 'domain.db') },
          store_authority: authority,
        })
      );

    // A POPULATED project store — this is what makes the empty-store skip miss it.
    const NOW = '2026-06-10T12:00:00.000Z';
    const project = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    project.create({
      id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      title: 'locally minted', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [],
    });
    project.close();
    new SterlingStore(join(dir, 'domain.db')).close();

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' }).status, 0);
    writeFileSync(join(dir, 'src.mjs'), '// decision deadbeef minted on the other machine\n'); // not-a-citation: fixture
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' }).status, 0);

    const run = () =>
      spawnSync(process.execPath, [join(root, 'scripts', 'check-record-citations.mjs'), dir], {
        encoding: 'utf8', cwd: dir, timeout: 120_000,
      });

    writeConfig('secondary');
    const secondary = run();
    assert.equal(secondary.status, 0, `a secondary store must pass: ${secondary.stdout}${secondary.stderr}`);
    assert.match(secondary.stdout, /REPORTED, NOT FAILED/);
    assert.match(secondary.stdout, /citation_unresolved/, 'passing must not mean going quiet (P5)');

    writeConfig('primary');
    const primary = run();
    assert.equal(primary.status, 1, 'the minting store must still fail on an id that resolves to nothing');
    assert.match(primary.stderr, /citation_unresolved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all day-one check scripts pass on the current repo (empty sets pass — invariant 3)', () => {
  // check-bundles-fresh joined the list with R2 7cde1448 (bundle freshness is a
  // tree invariant). check-projection-fresh stays gate-bound only (direct-merge
  // runs the full battery, R2 2e443375): the projection legitimately lags the
  // store mid-work, so it is a pre-merge duty, not a test invariant.
  for (const script of ['check-agent-registry.mjs', 'check-totality.mjs', 'check-spawn-contracts.mjs', 'check-agent-prompts.mjs', 'check-skills.mjs', 'check-bundles-fresh.mjs']) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', script)], { encoding: 'utf8', cwd: root, timeout: 120_000 });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  }
});
