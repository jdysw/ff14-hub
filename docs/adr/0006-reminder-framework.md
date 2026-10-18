# ADR 0006 — Reminder and delivery framework (05B)

Scope: runnable framework and generic notification placeholder text. Concrete templates, real fish
datasets, production Cron configuration and real device receipt validation remain separate work.

## Reuse and transport

The MIT `@block65/webcrypto-web-push` 2.0.0 builds RFC8291 encrypted payloads and VAPID authentication.
This was selected after checking the existing Cloudflare Workers example and API in its upstream
repository. The application retains licenses, restricts subscription endpoints to exact HTTPS browser
push provider hostnames, forbids credentials/alternate ports, follows no redirects and limits fetches
to five seconds. A real workerd crypto test builds a 4096-byte encrypted request and mocks only HTTP.
This validates local encryption/runtime compatibility, not delivery to an actual browser.

VAPID keys/contact are optional environment secrets. They are not generated, stored in the repository
or logged. Without configuration, jobs are blocked without consuming delivery retry attempts.
Only the public key is returned to an authenticated management view. Provider acceptance is distinct
from receipt/display on a device; `sent` means at least one provider accepted the request.

Subscriptions belong to the authenticated device/workspace, one per device, maximum ten per
workspace. An endpoint cannot silently move to another device or workspace. Reads expose only
subscription IDs, device IDs and active flags, never endpoints or key material. Revoked devices and
inactive subscriptions are rechecked before each send. Browser permission is requested only after
an explicit subscribe button click. Notification clicks use a fixed same-origin reminders URL;
payload-supplied URLs are ignored, text is bounded, malformed JSON has a safe fallback.

## Rules and planning

Rules target a workspace-owned manual event or an explicit region/fish ID. Up to 100 active rules
per workspace; independently revisioned PUT/delete with operation IDs reuse the existing atomic
claim/intent/result ledger algorithm. Changing/deleting a rule cancels its old job generation in the
same transaction. An existing tombstone requires its correct revision to restore.

Each planning call rotates through at most 20 rules by last-planned time. Events derive a source
fingerprint from times and revision. Fish derive it from the full versioned rule and require verified
source + verified complete rule, non-demo data, alarm preference true and caught false. Fish windows
are bounded to 72 hours; planning selects at most 50 occurrences whose reminder due times are
within the next six hours. Selection happens after applying lead time, rather than truncating the
nearest fish windows first (which would starve long-lead reminders). Fish lead time is capped at 72 hours to stay
within that prediction horizon; manual events allow seven days. Unknown/complex rules never become notifications.
Jobs have a unique key covering rule ID/revision, source fingerprint and occurrence identity. Stale
planning can create an obsolete job but cannot send it: delivery revalidates the source and rule.

Events may be entered by the user without source verification; their reminders represent that user's
explicit schedule. Planning does not attest to the real-world accuracy of a manual activity.

## Leases and delivery outcomes

At most 20 due jobs per runner call. Conditional UPDATE RETURNING grants a unique 120-second lease;
reclaim requires expiry. Every completion and per-device checkpoint checks token, state and live
lease. Old executors cannot overwrite a newer executor or cancelled job. Before each network send,
rule revision, target eligibility, source hash, module gates, fish progress and device status are read
again. Concurrent state changes after the last read cannot unsend an already dispatched request.

Per-device accepted/permanent checkpoints prevent resending those devices while another retries.
Network errors, 408, 429 and 5xx retry with bounded exponential delay (30 seconds to one hour), at
most five attempts, respecting bounded numeric Retry-After. 404/410 deactivate that endpoint only
if its subscription contents have not since changed. Other non-2xx results are permanent for that
job/device. No configured channel/device is a blocked state. Expired source windows are suppressed;
completed fish, cancelled rules and disabled modules are suppressed at dispatch. Expired final leases
become failed. The grace period ends at target end or 15 minutes after the reminder due time, whichever
comes first.

Logical jobs are unique. Physical Web Push is **at least once** after an ambiguous network timeout
or a crash between provider acceptance and DB checkpoint. A stable notification tag reduces duplicate
display but cannot guarantee exactly-once delivery. Jobs and delivery records are retained; this
framework does not implement garbage collection. A suppressed occurrence does not automatically
re-arm after disable/restore; edit/re-enable its rule to create an explicit new rule generation.

## Interface and deployment boundary

The management page/Widget supports rule CRUD, target selection, device subscription, manual bounded
reconciliation and latest 100 job/delivery records. Initial target picker is capped at 100 manual
events and 100 catalog rows. Edits survive failed saves; background polling does not replace drafts.
Cross-device rule changes are detected by polling and CAS. The existing PWA private-cache exclusions
remain intact. Scheduled handler delegates to the same planner/runner, but no remote Cron or resources
are registered. HUB-027 digest/quiet hours is deferred (P1), not silently treated as implemented.
