-- Artifacts repos per agent + retention (task 011, SPEC-agents 5.1, 5.1.1).

ALTER TABLE agents ADD COLUMN artifact_repo TEXT;

-- Reports now live in the agent's repo (repo + path + commit). Old rows keep their r2_key.
ALTER TABLE task_artifacts ADD COLUMN repo TEXT;
ALTER TABLE task_artifacts ADD COLUMN path TEXT;
ALTER TABLE task_artifacts ADD COLUMN commit_hash TEXT;

-- Retention per task: NULL = default (routine runs 14 d, regular 30 d, cancelled 7 d after close).
ALTER TABLE tasks ADD COLUMN artifact_retention_days INTEGER;
ALTER TABLE tasks ADD COLUMN artifacts_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN artifacts_deleted_at TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES ('artifacts_last_retention_at', '');
