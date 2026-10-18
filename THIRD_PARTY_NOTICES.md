# Third party code

`packages/fish-engine/src/index.ts` adapts the forecast-target algorithm from
[node-eorzea-weather](https://github.com/eorzea-weather/node-eorzea-weather), commit
`900314c8d0e5cef652b66f590c7e0a83f945daba`, `src/utils/calculateForecastTarget.ts`.
Copyright (c) 2018 Lily Cartelet, MIT. Full license: `third_party/eorzea-weather-LICENSE.txt`.
Changes: numeric UTC input, explicit supported range, pure function, no Date/locale/zone dependencies.
The upstream acknowledges Rogueadyn's SaintCoinach calculation.

Window enumeration, versioned adapters, API and UI integrate with this repository's existing code.
No game CSV, icon pack or third party fish-rule dataset is bundled. Synthetic examples are visibly
marked and unverified. Code permission and game-data provenance are recorded separately.
