# ADR 0007 — Fishcake and WebDAV sync foundation (06A)

Scope is framework-first. The management page imports/exports files and previews Hub changes;
the separate client SDK provides merge and WebDAV primitives. It does **not** yet run a production
fishcake userscript or coordinate live local/DAV/Hub replicas automatically. Release integration,
real WebDAV interoperability, full backup/deployment rehearsal and external-site storage API audit
remain for 06B. No remote resources are created.

## Compatibility and merge

`@ff14-hub/fish-sync` preserves the independent `completed`, `pinned`, `alarmFish` sets, unknown numeric
IDs and JSON extension fields. Input is capped at 1MiB, depth 30, 100,000 nodes and 5,000 IDs per set.
Integers must be safe JavaScript integers; larger identifiers should use strings in extension fields,
not be silently rounded. JSON is data only. Extension dictionaries are validated without rebuilding
them, preserving even reserved names as own data properties without changing prototypes. Serialization
is canonical by object key for stable hashes, not byte-for-byte original formatting.

Three-way merge compares a last-common baseline with local, WebDAV and Hub values for each fish/set.
Unilateral cancellation propagates false; this is not set union. First sync without a baseline requires
explicit choices for disagreeing values. Changed field revisions count as edits even when the final
boolean returned to its baseline; opposite concurrent intents then conflict. Resolutions name an explicit
replica or baseline. Unknown extension fields have local/WebDAV authority only and never enter Hub APIs.
Merge conflicts must be resolved before any caller commits the result.

The sidecar carries monotonic per-field revisions. SDK commits increment changed/touched keys;
`touchedSince` feeds later merge decisions. A legacy writer that only rewrites fish.json has no intent
log: net-zero toggles cannot be reconstructed. Do not claim these legacy writes have full causal
history. A future audited userscript adapter must record local touches through its actual storage API.

## Conditional WebDAV protocol

The SDK is browser/client-only. Credentials remain in its volatile closure; no Hub endpoint accepts
a WebDAV URL, username or password. Base URL must be HTTPS with no embedded credentials/query/hash
and must have a different origin from the Hub. Requests omit cookies, disable redirects and have a
15-second timeout. GET bodies are streamed with a 4MiB limit. CORS must expose strong ETag and permit
Authorization, If-Match, If-None-Match and Content-Type. Weak/missing tags stop writes.

Before writing user files, a random isolated probe resource verifies both create-only and stale-tag
conditions. An incompatible server can leave only a probe file; fish.json/fish.sync.json are untouched.
Every user-file write is If-Match or If-None-Match, never unconditional. This assumes a server that
continues honoring the tested HTTP semantics; it is not protection against a malicious DAV server.

Commit order: CAS a `prepared` sidecar (transaction ID, before hash/ETag/document, after document/hash,
field revisions) → CAS fish.json → CAS a `committed` sidecar retaining the previous document. A crash
before fish write resumes only if its before ETag/hash still match. A lost response after fish write
can finalize when the after hash matches. Unexpected third-party edits stop with conflict, preserving
both the pending intent and current file for manual re-merge; they are never overwritten to force
recovery. Read order sidecar→fish→sidecar detects a cooperative concurrent prepare; up to three reads.
Sidecar hashes, version, shape and JSON budget are checked. Unsupported future metadata is rejected.

This is recovery of the two DAV files, not a distributed transaction with D1/local storage. The live
three-replica coordinator must persist a client checkpoint, recover ambiguous operations and re-preview
before resuming. It is deferred instead of claiming the independent pieces already form live sync.

## Minimal Hub state and transactions

Only `{region, fishId, field, value, expectedRevision}` enters the backend. Strict schemas reject
extra fields, including nested credentials. Unknown extension JSON stays client-side. Unknown fish
IDs go to `fish_external_fields`; catalog insertion atomically promotes them into the existing FK
table without resetting booleans/revisions. Both tables share the same trigger-backed monotonic
progress sequence. Snapshots read fields, watermark, freshness and audit metadata in one D1 batch.

Import previews validate field revisions, bind the normalized intent to a 10-minute random token and
the exact region watermark, and capture undo-safe old values. Apply is an existing atomic idempotency
ledger transaction: live token + source watermark + module gates + live device + capacity → normal and
unknown fields via JSON_each → consume token → append audit → save result. A constraint error rolls
everything back. Exact retries return the original result even after token consumption. Concurrent
edits invalidate the preview, including edits of another field: conservative full-preview invalidation
is intentional. Each apply is limited to 200 fields; up to 15,000 fields per scope/region. No silent
partial import. Larger imports need a future checkpointed batch coordinator or smaller explicit input.

Rollback generates a new preview with original values and expected post-import revisions. Newer field
edits reject it. It creates new false/revision rows rather than deleting history. The browser requires
backup download and explicit confirmation before apply, preserves failed input, and publishes snapshots
monotonically by region watermark. It re-reads state after confirmed apply before announcing completion.
Audit history shows the latest 20 operations. Freshness is labeled as last Hub import, not current DAV
freshness. Client closure means the server cannot learn later DAV changes.

## Reuse decision

Reviewed `perry-mitchell/webdav-client` (MIT, browser support) and HTTP conditional-write documentation.
Its directory/Digest/XML/dependency surface is unnecessary for two fixed JSON resources, and an
application-specific prepared/committed journal is still required. No third-party DAV source was copied;
the minimal adapter uses standard Fetch/WebCrypto and reuses Zod, existing module ports and the existing
Hub idempotency ledger. This is a conscious bounded adaptation, not reimplementation of a full DAV client.
