CREATE TABLE IF NOT EXISTS records (
 user_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
 data TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,kind,id)
);
CREATE TABLE IF NOT EXISTS changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
 op_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
 patch TEXT NOT NULL, deleted INTEGER NOT NULL, UNIQUE(user_id,op_id)
);
CREATE INDEX IF NOT EXISTS changes_user_seq ON changes(user_id,seq);
CREATE INDEX IF NOT EXISTS records_user_seq ON records(user_id,seq);
-- A single INSERT transaction records idempotency, merges fields and increments server version.
CREATE TRIGGER IF NOT EXISTS apply_change AFTER INSERT ON changes BEGIN
 INSERT INTO records(user_id,kind,id,data,deleted,version,seq)
 VALUES(NEW.user_id,NEW.kind,NEW.id,NEW.patch,NEW.deleted,1,NEW.seq)
 ON CONFLICT(user_id,kind,id) DO UPDATE SET
 data=json_patch(records.data,NEW.patch),
 deleted=CASE WHEN records.deleted=1 THEN 1 ELSE NEW.deleted END,
 version=records.version+1,seq=NEW.seq;
END;
