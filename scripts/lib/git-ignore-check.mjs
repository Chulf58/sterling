// Which of a target's generated, meant-to-be-committed paths its own ignore
// rules already cover (Sol review: a project ignoring .opencode/, docs/ or *.md
// would never commit the handoff files). A report, never an edit: Sterling does
// not touch the user's ignore rules, the caller refuses and names the rule.
//
// `git check-ignore -v` reports, per ignored path, `<source>:<line>:<pattern>\t<path>`.
// A path that git already TRACKS is not reported (its ignore rule no longer
// matters), and a negated (`!`) pattern that matched means "not ignored".
// Returns { checked: false, reason } when the target is not a git work tree or
// git cannot run — the caller says so, never treats it as a pass in silence.

import { spawnSync } from 'node:child_process';

export function ignoredPaths(root, rels) {
  if (!rels.length) return { checked: true, ignored: [] };
  const r = spawnSync('git', ['check-ignore', '-v', '--', ...rels], { cwd: root, encoding: 'utf8' });
  if (r.error) return { checked: false, reason: `git could not run (${r.error.code ?? r.error.message})` };
  if (r.status === 128) return { checked: false, reason: (r.stderr || 'not a git work tree').trim().split('\n')[0] };
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore exited ${r.status}: ${r.stderr}`);
  const ignored = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const tab = line.lastIndexOf('\t');
    const rule = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const pattern = rule.split(':').slice(2).join(':');
    if (pattern.startsWith('!')) continue;
    ignored.push({ path, rule });
  }
  return { checked: true, ignored };
}

export function ignoredRemedy(ignored) {
  const rules = [...new Set(ignored.map((i) => i.rule))];
  return (
    `ignored by git (${rules.join('; ')}): ${ignored.map((i) => i.path).join(', ')}. ` +
    'These files are meant to be committed for engineers without Sterling. Remove or narrow that rule, ' +
    "or add a negation such as '!<path>' after it, then rerun — Sterling never edits your ignore rules."
  );
}
