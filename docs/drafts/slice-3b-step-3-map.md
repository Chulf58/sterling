# Slice 3b / knowledge-delivery migration step 3 map

Phase-0 map at `66b814b` (runtime files intentionally unmodified in this phase).

## Shared state

- `scripts/hooks/lib/delivery.mjs:139-143` chooses one guard file per conductor/agent context.
- `scripts/hooks/lib/delivery.mjs:154-224` creates, reads, and atomically writes the current flat guard: `records`, `slugs`, `frontier_files`, `pointer_files`, and `gap_articles`.
- `scripts/hooks/lib/delivery.mjs:171-184` reads/writes substance eligibility using `records`/`slugs`; it has no content-class or revision distinction.
- `scripts/hooks/lib/delivery.mjs:2316-2319` derives marks by searching the final string for a record UUID. This is the rejected false-delivery path.

## Compose → cap → emit → mark

- Read/Edit H19: `h19-knowledge-delivery.mjs:203-213` renders hazards, owners, decision pointers and advisory into `payload`; `:225-312` rebuilds an inject form and caps it with `capDeliveryParts`; `:344-354` writes the stdout envelope then marks UUIDs found in `injectPayload` and writes the guard.
- Bash H19: `h19-bash-delivery.mjs:143-146` filters record ids using the shared flat guard and builds/caps a pointer block; `:160-176` derives shown ids from lines, writes stdout, then records pointer paths and gap owners. It does not currently mark record substance, and hazards travel as pointer lines.
- Dispatch staging: `h19-dispatch-staging.mjs:333-499` selects fresh records, renders/caps a payload and appends dispatch posture/return text; `:511-512` searches the composed payload for ids and appends them to `guard.records` after stdout succeeds. The posture append occurs after its cap at `:214-224`.
- H20: `h20-mechanism-axis.mjs:432-599` selects subject matches, uses a local `.slice(0, HAZARD_CAP)`, builds header/body, then `capDeliveryParts`; `:600-601` searches carriage UUIDs and marks them after `emitEnvelope` writes. The header/envelope at `:260-320` is outside the cap assembly.
- H23: `h23-output-axis.mjs:179-216` uses its independent `guard.output_axis` namespace and does not call `markDelivered`; it is not a step-3 substance marker.

## Cap and hazard helpers

- `delivery.mjs:1097-1162` defines `HAZARD_CAP`, ranks hazards only by severity, selects the cap, and renders whole trigger/right-way fields, including a count disclosure.
- `delivery.mjs:2175-2313` implements `capDeliveryParts`; it treats hazards as unbudgeted and returns strings only, so it cannot tell callers which structured parts survived. It also makes final-envelope accounting impossible where callers wrap or append afterwards.

## Required replacement boundary

The assembler must own final composition and return emitted substance/discovery identities directly. Guard persistence must consume only those returned sets after the corresponding stdout callback. This map does not change the known step-4 limitation: guard paths omit `session_id`.
