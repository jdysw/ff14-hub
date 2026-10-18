CREATE TABLE IF NOT EXISTS reminder_rules (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,region TEXT NOT NULL CHECK(region IN ('cn','global')),
  kind TEXT NOT NULL CHECK(kind IN ('event','fish')),target_id TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL CHECK(lead_minutes BETWEEN 0 AND 10080),
  enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),
  revision INTEGER NOT NULL CHECK(revision>0),updated_at INTEGER NOT NULL,last_planned_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS reminder_operations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,attempt_token TEXT,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS reminder_operation_intents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,request_fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,rule_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,occurrence_key TEXT NOT NULL,
  starts_at INTEGER NOT NULL,due_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN('queued','leased','retry','sent','suppressed','blocked','failed','cancelled')),
  reason TEXT,attempts INTEGER NOT NULL DEFAULT 0,claim_token TEXT,lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  dedup_key TEXT NOT NULL,UNIQUE(workspace_id,dedup_key),
  FOREIGN KEY(workspace_id,rule_id) REFERENCES reminder_rules(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON notification_jobs(status,next_attempt_at,lease_until);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_scope_id ON devices(workspace_id,id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL,device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,subscription_json TEXT NOT NULL CHECK(json_valid(subscription_json)),
  active INTEGER NOT NULL CHECK(active IN(0,1)),updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id,device_id),
  FOREIGN KEY(workspace_id,device_id) REFERENCES devices(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('accepted','temporary','permanent')),
  http_status INTEGER,attempted_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,subscription_id)
);
