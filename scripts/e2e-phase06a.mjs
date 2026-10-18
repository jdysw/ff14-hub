process.env['E2E_SYNC']='true';
process.env['E2E_FISH']='true';
process.env['E2E_PORT'] ??= '8894';
await import('./e2e-phase04.mjs');
