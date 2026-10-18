// Reuse the existing isolated local D1/Worker/Chromium harness.
process.env['E2E_FISH']='true';
process.env['E2E_PORT'] ??= '8891';
await import('./e2e-phase04.mjs');
