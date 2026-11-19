// Config write-back for the System tab (decisions foreign_752caf98 and
// system-tab-layout-one-screen-with-three-sections-agents-one; the sibling
// mutation-verification toggle this module used to also write back was
// REMOVED entirely — decision
// cleanup-run-deletes-dead-scripts-and-removes-mutation-verification-key,
// 2026-09-22, no live mechanism ever performed the check it promised) —
// EXTRACTED from main.ts (Codex review finding) so the frozen pins in
// tests/config-writeback.test.ts can import this module directly without
// pulling in main.ts's argv-parsing/terminal-kit side effects on import.
//
// Reads/writes .sterling/config.json under the PROCESS CWD — read-modify-
// write with a spread-merge: unrelated top-level keys and unrelated sibling
// keys inside the touched block survive byte-for-byte; a config missing the
// block entirely gains exactly {enabled: <effect value>}.
//
// Each function stays SYNC (the pre-extraction convention). onError is an
// optional callback (main.ts wires it to its local notice state); a caller
// that omits it gets silent-but-caught failure, matching the pre-extraction
// behavior of swallowing the error into a UI notice the caller owns. Each
// function returns `true` on a successful write and `false` on a caught
// failure (onError still fires with the byte-identical failure message) —
// on SUCCESS, nothing is emitted here: a throwing onError must never land
// inside the try and turn a completed write into a false failure report,
// and a later success in a same-tick batch must never clobber an earlier
// failure on the shared UI notice sink. The caller (main.ts) composes the
// single H17-latch reminder itself once all appliers in the batch have run
// — board 09f05fca half 2, review fix.
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_REF_RE, OVERPASS_PROVIDER_RE, canonicalConfigSchema, toCanonicalConfig } from '@sterling/schemas';
// Static, so esbuild inlines it into the bundles (as controller.ts does for the other scripts/lib modules).
import { writeFileAtomic } from '../../../scripts/lib/atomic-write.mjs';
import type { AgentModelEffect, HandoffToggleEffect, OverpassProviderEffect, TddToggleEffect, WorkflowEffect } from './state.js';

function configPath(explicit?: string): string {
  return explicit ?? join(process.cwd(), '.sterling', 'config.json');
}

/** The move that is the only writer of config.storage (decision
 *  storage-backend-is-its-own-config-key-written-only-by-store-move). */
const MOVE_STORE = '`node "<Sterling root>/bin/move-store.mjs" --to pg|sqlite`';

/** The TUI's refusal to write config.storage: config_set's message
 *  (packages/mcp-server tools.ts StorageTransitionRequiredError), with this
 *  surface's name in place of config_set's. */
export class StorageTransitionRequiredError extends Error {
  constructor(path: string) {
    super(
      `TUI: '${path}' cannot be written directly. config.storage records where this project's stores live (SQLite or Postgres), ` +
        `so it changes only when the stores move, through the explicit storage transition: ${MOVE_STORE}, ` +
        `which writes it after the move commits. Nothing was written.`
    );
    this.name = 'StorageTransitionRequiredError';
  }
}

/** Test seams for the config.json write: `writeFile` replaces the temp-file write and
 *  `beforeRename` runs in the window between that write and the final compare. */
export interface ConfigWriteSeams {
  writeFile?: (path: string, content: string, mode: number) => void;
  beforeRename?: () => void;
}

/** Thrown when config.json changed on disk between the read a write was built from and
 *  the rename: nothing was written and the other writer's file stands. */
export class ConfigChangedError extends Error {
  constructor() {
    super('config.json changed on disk while this write was in flight (a concurrent change); nothing was written — reopen the setting and retry');
    this.name = 'ConfigChangedError';
  }
}

/** The one place the TUI replaces config.json: a temp file in the same directory with
 *  the original's mode, then a rename, so a failed write leaves the original whole.
 *  Immediately before the rename the file's bytes are compared with `expected`, the
 *  bytes `next` was built from: a concurrent change (config_set, another TUI) throws
 *  ConfigChangedError, with the temp file removed and the file as the other writer left
 *  it. Residual, as in config_set and commitConfigMigration: the sliver between that
 *  compare and the rename needs a file lock this does not take. */
export function replaceConfigFile(target: string, next: string, expected: Buffer, seams: ConfigWriteSeams = {}): void {
  // lstat, not stat: the rename replaces the path itself, so a symlinked config.json would
  // be swapped for a plain file (config_set and the config migration refuse the same way)
  const linkStat = lstatSync(target);
  if (linkStat.isSymbolicLink()) throw new Error('config.json is a symlink — refusing to write through a link, which the write would replace with a plain file. Nothing was written.');
  const mode = linkStat.mode & 0o777;
  // the shared temp-file lifecycle (write, rename, remove the temp file on failure) is
  // writeFileAtomic's; the mode and the byte compare ride on its two seams
  writeFileAtomic(target, next, {
    writeFile: (tmp: string, content: string) => {
      if (seams.writeFile) seams.writeFile(tmp, content, mode);
      else writeFileSync(tmp, content, { mode });
      chmodSync(tmp, mode);
    },
    rename: (tmp: string, path: string) => {
      seams.beforeRename?.();
      let now: Buffer | undefined;
      try {
        now = readFileSync(path);
      } catch {
        now = undefined;
      }
      if (now === undefined || !now.equals(expected)) throw new ConfigChangedError();
      renameSync(tmp, path);
    },
  });
}

/** Read config.json, replace the top-level `key` with `update(old, raw)`, and write it
 *  back through replaceConfigFile with every other key kept. `storage` (or any
 *  `storage.` path) is refused before anything is read or written: only the store move
 *  writes it. */
export function writeConfigKey(target: string, key: string, update: (old: unknown, raw: Record<string, unknown>) => unknown, seams: ConfigWriteSeams = {}): void {
  if (key === 'storage' || key.startsWith('storage.')) throw new StorageTransitionRequiredError(key);
  const original = readFileSync(target);
  const raw = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
  raw[key] = update(raw[key], raw);
  replaceConfigFile(target, JSON.stringify(raw, null, 2) + '\n', original, seams);
}

/** Execute a tdd_toggle effect: config.tdd.enabled write only (decision
 *  752caf98) — mirrors the other toggles. OFF silences the
 *  automatic default TDD posture only; H5/H18 test protection is untouched.
 *  Optional trailing `path` overrides the cwd-derived default (see
 *  applyTddToggle). */
export function applyTddToggle(e: TddToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'tdd', (old) => ({ ...(old as { enabled?: boolean } | undefined), enabled: e.enabled }));
    return true;
  } catch (err) {
    onError?.(`tdd toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute a handoff_toggle effect: config.handoff.enabled write only (decision
 *  project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting) —
 *  mirrors applyTddToggle. The switch deletes nothing: turning it off leaves the
 *  existing portable OpenCode agents and handoff projection in place (they stop
 *  being maintained); turning it on is provisioned by the next init or
 *  /sterling:update. A recorded `handoff` that is not an object is replaced,
 *  never spread. Optional trailing `path` overrides the cwd-derived default
 *  (see applyTddToggle). */
export function applyHandoffToggle(e: HandoffToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'handoff', (old) => {
      const block = old !== null && typeof old === 'object' && !Array.isArray(old) ? old : {};
      return { ...block, enabled: e.enabled };
    });
    return true;
  } catch (err) {
    onError?.(`handoff toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Throw unless the whole proposed document passes canonicalConfigSchema (after the one legacy
 *  transform, which is where a legacy document is tolerated): a write a reader would refuse is never persisted. */
function assertCanonical(proposed: Record<string, unknown>): void {
  const checked = canonicalConfigSchema.safeParse(toCanonicalConfig(proposed).config);
  if (!checked.success) {
    throw new Error(`the result is not a valid canonical config (${checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}). Nothing was written.`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Execute an agent_model effect: config.models.<key> becomes {model, effort?}, replacing the entry whole so
 *  no per-host field survives; a null model leaves an empty entry (a custom agent on its host's default). The
 *  document is validated with canonicalConfigSchema before the write. */
export function applyAgentModel(e: AgentModelEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    // the legacy transform reads a bare Claude id as anthropic/<id>, so a bare id would pass the document check
    // below and be written bare: a write names its model as <provider>/<id> itself
    if (e.model !== null && !MODEL_REF_RE.test(e.model)) throw new Error(`'${e.model}' is not a canonical model (<provider>/<id>). Nothing was written.`);
    writeConfigKey(configPath(path), 'models', (old, raw) => {
      const models = isObj(old) ? old : {};
      const entry = e.model === null ? {} : { model: e.model, ...(e.effort === undefined ? {} : { effort: e.effort }) };
      const proposed = { ...models, [e.key]: entry };
      assertCanonical({ ...raw, models: proposed });
      return proposed;
    });
    return true;
  } catch (err) {
    onError?.(`model change for '${e.key}' failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute a workflow_set effect: one field of config.workflow. The block is built from the workflow the
 *  canonical transform reads (a legacy mode becomes its merge path and reviewer defaults), so writing one
 *  field of a project that still carries `mode` records the other three as they read now. Validated with
 *  canonicalConfigSchema (reviewers 1-5, merge direct or pr, booleans) before the write. */
export function applyWorkflow(e: WorkflowEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'workflow', (_old, raw) => {
      const current = (toCanonicalConfig(raw).config as { workflow?: unknown }).workflow;
      const proposed = { ...(isObj(current) ? current : {}), [e.field]: e.value };
      assertCanonical({ ...raw, workflow: proposed });
      return proposed;
    });
    return true;
  } catch (err) {
    onError?.(`workflow update failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute an overpass_provider effect: config.overpass.provider. Every other overpass key is kept; the
 *  document is validated with canonicalConfigSchema, so a provider id the schema refuses is never written. */
export function applyOverpassProvider(e: OverpassProviderEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    if (!OVERPASS_PROVIDER_RE.test(e.provider)) throw new Error(`'${e.provider}' is not a provider id`);
    writeConfigKey(configPath(path), 'overpass', (old, raw) => {
      const proposed = { ...(isObj(old) ? old : {}), provider: e.provider };
      assertCanonical({ ...raw, overpass: proposed });
      return proposed;
    });
    return true;
  } catch (err) {
    onError?.(`Overpass provider update failed — ${(err as Error).message}`);
    return false;
  }
}
