-- Code Mode (task 012). SPEC-orchestrator 8.1, SPEC-agents (code_mode).
-- Per agent: on by default for Operators, off for the Principal and Leads.
ALTER TABLE agents ADD COLUMN code_mode INTEGER NOT NULL DEFAULT 0;
UPDATE agents SET code_mode = 1 WHERE tier = 'operator';

-- Global feature toggle. On by default; off: no agent gets exec, nothing runs on Dynamic Workers.
INSERT INTO settings (key, value) VALUES ('code_mode_enabled', 'true') ON CONFLICT (key) DO NOTHING;
