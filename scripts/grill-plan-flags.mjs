// Grill-plan divergence flags [S] (spec §7.6): mechanically pre-computed
// intent↔plan divergences for the human to adjudicate, one at a time. The
// script flags; it never adjudicates. Run-proven shape (computed by hand in
// r-0001's grill-plan, now scripted).
//   node scripts/grill-plan-flags.mjs --brief <id> [--target <dir>]
import { matchesGlob } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';

export function computeDivergenceFlags(brief) {
  const flags = [];
  const flag = (kind, detail) => flags.push({ kind, detail });

  // ACs without phases / phases without ACs — coverage must close both ways
  const phaseAcIds = new Set(brief.phases.flatMap((p) => p.ac_ids));
  for (const ac of brief.acceptance_criteria) {
    if (!phaseAcIds.has(ac.ac_id) && ac.verifiable_at !== 'final') {
      flag('ac_without_phase', `AC '${ac.ac_id}' (${ac.verifiable_at}) is assigned to no phase`);
    }
  }
  for (const p of brief.phases) {
    if (p.ac_ids.length === 0) flag('phase_without_acs', `phase '${p.phase_id}' satisfies no AC — what is it for?`);
  }

  // unconfirmed conductor proposals must not survive to the gate
  for (const prop of brief.conductor_proposals) {
    if (prop.status === 'unconfirmed') {
      flag('unconfirmed_proposal', `conductor proposal still unconfirmed: "${prop.text}" — confirm or strike (an unanswered recommendation is not an accepted one)`);
    }
  }

  // plan scope claims vs locked exclusions
  const scopePaths = [...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope];
  for (const path of scopePaths) {
    for (const oos of brief.out_of_scope) {
      if (matchesGlob(path, oos)) flag('scope_conflict', `'${path}' is in scope AND matches out_of_scope ('${oos}')`);
    }
  }

  // phase file claims vs the blast radius
  const allowed = new Set(scopePaths);
  for (const p of brief.phases) {
    for (const f of p.files ?? []) {
      if (!allowed.has(f)) flag('phase_file_outside_scope', `phase '${p.phase_id}' claims '${f}' which is outside blast_radius + incidental_scope`);
    }
  }

  // a phase without a declared interface slice starves the test-writer (§8.1)
  for (const p of brief.phases) {
    if (!p.interfaces || p.interfaces.length === 0) {
      flag('phase_missing_interfaces', `phase '${p.phase_id}' declares no interface slice — the test-writer's spawn will fail loud (§8.1)`);
    }
  }

  // risk flags exist to be confirmed at the gate; absence is itself worth one look
  if (!brief.risk_flags || brief.risk_flags.length === 0) {
    flag('no_risk_flags', 'no risk flags proposed — confirm this plan really has no security/perf relevance (§7.6 step 3)');
  }

  return flags;
}

const isCli = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isCli) {
  const target = arg('--target') ?? process.cwd();
  const { store } = openProject(target);
  try {
    const briefId = arg('--brief');
    if (!briefId) fail('usage: grill-plan-flags.mjs --brief <id> [--target <dir>]', 2);
    const brief = store.get(briefId);
    if (!brief || brief.type !== 'brief') fail(`grill-plan-flags: '${briefId}' is not a brief in the store`, 2);
    console.log(JSON.stringify({ brief: briefId, flags: computeDivergenceFlags(brief) }, null, 2));
  } finally {
    store.close();
  }
}
