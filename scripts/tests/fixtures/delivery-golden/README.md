Golden delivery-scenario fixtures (layer 2, board ab288113).
Each `*.json` is one scenario: `{event, payload, expected_ids, expected_absent_ids, source_incident}`.
`event` is the hook_event_name (PostToolUse/PreToolUse/Stop/UserPromptSubmit); `payload` is the stdin fragment for that event (`tool_name`, `tool_input`, ... — `tool_input.file_path` authored repo-relative).
Expectations (`expected_ids`/`expected_absent_ids`) stay in this JSON — never split out — per decision 08872881.
A SHA-256 digest over a canonical manifest of ONLY those expectations lives as a literal inside the frozen test file: editing an expectation here without re-minting that literal fails the digest pin.
`expected_ids`/`expected_absent_ids` must name `decision`/`anti_pattern` ids only — both render inline as `(knowledge_get <uuid>)` pointers; a `feature_article` id would never match because articles render by SLUG, not uuid.
