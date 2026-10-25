-- Routines: recurring work owned by an agent (task 009, SPEC-agents section 7).

CREATE TABLE routines (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner_id          TEXT NOT NULL REFERENCES agents(id),
  schedule_kind     TEXT NOT NULL CHECK (schedule_kind IN ('cron', 'interval', 'manual')),
  cron              TEXT,
  interval_minutes  INTEGER,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  prompt            TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       TEXT,
  next_run_at       TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX routines_due   ON routines (enabled, next_run_at);
CREATE INDEX routines_owner ON routines (owner_id);

CREATE TABLE routine_runs (
  id          TEXT PRIMARY KEY,
  routine_id  TEXT NOT NULL REFERENCES routines(id),
  task_id     TEXT REFERENCES tasks(id),
  status      TEXT NOT NULL CHECK (status IN ('started', 'skipped', 'failed')),
  reason      TEXT,
  trigger     TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX routine_runs_routine ON routine_runs (routine_id, at);

-- Morning standup (SPEC-agents 7.3), shipped disabled so nothing runs (or bills) until turned on.
INSERT INTO routines (id, name, owner_id, schedule_kind, cron, timezone, prompt, enabled, created_by)
VALUES (
  'morning-standup', 'Morning standup', 'principal', 'cron', '0 9 * * 1-5', 'UTC',
  'Morning standup. List the open tasks (tasks_list) grouped by the Lead that owns them, with their state and any blockers in their comments. Save it as a report on this task (reports_save) and finish with a one-paragraph summary.',
  0, 'system'
);
