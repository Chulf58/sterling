// scripts/plan-lock.mjs refuses any token that does not belong to its verb.
// Why: OpenCode's Plan agent may run exactly `node <root>/bin/plan-lock.mjs --plan *`,
// and an OpenCode shell pattern's `*` matches the whole rest of the command line
// (finding how-does-opencode-v2-override-its-built-in-plan-agent-and-ho), so the
// script, not the rule, has to refuse `--plan x --release` and its kin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIS = { source: join(root, 'scripts', 'plan-lock.mjs'), bundle: join(root, 'bin', 'plan-lock.mjs') };

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-lock-args-'));
  mkdirSync(join(dir, '.sterling', 'plans'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  const plan = join(dir, '.sterling', 'plans', 'p.md');
  writeFileSync(plan, '# P\n\nsteps\n');
  return { dir, plan };
}

const lockOf = (dir) => join(dir, '.sterling', 'plan-lock.json');

for (const [which, cli] of Object.entries(CLIS)) {
  const runCli = (dir, args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });

  test(`${which}: --plan refuses another verb, another verb's flag, an unknown flag and a stray argument; nothing is written`, () => {
    const { dir, plan } = project();
    try {
      const cases = [
        [['--plan', plan, '--release'], /exactly one verb/],
        [['--plan', plan, '--observe'], /exactly one verb/],
        [['--plan', plan, '--show'], /exactly one verb/],
        [['--plan', plan, '--reason', 'x'], /--reason does not go with --plan/],
        [['--plan', plan, '--reason=x'], /--reason does not go with --plan/],
        [['--plan', plan, '--evil'], /--evil does not go with --plan/],
        [['--plan', plan, 'extra'], /unexpected argument "extra"/],
        [['--plan', plan, '--force=yes'], /--force takes no value/],
      ];
      for (const [args, re] of cases) {
        const r = runCli(dir, args);
        assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, re, args.join(' '));
        assert.ok(!existsSync(lockOf(dir)), `${args.join(' ')} wrote no lock`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${which}: the plain forms still work: --plan <path>, --plan=<path> --force, --show, --release --reason`, () => {
    const { dir, plan } = project();
    try {
      let r = runCli(dir, ['--plan', plan]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(lockOf(dir), 'utf8')).source, 'manual');
      r = runCli(dir, [`--plan=${plan}`, '--force']);
      assert.equal(r.status, 0, r.stderr);
      r = runCli(dir, ['--show']);
      assert.equal(r.status, 0, r.stderr);
      r = runCli(dir, ['--show', '--force']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--force does not go with --show/);
      r = runCli(dir, ['--release', '--reason', 'done']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(lockOf(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
