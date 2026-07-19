# Knowledge export — chulf machine, 2026-07-19

**Transfer payload, machine-generated from the live stores via the §10 MCP tool surface — not a hand-maintained document.** Produced so the main project store (cuj machine) can absorb the knowledge born on the chulf machine during the retrieval-first-enforcement session (H19 build) and its board drain. Delete this directory once imported.

## Contents

Project-scoped records (from `sterling-main/.sterling/sterling.db`):

| file | type | id | what |
|---|---|---|---|
| `01-decision-retrieval-first-deliver-mechanize.json` | decision | `fe62546f` | The core fork: deliver + mechanize, no blocking gate; ladder, payload, frontier signal, guard; toothed gate deferred. Resolves the trigger of deferred decision `9950dfff` (supersede that from its home store). |
| `02-brief-retrieval-first-knowledge-delivery.json` | brief | `af0bfcd9` | The authoritative intake brief: verbatim trigger, user_stated, 7 ACs, out_of_scope, proposals (one still unconfirmed: KB sync task). |
| `03-feature-article-knowledge-delivery.json` | feature_article | `2f38ebf5` (v4) | Concept family `knowledge-delivery` — front half of the learning loop; members, intent, interactions, owning H19 files, build history. |
| `04-anti-pattern-structuredoutput-transport.json` | anti_pattern | `cc71012a` | Platform: long StructuredOutput payloads lose parameters in transport — schema-design rule for Workflow agents. |
| `05-decision-keep-h11-detach-spawn.json` | decision | `92e4bb25` | Keep H11 server-side despite the lifted MCP-hook constraint. |

Domain-scoped records (from `~/.sterling/domains/sterling/sterling.db` on the chulf machine):

| file | type | id | what |
|---|---|---|---|
| `06-research-finding-additionalcontext-docs.json` | research_finding | `da67878f` | Docs/issues research: additionalContext support documented but historically unreliable; injections accumulate, no dedup. |
| `07-research-finding-mcp-hooks-resolved.json` | research_finding | `72fa8697` | LIVE-PROBED: Pre/PostToolUse DO fire on MCP tools on CC 2.1.215, PostToolUse carries tool_response, MCP-matched injection works — **disproves `5e7d0a78` (this store); supersede it on import.** |
| `08-research-finding-rung-probe-chulf.json` | research_finding | `6045b856` | chulf-machine AC1 probe: H19 injection rung 'read' proven on CC 2.1.215. |
| `09-reference-update-procedure-chulf.json` | reference_material | `4a281791` | chulf-machine install update procedure (location points at a chulf-local file). |

## Import notes (for the receiving conductor)

- Import through the MCP tool surface (`knowledge_create` per record), never shell writes (H15). Envelope fields (`id`, `created_at`, `author`, `links`, `scope`) are provenance from the chulf stores — your server will mint fresh envelopes; keep these files as the cross-reference resolution source, since prose and `decisions_made`/`reconcile_list` reference the chulf UUIDs.
- `file_baselines` in the article are chulf-machine hashes — drop the field on import; your server recomputes at create/reconcile.
- Read-time annotations (`staleness`, `verify_before_use`) were stripped at export.
- Two records in YOUR stores are affected: `9950dfff` (superseded in effect by record 01) and `5e7d0a78` (disproven by record 07) — supersede both there.
- The domain-scoped four belong in your sterling domain store (import project-side and promote, or ingest directly — your call).
- Everything here corresponds to repo state at merge `7cbbc6d` (H19 + council transport fix + dead-finally sweep + grill-intent step 8).
