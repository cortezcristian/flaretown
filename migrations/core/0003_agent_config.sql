-- Per-agent settings shown in the chat Config panel (SPEC-ui 5.3).
CREATE TABLE agent_config (
  agent_id         TEXT PRIMARY KEY,
  model            TEXT NOT NULL,
  response_format  TEXT NOT NULL DEFAULT 'markdown' CHECK (response_format IN ('markdown', 'plain')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
