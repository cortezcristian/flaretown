-- Decisions (task 015, SPEC-decisions 1): agents escalate calls they shouldn't make alone.
-- Decided by the human (manual) or by Clef (system_one).

CREATE TABLE decisions (
  id                  TEXT PRIMARY KEY,
  identifier          TEXT NOT NULL UNIQUE,            -- DEC-<n>
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,                   -- Markdown: What / Why / How
  task_id             TEXT REFERENCES tasks(id),
  requested_by        TEXT NOT NULL,                   -- agent id or 'human'
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by          TEXT,                            -- 'human' | 'clef' | 'clef-flash'
  decision_comment    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  decided_at          TEXT,
  -- Latest Clef evaluation, copied here for the list and the matrix (history in decision_evaluations).
  eval_model          TEXT,
  eval_recommendation TEXT,                            -- 'approve' | 'reject'
  eval_confidence     REAL,
  eval_urgency        REAL,                            -- 0..3
  eval_importance     REAL,                            -- 0..3
  eval_risk           REAL,                            -- 0..3
  eval_evidence       REAL,                            -- 0..3
  eval_error          TEXT,
  evaluated_at        TEXT
);

CREATE INDEX decisions_status ON decisions (status, created_at);
CREATE INDEX decisions_task   ON decisions (task_id);

CREATE TABLE decision_evidence (
  id           TEXT PRIMARY KEY,
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  position     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text', 'link', 'report', 'artifact', 'command')),
  label        TEXT NOT NULL,
  content      TEXT NOT NULL,
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX decision_evidence_decision ON decision_evidence (decision_id, position);

-- Every Clef run, for audit.
CREATE TABLE decision_evaluations (
  id           TEXT PRIMARY KEY,
  decision_id  TEXT NOT NULL REFERENCES decisions(id),
  model        TEXT NOT NULL,
  answers      TEXT,                                   -- JSON, Clef answers per question key
  error        TEXT,
  usage        TEXT,                                   -- JSON, when the response includes it
  outcome      TEXT,                                   -- what System One did: 'approved' | 'rejected' | 'unsure' | 'critical_risk' | 'manual'
  created_at   TEXT NOT NULL
);

CREATE INDEX decision_evaluations_decision ON decision_evaluations (decision_id, created_at);

INSERT INTO counters (name, value) VALUES ('decision', 0);

-- A task that can't go to review or close without an approved Decision.
ALTER TABLE tasks ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;

INSERT INTO settings (key, value) VALUES
  ('decisions_mode', 'manual'),
  ('decisions_model', 'clef-flash'),
  ('decisions_threshold', '0.85'),
  ('decisions_auto_reject', 'false')
ON CONFLICT (key) DO NOTHING;
