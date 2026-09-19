#!/usr/bin/env node
/* Frozen-corpus replay harness.  It deliberately patches only disposable eval worktrees. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HARNESS_VERSION = 'knowledge-eval/v2';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROJECTS = { 'sterling-main': '/mnt/c/Users/chulf/sterling-main', 'dome-farmer': '/mnt/c/Users/chulf/Dome Farmer' };
const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const bytes = (x) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x));
const json = (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value, null, 2)); };
const readJsonl = (p) => { const source = readFileSync(p, 'utf8'); try { const parsed = JSON.parse(source); return Array.isArray(parsed) ? parsed : parsed.synthetic_cases ?? []; } catch { return source.split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x)); } };
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
export function mrrFromHistogram(histogram) { const total = Object.values(histogram).reduce((n, x) => n + x, 0); return total ? Object.entries(histogram).reduce((n, [rank, count]) => n + (Number.isInteger(Number(rank)) ? Number(count) / Number(rank) : 0), 0) / total : 0; }
export function scoreEventIndexes(inputEvents, scoreEvent = inputEvents.length - 1) {
  if (!Number.isInteger(scoreEvent) || scoreEvent < 0 || scoreEvent >= inputEvents.length) throw new Error(`invalid score_event ${scoreEvent}`);
  let offset = 0;
  for (const [index, event] of inputEvents.entries()) {
    const expanded = (event.tool === 'Agent' || event.tool === 'Task') && !event.hook_event ? 2 : 1;
    if (index === scoreEvent) return expanded === 2 ? [offset, offset + 1] : [offset];
    offset += expanded;
  }
  throw new Error(`invalid score_event ${scoreEvent}`);
}
export function aggregateMetricValues(values) {
  if (values.every((value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite))) return values.reduce((out, value) => [out[0] + value[0], out[1] + value[1]], [0, 0]);
  const ids = [...new Set(values.flatMap((value) => Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []))];
  return { ids, count: ids.length };
}

/** Parse directives embedded as complete lines in an event note. */
export function parseCaseDirectives(note = '') {
  const directives = [];
  for (const line of String(note).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const [, kind, value] = match;
    if (kind === 'config') {
      const config = value.match(/^injection_rung=(prompt|read|edit)$/);
      if (!config) throw new Error(`unknown config directive ${JSON.stringify(value)}; only injection_rung=prompt|read|edit is supported`);
      directives.push({ kind, key: 'injection_rung', value: config[1] });
    } else if (kind === 'mutate') {
      const mutate = value.match(/^([0-9a-f-]{36}) revision$/i);
      if (!mutate) throw new Error(`invalid mutate directive ${JSON.stringify(value)}; expected <record-id> revision`);
      directives.push({ kind, id: mutate[1] });
    } else if (kind === 'lifecycle') {
      if (!['clear', 'resume'].includes(value)) throw new Error(`invalid lifecycle directive ${JSON.stringify(value)}; expected clear or resume`);
      directives.push({ kind, source: value });
    } else throw new Error(`unknown case directive ${kind}:`);
  }
  return directives;
}
export function resolveProjects(value) {
  let supplied = {};
  if (value !== undefined) { try { supplied = JSON.parse(value); } catch { throw new Error('--projects must be a JSON object mapping project names to roots'); } }
  if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object' || Object.values(supplied).some((x) => typeof x !== 'string')) throw new Error('--projects must be a JSON object mapping project names to roots');
  return Object.fromEntries(Object.entries({ ...DEFAULT_PROJECTS, ...supplied }).map(([name, projectRoot]) => [name, resolve(projectRoot)]));
}

/** Pure scoring functions; intentionally exported for synthetic unit tests. */
export function scorePull(response, labels, negative = false) {
  const records = response?.records ?? response?.matches ?? (response?.id ? [response] : []);
  const ids = records.map((r) => r.id).filter(Boolean);
  const wanted = new Set((labels.required ?? []).map((x) => x.id));
  const acceptable = new Set(labels.acceptable ?? []);
  const at = (n) => ids.slice(0, n).filter((id) => wanted.has(id)).length;
  const rank = ids.findIndex((id) => wanted.has(id));
  const rankHistogram = rank < 0 ? { miss: 1 } : { [rank + 1]: 1 };
  return { recall: { at1: [at(1), wanted.size], at5: [at(5), wanted.size], at10: [at(10), wanted.size] },
    precision5: [ids.slice(0, 5).filter((id) => wanted.has(id) || acceptable.has(id)).length, Math.min(5, ids.length)],
    rank_histogram: rankHistogram, mrr: { numerator: rank < 0 ? 0 : 1 / (rank + 1), denominator: 1, value: rank < 0 ? 0 : 1 / (rank + 1) },
    confusion: negative ? { tn: ids.length === 0 ? 1 : 0, fp: ids.length ? 1 : 0 } : { tp: ids.length ? 1 : 0, fn: ids.length ? 0 : 1 }, bytes: bytes(response) };
}
export function emittedLevel(envelope, record) {
  const normalise = (value) => String(value ?? '').replace(/\s+/g, ' ').replaceAll('…', '...').trim();
  const text = normalise(typeof envelope === 'string' ? envelope : JSON.stringify(envelope ?? ''));
  const r = record ?? {};
  const pointer = [r.id, r.slug, r.title].filter(Boolean).map(normalise).some((x) => text.includes(x));
  // H19 renders a record's beginning under an article header and may clip the
  // tail. A distinctive normalized opening/clause is substance; a UUID alone is
  // always only a pointer. Hazards remain stricter: both exact fields are needed.
  const fields = [r.what_it_does, r.intended_behavior, r.statement, r.guidance].filter((x) => typeof x === 'string' && x.length > 12).map(normalise);
  const passages = fields.flatMap((field) => {
    const clauses = field.split(/(?<=[.!?])\s+/).filter((x) => x.length >= 32).map((x) => x.slice(0, 180));
    return [...clauses, field.slice(0, 96)].filter((x) => x.length >= 32);
  });
  const hazardSubstance = !!r.trigger && !!r.right_way && text.includes(normalise(r.trigger)) && text.includes(normalise(r.right_way));
  // H20's rendered decision/article pointer blocks deliberately include a
  // clipped orienting excerpt. They are discovery contracts, never body delivery.
  const h20PointerBlock = /STERLING MECHANISM-AXIS DELIVERY \(H20\)[\s\S]*?Pointers only;/.test(text);
  const substance = pointer && !h20PointerBlock && (passages.some((x) => text.includes(x)) || hazardSubstance);
  const whole = substance && hazardSubstance;
  return { pointer, substance, whole };
}
function markedRecordIds(state) {
  const ids = new Set();
  const visit = (value) => {
    if (typeof value === 'string') { try { visit(JSON.parse(value)); } catch { /* non-JSON transient text has no structured record mark */ } }
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if ((key === 'records' || key === 'delivered' || key === 'substance_records') && Array.isArray(item)) {
        for (const id of item) if (typeof id === 'string') ids.add(id);
      } else visit(item);
    }
  };
  visit(state); return ids;
}
export function scorePush({ envelopes = [], lateEnvelopes = [], labels, recordsById = {}, guardBefore = {}, guardAfter = {}, late = false }) {
  const required = labels.required ?? [], acceptable = new Set(labels.acceptable ?? []);
  const text = envelopes.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
  const timely = late ? [] : envelopes;
  const discoveryLabels = required.filter((x) => x.level === 'pointer');
  const substanceLabels = required.filter((x) => x.level === 'substance' || x.level === 'hazard_whole');
  let discovery = 0, substance = 0, whole = 0;
  for (const label of required) {
    const seen = timely.map((e) => emittedLevel(e, recordsById[label.id])).reduce((a, x) => ({ pointer: a.pointer || x.pointer, substance: a.substance || x.substance, whole: a.whole || x.whole }), { pointer: false, substance: false, whole: false });
    if (label.level === 'pointer' && seen.pointer) discovery++;
    if ((label.level === 'substance' || label.level === 'hazard_whole') && seen.substance) substance++;
    if (label.level === 'hazard_whole' && seen.whole) whole++;
  }
  const beforeMarks = markedRecordIds(guardBefore), afterMarks = markedRecordIds(guardAfter);
  const falseMarkIds = [...afterMarks].filter((id) => !beforeMarks.has(id) && !emittedLevel(envelopes, recordsById[id]).substance);
  const lateByRecord = Object.fromEntries(required.map((label) => [label.id, lateEnvelopes.some((e) => emittedLevel(e, recordsById[label.id]).pointer) || (late && emittedLevel(envelopes, recordsById[label.id]).pointer)]));
  const allKnown = new Set([...required.map((x) => x.id), ...acceptable]);
  const mentioned = Object.keys(recordsById).filter((id) => text.includes(id));
  const noise = mentioned.filter((id) => !allKnown.has(id));
  const duplicateCount = required.reduce((n, l) => n + Math.max(0, text.split(l.id).length - 2), 0);
  return { timely: { discovery: [discovery, discoveryLabels.length], substance: [substance, substanceLabels.length] }, wholeHazard: [whole, required.filter((x) => x.level === 'hazard_whole').length], falseSubstanceMarks: falseMarkIds.length, falseSubstanceMarkIds: falseMarkIds, guardOnlyMarks: falseMarkIds.length, silence: text.length === 0 ? 1 : 0, noise: noise.length, duplicates: duplicateCount, late: Object.values(lateByRecord).filter(Boolean).length, lateByRecord, lateEnvelopes: lateEnvelopes.length, bytes: bytes(envelopes) };
}

function snapshotDb(source, target) { mkdirSync(dirname(target), { recursive: true }); const db = new DatabaseSync(source, { readOnly: true }); db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); db.close(); }
function snapshotProject(dir, name, projectRoot) {
  const config = join(projectRoot, '.sterling', 'config.json'); const store = join(projectRoot, '.sterling', 'sterling.db');
  if (!existsSync(config) || !existsSync(store)) throw new Error(`project ${name} requires live .sterling/config.json and .sterling/sterling.db`);
  const configText = readFileSync(config, 'utf8'); const cfg = JSON.parse(configText); const projectDir = join(dir, 'projects', name);
  const dbs = [{ name: 'project', source: store, target: join(projectDir, 'project.db') }];
  for (const tag of cfg.stack_tags ?? []) {
    const source = cfg.domain_paths?.[tag] ?? join(homedir(), '.sterling', 'domains', tag, 'sterling.db');
    if (existsSync(source)) dbs.push({ name: `domain:${tag}`, source, target: join(projectDir, 'domains', tag, 'sterling.db') });
  }
  for (const d of dbs) { snapshotDb(d.source, d.target); chmodSync(d.target, 0o444); }
  cpSync(config, join(projectDir, 'config.json'));
  const head = run(['git', 'rev-parse', 'HEAD'], projectRoot).stdout.trim();
  return { root: projectRoot, head, config_sha256: sha256(configText), config: cfg, stores: dbs.map((d) => ({ name: d.name, path: d.target, sha256: sha256(readFileSync(d.target)) })) };
}
function snapshot(workDir, projects) {
  const dir = join(workDir, 'snapshot');
  if (existsSync(join(dir, 'manifest.json'))) {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json')));
    if (manifest.harness_version !== HARNESS_VERSION) throw new Error('existing snapshot harness version differs; choose a new --work-dir');
    for (const [name, p] of Object.entries(manifest.projects ?? {})) {
      if (sha256(readFileSync(join(dir, 'projects', name, 'config.json'), 'utf8')) !== p.config_sha256) throw new Error(`snapshot ${name} config hash mismatch`);
      for (const store of p.stores ?? []) if (!existsSync(store.path) || sha256(readFileSync(store.path)) !== store.sha256) throw new Error(`snapshot ${name} ${store.name} hash mismatch`);
    }
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  const manifest = { harness_version: HARNESS_VERSION, node: process.version, projects: Object.fromEntries(Object.entries(projects).map(([name, projectRoot]) => [name, snapshotProject(dir, name, projectRoot)])) };
  json(join(dir, 'manifest.json'), manifest); return dir;
}
function patchAdapter(tree) {
  // Patch the committed runtime artifact, not product source: historical commits
  // can no longer typecheck under the current compiler, but their shipped dist is
  // the implementation the replay is measuring.
  const p = join(tree, 'packages/store/dist/index.js'); let s = readFileSync(p, 'utf8');
  const needle = 'this.db = new DatabaseSync(path);';
  if (s.includes('knowledge-eval adapter: snapshot schema lacks records')) return sha256(s);
  if (!s.includes(needle)) throw new Error('adapter seam missing: SterlingStore constructor changed');
  s = s.replace(needle, `this.db = new DatabaseSync(path, { readOnly: true });\n        const evalTables = this.db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='records'\").get();\n        if (!evalTables) { this.db.close(); throw new Error('knowledge-eval adapter: snapshot schema lacks records'); }\n        this.openedSchemaVersion = this.db.prepare('PRAGMA user_version').get().user_version;\n        return; // evaluation-only: no pragma/DDL/migration writes`);
  writeFileSync(p, s); return sha256(s);
}
function patchReadOnlyTools(tree) {
  // Historical knowledgeQueryResult can lazily enqueue a maintenance item while
  // annotating stale records. Replay measures retrieval, not that side effect;
  // the frozen store is intentionally read-only, so suppress only that enqueue
  // in the disposable compiled artifact.
  const p = join(tree, 'packages/mcp-server/dist/tools.js'); let s = readFileSync(p, 'utf8');
  const marker = '// knowledge-eval adapter: suppress lazy read maintenance writes';
  if (s.includes(marker)) return sha256(s);
  if (!s.includes('export class SterlingTools')) throw new Error('adapter seam missing: SterlingTools export changed');
  s += `\n${marker}\nSterlingTools.prototype.maintenanceEnqueue = function () { return undefined; };\n`;
  writeFileSync(p, s); return sha256(s);
}
function cleanStaleWorktrees(repo, workDir) {
  const prefix = `${resolve(workDir)}/`;
  const listing = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`git worktree list in ${repo}: ${listing.stderr}`);
  for (const block of listing.stdout.trim().split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path || !resolve(path).startsWith(prefix) || (!block.includes('\nlocked') && existsSync(path))) continue;
    spawnSync('git', ['worktree', 'unlock', path], { cwd: repo, encoding: 'utf8' });
    spawnSync('git', ['worktree', 'remove', '--force', path], { cwd: repo, encoding: 'utf8' });
  }
  const prune = spawnSync('git', ['worktree', 'prune'], { cwd: repo, encoding: 'utf8' });
  if (prune.status !== 0) throw new Error(`git worktree prune in ${repo}: ${prune.stderr}`);
}
function worktree(commit, workDir) {
  cleanStaleWorktrees(root, workDir);
  const tree = join(workDir, 'worktrees', commit); if (!existsSync(tree)) { mkdirSync(dirname(tree), { recursive: true }); run(['git', 'worktree', 'add', '--detach', tree, commit], root); }
  const lockMatch = existsSync(join(root, 'package-lock.json')) && readFileSync(join(root, 'package-lock.json'), 'utf8') === readFileSync(join(tree, 'package-lock.json'), 'utf8');
  if (lockMatch && !existsSync(join(tree, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'), 'dir');
  if (!existsSync(join(tree, 'packages/schemas/dist/index.js'))) run(['npx', 'tsc', '-p', 'packages/schemas/tsconfig.json'], tree);
  if (!existsSync(join(tree, 'packages/store/dist/index.js'))) run(['npx', 'tsc', '-p', 'packages/store/tsconfig.json'], tree);
  const diff = patchAdapter(tree);
  // Old baseline commits do not carry the MCP artifact. Compile only that
  // package against the patched store artifact; no product source is changed.
  if (!existsSync(join(tree, 'packages/mcp-server/dist/tools.js'))) run(['npx', 'tsc', '-p', 'packages/mcp-server/tsconfig.json'], tree);
  const toolsAdapter = patchReadOnlyTools(tree);
  return { tree, build: lockMatch ? 'MCP dist compiled; main node_modules symlinked (lockfile matched)' : 'MCP dist compiled', adapter_sha256: diff, tools_adapter_sha256: toolsAdapter };
}
function run(argv, cwd, input) { const r = spawnSync(argv[0], argv.slice(1), { cwd, input, encoding: 'utf8', env: { ...process.env, STERLING_PLUGIN_ROOT: cwd, CLAUDE_PLUGIN_ROOT: cwd }, timeout: 120000 }); if (r.status !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr}`); return r; }
function transientState(project) {
  const dir = join(project, '.sterling', 'transient');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir, { recursive: true }).filter((p) => {
    try { return !lstatSync(join(dir, p)).isDirectory(); } catch { return false; }
  }).map((p) => [p, readFileSync(join(dir, p), 'utf8')]));
}
function eventName(ev) { return ev.hook_event ?? ((ev.tool === 'Read' || ev.tool === 'Bash') ? 'PostToolUse' : 'PreToolUse'); }
function authenticToolInput(event, project) {
  if (event.tool === 'Read') return { file_path: join(project, event.path ?? '') };
  if (event.tool === 'Bash') return { command: event.command ?? '' };
  if (event.tool === 'AskUserQuestion') return { questions: event.questions ?? [{ question: event.prompt ?? '', header: event.header ?? 'Question', options: event.options ?? [] }] };
  if (event.tool === 'Agent' || event.tool === 'Task') return { prompt: event.prompt ?? '', subagent_type: event.subagent_type ?? event.agent_type ?? 'general-purpose', description: event.description ?? '' };
  return event.tool_input ?? { prompt: event.prompt ?? '' };
}
function deliveredText(capture) {
  try {
    const parsed = JSON.parse(capture.stdout); const output = parsed.hookSpecificOutput ?? {};
    return [output.additionalContext, output.systemMessage, parsed.systemMessage].filter((x) => typeof x === 'string' && x.length > 0).join('\n');
  } catch { return capture.stdout; }
}
function captureHooks(tree, project, event, eventOverride, sessionSource) {
  const hooks = JSON.parse(readFileSync(join(tree, 'hooks/hooks.json'))).hooks;
  const hookEvent = eventOverride ?? eventName(event);
  const entries = (hooks[hookEvent] ?? []).filter((x) => !x.matcher || new RegExp(`^(${x.matcher})$`).test(event.tool ?? ''));
  const before = transientState(project);
  const captures = entries.flatMap((group) => group.hooks.map((h) => {
    const script = h.command.match(/hooks\/[^\s"']+\.mjs/)?.[0];
    if (!script) throw new Error(`unrecognised hook command: ${h.command}`);
    const input = { hook_event_name: hookEvent, source: sessionSource, tool_name: event.tool, tool_input: authenticToolInput(event, project), tool_response: event.output, cwd: project, agent_id: event.agent_id ?? undefined, agent_type: event.agent_type };
    const r = spawnSync(process.execPath, [join(tree, script)], { input: JSON.stringify(input), encoding: 'utf8', cwd: project, env: { ...process.env, STERLING_PLUGIN_ROOT: tree, CLAUDE_PLUGIN_ROOT: tree, CLAUDE_PROJECT_DIR: project } });
    return { script, code: r.status, stdout: r.stdout, stderr: r.stderr, envelope: deliveredText({ stdout: r.stdout }) };
  }));
  return { hook_event: hookEvent, captures, guard_before: before, guard_after: transientState(project) };
}
function replayEvents(tree, project, events) {
  const captures = [];
  for (const event of events) {
    if ((event.tool === 'Agent' || event.tool === 'Task') && !event.hook_event) {
      captures.push(captureHooks(tree, project, event, 'PreToolUse'));
      captures.push(captureHooks(tree, project, { ...event, tool: undefined, hook_event: 'SubagentStart' }, 'SubagentStart'));
    } else captures.push(captureHooks(tree, project, event));
  }
  return captures;
}
function caseProject(pluginCommit, workDir, caseId, snap, projectName, projectSnapshot, caseConfig, needsMutation) {
  const project = join(workDir, 'projects', pluginCommit, projectName, caseId);
  if (existsSync(project)) throw new Error(`case project already exists at ${project}; choose a fresh --work-dir to preserve isolation`);
  cleanStaleWorktrees(projectSnapshot.root, workDir);
  // Plugin hooks/dist and project source intentionally differ.
  run(['git', 'worktree', 'add', '--detach', project, projectSnapshot.head], projectSnapshot.root);
  const sterling = join(project, '.sterling');
  if (existsSync(sterling)) throw new Error(`case project unexpectedly contains tracked .sterling at ${sterling}`);
  mkdirSync(sterling, { recursive: true });
  const snapshotDbPath = join(snap, 'projects', projectName, 'project.db');
  // Normal cases share the immutable snapshot. A mutate directive alone earns
  // a private database copy so it can never contaminate another replay.
  if (needsMutation) { cpSync(snapshotDbPath, join(sterling, 'sterling.db')); chmodSync(join(sterling, 'sterling.db'), 0o644); }
  else symlinkSync(snapshotDbPath, join(sterling, 'sterling.db'));
  json(join(sterling, 'config.json'), caseConfig);
  return project;
}
function bumpRevision(project, id) {
  const db = new DatabaseSync(join(project, '.sterling', 'sterling.db'));
  try { const result = db.prepare('UPDATE records SET version = version + 1 WHERE id = ?').run(id); if (result.changes !== 1) throw new Error(`mutate directive record ${id} was not found in the case-local project store`); } finally { db.close(); }
}
function assertEventPaths(caseId, events, project) {
  for (const [index, event] of events.entries()) if (event.path !== undefined) {
    const target = join(project, event.path);
    if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error(`case ${caseId} input.events[${index}].path: expected an existing file in the case project, got ${JSON.stringify(event.path)} (${target})`);
  }
}
function labelHash(c) { return sha256(JSON.stringify(c.labels)); }
function channelTotals(cases) {
  const totals = {};
  const add = (target, score) => {
    for (const [key, value] of Object.entries(score ?? {})) {
      if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
        const out = target[key] ??= [0, 0]; out[0] += value[0]; out[1] += value[1];
      } else if (typeof value === 'number') target[key] = (target[key] ?? 0) + value;
      else if (value && typeof value === 'object') add(target[key] ??= {}, value);
    }
  };
  for (const channel of new Set(cases.map((c) => c.channel))) {
    const selected = cases.filter((c) => c.channel === channel);
    const total = totals[channel] = { completed_cases: [selected.filter((c) => !c.error).length, selected.length] };
    for (const c of selected) if (!c.error) add(total, c.score);
    if (total.rank_histogram) {
      const count = Object.values(total.rank_histogram).reduce((n, x) => n + x, 0);
      total.mrr = { rank_histogram: total.rank_histogram, numerator: Object.entries(total.rank_histogram).reduce((n, [rank, hits]) => n + (Number.isInteger(Number(rank)) ? hits / Number(rank) : 0), 0), denominator: count, value: mrrFromHistogram(total.rank_histogram) };
    }
  }
  return totals;
}
function pairedComparison(summaries) {
  const invalidReasons = [];
  const byCommit = summaries.map((s) => new Map(s.cases.map((c) => [c.id, c])));
  const ids = new Set(summaries.flatMap((s) => s.cases.map((c) => c.id)));
  const metricDelta = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b) && a.every(Number.isFinite) && b.every(Number.isFinite)) return { before: a, after: b, delta: [b[0] - a[0], b[1] - a[1]] };
    if (Array.isArray(a) && Array.isArray(b)) return { before: a, after: b, delta: { added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) } };
    if (typeof a === 'number' && typeof b === 'number') return { before: a, after: b, delta: b - a };
    if (a && b && typeof a === 'object' && typeof b === 'object') return Object.fromEntries(Object.keys(a).filter((k) => k in b).map((k) => [k, metricDelta(a[k], b[k])]));
    return undefined;
  };
  const cases = {};
  for (const id of ids) {
    const pair = byCommit.map((m) => m.get(id));
    if (pair.some((x) => !x)) { invalidReasons.push(`case ${id}: result missing; expected one result for each commit [${summaries.map((s) => s.commit).join(', ')}], got [${pair.map((x, i) => x ? summaries[i].commit : 'missing').join(', ')}]`); continue; }
    if (pair.some((x) => x.error)) { invalidReasons.push(...pair.flatMap((x, i) => x.error ? [`case ${id}: harness error on ${summaries[i].commit}; expected a score, got ${x.error}`] : [])); continue; }
    const schemas = pair.map((x) => x.case_schema);
    if (schemas.some((x) => !x) || new Set(schemas).size !== 1) { invalidReasons.push(`case ${id}: case_schema mismatch; expected one non-empty schema across commits, got ${JSON.stringify(Object.fromEntries(summaries.map((s, i) => [s.commit, schemas[i]])))}`); continue; }
    const labelHashes = pair.map((x) => x.label_sha256);
    if (labelHashes.some((x) => !x) || new Set(labelHashes).size !== 1) { invalidReasons.push(`case ${id}: labels hash mismatch; expected one hash across commits, got ${JSON.stringify(Object.fromEntries(summaries.map((s, i) => [s.commit, labelHashes[i]])))}`); continue; }
    cases[id] = metricDelta(pair[0].score, pair[pair.length - 1].score);
  }
  const totals = {};
  for (const value of Object.values(cases)) {
    const visit = (v, path = []) => {
      if (v && typeof v === 'object' && 'before' in v && 'after' in v && Array.isArray(v.before)) {
        const key = path.join('.'); const t = totals[key] ??= { before: [0, 0], after: [0, 0], delta: [0, 0] };
        for (let i = 0; i < 2; i++) { t.before[i] += v.before[i]; t.after[i] += v.after[i]; t.delta[i] += v.delta[i]; }
      } else if (v && typeof v === 'object' && Array.isArray(v.before) && Array.isArray(v.after)) totals[path.join('.')] = aggregateMetricValues([v.before, v.after]);
      else if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) visit(child, [...path, k]);
    }; visit(value);
  }
  return { invalid: invalidReasons.length > 0, invalid_reasons: invalidReasons, cases, paired_totals: totals };
}
async function evaluateCommit(commit, cases, workDir, snap) {
  const started = Date.now(), w = worktree(commit, workDir), runDir = join(workDir, 'runs', commit); const manifest = JSON.parse(readFileSync(join(snap, 'manifest.json')));
  const { MountedStores, resolveDomainMounts } = await import(pathToFileURL(join(w.tree, 'packages/store/dist/index.js')).href + `?${Date.now()}`); const { SterlingTools } = await import(pathToFileURL(join(w.tree, 'packages/mcp-server/dist/tools.js')).href + `?${Date.now()}`); const { parseConfig } = await import(pathToFileURL(join(w.tree, 'packages/schemas/dist/index.js')).href + `?${Date.now()}`);
  const scored = []; for (const c of cases) { const out = join(runDir, c.id); const caseSchema = c.version ?? 'v1'; let stores; mkdirSync(out, { recursive: true }); try {
    const projectName = c.project ?? 'sterling-main'; const projectSnapshot = manifest.projects?.[projectName];
    if (!projectSnapshot) throw new Error(`case ${c.id} names unknown project ${JSON.stringify(projectName)}`);
    const directives = (c.input?.events ?? []).flatMap((event, index) => parseCaseDirectives(event.note).map((directive) => ({ ...directive, index })));
    const cfg = structuredClone(projectSnapshot.config); cfg.domain_paths = Object.fromEntries((cfg.stack_tags ?? []).map((tag) => [tag, join(snap, 'projects', projectName, 'domains', tag, 'sterling.db')]));
    for (const directive of directives.filter((x) => x.kind === 'config')) cfg.delivery = { ...cfg.delivery, injection_rung: directive.value };
    const effectiveRung = cfg.delivery?.injection_rung;
    if (!['prompt', 'read', 'edit'].includes(effectiveRung)) throw new Error(`project ${projectName} has no explicit valid delivery.injection_rung; refusing a silent default (${String(effectiveRung)})`);
    const project = caseProject(commit, workDir, c.id, snap, projectName, projectSnapshot, cfg, directives.some((x) => x.kind === 'mutate'));
    const caseDb = join(project, '.sterling', 'sterling.db'); const dbBefore = sha256(readFileSync(caseDb));
    stores = new MountedStores(join(project, '.sterling', 'sterling.db'), resolveDomainMounts(parseConfig(cfg)), { skipMissing: true });
    const tools = new SterlingTools({ store: stores, config: parseConfig(cfg), repoRoot: project });
    // MountedStores.all() is the mounted STORE fan, not a record list. Enumerate
    // each read-only store so push matching uses the frozen record content.
    const records = Object.fromEntries(stores.all().flatMap((store) => store.query({ cap: 10000 })).map((record) => [record.id, record]));
    if (c.channel === 'pull') { const response = c.kind === 'preflight' ? tools.knowledgePreflight(c.input.text) : c.kind === 'get' ? tools.knowledgeGet(c.input.id) : tools.knowledgeQueryResult(c.input); if (dbBefore !== sha256(readFileSync(caseDb))) throw new Error('case-local store mutated during pull replay'); json(join(out, 'response.json'), response); scored.push({ id: c.id, project: projectName, channel: 'pull', case_schema: caseSchema, label_sha256: labelHash(c), score: scorePull(response, c.labels, c.negative) }); } else {
      if (!Array.isArray(c.input?.events) || c.input.events.length === 0) throw new Error(`push case ${c.id} requires a non-empty input.events sequence`);
      assertEventPaths(c.id, c.input.events, project);
      const events = [];
      for (const [index, ev] of c.input.events.entries()) {
        for (const directive of directives.filter((x) => x.index === index && x.kind === 'config')) { cfg.delivery = { ...cfg.delivery, injection_rung: directive.value }; json(join(project, '.sterling', 'config.json'), cfg); }
        for (const directive of directives.filter((x) => x.index === index && x.kind === 'mutate')) bumpRevision(project, directive.id);
        for (const directive of directives.filter((x) => x.index === index && x.kind === 'lifecycle')) captureHooks(w.tree, project, { tool: 'SessionStart', agent_id: ev.agent_id }, 'SessionStart', directive.source);
        if ((ev.tool === 'Agent' || ev.tool === 'Task') && !ev.hook_event) {
          events.push(captureHooks(w.tree, project, ev, 'PreToolUse'));
          events.push(captureHooks(w.tree, project, { ...ev, tool: undefined }, 'SubagentStart'));
        } else events.push(captureHooks(w.tree, project, ev));
      }
      const late = captureHooks(w.tree, project, { tool: 'UserPromptSubmit', prompt: c.input.late_prompt ?? '' }, 'UserPromptSubmit');
      const scoreInputIndex = c.score_event ?? c.input.events.length - 1;
      const scoreIndexes = scoreEventIndexes(c.input.events, scoreInputIndex);
      json(join(out, 'hooks.json'), { events, late });
      const dbAfter = sha256(readFileSync(caseDb)); if (dbBefore !== dbAfter && !directives.some((x) => x.kind === 'mutate')) throw new Error(`case-local store mutated by hooks (db ${dbBefore} -> ${dbAfter}); hooks run against a disposable, mutation-detected copy`);
      const selected = scoreIndexes.map((i) => events[i]);
      scored.push({ id: c.id, project: projectName, channel: 'push', case_schema: caseSchema, label_sha256: labelHash(c), score_event: scoreInputIndex, score_hook_events: scoreIndexes, score: scorePush({ envelopes: selected.flatMap((event) => event.captures.map((x) => x.envelope)), lateEnvelopes: late.captures.map((x) => x.envelope).filter((x) => String(x).length > 0), labels: c.labels, recordsById: records, guardBefore: selected[0].guard_before, guardAfter: selected.at(-1).guard_after }) });
    } } catch (error) { scored.push({ id: c.id, project: c.project ?? 'sterling-main', channel: c.channel, case_schema: caseSchema, label_sha256: labelHash(c), error: String(error) }); } finally { stores?.close(); } }
  const perProjectTotals = Object.fromEntries([...new Set(scored.map((x) => x.project ?? 'sterling-main'))].map((project) => [project, channelTotals(scored.filter((x) => (x.project ?? 'sterling-main') === project))]));
  const summary = { commit, runtime_ms: Date.now() - started, build: w.build, adapter_sha256: w.adapter_sha256, tools_adapter_sha256: w.tools_adapter_sha256, projects: manifest.projects, cases: scored, channel_totals: channelTotals(scored), project_totals: perProjectTotals, invalid: scored.some((x) => x.error) }; json(join(runDir, 'summary.json'), summary); return summary;
}
async function main() { const commits = (arg('--commits', '') ?? '').split(',').filter(Boolean); const casesPath = arg('--cases'); const workDir = resolve(arg('--work-dir', '/tmp/claude-1000/knowledge-eval')); if (!commits.length || !casesPath) throw new Error('usage: --commits sha[,sha] --cases cases.jsonl [--work-dir dir] [--projects JSON] [--clean]'); const projects = resolveProjects(arg('--projects', undefined)); if (process.argv.includes('--clean')) { cleanStaleWorktrees(root, workDir); for (const project of Object.values(projects)) cleanStaleWorktrees(project, workDir); if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true }); } const snap = arg('--snapshot') ? resolve(arg('--snapshot')) : snapshot(workDir, projects); const cases = readJsonl(resolve(casesPath)); const summaries = []; for (const c of commits) summaries.push(await evaluateCommit(c, cases, workDir, snap)); const paired = pairedComparison(summaries); const projectTotals = Object.fromEntries(Object.keys(JSON.parse(readFileSync(join(snap, 'manifest.json'))).projects ?? {}).map((project) => [project, summaries.map((s) => ({ commit: s.commit, totals: s.project_totals[project] ?? {} }))])); const comparison = { harness_version: HARNESS_VERSION, snapshot: snap, invalid: summaries.some((x) => x.invalid) || paired.invalid, ...paired, project_totals: projectTotals, commits: summaries }; json(join(workDir, 'comparison.json'), comparison); console.log(JSON.stringify(comparison, null, 2)); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`knowledge-eval: ${e.stack ?? e}`); process.exitCode = 1; });
