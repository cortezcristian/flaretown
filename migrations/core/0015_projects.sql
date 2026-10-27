-- Projects section (task 019): description, owner Lead, archive.
ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN owner_id    TEXT REFERENCES agents(id);  -- optional Lead that owns it
ALTER TABLE projects ADD COLUMN status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'));
ALTER TABLE projects ADD COLUMN created_by  TEXT NOT NULL DEFAULT 'human';
ALTER TABLE projects ADD COLUMN updated_at  TEXT;

UPDATE projects SET updated_at = created_at;
UPDATE projects SET description = 'Tasks that don''t belong to a specific project.' WHERE id = 'default' AND description = '';
