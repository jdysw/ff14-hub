process.env['E2E_SYNC_RUNTIME']='true';
process.env['E2E_SYNC']='true';
process.env['E2E_FISH']='true';
process.env['E2E_PORT']??='8896';
await import('./e2e-phase04.mjs');
