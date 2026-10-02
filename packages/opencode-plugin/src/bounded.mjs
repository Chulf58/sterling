// A size cap for the plugin's in-process maps keyed by session: an OpenCode
// server can live for days and see thousands of sessions, so each map keeps
// only the most recently written entries.

export const SESSION_CACHE_CAP = 512;

/** Set `key` in `map` as its newest entry, then drop the oldest entries past `cap`. */
export function remember(map, key, value, cap = SESSION_CACHE_CAP) {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) map.delete(map.keys().next().value);
  return value;
}
