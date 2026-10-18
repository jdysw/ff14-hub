-- Region is part of every identity. Catalog updates never touch private fields.
CREATE TABLE IF NOT EXISTS fish_catalog (
  region TEXT NOT NULL CHECK(region IN ('cn','global')),
  fish_id INTEGER NOT NULL CHECK(fish_id > 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY(region,fish_id)
);
CREATE TABLE IF NOT EXISTS fish_state_fields (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL,
  fish_id INTEGER NOT NULL,
  field TEXT NOT NULL CHECK(field IN ('caught','pinned','alarm')),
  value INTEGER NOT NULL CHECK(value IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,region,fish_id,field),
  FOREIGN KEY(region,fish_id) REFERENCES fish_catalog(region,fish_id)
);
-- Separate invalidation stream, atomically read with /me/fish-progress snapshots.
CREATE TABLE IF NOT EXISTS fish_progress_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fish_changes_scope ON fish_progress_changes(workspace_id,region,seq);
CREATE TRIGGER IF NOT EXISTS fish_progress_insert AFTER INSERT ON fish_state_fields BEGIN
  INSERT INTO fish_progress_changes(workspace_id,region) VALUES(NEW.workspace_id,NEW.region);
END;
CREATE TRIGGER IF NOT EXISTS fish_progress_update AFTER UPDATE ON fish_state_fields BEGIN
  INSERT INTO fish_progress_changes(workspace_id,region) VALUES(NEW.workspace_id,NEW.region);
END;
CREATE TABLE IF NOT EXISTS fish_operations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,attempt_token TEXT,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS fish_operation_intents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,request_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,operation_id)
);
