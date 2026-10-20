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

## Ultrawide and motion follow-up

- 3440×1440 screenshot: `.wrangler/ui-review/ultrawide-3440.png`; content width 2560px with five columns, no overflow. 2560×1080 uses four columns; the 1440px three-column baseline remains intact.
- Expanded detail: `.wrangler/ui-review/ultrawide-overlay-3440.png`; panel 1920×1120 at (752.5,160), internal content has no horizontal overflow.
- Motion observed in ego lite: opacity advances 0 → .543 → .773 → 1; scaleX equals scaleY at each sampled frame. Entry is bounded directional translation and uniform .96 → 1 scale, not a stretched thumbnail.
- Rapid dismissal during entry starts from its current computed matrix and opacity; native modal closes once, focus returns to `.fish-glance__link`, root overflow is restored. The dashboard's left edge remains 432.5px before and after dismissal, showing scrollbar locking caused no lateral jump.
- Reduced-motion browser emulation: phase immediately `open`, zero panel animations, backdrop animation `none`, no content overflow. Mobile 320/390px and desktop 1440/2560/3440px tested.
- Added lifecycle regressions for interrupted transitions, stale callbacks after unmount, reduced motion, and geometry limits. Total frontend suite: 422 passing tests; build/typecheck and scoped ESLint pass.
- No unresolved P0/P1/P2 findings in this follow-up. Static screenshots demonstrate layout; actual animation interpolation and interrupt behavior were additionally observed through live browser state.
