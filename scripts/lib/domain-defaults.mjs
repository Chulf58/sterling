// Descriptions init ships for domains every Sterling project mounts. A domain
// store records its description at creation (store_meta 'description'), and a
// project can change it afterwards; init never rewrites an existing store's.
// Only the forced 'sterling' domain has one: every other domain needs the user's
// own description (decision projects-mount-domains-and-sibling-projects).
export const DEFAULT_DOMAIN_DESCRIPTIONS = {
  sterling:
    'Knowledge about Sterling itself: how the plugin behaves, facts about the Claude Code and OpenCode hosts, ' +
    'and workflow knowledge that applies to every project that uses Sterling.',
};
