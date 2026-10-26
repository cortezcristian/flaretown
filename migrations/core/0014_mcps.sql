-- MCP servers and secrets (task 018, SPEC-mcps).

-- Secrets: AES-GCM ciphertext, encrypted with FLARETOWN_SECRETS_KEY (Worker secret). Write-only.
CREATE TABLE secrets (
  name         TEXT PRIMARY KEY,                     -- [A-Z0-9_]
  ciphertext   TEXT NOT NULL,                        -- base64
  iv           TEXT NOT NULL,                        -- base64, 12 bytes
  key_id       TEXT NOT NULL,                        -- short hash of the key it was encrypted with
  last4        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Remote MCP servers (Streamable HTTP / SSE). Headers are templates with ${SECRET} references.
CREATE TABLE mcp_servers (
  id           TEXT PRIMARY KEY,                     -- [a-z0-9-], also the agents' server id
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  transport    TEXT NOT NULL DEFAULT 'auto' CHECK (transport IN ('auto', 'streamable-http', 'sse')),
  auth         TEXT NOT NULL DEFAULT 'none' CHECK (auth IN ('none', 'headers', 'oauth')),
  headers      TEXT NOT NULL DEFAULT '{}',           -- JSON { header: template }
  policy       TEXT NOT NULL DEFAULT 'allowed' CHECK (policy IN ('allowed', 'ask', 'off')),
  description  TEXT NOT NULL DEFAULT '',
  builtin      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Which agents have which server. Live status comes from the agent's Durable Object.
CREATE TABLE agent_mcps (
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  server_id    TEXT NOT NULL REFERENCES mcp_servers(id),
  status       TEXT NOT NULL DEFAULT 'pending',      -- last known: ready | authenticating | failed | pending
  auth_url     TEXT,
  error        TEXT,
  attached_by  TEXT NOT NULL,
  attached_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (agent_id, server_id)
);

CREATE INDEX agent_mcps_server ON agent_mcps (server_id);

-- Decisions get a kind: 'mcp_call' Decisions approve one exact MCP tool call (policy "ask").
ALTER TABLE decisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE decisions ADD COLUMN payload TEXT;           -- JSON, per kind
ALTER TABLE decisions ADD COLUMN consumed_at TEXT;       -- mcp_call: when the approved call ran

-- Cloudflare's own MCP servers (SPEC-cf-own-mcps 2).
INSERT INTO mcp_servers (id, name, url, auth, policy, description, builtin, created_at, updated_at) VALUES
  ('cloudflare-docs', 'Cloudflare Documentation', 'https://docs.mcp.cloudflare.com/mcp', 'none', 'allowed', 'Up-to-date Cloudflare reference', 1, datetime('now'), datetime('now')),
  ('cloudflare-agents-docs', 'Agents SDK docs', 'https://agents.cloudflare.com/mcp', 'none', 'allowed', 'Token-efficient Agents SDK docs search', 1, datetime('now'), datetime('now')),
  ('cloudflare-api', 'Cloudflare API', 'https://mcp.cloudflare.com/mcp', 'oauth', 'ask', 'Full Cloudflare API and docs via Code Mode (search, execute, docs)', 1, datetime('now'), datetime('now')),
  ('cloudflare-browser', 'Browser Run', 'https://browser.mcp.cloudflare.com/mcp', 'oauth', 'allowed', 'Fetch pages, markdown, screenshots', 1, datetime('now'), datetime('now')),
  ('cloudflare-containers', 'Container', 'https://containers.mcp.cloudflare.com/mcp', 'oauth', 'allowed', 'Sandbox dev environment', 1, datetime('now'), datetime('now')),
  ('cloudflare-dex', 'Digital Experience Monitoring', 'https://dex.mcp.cloudflare.com/mcp', 'oauth', 'ask', 'App health insight (Zero Trust DEX)', 1, datetime('now'), datetime('now')),
  ('cloudflare-casb', 'Cloudflare One CASB', 'https://casb.mcp.cloudflare.com/mcp', 'oauth', 'ask', 'SaaS misconfiguration findings', 1, datetime('now'), datetime('now'));
