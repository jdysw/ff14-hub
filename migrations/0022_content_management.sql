-- Runtime content lifecycle; persistent tombstones survive source refreshes and deployments.
UPDATE site_admin_settings SET payload=json_set(payload,'$.siteName','私用以太之光'),revision=revision+1,updated_at=unixepoch()*1000 WHERE json_extract(payload,'$.siteName')='FF14 Hub';
CREATE TABLE IF NOT EXISTS site_game_data (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL CHECK(json_valid(payload)),revision INTEGER NOT NULL CHECK(revision>0),updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_game_data_history (
 revision INTEGER PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)),updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sync_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_content_state (
 domain TEXT NOT NULL CHECK(domain IN('navigation','calendar')),
 content_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('active','trash','deleted')),
 title TEXT NOT NULL,
 record_payload TEXT CHECK(record_payload IS NULL OR json_valid(record_payload)),
 revision INTEGER NOT NULL CHECK(revision>0),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(domain,content_id)
);
CREATE TABLE IF NOT EXISTS admin_content_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 domain TEXT NOT NULL, content_id TEXT NOT NULL, state TEXT NOT NULL,
 title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS admin_content_audit_insert AFTER INSERT ON admin_content_state
BEGIN
 INSERT INTO admin_content_audit(domain,content_id,state,title,revision,updated_at)
 VALUES(new.domain,new.content_id,new.state,new.title,new.revision,new.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS admin_content_audit_update AFTER UPDATE ON admin_content_state
BEGIN
 INSERT INTO admin_content_audit(domain,content_id,state,title,revision,updated_at)
 VALUES(new.domain,new.content_id,new.state,new.title,new.revision,new.updated_at);
END;
