# Third party code

`packages/fish-engine/src/index.ts` adapts the forecast-target algorithm from
[node-eorzea-weather](https://github.com/eorzea-weather/node-eorzea-weather), commit
`900314c8d0e5cef652b66f590c7e0a83f945daba`, `src/utils/calculateForecastTarget.ts`.
Copyright (c) 2018 Lily Cartelet, MIT. Full license: `third_party/eorzea-weather-LICENSE.txt`.
Changes: numeric UTC input, explicit supported range, pure function, no Date/locale/zone dependencies.
The upstream acknowledges Rogueadyn's SaintCoinach calculation.

Window enumeration, versioned adapters, API and UI integrate with this repository's existing code.
Raw game CSV and game artwork are not bundled. Public fishing catalogs contain transformed
factual records; their sources and revisions are described below. Code licensing and data
redistribution rights are separate; see [data licensing status](docs/data-sources-and-licensing.md).

The Worker uses npm `@block65/webcrypto-web-push` 2.0.0 (MIT, Copyright 2024 Block65 Pte Ltd)
for Web Push encryption/VAPID. Upstream reviewed at commit `31b7c729f7d9945e66722a95bddead85aea1c43f`:
https://github.com/block65/webcrypto-web-push. Its license is retained as
`third_party/webcrypto-web-push-LICENSE.md`. Its pinned transitive dependency `uint8array-extras` 1.6.0
(MIT, Sindre Sorhus) has its license retained as `third_party/uint8array-extras-LICENSE.txt`.
We reuse the library as a dependency and add endpoint restrictions, bounded transport, lease fencing
and private device ownership in this application rather than reimplementing the encryption protocol.
# Fishing catalog references and factual metadata

## UI icons

Homepage controls use Bootstrap Icons 1.13.2 (MIT, Copyright 2019-2024 The Bootstrap Authors),
bundled from the npm package rather than a remote script. License retained at
`third_party/bootstrap-icons-LICENSE.txt`. Source: https://github.com/twbs/icons.

## Fishing sources

The public fishing snapshots reference the MIT-licensed projects
[FF14 Fish Tracker](https://github.com/icykoneko/ff14-fish-tracker-app) and
[FFXIV Teamcraft](https://github.com/ffxiv-teamcraft/ffxiv-teamcraft).
Exact upstream revisions are recorded in `data/fishing-sources.json` and each snapshot.
Their license texts are retained under `third_party/`. Chinese game-table identities
and labels are sourced separately from thewakingsands/ffxiv-datamining-cn.
Game content remains attributable to SQUARE ENIX; no game icons, artwork, descriptive
prose, or Fishcake application source is copied as part of this change.
