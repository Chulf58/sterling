#!/usr/bin/env node
// Bench: how long a hook takes to open the subject fan (scripts/hooks/lib/subject-fan.mjs)
// with 0, 3 and 6 mounted domains (board c10f139b: measure before any tuning).
//
// Builds a throwaway project and domain stores under the OS temp dir, seeds each store
// with --records anti_patterns, then times in-process, per iteration:
//   open+close  openSubjectFan(cwd) then close()
//   open+query  the same plus the six subject queries H20 runs (composeMechanismAxis stage 1)
// Prints the median and p95 in milliseconds for each domain count. The first
// iteration of each set is a discarded warm-up. Removes everything it created.
//
// Usage: node scripts/bench-mount-open.mjs [--iterations 30] [--records 50] [--domains 0,3,6]
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SterlingStore, createDomain } from '@sterling/store';
import { openSubjectFan } from './hooks/lib/subject-fan.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const iterations = Number(arg('iterations', '30'));
const records = Number(arg('records', '50'));
const domainCounts = arg('domains', '0,3,6').split(',').map(Number);
for (const n of [iterations, records, ...domainCounts]) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`bench-mount-open: every option must be a non-negative integer, got ${n}`);
}
if (iterations < 2) throw new Error('bench-mount-open: --iterations must be at least 2 (the first is a warm-up)');

const NOW = new Date().toISOString();
const TYPES = ['anti_pattern', 'decision', 'feature_article', 'research_finding', 'disconfirmed_hypothesis', 'open_question'];
const TERMS = ['breach', 'countdown', 'widget', 'flywheel', 'ballast', 'klaxon'];

function seed(store, scope, n) {
  for (let i = 0; i < n; i++) {
    store.create({
      id: randomUUID(), type: 'anti_pattern', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope, stack_tags: [],
      title: `bench hazard ${i} breach countdown widget`, trigger: `flywheel ballast klaxon case ${i}`, guidance: 'g', wrong_way: 'w', right_way: 'r', source_evidence: 'e', basis: 'codebase', file_keys: [],
    });
  }
}

function project(domainCount, base) {
  const dir = join(base, `p${domainCount}`);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const names = Array.from({ length: domainCount }, (_, i) => `d${i}`);
  const domain_paths = Object.fromEntries(names.map((n) => [n, join(dir, 'domains', n, 'sterling.db')]));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ stack_tags: names, domain_paths }));
  const p = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  seed(p, 'project', records);
  p.close();
  for (const n of names) {
    mkdirSync(join(dir, 'domains', n), { recursive: true });
    createDomain(n, `bench domain ${n}`, domain_paths[n]);
    const d = new SterlingStore(domain_paths[n]);
    seed(d, `domain:${n}`, records);
    d.close();
  }
  return dir;
}

function time(fn) {
  const out = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return out.slice(1).sort((a, b) => a - b);
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const fmt = (ms) => ms.toFixed(1).padStart(7);

const base = mkdtempSync(join(tmpdir(), 'sterling-bench-mount-'));
try {
  console.log(`bench-mount-open: ${iterations - 1} timed iterations each (1 warm-up), ${records} records per store, node ${process.version}`);
  console.log('domains   open+close median    p95   open+query median    p95');
  for (const n of domainCounts) {
    const dir = project(n, base);
    const openClose = time(() => {
      const fan = openSubjectFan(dir);
      fan.close();
    });
    const openQuery = time(() => {
      const fan = openSubjectFan(dir);
      try {
        for (const type of TYPES) fan.query({ types: [type], rank_terms: TERMS, cap: 40 });
      } finally {
        fan.close();
      }
    });
    console.log(`${String(n).padStart(7)}   ${fmt(pct(openClose, 0.5))} ms ${fmt(pct(openClose, 0.95))} ms   ${fmt(pct(openQuery, 0.5))} ms ${fmt(pct(openQuery, 0.95))} ms`);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
