export const schemaVersion = 3

export const migrations: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id, name));
    CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, type TEXT NOT NULL, display_name TEXT NOT NULL, source TEXT NOT NULL, capabilities TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id), project_id TEXT REFERENCES projects(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL REFERENCES actors(id), fencing_token INTEGER NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(resource_type, resource_id, state));
    CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, source TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES actors(id), workspace_id TEXT, project_id TEXT, occurred_at TEXT NOT NULL, sequence INTEGER, payload TEXT NOT NULL, parent_event_id TEXT, origin_marker TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_sequence_idx ON events(sequence, event_id);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, request_id TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projection_status (projection TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
  `,
  2: `
    CREATE TABLE IF NOT EXISTS context_nodes (uri TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, sha256 TEXT NOT NULL, version INTEGER NOT NULL, provenance TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS context_nodes_scope_idx ON context_nodes(workspace_id, project_id);
  `,
  3: `
    CREATE TABLE IF NOT EXISTS context_tombstones (uri TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, deleted_at TEXT NOT NULL, deleted_by TEXT NOT NULL, commit_hash TEXT);
    CREATE INDEX IF NOT EXISTS context_tombstones_scope_idx ON context_tombstones(workspace_id, project_id);
    CREATE TABLE IF NOT EXISTS context_links (from_uri TEXT NOT NULL, to_uri TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id), cross_project INTEGER NOT NULL, PRIMARY KEY(from_uri, to_uri));
    CREATE INDEX IF NOT EXISTS context_links_target_idx ON context_links(to_uri);
    CREATE TABLE IF NOT EXISTS context_snapshots (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id), label TEXT NOT NULL, ref TEXT NOT NULL, commit_hash TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, node_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, manifest TEXT NOT NULL, UNIQUE(workspace_id, project_id, label));
  `,
}
