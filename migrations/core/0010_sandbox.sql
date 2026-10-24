-- Sandbox per agent (task 013). SPEC-sandbox.
-- Per agent: all off by default. sandbox_last_used_at NULL = no container running.
ALTER TABLE agents ADD COLUMN sandbox_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN sandbox_internet INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN sandbox_persist INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN sandbox_last_used_at TEXT;

-- Global switch (off by default: containers are billable) and max running sandboxes per tier.
INSERT INTO settings (key, value) VALUES
  ('sandbox_global_enabled', 'false'),
  ('sandbox_max_principal', '1'),
  ('sandbox_max_leads', '2'),
  ('sandbox_max_operators', '3')
ON CONFLICT (key) DO NOTHING;
