# Knowledge export — chulf machine, 2026-07-26

**Transfer payload, assembled from the live stores via the §10 MCP tool surface.** Note honestly: assembled BY HAND (the conductor copying `knowledge_get` output), not by a script — there is no `scripts/knowledge-export.mjs` yet. The 2026-07-19 payload claimed to be "machine-generated"; that was never true of either payload, and record `07` records the gap. Treat the JSON as high-fidelity but not mechanically guaranteed. Produced so the main project store (cuj machine) can absorb the knowledge born on the chulf machine during the agent tool-grant session: fixing the MCP prefix / ToolSearch defect carried in `TODO-agent-tool-prefix.md`, adopting the `librarian` and `debugger` agents from the Comsoft project, and the post-hoc six-hats council (`wf_0d90ab18-436`) that reviewed both. Delete this directory once imported.

Corresponding code: branch `feat/agent-tool-grants-and-conductor-direct-agents`, commit `c176b6f`.

## Contents

Project-scoped records (from `sterling-main/.sterling/sterling.db`):

| file | type | id | what |
|---|---|---|---|
| `01-decision-dual-prefix-toolsearch.json` | decision | `b4388c11` | Agent templates declare BOTH MCP prefixes + `ToolSearch`. The correct prefix is a function of the LAUNCHER, not the install, and init generates both launchers — so no baked value is right. **Supersedes in effect `097851ed` (single-prefix mandate) — supersede that explicitly in your store.** |
| `02-decision-conductor-direct-agent-class.json` | decision | `87f5f982` | Adopt `librarian` + `debugger` as a marked `conductor_direct` class; roster 9 → 11. The class marking is LOAD-BEARING (registry → `AGENT_CLASS` → `PIPELINE_AGENT_TYPES` → H8), replacing a regression where H8 slice-guarded the new agents. |
| `03-decision-h14-scope-discipline-not-sandbox.json` | decision | `4be0a159` | H14 enforces scope discipline, NOT code-execution containment — stated honestly in the hook header rather than tightened, because no tightening can work. |
| `06-feature-article-agent-distribution.json` | feature_article | `3882375a` (v4) | Owning article `agent-distribution` — templates, install/sync, the two agent classes, the tool-grant surface, 8 ACs. Supersedes `0d6a375a`, `5696152c`, `0104f166` (all born this session; only the head matters). |
| `07-feature-article-knowledge-transfer-export.json` | feature_article | `6e12c43e` | Owning article `knowledge-transfer-export` — **the convention this very directory follows**, written down for the first time: the seven export rules, plus the standing gap that no export script exists. Import this one first if you ever intend to send a payload back. |

Domain-scoped records (from `~/.sterling/domains/sterling/sterling.db` on the chulf machine):

| file | type | id | what |
|---|---|---|---|
| `04-research-finding-mcp-prefix-launcher-dependent.json` | research_finding | `34a03611` | LIVE-PROBED (CC 2.1.220): `--plugin-dir` alone mounts only `mcp__plugin_sterling_sterling__*`; `--strict-mcp-config` mounts only `mcp__sterling__*`. Both may be declared; the unmounted one is ignored. Store tools are served DEFERRED — without `ToolSearch` the right prefix is still uncallable. |
| `05-research-finding-h14-not-a-sandbox.json` | research_finding | `08893fc0` | LIVE-PROBED: `node --test <file.mjs>` executes the file's top-level code even with no tests in it, and the shipped node adapter declares `test: "node --test"` — so arbitrary execution is allowlisted in every Sterling node project by default. Security-relevant; read before designing anything that leans on H14. |

## Import notes (for the receiving conductor)

- Import through the MCP tool surface (`knowledge_create` per record), never shell writes (H15). Envelope fields (`id`, `created_at`, `author`, `links`, `scope`) are provenance from the chulf stores — your server mints fresh envelopes; keep these files as the cross-reference resolution source, since the prose references the chulf UUIDs throughout.
- `file_baselines` was stripped from the article (`_export_note` records this) — your server recomputes at create/reconcile.
- Read-time annotations (`staleness`, `verify_before_use`) were stripped at export.
- **One record in YOUR store is affected:** `097851ed` — the single-prefix mandate. It was not *wrong*, it was mode-incomplete: correct under the plugin launcher, silently dead under `--strict-mcp-config`. Supersede it with record 01. This is the last outstanding item from the session (tracked there as board `2b66c2ae`).
- The article supersedes three earlier versions of itself (`0d6a375a`, `5696152c`, `0104f166`). Those never left this machine — import only the head (`3882375a`); the chain is listed purely so the `links` array reads honestly.
- The two domain-scoped findings belong in your sterling domain store (import project-side and promote, or ingest directly — your call). `34a03611` is `volatility_hint: fast` — re-probe on any Claude Code upgrade.
- **Read `05` before touching H14 or writing any agent that relies on Bash restriction.** It corrects a claim made earlier in the same session (that Comsoft's `probe: "node"` opened the hole — it did not; the default `node --test` prefix already had).

## Caveat on what is NOT here

This is the knowledge *born* this session, not a full store dump. The chulf store is sparser than the cuj store generally, and two things were deliberately left out of the accompanying code push for the same reason: `CLAUDE.md` (machine-local backup path) and `architecture.md` (a projection of a per-machine store — the chulf copy is 53 lines against the repo's 65, so pushing it would have regressed it). That projection-vs-per-machine-store tension is unresolved and worth a decision of its own.
