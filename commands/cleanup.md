---
description: Start a Sterling cleanup run — gated deletion; the anti-accretion mechanism.
---

Run the deletion-evidence script and present its output, then invoke the `cleanup` skill:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/cleanup-plan.mjs"
```

The script only reads the store. For each deletable candidate it sorts every path in the article's `files[]` into one bucket, with a reason:

- `delete`: on disk, no live article owns it, and no other file references it.
- `release`: a live article also owns it. The file stays; only this article's ownership goes.
- `absent`: not on disk. Only the store entry goes.
- `keep`: no live owner, but another file references it, or the reference check could not run. The file stays.

Present the whole deletion map for one confirmation, grouped by article and bucket with each reason; the human may strike any item from it. Only `delete` paths are deleted, and `delete_paths` lists them. Execute confirmed deletions through `node "${CLAUDE_PLUGIN_ROOT}/bin/fs-remove.mjs" <path>...` — never raw deletion, and never as a side-job inside another change. Never pass a `release`, `absent` or `keep` path to fs-remove: `release` and `absent` paths are a store edit (drop the path from that article's `files[]`), and `keep` paths are left alone.
