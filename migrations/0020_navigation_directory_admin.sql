-- Independent owner overrides: imports never overwrite edits or revive hidden sites.
CREATE TABLE IF NOT EXISTS nav_catalog_edits (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  canonical_url TEXT NOT NULL UNIQUE,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nav_catalog_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS nav_catalog_audit_insert AFTER INSERT ON nav_catalog_edits
BEGIN
  INSERT INTO nav_catalog_audit(catalog_id,payload,hidden,revision,created_at)
  VALUES(new.id,new.payload,new.hidden,new.revision,new.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS nav_catalog_audit_update AFTER UPDATE ON nav_catalog_edits
BEGIN
  INSERT INTO nav_catalog_audit(catalog_id,payload,hidden,revision,created_at)
  VALUES(new.id,new.payload,new.hidden,new.revision,new.updated_at);
END;
