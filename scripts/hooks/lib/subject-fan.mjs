// The subject fan (board c10f139b, decision projects-mount-domains-and-sibling-projects):
// a store-like object over the project store plus the domains the project mounts,
// for the delivery hooks' SUBJECT matching (H20, H23, the H19 dispatch-staging
// subject arm) and the OpenCode axis, which passes its own opener.
//
// What it guarantees:
// - The domain list is config.stack_tags, with config.domain_paths overriding a
//   store path, resolved by @sterling/store's resolveDomainMounts (the resolver the
//   MCP server uses). A configured domain whose store does not exist is skipped and
//   listed on missingDomains; no domain store is ever created here.
// - A domain that cannot be opened or read is dropped and listed on
//   unreadableDomains; a config.json that does not parse mounts the project store
//   only and sets configError. The project store's delivery always survives.
// - A query with no file_keys reads every open store at the full cap, and
//   allocateShares decides how many of each store's own ranked list make the cap
//   (project first). Scores are never compared across databases.
// - A query WITH file_keys reads the project store only: a domain record's
//   file_keys name files in other repos, so they must never drive path delivery
//   here (the hazard the decision's sparring round recorded).
// - Every record returned carries source_store: 'project' or the domain name.
//   The key is not a record field (todo records already own `source`). The one
//   exception is inboundSupersedes on Postgres storage (see openRoutedSubjectFan).
// What it does NOT do: write, read board or queue state, or fan articlesBySlug
// (feature articles are project-scoped and never promote).
//
// POSTGRES STORAGE (lib/store-backend.mjs says 'routed'): the stores open through
// @sterling/store/routing as one MountedStores, and nothing is skipped or dropped.
// A missing or unreadable domain, an unreachable server or missing credentials
// throws a named error (DomainUnavailableError, StoreUnreachableError, ...)
// instead of landing on missingDomains/unreadableDomains, and the caller's
// degraded path reports it. The opener argument is not used there.
//
// Hooks bundle this module: builtins, sibling libs and @sterling/* only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, resolveDomainMounts, allocateShares, DEFAULT_QUERY_CAP, DOMAIN_DESCRIPTION_KEY } from '@sterling/store';
import { openRoutedForHook } from './broker-client.mjs';
import { loadConfig } from './common.mjs';
import { storeBackend } from './store-backend.mjs';

const defaultOpener = (dbPath) => new SterlingStore(dbPath);

/**
 * The domain mounts a raw project config declares, as [{name, dbPath}] in
 * manifest order. A null config (no config file) mounts nothing. Only stack_tags
 * and domain_paths are validated, through the config schema, so a malformed value
 * there throws instead of reading as "no domains".
 */
export function domainMountsFromConfig(config) {
  if (config === null || config === undefined) return [];
  return resolveDomainMounts(parseConfig({ stack_tags: config.stack_tags, domain_paths: config.domain_paths }));
}

const tag = (records, source) => records.map((r) => ({ ...r, source_store: source }));

const errorText = (e) => String((e && e.message) || e);

/**
 * Open the subject fan for the project at `cwd`, or null when the project has no
 * store (not Sterling-initialized; nothing is created). `opener(dbPath)` opens one
 * store and defaults to `new SterlingStore(dbPath)`.
 *
 * Failures are isolated per domain: the project store is the delivery, so a
 * domain can never take it down. A domain that fails to open (not SQLite,
 * pre-v2, locked) or whose query throws is dropped from the fan and listed on
 * unreadableDomains as {name, dbPath, error}. A config.json that does not parse,
 * or whose domain fields are malformed, mounts the project store only and sets
 * configError. Neither is silent: the caller prints fanDegradedLine. Only a
 * failure to open the PROJECT store throws.
 */
export function openSubjectFan(cwd, { opener = defaultOpener } = {}) {
  if (storeBackend(cwd) === 'routed') return openRoutedSubjectFan(cwd);
  const projectPath = join(cwd, '.sterling', 'sterling.db');
  if (!existsSync(projectPath)) return null;
  let mounts = [];
  let configError = null;
  try {
    mounts = domainMountsFromConfig(loadConfig(cwd));
  } catch (e) {
    configError = errorText(e);
  }
  const project = opener(projectPath);
  let domains = [];
  const missingDomains = [];
  const unreadableDomains = [];
  const drop = (d, e) => {
    unreadableDomains.push({ name: d.name, dbPath: d.dbPath, error: errorText(e) });
    domains = domains.filter((x) => x !== d);
    try {
      d.store.close();
    } catch {
      /* the domain is already reported unreadable; a failed close adds nothing */
    }
  };
  for (const m of mounts) {
    if (!existsSync(m.dbPath)) {
      missingDomains.push({ name: m.name, dbPath: m.dbPath });
      continue;
    }
    try {
      domains.push({ name: m.name, dbPath: m.dbPath, store: opener(m.dbPath) });
    } catch (e) {
      unreadableDomains.push({ name: m.name, dbPath: m.dbPath, error: errorText(e) });
    }
  }
  /** Run fn on each domain store; a domain whose read throws is dropped and reported. */
  const eachDomain = (fn) => {
    const out = [];
    for (const d of [...domains]) {
      try {
        out.push([d, fn(d.store)]);
      } catch (e) {
        drop(d, e);
      }
    }
    return out;
  };

  return {
    project,
    get domainNames() {
      return domains.map((d) => d.name);
    },
    missingDomains,
    unreadableDomains,
    configError,
    query(opts = {}) {
      if (opts.file_keys !== undefined || !domains.length) return tag(project.query(opts), 'project');
      const cap = opts.cap ?? DEFAULT_QUERY_CAP;
      const perStore = [['project', project.query({ ...opts, cap })], ...eachDomain((s) => s.query({ ...opts, cap })).map(([d, r]) => [d.name, r])];
      const shares = allocateShares(perStore.map(([, r]) => r.length), cap);
      return perStore.flatMap(([name, records], i) => tag(records.slice(0, shares[i]), name));
    },
    /** query() for each entry of `list`; element i is what query(list[i]) returns. */
    queryEach(list) {
      return list.map((opts) => this.query(opts));
    },
    /** Supersedes edges live with their SOURCE record, so every mount is read; first seen wins. */
    inboundSupersedes(id) {
      const seen = new Set();
      const out = [];
      const lists = [['project', project.inboundSupersedes(id)], ...eachDomain((s) => s.inboundSupersedes(id)).map(([d, r]) => [d.name, r])];
      for (const [name, records] of lists) {
        for (const r of records) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          out.push({ ...r, source_store: name });
        }
      }
      return out;
    },
    articlesBySlug(slug) {
      return project.articlesBySlug(slug);
    },
    close() {
      let first;
      for (const s of [project, ...domains.map((d) => d.store)]) {
        try {
          s.close();
        } catch (e) {
          first ??= e;
        }
      }
      if (first) throw first;
    },
  };
}

/**
 * The subject fan of a Postgres-storage project: the same surface as
 * openSubjectFan, over routed MountedStores. Never null (a routed project is a
 * Sterling project) and never degraded: missingDomains, unreadableDomains and
 * configError stay empty, because every such case throws by name instead. A
 * config that names storage 'postgres' but fails the router's checks throws
 * StoreSettingsError the same way.
 */
function openRoutedSubjectFan(cwd) {
  const { stores } = openRoutedForHook(cwd, { mount: true });
  const project = stores.project;
  return {
    project,
    get domainNames() {
      return stores.domainNames();
    },
    missingDomains: [],
    unreadableDomains: [],
    configError: null,
    query(opts = {}) {
      if (opts.file_keys !== undefined || !stores.domainNames().length) return tag(project.query(opts), 'project');
      const cap = opts.cap ?? DEFAULT_QUERY_CAP;
      const perStore = stores.bySource({ ...opts, cap });
      const shares = allocateShares(perStore.map((s) => s.records.length), cap);
      return perStore.flatMap((s, i) => tag(s.records.slice(0, shares[i]), s.source));
    },
    /** query() for each entry of `list` (element i is what query(list[i]) returns) in one
     *  store call, so a broker hook pays one round trip and one read transaction per store. */
    queryEach(list) {
      if (list.some((opts) => opts.file_keys !== undefined)) return list.map((opts) => this.query(opts));
      if (!stores.domainNames().length) return project.queryEach(list).map((records) => tag(records, 'project'));
      const capped = list.map((opts) => ({ ...opts, cap: opts.cap ?? DEFAULT_QUERY_CAP }));
      const perStore = stores.bySourceEach(capped);
      return capped.map((opts, j) => {
        const shares = allocateShares(perStore.map((s) => s.results[j].length), opts.cap);
        return perStore.flatMap((s, i) => tag(s.results[j].slice(0, shares[i]), s.source));
      });
    },
    /** MountedStores' own merge (project first, first seen wins). These records carry no
     *  source_store: MountedStores does not say which mount held each edge, and the one
     *  reader (delivery.mjs withInboundSupersedes) keeps only id, slug, title and status. */
    inboundSupersedes(id) {
      return stores.inboundSupersedes(id);
    },
    /** inboundSupersedes for each id in one store call (element i answers ids[i]). */
    inboundSupersedesEach(ids) {
      return stores.inboundSupersedesEach(ids);
    },
    articlesBySlug(slug) {
      return project.articlesBySlug(slug);
    },
    close() {
      stores.close();
    },
  };
}

/**
 * The one loud line for a degraded fan, or null when nothing degraded: the
 * config error, then every unreadable domain with its path and error. `who`
 * names the hook. Delivery from the project store is unaffected.
 */
export function fanDegradedLine(fan, who) {
  if (!fan) return null;
  const parts = [];
  if (fan.configError) parts.push(`config.json unreadable, no domains mounted (${fan.configError})`);
  for (const d of fan.unreadableDomains) parts.push(`domain '${d.name}' unreadable at ${d.dbPath} (${d.error})`);
  if (!parts.length) return null;
  return `${who}: DEGRADED subject fan: ${parts.join('; ')}. Delivering from the project store only.`;
}

/** Print fanDegradedLine on stderr. A failed write must not change the delivery outcome. */
export function warnFanDegraded(fan, who) {
  const line = fanDegradedLine(fan, who);
  if (!line) return;
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* stderr is the only channel left; the delivery still goes out */
  }
}

/**
 * Each configured domain's state for the session-start lines, in manifest order:
 * {name, dbPath, state, description?, error?} with state 'described',
 * 'undescribed' (the store exists but has no description), 'missing' (no store;
 * never created here) or 'unreadable' (the store or its description could not be
 * read; `error` says why). Throws only when the config's domain fields are malformed.
 *
 * With config.storage 'postgres' the domains are read through the router at
 * `root` (required there): a domain is 'described' or 'undescribed', and when
 * the stores cannot be opened every configured domain is 'unreadable' with the
 * named error. A Postgres domain is never 'missing' and never skipped.
 */
export function describeMountedDomains(config, { opener = defaultOpener, root } = {}) {
  if (config?.storage === 'postgres') return describeRoutedDomains(config, root);
  return domainMountsFromConfig(config).map((m) => {
    if (!existsSync(m.dbPath)) return { name: m.name, dbPath: m.dbPath, state: 'missing' };
    let store;
    try {
      store = opener(m.dbPath);
      const description = store.getMeta(DOMAIN_DESCRIPTION_KEY);
      return description ? { name: m.name, dbPath: m.dbPath, state: 'described', description } : { name: m.name, dbPath: m.dbPath, state: 'undescribed' };
    } catch (e) {
      return { name: m.name, dbPath: m.dbPath, state: 'unreadable', error: String((e && e.message) || e) };
    } finally {
      store?.close();
    }
  });
}

function describeRoutedDomains(config, root) {
  const names = domainMountsFromConfig(config).map((m) => m.name);
  if (!names.length) return [];
  if (typeof root !== 'string') throw new Error("describeMountedDomains: config.storage is 'postgres', so the project root is required to read its domains");
  let stores;
  try {
    ({ stores } = openRoutedForHook(root, { mount: true }));
  } catch (e) {
    const error = namedText(e);
    return names.map((name) => ({ name, dbPath: `postgres (domain '${name}')`, state: 'unreadable', error }));
  }
  try {
    return names.map((name) => {
      const dbPath = `postgres (domain '${name}')`;
      try {
        const description = stores.domainDescription(name);
        return description ? { name, dbPath, state: 'described', description } : { name, dbPath, state: 'undescribed' };
      } catch (e) {
        return { name, dbPath, state: 'unreadable', error: namedText(e) };
      }
    });
  } finally {
    stores.close();
  }
}

const namedText = (e) => `${e?.constructor?.name ?? e?.name ?? 'Error'}: ${errorText(e)}`;
