# ADR 0005 — Phase 05A fishing foundation

Status: implemented, dataset coverage and historical validation incomplete.

Scope update from the user: deliver the runnable framework and explicit sample placeholders first.
Concrete template content and real datasets will be developed separately. Deferred content is not
a failure of this framework milestone and is not represented as completed game functionality.

## Reuse

The forecast target is adapted from the MIT node-eorzea-weather implementation at
`900314c8d0e5cef652b66f590c7e0a83f945daba`. Its original license and attribution are retained.
The large tracker/Teamcraft applications were used as schema references; their UI frameworks
are not imported. See `phase05a-reuse-research.md` and `THIRD_PARTY_NOTICES.md`.

## Rules and intervals

`packages/fish-engine` is a pure UTC-in/UTC-out package. One ET hour is 175 earth seconds;
one weather period is eight ET hours. Supported UTC range is Unix epoch through 2100-01-01.
Weather rates must sum to 100. Region, fish ID and rule version are explicit.
Intervals are half-open; midnight crossings are supported. A result includes the full canonical
weather-period/time-window intersection, even if the query starts inside it. Occurrence identity
therefore survives query clipping. Adjacent weather periods remain distinct occurrences.
The API caps queries at 168 earth hours, 50 fish and 5,000 returned intervals. Callers should
query a selected ID set; the UI computes only its current 30-record page.

Additional mechanisms are structured requirements. An intuition/predator/bait/folklore/fish-eyes
condition makes the result incomplete and candidate-only until a future evaluator can prove it.
Unverified rules are also candidate-only. A passing synthetic test does not verify a real fish rule.

## Data boundaries

Catalog primary key is `(region, fish_id)`. Each normalized record embeds source URL, exact
source version, fetched time, authorization state and verification state. Offline import validates
the complete versioned bundle before writing, commits batches of 50, and never deletes catalog
identities or private progress. An interrupted multi-batch import can leave mixed source versions;
rerun the same bundle to converge. Each row still describes its own version honestly.
The CLI emits SQL after the same Zod schema check used by the Worker. There is no public catalog
write endpoint or runtime scraper.

The bundled sample is one **synthetic** fish per region, not actual game data. Normal/big/legendary
fish are supported by the model but a complete game catalog is not supplied. No real historical
fish-window cases have been independently verified. HUB-013 data coverage and HUB-019 historical
validation remain partial. Code licensing and data authorization are separate facts.

## Progress and synchronization

`caught`, `pinned`, `alarm` are independently revisioned boolean rows. False is a real update,
not absence or a union operation. Identity includes workspace, region, fish and field. The existing
idempotency ledger algorithm is reused with a separate pair of tables. A claim, the exact intent,
field mutation, module gate check and result commit in one D1 batch. Stale field revisions conflict.
Disable/uninstall retain user progress; platform lifecycle handles widget cleanup and task fences.

Progress uses a separate monotonic `fish_progress_changes` sequence rather than changing the
phase-04 journal's closed enum. Insert/update triggers run in the same transaction. GET progress
reads rows and its region/workspace watermark in one batch. The UI polls every 30 seconds and on
focus, and discards older responses. It never replays historical deletes onto current snapshots.
Catalog/window data are public and separately refreshed; they are not an atomic snapshot with
private progress. A token change remounts the session tree; unmounted async requests cannot publish.
PWA caching remains default-deny for Authorization and `/me` responses.

## Delivery limits

This phase stores an alarm preference only. Reminder scheduling, Cron, Web Push and WebDAV
remain for 05B/06. No remote infrastructure or deployment is part of this change.
Sonar-only cleanup is explicitly deferred by the user; functional checks remain mandatory.
