-- Browser-owned push subscriptions, separate from owner and legacy workspace credentials.
CREATE TABLE IF NOT EXISTS local_push_devices (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, endpoint_hash TEXT NOT NULL UNIQUE,
 channel_ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 daily_limit INTEGER NOT NULL DEFAULT 5, sent_day TEXT NOT NULL DEFAULT '', sent_count INTEGER NOT NULL DEFAULT 0,
 digest_json TEXT, digest_next_at INTEGER
);
CREATE TABLE IF NOT EXISTS local_push_jobs (
 device_id TEXT NOT NULL REFERENCES local_push_devices(id) ON DELETE CASCADE,
 job_key TEXT NOT NULL, payload TEXT NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','leased','sent','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, claim_token TEXT,
 PRIMARY KEY(device_id,job_key)
);
CREATE INDEX IF NOT EXISTS local_push_due ON local_push_jobs(status,due_at);
CREATE INDEX IF NOT EXISTS local_push_digest_due ON local_push_devices(digest_next_at);
