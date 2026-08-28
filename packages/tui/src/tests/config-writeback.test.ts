import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===========================================================================
// CONFIG WRITE-BACK oracle (decision 752caf98, tdd-and-mutation-toggles-in-
// system-tab; test-writer work order item 3) — SPEC-ONLY, written against the
// brief without reading main.ts or state.ts.
//
// SPEC: packages/tui/src/config-writeback.ts is a module being EXTRACTED from
// main.ts (it does not exist yet) exporting three functions:
//   applyTddToggle(e), applyMutationToggle(e), applySparringToggle(e)
// Each takes the reducer's toggle effect verbatim (the effect already carries
// the FLIPPED target value — { type: 'tdd_toggle', enabled: boolean } /
// { type: 'mutation_toggle', enabled: boolean }, per the CONTRACT already
// pinned in tdd-mutation-toggles.test.ts) and rewrites .sterling/config.json
// under the process cwd so <block>.enabled equals the effect's `enabled`.
//
// CONTRACT this oracle OWNS for the two NEW functions (applyTddToggle /
// applyMutationToggle — applySparringToggle is existence-only here, its
// behavior is out of this brief's scope):
//   (a) unrelated TOP-LEVEL keys in config.json are byte-preserved;
//   (b) unrelated SIBLING keys inside the same block (tdd / mutation_verification)
//       are preserved;
//   (c) a config missing the block entirely gains exactly {enabled: <effect
//       value>} for that block, without disturbing anything else.
//
// CLEAN-RED discipline (mirrors tdd-mutation-toggles.test.ts / sparring-partner.
// test.ts): the module does not exist yet, so it is loaded dynamically and
// existence-asserted before any test uses it — a genuinely unimplemented
// module fails on a clean AssertionError, never a MODULE_NOT_FOUND crash.
// ===========================================================================

type ToggleEffect = { type: 'tdd_toggle' | 'mutation_toggle' | 'sparring_toggle'; enabled: boolean };
// Widened (additive, backward-compatible) for the explicit-config-path pins below:
// PINNED SIGNATURE (this oracle's own call, per the work order — no existing
// test exercises the onError slot, so this states it explicitly): the new
// config-path argument is the THIRD, TRAILING positional parameter, after the
// existing onError callback —
//   (effect: ToggleEffect, onError?: (err: unknown) => void, configPath?: string)
// Omitting onError/configPath preserves every existing pin's 1-arg call untouched.
type Writeback = {
  applyTddToggle?: (e: ToggleEffect, onError?: (err: unknown) => void, configPath?: string) => unknown;
  applyMutationToggle?: (e: ToggleEffect, onError?: (err: unknown) => void, configPath?: string) => unknown;
  applySparringToggle?: (e: ToggleEffect, onError?: (err: unknown) => void, configPath?: string) => unknown;
};

async function loadWriteback(): Promise<Writeback> {
  try {
    return (await import('../config-writeback.js')) as unknown as Writeback;
  } catch {
    return {};
  }
}

async function withTempConfig<T>(
  initial: Record<string, unknown>,
  run: (cfgPath: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cfgwb-'));
  mkdirSync(join(dir, '.sterling'));
  const cfgPath = join(dir, '.sterling', 'config.json');
  writeFileSync(cfgPath, JSON.stringify(initial, null, 2));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return await run(cfgPath);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function readConfigFile(cfgPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(cfgPath, 'utf8'));
}

// Additive fixture for the explicit-config-path pins: TWO independent temp
// dirs — a TARGET dir (never cwd) holding the config the explicit path
// argument names, and a separate CWD dir holding an unrelated decoy
// config.json that process.cwd()-derived resolution would hit if the
// explicit path argument were silently ignored. cwd is set to the decoy dir
// for the duration of `run`.
async function withCwdAndExplicitConfig<T>(
  targetInitial: Record<string, unknown>,
  cwdDecoyInitial: Record<string, unknown>,
  run: (targetCfgPath: string, decoyCfgPath: string) => Promise<T> | T,
): Promise<T> {
  const targetDir = mkdtempSync(join(tmpdir(), 'sterling-cfgwb-target-'));
  mkdirSync(join(targetDir, '.sterling'));
  const targetCfgPath = join(targetDir, '.sterling', 'config.json');
  writeFileSync(targetCfgPath, JSON.stringify(targetInitial, null, 2));

  const cwdDir = mkdtempSync(join(tmpdir(), 'sterling-cfgwb-cwd-'));
  mkdirSync(join(cwdDir, '.sterling'));
  const decoyCfgPath = join(cwdDir, '.sterling', 'config.json');
  writeFileSync(decoyCfgPath, JSON.stringify(cwdDecoyInitial, null, 2));

  const prevCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    return await run(targetCfgPath, decoyCfgPath);
  } finally {
    process.chdir(prevCwd);
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  }
}

// ===========================================================================
// Existence
// ===========================================================================

test('config-writeback: applyTddToggle, applyMutationToggle, and applySparringToggle are all exported as functions (frozen extraction target)', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyTddToggle, 'function', 'applyTddToggle must be exported from config-writeback.ts');
  assert.strictEqual(typeof mod.applyMutationToggle, 'function', 'applyMutationToggle must be exported from config-writeback.ts');
  assert.strictEqual(typeof mod.applySparringToggle, 'function', 'applySparringToggle must be exported from config-writeback.ts');
});

// ===========================================================================
// applyTddToggle — (a) top-level preservation, (b) sibling preservation,
// (c) missing-block creation
// ===========================================================================

test('config-writeback: applyTddToggle rewrites tdd.enabled and byte-preserves unrelated top-level keys', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyTddToggle, 'function', 'applyTddToggle must be exported');
  const applyTddToggle = mod.applyTddToggle!;

  await withTempConfig(
    { tdd: { enabled: true }, sparring_partner: { enabled: true, model: 'gpt-5.6' }, caps: { inner_loop_n: 3 } },
    async (cfgPath) => {
      await applyTddToggle({ type: 'tdd_toggle', enabled: false });
      const written = readConfigFile(cfgPath);
      assert.equal((written.tdd as { enabled: boolean }).enabled, false, 'tdd.enabled is rewritten to the effect value');
      assert.deepEqual(
        written.sparring_partner,
        { enabled: true, model: 'gpt-5.6' },
        'the unrelated top-level sparring_partner block is untouched',
      );
      assert.deepEqual(written.caps, { inner_loop_n: 3 }, 'the unrelated top-level caps block is untouched');
    },
  );
});

test('config-writeback: applyTddToggle preserves unrelated sibling keys inside the tdd block itself', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyTddToggle, 'function', 'applyTddToggle must be exported');
  const applyTddToggle = mod.applyTddToggle!;

  await withTempConfig({ tdd: { enabled: true, note: 'hand-added sibling key' } }, async (cfgPath) => {
    await applyTddToggle({ type: 'tdd_toggle', enabled: false });
    const written = readConfigFile(cfgPath);
    const tdd = written.tdd as { enabled: boolean; note?: string };
    assert.equal(tdd.enabled, false, 'enabled is rewritten to the effect value');
    assert.equal(tdd.note, 'hand-added sibling key', 'an unrelated sibling key inside the tdd block survives the rewrite');
  });
});

test('config-writeback: applyTddToggle on a config missing the tdd block entirely adds {enabled: <effect value>} without disturbing anything else', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyTddToggle, 'function', 'applyTddToggle must be exported');
  const applyTddToggle = mod.applyTddToggle!;

  await withTempConfig({ caps: { inner_loop_n: 3 } }, async (cfgPath) => {
    await applyTddToggle({ type: 'tdd_toggle', enabled: false });
    const written = readConfigFile(cfgPath);
    assert.deepEqual(written.tdd, { enabled: false }, 'a config missing the tdd block entirely gains exactly {enabled: <effect value>}');
    assert.deepEqual(written.caps, { inner_loop_n: 3 }, 'the unrelated caps block is untouched');
  });
});

// ===========================================================================
// applyMutationToggle — same three properties, mirrored
// ===========================================================================

test('config-writeback: applyMutationToggle rewrites mutation_verification.enabled and byte-preserves unrelated top-level keys', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyMutationToggle, 'function', 'applyMutationToggle must be exported');
  const applyMutationToggle = mod.applyMutationToggle!;

  await withTempConfig(
    {
      mutation_verification: { enabled: true },
      sparring_partner: { enabled: true, model: 'gpt-5.6' },
      caps: { inner_loop_n: 3 },
    },
    async (cfgPath) => {
      await applyMutationToggle({ type: 'mutation_toggle', enabled: false });
      const written = readConfigFile(cfgPath);
      assert.equal(
        (written.mutation_verification as { enabled: boolean }).enabled,
        false,
        'mutation_verification.enabled is rewritten to the effect value',
      );
      assert.deepEqual(
        written.sparring_partner,
        { enabled: true, model: 'gpt-5.6' },
        'the unrelated top-level sparring_partner block is untouched',
      );
      assert.deepEqual(written.caps, { inner_loop_n: 3 }, 'the unrelated top-level caps block is untouched');
    },
  );
});

test('config-writeback: applyMutationToggle preserves unrelated sibling keys inside the mutation_verification block itself', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyMutationToggle, 'function', 'applyMutationToggle must be exported');
  const applyMutationToggle = mod.applyMutationToggle!;

  await withTempConfig({ mutation_verification: { enabled: true, note: 'hand-added sibling key' } }, async (cfgPath) => {
    await applyMutationToggle({ type: 'mutation_toggle', enabled: false });
    const written = readConfigFile(cfgPath);
    const mv = written.mutation_verification as { enabled: boolean; note?: string };
    assert.equal(mv.enabled, false, 'enabled is rewritten to the effect value');
    assert.equal(mv.note, 'hand-added sibling key', 'an unrelated sibling key inside the mutation_verification block survives the rewrite');
  });
});

test('config-writeback: applyMutationToggle on a config missing the mutation_verification block entirely adds {enabled: <effect value>} without disturbing anything else', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyMutationToggle, 'function', 'applyMutationToggle must be exported');
  const applyMutationToggle = mod.applyMutationToggle!;

  await withTempConfig({ caps: { inner_loop_n: 3 } }, async (cfgPath) => {
    await applyMutationToggle({ type: 'mutation_toggle', enabled: false });
    const written = readConfigFile(cfgPath);
    assert.deepEqual(
      written.mutation_verification,
      { enabled: false },
      'a config missing the mutation_verification block entirely gains exactly {enabled: <effect value>}',
    );
    assert.deepEqual(written.caps, { inner_loop_n: 3 }, 'the unrelated caps block is untouched');
  });
});

// ===========================================================================
// Explicit config-path argument (adjudicated from a MEDIUM review finding,
// decision-752caf98 territory; test-writer regression pin) —
// applyTddToggle / applyMutationToggle gain an OPTIONAL TRAILING explicit
// config-path argument: when a caller passes an absolute path to a
// config.json, the function reads and writes EXACTLY that file, regardless
// of process.cwd(). Omitting it preserves the cwd-derived default already
// pinned by the 7 tests above (untouched by this addition). This pin exists
// so the production caller's argv-derived path can never silently regress to
// cwd — e.g. a change that reads the third argument but still resolves the
// WRITE target from cwd, or that ignores the argument entirely.
// ===========================================================================

test('config-writeback: applyTddToggle called with an explicit config path reads and writes exactly that file, ignoring a different process.cwd', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyTddToggle, 'function', 'applyTddToggle must be exported');
  const applyTddToggle = mod.applyTddToggle!;

  await withCwdAndExplicitConfig(
    { tdd: { enabled: true } },
    { tdd: { enabled: true } },
    async (targetCfgPath, decoyCfgPath) => {
      const decoyBefore = readFileSync(decoyCfgPath, 'utf8');

      await applyTddToggle({ type: 'tdd_toggle', enabled: false }, undefined, targetCfgPath);

      const target = readConfigFile(targetCfgPath);
      assert.equal(
        (target.tdd as { enabled: boolean }).enabled,
        false,
        'the explicit target config.json is rewritten to the effect value even though it is not process.cwd()',
      );
      const decoyAfter = readFileSync(decoyCfgPath, 'utf8');
      assert.equal(
        decoyAfter,
        decoyBefore,
        'the cwd-resident decoy config.json is byte-unchanged — the explicit path argument must never fall back to cwd',
      );
    },
  );
});

test('config-writeback: applyMutationToggle called with an explicit config path reads and writes exactly that file, ignoring a different process.cwd', async () => {
  const mod = await loadWriteback();
  assert.strictEqual(typeof mod.applyMutationToggle, 'function', 'applyMutationToggle must be exported');
  const applyMutationToggle = mod.applyMutationToggle!;

  await withCwdAndExplicitConfig(
    { mutation_verification: { enabled: true } },
    { mutation_verification: { enabled: true } },
    async (targetCfgPath, decoyCfgPath) => {
      const decoyBefore = readFileSync(decoyCfgPath, 'utf8');

      await applyMutationToggle({ type: 'mutation_toggle', enabled: false }, undefined, targetCfgPath);

      const target = readConfigFile(targetCfgPath);
      assert.equal(
        (target.mutation_verification as { enabled: boolean }).enabled,
        false,
        'the explicit target config.json is rewritten to the effect value even though it is not process.cwd()',
      );
      const decoyAfter = readFileSync(decoyCfgPath, 'utf8');
      assert.equal(
        decoyAfter,
        decoyBefore,
        'the cwd-resident decoy config.json is byte-unchanged — the explicit path argument must never fall back to cwd',
      );
    },
  );
});
