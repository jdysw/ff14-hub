# Field Guide visual QA

final result: passed

## Source and normalization

- Source visual: `C:/Users/33477/.codex/generated_images/01a158fa-e7f7-7820-b2eb-3f726bde7a7e/exec-b98e6ddb-412a-4d70-b977-53efc9ad433c.png` (1487 × 1058 pixels).
- Target browser viewport: 1440 × 1024 CSS pixels, deviceScaleFactor 1, desktop homepage, no filters.
- Implementation: `.wrangler/ui-review/field-desktop-final.png` (1440 × 1024 pixels), captured in ego lite.
- Normalize the reference to 1440 × 1024 for comparison; no browser frame or device bezel. Sources are light themed; live data is necessarily different from generated illustrative content.
- Full-view comparison: `.wrangler/ui-review/field-comparison-final.jpg`, source left, implementation right.
- Focused comparison: `.wrangler/ui-review/field-detail-comparison.jpg`, source above, implementation below. Checks list hierarchy, event grouping and fishing columns at readable scale.
- Mobile evidence: `.wrangler/ui-review/field-mobile-navigation.png` (390 × 844 pixels).

## Required surfaces

- Typography: serif section headings, sans-serif product data; clear title/body/domain hierarchy, local font fallbacks, tabular countdown digits. Mobile keeps website titles readable.
- Layout: two overview columns, shared base surface and light divider, full-width directory search and three-column rows. Mobile stacks overview and uses one directory column. Six tested widths have no document overflow.
- Colors: green primary, dark grey body, subdued secondary text and pale green selection. Icons, focus and empty states follow the same roles.
- Assets: real site favicons with the existing fallback behavior; static Bootstrap Icons for controls, bundled with license. No invented reference URLs or fake favicon artwork was copied into the directory. No generated illustration is used.
- Content: existing official data, stale-source warning, real region/time horizon and complete-calendar entry preserved. User override removes fish-row status and progress, adds ticking seconds. Top counts remain.

## Comparison history

1. Initial implementation: P2 vertical spacing in fishing placed the navigation significantly below the reference. Cause: clock on a separate line and oversized rows. Changed the desktop heading/clock to one line, reduced fish rows to 43px, and event rows to 83px. Source warning and complete-calendar entry remain visible.
2. Post-fix capture `field-desktop-final.png`: overview and navigation are proportionate, three-column website rows and green filter state match the selected direction. Remaining extra height comes from required real-source warnings and functional entries; accepted rather than removing information. No unresolved P0/P1/P2 issues found.

## Interaction and evidence limits

- Existing search/filter/reset, real IndexedDB favorites and modal/session tests pass. Date/region algorithms and data contracts are unchanged.
- Fish countdown changes observed in ego lite across an actual second; negative and day/hour/minute boundary cases are unit tested.
- Generated reference data and favicons are illustrative; implementation intentionally uses real public data. This is visual/functional review, not a claim of comprehensive WCAG compliance.
- P3: font rendering can vary across operating systems; native favicon availability depends on each destination.
