// The domain map behind /sterling:domains (decision
// consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command):
// which knowledge domains exist for the user on this machine, which registered
// projects mount each one, and which mounts the current project is missing.
//
// PURE: no filesystem, no store, no registry. The caller (scripts/domains.mjs)
// reads the domain store folders and the shared project registry and passes
// plain data in, with every path already forward-slashed; the same input always
// gives the same map. Nothing is stored: the map is computed on each run.
//
// THE PROPOSAL RULE, in two parts, both additive (a tag is never removed):
//   (i)  A domain named like the current project (its name or its folder name,
//        compared case-insensitively) that has a store or that a sibling
//        mounts, and that the project does not mount: add it, as the project's
//        own subject.
//   (ii) A sibling that mounts a domain named like the current project while
//        the current project mounts a domain named like that sibling, and the
//        two share no subject domain: each adds the domain named like itself,
//        so both mount both. Only the current project's side can be applied
//        here; the sibling's side is a step to run in that project.
// 'sterling' is mounted by every project, so it never counts as a shared
// subject and is never proposed.
// What the rule does NOT do: it does not guess a subject from a project's
// files, and it proposes nothing for a project whose name matches no domain.

export const UNIVERSAL_DOMAIN = 'sterling';

export const MAP_LIMITS = [
  'This map covers one user on one machine: the domain stores under this user\'s home folder and the projects in this user\'s project registry.',
  'A project on another machine, or under another user (native Windows and WSL count as two), is not listed, and its domain stores are separate files.',
  'A project that never ran /sterling:init on this machine is not listed. Run /sterling:domains inside it to register it.',
];

const lower = (s) => String(s).toLowerCase();
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const folderName = (path) => String(path).replace(/\/+$/, '').split('/').pop() ?? '';
const namesOf = (p) => new Set([lower(p.name), lower(folderName(p.path))].filter(Boolean));
const unique = (list) => [...new Set(list)];

/**
 * stores:   [{ name, path, description | null, format: 'current' | 'old', unreadable: null | string }]
 * projects: [{ name, path, stack_tags, exists }]  the registry entries
 * current:  { name, path, stack_tags } | null     the project the command runs in, with its live tags
 * notes:    string[]                              caller remarks carried into the output
 */
export function buildDomainMap({ stores, projects, current, notes = [] }) {
  const registered = current ? projects.some((p) => p.path === current.path) : false;
  const missing_projects = projects.filter((p) => !p.exists).map((p) => ({ name: p.name, path: p.path }));
  const live = projects.filter((p) => p.exists && !(current && p.path === current.path)).map((p) => ({ name: p.name, path: p.path, mounts: unique(p.stack_tags) }));
  const me = current ? { name: current.name, path: current.path, mounts: unique(current.stack_tags) } : null;
  const everyone = [...(me ? [me] : []), ...live].sort(byName);

  const storeByName = new Map(stores.map((s) => [s.name, s]));
  const names = unique([...storeByName.keys(), ...everyone.flatMap((p) => p.mounts)]).sort();
  const domains = names.map((name) => {
    const s = storeByName.get(name);
    return {
      name,
      has_store: Boolean(s),
      path: s?.path ?? null,
      description: s?.description ?? null,
      format: s?.format ?? null,
      unreadable: s?.unreadable ?? null,
      mounted_by: everyone.filter((p) => p.mounts.includes(name)).map((p) => p.name),
    };
  });

  const siblings = live.sort(byName).map((p) => {
    const shared = me ? me.mounts.filter((t) => p.mounts.includes(t)) : [];
    return { name: p.name, path: p.path, mounts: p.mounts, shared, shared_subjects: shared.filter((t) => t !== UNIVERSAL_DOMAIN).sort() };
  });

  return {
    current: me ? { ...me, registered } : null,
    domains,
    unmounted: domains.filter((d) => d.has_store && d.mounted_by.length === 0).map((d) => d.name),
    tags_without_store: domains.filter((d) => !d.has_store).map((d) => ({ tag: d.name, projects: d.mounted_by })),
    undescribed: domains.filter((d) => d.has_store && !d.unreadable && d.format === 'current' && !d.description).map((d) => d.name),
    old_format: domains.filter((d) => d.format === 'old').map((d) => d.name),
    unreadable: domains.filter((d) => d.unreadable).map((d) => ({ name: d.name, error: d.unreadable })),
    siblings,
    missing_projects,
    proposal: me ? propose(me, siblings, domains) : { add: [], sibling_steps: [] },
    notes,
    limits: MAP_LIMITS,
  };
}

function propose(me, siblings, domains) {
  const mine = namesOf(me);
  const add = new Map();
  const sibling_steps = [];
  const hasStore = (name) => domains.some((d) => d.name === name && d.has_store);
  const offer = (domain, reason) => {
    if (!add.has(domain)) add.set(domain, { domain, reason, has_store: hasStore(domain) });
  };

  for (const d of domains) {
    if (d.name === UNIVERSAL_DOMAIN || !mine.has(lower(d.name)) || me.mounts.includes(d.name)) continue;
    const users = d.mounted_by.filter((n) => n !== me.name);
    offer(
      d.name,
      `'${d.name}' is this project's own subject${users.length ? ` and ${users.join(', ')} ${users.length === 1 ? 'mounts' : 'mount'} it` : ''}, ` +
        'but this project does not mount it, so what it learns about its own subject cannot be written where other projects read it.'
    );
  }

  for (const s of siblings) {
    if (s.shared_subjects.length) continue;
    const theirs = namesOf(s);
    const namedLikeMe = s.mounts.filter((t) => t !== UNIVERSAL_DOMAIN && mine.has(lower(t)));
    const namedLikeThem = me.mounts.filter((t) => t !== UNIVERSAL_DOMAIN && theirs.has(lower(t)));
    if (!namedLikeMe.length || !namedLikeThem.length) continue;
    for (const t of namedLikeMe) {
      offer(t, `'${t}' is this project's own subject and ${s.name} mounts it, but this project does not, so the two projects share no subject domain.`);
    }
    sibling_steps.push({ project: s.name, path: s.path, add: namedLikeThem });
  }
  return { add: [...add.values()], sibling_steps };
}

const list = (items) => (items.length ? items.join(', ') : 'none');

/** The map as plain text for a person. `applyCommand` is the command line that reaches this CLI. */
export function renderDomainMap(map, { applyCommand = '/sterling:domains' } = {}) {
  const out = [];
  if (map.current) {
    out.push(`Current project: ${map.current.name} (${map.current.path})`, `  mounts: ${list(map.current.mounts)}`);
  } else {
    out.push('Current project: none (this folder is not an initialized Sterling project, so there is nothing to propose)');
  }
  for (const note of map.notes) out.push(`Note: ${note}`);

  out.push('', `Domains (${map.domains.length}):`);
  const width = Math.max(0, ...map.domains.map((d) => d.name.length));
  for (const d of map.domains) {
    out.push(`  ${d.name.padEnd(width)}  mounted by: ${list(d.mounted_by)}`);
    const detail = !d.has_store
      ? '(no store: the tag names a domain that was never created)'
      : d.unreadable
        ? `(could not be read: ${d.unreadable})`
        : d.format === 'old'
          ? '(old format)'
          : d.description || '(no description)';
    out.push(`  ${' '.repeat(width)}  ${detail}`);
  }

  out.push('');
  out.push(`Stores no project mounts: ${list(map.unmounted)}`);
  out.push(`Tags that name no store: ${list(map.tags_without_store.map((t) => `${t.tag} (${t.projects.join(', ')})`))}`);
  if (map.tags_without_store.length) {
    out.push('  A tag with no store is not mounted: nothing is read from it and writes to it are refused. Adding it with a description creates the store.');
  }
  out.push(`Stores with no description: ${list(map.undescribed)}`);
  if (map.undescribed.length) {
    out.push('  The description decides which records are written to a domain and which are promoted into it. Set one with the domain_describe tool from a project that mounts the domain.');
  }
  out.push(`Stores in the old format: ${list(map.old_format)}`);
  if (map.old_format.length) {
    out.push('  In a project that mounts an old-format store, knowledge_query and knowledge_get fail. This command does not migrate a store; the defect is tracked on the Sterling board as item 06f72a10.');
  }
  if (map.unreadable.length) out.push(`Stores that could not be read: ${map.unreadable.map((u) => `${u.name} (${u.error})`).join(', ')}`);

  out.push('', `Other projects (${map.siblings.length}):`);
  for (const s of map.siblings) {
    out.push(`  ${s.name} (${s.path}) mounts: ${list(s.mounts)}`);
    if (!map.current) continue;
    if (s.shared_subjects.length) out.push(`    shares with this project: ${s.shared_subjects.join(', ')}`);
    else if (s.shared.length) out.push(`    shares no subject domain with this project (only '${UNIVERSAL_DOMAIN}', which every project mounts)`);
    else out.push('    shares no domain with this project');
  }
  if (map.missing_projects.length) {
    out.push(`Registered projects whose folder is gone (not counted above): ${map.missing_projects.map((p) => `${p.name} (${p.path})`).join(', ')}`);
  }

  if (map.current) {
    out.push('', `Proposal for ${map.current.name}:`);
    if (!map.proposal.add.length && !map.proposal.sibling_steps.length) {
      out.push('  nothing to add. A project should mount every subject it works with, its own included; add one with --apply --add <domain> if this list misses a subject.');
    }
    for (const a of map.proposal.add) {
      out.push(`  add '${a.domain}': ${a.reason}`);
      if (!a.has_store) out.push(`    '${a.domain}' has no store yet, so adding it needs a description of which knowledge belongs in it.`);
    }
    for (const s of map.proposal.sibling_steps) {
      out.push(`  In ${s.project} (${s.path}): add ${s.add.map((t) => `'${t}'`).join(', ')}. Run /sterling:domains in that project; this run changes only the current project.`);
    }
    if (map.proposal.add.length) {
      const flags = map.proposal.add.map((a) => `--add ${a.domain}${a.has_store ? '' : ` --description "${a.domain}=<which knowledge belongs in it>"`}`).join(' ');
      out.push(`  Apply: ${applyCommand} --apply ${flags}`);
    }
  }

  out.push('', 'Limits:');
  for (const limit of map.limits) out.push(`  ${limit}`);
  return out.join('\n');
}
