-- When a task last changed state, for "time in column" on the Kanban (task 008).
ALTER TABLE tasks ADD COLUMN state_changed_at TEXT;
UPDATE tasks SET state_changed_at = COALESCE(closed_at, updated_at);

CREATE TRIGGER tasks_state_changed AFTER UPDATE OF state ON tasks
WHEN NEW.state <> OLD.state
BEGIN
  UPDATE tasks SET state_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER tasks_state_initial AFTER INSERT ON tasks
WHEN NEW.state_changed_at IS NULL
BEGIN
  UPDATE tasks SET state_changed_at = NEW.created_at WHERE id = NEW.id;
END;
