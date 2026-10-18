process.env['E2E_REMINDERS']='true';
process.env['E2E_PORT'] ??= '8892';
await import('./e2e-phase04.mjs');
