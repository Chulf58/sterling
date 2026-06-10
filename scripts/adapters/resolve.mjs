// Adapter registry access (spec §9.1, §15): toolchains declared in project
// config map path globs -> adapter NAME; this module resolves names against
// the registry and bakes the adapter's declarations (test globs, run commands)
// into config. A declared toolchain with no registered adapter fails loudly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function loadAdapterRegistry(dir = here) {
  const registry = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8'));
  if (registry.version !== 1 || !Array.isArray(registry.adapters)) {
    throw new Error('adapter registry: unsupported shape (expected {version: 1, adapters: []})');
  }
  return registry;
}

export async function loadAdapter(adapterName, dir = here) {
  const registry = loadAdapterRegistry(dir);
  const entry = registry.adapters.find((a) => a.name === adapterName);
  if (!entry) {
    throw new Error(
      `declared toolchain '${adapterName}' resolves to no registered adapter (registry: ${registry.adapters.map((a) => a.name).join(', ') || 'empty'}) — consistency check failure (§9.1)`
    );
  }
  const mod = await import(new URL(`./${entry.module}`, import.meta.url).href);
  return mod;
}

/** Bake adapter declarations into declared toolchains (init calls this; §9.1). */
export async function resolveToolchains(declared, dir = here) {
  const baked = [];
  for (const tc of declared) {
    const mod = await loadAdapter(tc.adapter, dir);
    baked.push({
      ...tc,
      test_globs: mod.testPathGlobs,
      run_commands: mod.runCommands,
      capabilities: mod.capabilities,
    });
  }
  return baked;
}

/** Consistency check (§15): every registry member loads and exports the fixed interface. */
export async function checkAdapterRegistry(dir = here) {
  const violations = [];
  let registry;
  try {
    registry = loadAdapterRegistry(dir);
  } catch (e) {
    return [{ kind: 'registry_unloadable', detail: e.message }];
  }
  for (const entry of registry.adapters) {
    let mod;
    try {
      mod = await import(new URL(`./${entry.module}`, import.meta.url).href);
    } catch (e) {
      violations.push({ kind: 'module_unloadable', detail: `${entry.name} -> ${entry.module}: ${e.message}` });
      continue;
    }
    if (mod.name !== entry.name) violations.push({ kind: 'name_mismatch', detail: `registry '${entry.name}' vs module '${mod.name}'` });
    for (const field of ['capabilities', 'testPathGlobs', 'runCommands']) {
      if (mod[field] === undefined) violations.push({ kind: 'missing_export', detail: `${entry.name}: ${field}` });
    }
    if (typeof mod.runTests !== 'function') violations.push({ kind: 'missing_export', detail: `${entry.name}: runTests()` });
  }
  return violations;
}
