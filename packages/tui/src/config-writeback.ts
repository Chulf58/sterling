// Config write-back for the System-tab sparring/TDD toggles (decision
// foreign_752caf98, tdd-and-mutation-toggles-in-system-tab; the sibling
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
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERPASS_PROVIDER_RE, resolveOverpass } from '@sterling/schemas';
import type { AutoMergeToggleEffect, HandoffToggleEffect, ModeToggleEffect, OverpassBypassEffect, OverpassProviderEffect, OverpassRoleEffect, OverpassToggleEffect, SparringToggleEffect, TddToggleEffect } from './state.js';

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
  const tmp = `${target}.tmp-${randomUUID()}`;
  let renamed = false;
  try {
    if (seams.writeFile) seams.writeFile(tmp, next, mode);
    else writeFileSync(tmp, next, { mode });
    chmodSync(tmp, mode);
    seams.beforeRename?.();
    let now: Buffer | undefined;
    try {
      now = readFileSync(target);
    } catch {
      now = undefined;
    }
    if (now === undefined || !now.equals(expected)) throw new ConfigChangedError();
    renameSync(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // the temp file may never have been created; the original is untouched either way
      }
    }
  }
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

/** Execute a sparring_toggle effect: config.sparring_partner.enabled write
 *  only (advisory-only surface, article interaction a — never gates, so
 *  there is no downstream projection or decision record the way a model swap
 *  has). Preserves the model field untouched. Optional trailing `path`
 *  overrides the cwd-derived default (delta review finding: the TUI's own
 *  read/write path is argv-derived, not cwd-derived, so a foreign launch cwd
 *  must never split the two). */
export function applySparringToggle(e: SparringToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'sparring_partner', (old) => ({ ...(old as { enabled?: boolean; model?: string } | undefined), enabled: e.enabled }));
    return true;
  } catch (err) {
    onError?.(`sparring partner toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute a tdd_toggle effect: config.tdd.enabled write only (decision
 *  752caf98) — mirrors applySparringToggle exactly. OFF silences the
 *  automatic default TDD posture only; H5/H18 test protection is untouched.
 *  Optional trailing `path` overrides the cwd-derived default (see
 *  applySparringToggle). */
export function applyTddToggle(e: TddToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'tdd', (old) => ({ ...(old as { enabled?: boolean } | undefined), enabled: e.enabled }));
    return true;
  } catch (err) {
    onError?.(`tdd toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute a mode_toggle effect: config.mode write only (decision
 *  project-mode-hobby-work-toggle-decides-flow) — mirrors applyTddToggle. The
 *  mode decides only how work ships (a direct merge, or a pull request with
 *  the review loop); it writes and deletes no files. Optional trailing `path`
 *  overrides the cwd-derived default (see applySparringToggle). */
export function applyModeToggle(e: ModeToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'mode', () => e.mode);
    return true;
  } catch (err) {
    onError?.(`mode toggle failed — ${(err as Error).message}`);
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
 *  (see applySparringToggle). */
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

/** Execute an auto_merge_toggle effect: config.pr_review.auto_merge_on_clean
 *  write only (decision work-mode-pr-auto-merge-when-copilot-loop-ends-clean) —
 *  mirrors applyHandoffToggle. Every other pr_review key (copilot_logins, the
 *  pinned Copilot identity) is kept. A recorded `pr_review` that is not an
 *  object is replaced, never spread. Optional trailing `path` overrides the
 *  cwd-derived default (see applySparringToggle). */
export function applyAutoMergeToggle(e: AutoMergeToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeConfigKey(configPath(path), 'pr_review', (old) => {
      const block = old !== null && typeof old === 'object' && !Array.isArray(old) ? old : {};
      return { ...block, auto_merge_on_clean: e.enabled };
    });
    return true;
  } catch (err) {
    onError?.(`auto-merge toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Write one key of config.overpass (decision
 *  overpass-toggle-work-mode-only-routes-every-lane-through-tiers). Every other
 *  overpass key is kept; a recorded `overpass` that is not an object is replaced,
 *  never spread. Nothing else is written: the plugin applies the routing on its
 *  next turn. */
function writeOverpassKey(field: 'enabled' | 'provider' | 'conductor_bypass', value: boolean | string, path?: string): void {
  writeConfigKey(configPath(path), 'overpass', (old) => {
    const block = old !== null && typeof old === 'object' && !Array.isArray(old) ? old : {};
    return { ...block, [field]: value };
  });
}

/** Execute an overpass_role effect: config.overpass.roles.<role> becomes the picked
 *  tier and optional effort. Every other overpass key and every other role is kept;
 *  a recorded `overpass` or `roles` that is not an object is replaced, never spread.
 *  The whole proposed overpass block goes through resolveOverpass before anything is
 *  written, so a caller that skips the reducer can never persist a role, tier or effort
 *  the resolver would throw on (including a non-string tier). config.models and the
 *  agent files are not touched. */
export function applyOverpassRole(e: OverpassRoleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    const entry = e.effort === undefined ? { tier: e.tier } : { tier: e.tier, effort: e.effort };
    writeConfigKey(configPath(path), 'overpass', (old) => {
      const block = old !== null && typeof old === 'object' && !Array.isArray(old) ? (old as Record<string, unknown>) : {};
      const roles = block.roles !== null && typeof block.roles === 'object' && !Array.isArray(block.roles) ? (block.roles as Record<string, unknown>) : {};
      const proposed = { ...block, roles: { ...roles, [e.role]: entry } };
      // the canonical resolver judges the whole proposed block, so a value it would
      // throw on is never persisted (a throw there blocks every dispatch)
      resolveOverpass({ mode: 'work', overpass: proposed }, { host: 'opencode' });
      return proposed;
    });
    return true;
  } catch (err) {
    onError?.(`Overpass role update failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute an overpass_toggle effect: config.overpass.enabled. Optional trailing
 *  `path` overrides the cwd-derived default (see applySparringToggle). */
export function applyOverpassToggle(e: OverpassToggleEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeOverpassKey('enabled', e.enabled, path);
    return true;
  } catch (err) {
    onError?.(`Overpass toggle failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute an overpass_provider effect: config.overpass.provider. The provider id
 *  was validated by the reducer; it is checked again here, so a caller that skips
 *  the reducer can never write an id the resolver would refuse. */
export function applyOverpassProvider(e: OverpassProviderEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    if (!OVERPASS_PROVIDER_RE.test(e.provider)) throw new Error(`'${e.provider}' is not a provider id`);
    writeOverpassKey('provider', e.provider, path);
    return true;
  } catch (err) {
    onError?.(`Overpass provider update failed — ${(err as Error).message}`);
    return false;
  }
}

/** Execute an overpass_bypass_toggle effect: config.overpass.conductor_bypass. */
export function applyOverpassBypass(e: OverpassBypassEffect, onError?: (msg: string) => void, path?: string): boolean {
  try {
    writeOverpassKey('conductor_bypass', e.enabled, path);
    return true;
  } catch (err) {
    onError?.(`Overpass conductor bypass toggle failed — ${(err as Error).message}`);
    return false;
  }
}
