-- Operational metadata only: no workspace content, credentials, endpoints or exception messages.
CREATE TABLE IF NOT EXISTS scheduler_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN('running','succeeded','failed','abandoned')),
  scheduled_at INTEGER NOT NULL CHECK(scheduled_at>=0),
  started_at INTEGER NOT NULL CHECK(started_at>=0),
  finished_at INTEGER,
  planned INTEGER CHECK(planned>=0),
  processed INTEGER CHECK(processed>=0),
  failure_stage TEXT CHECK(failure_stage IN('plan','deliver','finish','abandoned'))
);
CREATE INDEX IF NOT EXISTS idx_scheduler_observations_retention ON scheduler_observations(status,seq);
