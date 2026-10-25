-- Agents, settings and task artifacts (task 004). SPEC-agents sections 1, 2, 5; SPEC-orchestrator 6.6.

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  tier        TEXT NOT NULL CHECK (tier IN ('principal', 'lead', 'operator')),
  parent_id   TEXT REFERENCES agents(id),
  area        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  retired_at  TEXT
);

CREATE INDEX agents_parent ON agents (parent_id);
CREATE INDEX agents_tier   ON agents (tier, status);

-- The Principal always exists and can never be retired.
INSERT INTO agents (id, name, tier, parent_id, area, created_by)
VALUES ('principal', 'Principal', 'principal', NULL, 'In charge of the whole instance', 'system');

INSERT INTO counters (name, value) VALUES ('agent', 0);

-- Instance settings (key/value). Orchestrator settings: SPEC-orchestrator 6.6.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('orchestrator_enabled', 'false'),
  ('orchestrator_poll_interval_s', '300'),
  ('orchestrator_max_concurrent_per_agent', '1'),
  ('orchestrator_stall_timeout_min', '10'),
  ('timezone', 'UTC');

-- Deliverables agents save on a task (reports). Content lives in R2 (ARTIFACTS).
CREATE TABLE task_artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  agent_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX task_artifacts_task ON task_artifacts (task_id, created_at);
