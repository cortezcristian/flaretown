-- Skills (task 017, SPEC-skills): a library of Agent Skills and which agents get them.
-- Library files live in R2 (ARTIFACTS) under skills/<name>/; bundled skills ship in the Worker.

CREATE TABLE skills (
  name          TEXT PRIMARY KEY,                     -- [a-z0-9-], from SKILL.md frontmatter
  description   TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('bundled', 'github', 'upload', 'paste')),
  source_url    TEXT,                                 -- GitHub folder URL for imports
  source_ref    TEXT,                                 -- branch or tag it was imported from
  license       TEXT,                                 -- frontmatter license or "see LICENSE"
  version       TEXT,
  size          INTEGER NOT NULL DEFAULT 0,           -- bytes, all files
  files         TEXT NOT NULL DEFAULT '[]',           -- JSON [{ path, size }], SKILL.md included
  all_agents    INTEGER NOT NULL DEFAULT 0,           -- 1 = every agent gets it
  installed_by  TEXT NOT NULL,
  installed_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE agent_skills (
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  skill_name  TEXT NOT NULL REFERENCES skills(name),
  added_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_name)
);

CREATE INDEX agent_skills_skill ON agent_skills (skill_name);

-- run_skill_script (experimental): off by default.
INSERT INTO settings (key, value) VALUES ('skills_scripts_enabled', 'false') ON CONFLICT (key) DO NOTHING;
