// sterling-check.mjs ensure [S] — the per-project consumer-runnable checks
// entry (board 4ccf0644). check-record-citations and check-stale-claims were
// registered only in THIS repo's `npm run check` battery, so both incidents
// they exist to catch (a citation to a nonexistent ruling; a stale absence
// claim) happened in a CONSUMING project, where nothing ever ran them. The
// two check scripts already accept an explicit target (a root positional arg
// / a --target flag) — what was missing was a way for a consumer to actually
// invoke them against their own project without knowing the clone's path or
// the check CLI by heart.
//
// Shared by TWO producers, mirroring ensureUpdateLauncher (update-launcher.mjs)
// exactly: init's ensure-manifest and runUpdate's per-project fan-out — the
// fan-out matters because a project init'd before this launcher existed would
// otherwise never get one until someone remembered to re-run /sterling:init
// there (P4 — bind the delivery to the update event, not to memory).
//
// BOOTSTRAP INDEPENDENCE: imported by scripts/lib/update.mjs at load time
// (same precedent as update-launcher.mjs) — builtins only.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampBody, verifyStamp } from './generated-marker.mjs';

export const CONSUMER_CHECK_LAUNCHER_NAME = 'sterling-check.mjs';

const normalize = (s) => s.replace(/\r\n/g, '\n');
const fwd = (p) => p.replace(/\\/g, '/');

// BAKE THE POSIX/WSL FORM ONLY — the form init/update actually run under.
// update-launcher.mjs can pre-convert to a Windows form because update-win.bat
// is executed by cmd.exe ONLY; this file is executed by EITHER a WSL node or a
// native-Windows node, and a pre-converted Windows form (C:\...) is invalid
// under WSL/Linux node — join('C:\\...', 'scripts', ...) resolves nowhere on
// Linux. The win32 conversion instead runs AT RUNTIME inside the generated
// file itself, gated on process.platform, so one generated file serves both
// (see templates/check-consumer.mjs's own toWindowsPath).
//
// JSON.stringify, not raw interpolation into '{{PLUGIN_DIR}}': a bare-quoted
// placeholder means ANY backslash in the baked path — Windows-form or not —
// lands inside a JS string literal unescaped, so '\U...', '\n', '\t' etc.
// are read as ESCAPE SEQUENCES by the generated file, silently corrupting the
// path. JSON.stringify produces a correctly escaped, self-quoting literal
// regardless of the path's separator style.
export function renderConsumerCheckLauncher(pluginRoot) {
  const template = readFileSync(join(pluginRoot, 'templates', 'check-consumer.mjs'), 'utf8');
  const body = template.replace('{{PLUGIN_DIR}}', JSON.stringify(fwd(pluginRoot)));
  return stampBody(body, '//');
}

/**
 * Ensure semantics (§12): created / matches / refreshed / differs / skipped —
 * never overwrites content it cannot prove it generated. Also ensures the
 * target's .gitignore carries the entry (mirrors ensureUpdateLauncher): a
 * generated machine artifact must never surface as untracked noise in a
 * sibling repo.
 *
 * REFRESH (board bb3aa162): a mismatch against the freshly rendered expected
 * no longer means "leave it, might be hand-edited" — the on-disk file's own
 * embedded content-hash marker (generated-marker.mjs) proves whether it was
 * touched since ITS generation. Unmodified-but-stale (a clone move, a
 * template edit) refreshes freely; a marker mismatch (or no marker at all —
 * a legacy or foreign file) still leaves it untouched as 'differs'.
 */
export function ensureConsumerCheckLauncher(target, pluginRoot) {
  if (!existsSync(target)) {
    return { status: 'skipped', detail: `target missing: ${target}` };
  }
  if (!existsSync(join(pluginRoot, 'templates', 'check-consumer.mjs'))) {
    return { status: 'skipped', detail: 'templates/check-consumer.mjs missing in the clone' };
  }
  const expected = renderConsumerCheckLauncher(pluginRoot);
  const launcherPath = join(target, CONSUMER_CHECK_LAUNCHER_NAME);

  let result;
  if (!existsSync(launcherPath)) {
    writeFileSync(launcherPath, expected);
    result = { status: 'created', detail: 'node sterling-check.mjs — runs record-citations + stale-claim checks against this project' };
  } else {
    const diskNorm = normalize(readFileSync(launcherPath, 'utf8'));
    if (diskNorm === normalize(expected)) {
      result = { status: 'matches', detail: 'unchanged' };
    } else {
      const stamp = verifyStamp(diskNorm, '//');
      if (stamp && stamp.unmodified) {
        writeFileSync(launcherPath, expected);
        result = { status: 'refreshed', detail: 'regenerated: unmodified since last generation, but this machine now renders it differently (clone moved or template changed)' };
      } else {
        result = { status: 'differs', detail: 'left untouched (hand-edited or other machine) — delete and re-run init to regenerate' };
      }
    }
  }

  const gitignorePath = join(target, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes(CONSUMER_CHECK_LAUNCHER_NAME)) {
    appendFileSync(gitignorePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${CONSUMER_CHECK_LAUNCHER_NAME}\n`);
  }
  return result;
}
