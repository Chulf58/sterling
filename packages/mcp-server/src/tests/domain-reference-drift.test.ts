// GitHub issue #114 on Chulf58/sterling: the read-time drift check in
// knowledge_query matched a reference_material held in a mounted DOMAIN store
// against THIS repo's file of the same repo-relative name. A domain store is
// shared by every project that mounts it, so its 'CLAUDE.md' location names the
// file of the repo that wrote it; reading it from another project minted a false
// refresh_reference (out-of-band edit, or "no longer exists on disk"). Only a
// record the PROJECT store physically holds is checked against this repo, and
// which store holds it is projectStoreHolds' answer, never the body `scope`
// (anti_pattern a61cbdf3-c8ca-46cb-b7ed-6dd513a634f6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, createDomain } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const NOW = '2026-10-16T12:00:00.000Z';
const SOURCE_DATE = '2026-09-06';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-domain-ref-drift-'));
  const domainDb = join(dir, 'domains', 'sterling', 'sterling.db');
  createDomain('sterling', 'test domain sterling', domainDb);
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'sterling', dbPath: domainDb }]);
  const tools = new SterlingTools({
    store,
    config: parseConfig({ stack_tags: ['sterling'] }),
    now: () => NOW,
    newId: randomUUID,
    repoRoot: dir,
  });
  const claudeMd = join(dir, 'CLAUDE.md');
  /** Write CLAUDE.md with an mtime after SOURCE_DATE and before NOW. */
  const writeClaudeMd = (text: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(claudeMd, text);
    const t = new Date('2026-10-10T00:00:00.000Z');
    utimesSync(claudeMd, t, t);
  };
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, claudeMd, store, tools, writeClaudeMd, cleanup };
}

const mkRef = (tools: SterlingTools, scope: string): Loose =>
  (
    tools.knowledgeCreate('reference_material', {
      scope,
      title: `CLAUDE.md conventions (${scope})`,
      kind: 'doc',
      location: 'CLAUDE.md',
      summary: 'conventions of the repo that wrote this record',
      source_date: SOURCE_DATE,
      capture_date: SOURCE_DATE,
      basis: 'platform',
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

const readRefs = (tools: SterlingTools): Loose[] =>
  (tools.knowledgeQueryResult({ types: ['reference_material'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as { records: Loose[] })
    .records;

const refreshItems = (tools: SterlingTools): Loose[] => tools.maintenanceQuery({ system_reason: 'refresh_reference' }) as unknown as Loose[];

test('#114 a domain-held doc reference whose location matches a CHANGED local file mints no refresh_reference and no verify_before_use', () => {
  const { store, tools, writeClaudeMd, cleanup } = fixture();
  try {
    writeClaudeMd('# the other repo wrote this\n');
    const ref = mkRef(tools, 'domain:sterling');
    assert.equal(store.projectStoreHolds(String(ref.id)), false, 'precondition: the project store does not hold the record');
    assert.ok(Object.keys((store.get(String(ref.id)) as unknown as Loose).file_baselines ?? {}).length > 0, 'precondition: the record carries a baseline');

    writeClaudeMd('# this repo has its own, different CLAUDE.md\n');

    const read = readRefs(tools).find((r) => r.id === ref.id);
    assert.ok(read, 'the domain record is still returned');
    assert.equal(read.verify_before_use, undefined, 'returned unannotated');
    assert.deepEqual(refreshItems(tools), [], 'no refresh_reference item is minted for a domain-held record');
  } finally {
    cleanup();
  }
});

test('#114 a domain-held doc reference whose location is ABSENT locally mints no deletion item and no verify_before_use', () => {
  const { claudeMd, store, tools, writeClaudeMd, cleanup } = fixture();
  try {
    writeClaudeMd('# the other repo wrote this\n');
    const ref = mkRef(tools, 'domain:sterling');
    assert.equal(store.projectStoreHolds(String(ref.id)), false, 'precondition: the project store does not hold the record');
    rmSync(claudeMd);

    const read = readRefs(tools).find((r) => r.id === ref.id);
    assert.ok(read, 'the domain record is still returned');
    assert.equal(read.verify_before_use, undefined, 'returned unannotated');
    assert.deepEqual(refreshItems(tools), [], 'no "no longer exists on disk" item for a domain-held record');
  } finally {
    cleanup();
  }
});

test('#114 control: the same reference HELD BY THE PROJECT store still mints on an out-of-band edit', () => {
  const { store, tools, writeClaudeMd, cleanup } = fixture();
  try {
    writeClaudeMd('# original\n');
    const ref = mkRef(tools, 'project');
    assert.equal(store.projectStoreHolds(String(ref.id)), true, 'precondition: the project store holds the record');

    writeClaudeMd('# edited out of band\n');

    const read = readRefs(tools).find((r) => r.id === ref.id);
    assert.equal(read?.verify_before_use, true, 'a project-held record is still flagged');
    const items = refreshItems(tools);
    assert.equal(items.length, 1, 'one refresh_reference item');
    assert.equal(items[0].feature_link, ref.id);
  } finally {
    cleanup();
  }
});

test('#114 control: a project-held reference whose file is gone still mints the deletion item', () => {
  const { claudeMd, tools, writeClaudeMd, cleanup } = fixture();
  try {
    writeClaudeMd('# original\n');
    const ref = mkRef(tools, 'project');
    rmSync(claudeMd);

    const read = readRefs(tools).find((r) => r.id === ref.id);
    assert.equal(read?.verify_before_use, true);
    const items = refreshItems(tools);
    assert.equal(items.length, 1);
    assert.match(String(items[0].text), /no longer exists on disk/);
  } finally {
    cleanup();
  }
});

// 200 days before NOW: past the 90-day default clock of a finding with no volatility_hint
const FINDING_DATE = '2026-03-30';

const mkFinding = (tools: SterlingTools, scope: string): Loose =>
  (
    tools.knowledgeCreate('research_finding', {
      scope,
      question: `how ${scope} finding behaves`,
      answer: 'a',
      source_urls: [],
      source_date: FINDING_DATE,
      capture_date: FINDING_DATE,
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

const readFindings = (tools: SterlingTools): Loose[] =>
  (tools.knowledgeQueryResult({ types: ['research_finding'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as { records: Loose[] })
    .records;

const staleItems = (tools: SterlingTools): Loose[] => tools.maintenanceQuery({ system_reason: 'stale_research' }) as unknown as Loose[];

test('GitHub #283 a domain-held finding past its clock reads stale but mints no stale_research item', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const finding = mkFinding(tools, 'domain:sterling');
    assert.equal(store.projectStoreHolds(String(finding.id)), false, 'precondition: the project store does not hold the record');

    const read = readFindings(tools).find((r) => r.id === finding.id);
    assert.equal((read?.staleness as Loose | undefined)?.stale, true, 'the read still marks it stale');
    assert.deepEqual(staleItems(tools), [], 'no stale_research item is minted for a domain-held finding');
  } finally {
    cleanup();
  }
});

test('GitHub #283 control: a project-held finding past its clock still mints one stale_research item', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const finding = mkFinding(tools, 'project');
    assert.equal(store.projectStoreHolds(String(finding.id)), true, 'precondition: the project store holds the record');

    readFindings(tools);
    const items = staleItems(tools);
    assert.equal(items.length, 1);
    assert.equal(items[0].feature_link, finding.id);
  } finally {
    cleanup();
  }
});
