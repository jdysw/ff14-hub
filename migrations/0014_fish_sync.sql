-- Unknown IDs must survive before the catalog has caught up. Known IDs retain the original FK.
CREATE TABLE IF NOT EXISTS fish_external_fields (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL CHECK(region IN('cn','global')),fish_id INTEGER NOT NULL CHECK(fish_id>0),
  field TEXT NOT NULL CHECK(field IN('caught','pinned','alarm')),value INTEGER NOT NULL CHECK(value IN(0,1)),
  revision INTEGER NOT NULL CHECK(revision>0),updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,region,fish_id,field)
);
CREATE TRIGGER IF NOT EXISTS external_fish_insert AFTER INSERT ON fish_external_fields BEGIN
  INSERT INTO fish_progress_changes(workspace_id,region) VALUES(NEW.workspace_id,NEW.region);
END;
CREATE TRIGGER IF NOT EXISTS external_fish_update AFTER UPDATE ON fish_external_fields BEGIN
  INSERT INTO fish_progress_changes(workspace_id,region) VALUES(NEW.workspace_id,NEW.region);
END;
CREATE TRIGGER IF NOT EXISTS promote_external_fish AFTER INSERT ON fish_catalog BEGIN
  INSERT INTO fish_state_fields(workspace_id,region,fish_id,field,value,revision,updated_at)
    SELECT workspace_id,region,fish_id,field,value,revision,updated_at FROM fish_external_fields
    WHERE region=NEW.region AND fish_id=NEW.fish_id ON CONFLICT(workspace_id,region,fish_id,field) DO NOTHING;
  DELETE FROM fish_external_fields WHERE region=NEW.region AND fish_id=NEW.fish_id;
END;
CREATE TABLE IF NOT EXISTS fish_sync_previews (
  token TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL,base_watermark INTEGER NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,
  backup_json TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_preview_scope ON fish_sync_previews(workspace_id,expires_at);
CREATE TABLE IF NOT EXISTS fish_sync_audit (
  id TEXT PRIMARY KEY NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL,operation_id TEXT NOT NULL,changes_json TEXT NOT NULL,backup_json TEXT NOT NULL,created_at INTEGER NOT NULL,
  UNIQUE(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS fish_sync_operations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,attempt_token TEXT,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS fish_sync_operation_intents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,request_fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,operation_id)
);
