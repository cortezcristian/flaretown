-- Per-agent compaction threshold (task 006). NULL = default: 70% of the model's context window.
ALTER TABLE agent_config ADD COLUMN compact_after_tokens INTEGER;
