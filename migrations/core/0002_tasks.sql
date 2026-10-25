-- Tasks core (task 003). SPEC-orchestrator 4.2, 4.3; SPEC-agents section 3.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  repo_url    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The Default project always exists and cannot be deleted (SPEC-sections-view 2.1).
INSERT INTO projects (id, name) VALUES ('default', 'Default');

-- Sequential counters (task identifiers FT-1, FT-2, ...). D1 runs one query at a time,
-- so UPDATE ... RETURNING is atomic.
CREATE TABLE counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('task', 0);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  identifier   TEXT NOT NULL UNIQUE,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  parent_id    TEXT REFERENCES tasks(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'todo'
               CHECK (state IN ('todo', 'in_progress', 'review', 'done', 'cancelled')),
  priority     INTEGER,
  assignee     TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at    TEXT
);

CREATE INDEX tasks_state      ON tasks (state);
CREATE INDEX tasks_project    ON tasks (project_id);
CREATE INDEX tasks_assignee   ON tasks (assignee);
CREATE INDEX tasks_updated_at ON tasks (updated_at);
CREATE INDEX tasks_parent     ON tasks (parent_id);

CREATE TABLE task_criteria (
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  checked     INTEGER NOT NULL DEFAULT 0,
  checked_by  TEXT,
  checked_at  TEXT,
  PRIMARY KEY (task_id, position)
);

CREATE TABLE task_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX task_comments_task ON task_comments (task_id, created_at);
