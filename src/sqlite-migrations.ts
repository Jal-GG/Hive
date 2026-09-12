export const schemaVersion = 12

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
  4: `
    CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, provider TEXT NOT NULL, backend TEXT NOT NULL, executable TEXT NOT NULL, definition TEXT NOT NULL, registered_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, work_item_id TEXT, actor_id TEXT NOT NULL REFERENCES actors(id),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id),
      runtime_profile TEXT NOT NULL, backend TEXT NOT NULL, session_key TEXT NOT NULL, cwd TEXT NOT NULL,
      repo_fingerprint TEXT NOT NULL, worktree_fingerprint TEXT NOT NULL, branch TEXT NOT NULL,
      state TEXT NOT NULL, lease_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      exit_code INTEGER, exit_signal TEXT, pid INTEGER, transcript_cursor TEXT,
      imported_event_count INTEGER NOT NULL DEFAULT 0, lost_event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS runs_scope_idx ON runs(workspace_id, project_id);
    CREATE INDEX IF NOT EXISTS runs_state_idx ON runs(state, started_at);
    -- One live session key per backend: re-adopting after a restart must find exactly one row.
    CREATE UNIQUE INDEX IF NOT EXISTS runs_session_idx ON runs(backend, session_key);
    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), path TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT NOT NULL,
      base_commit TEXT, repo_fingerprint TEXT NOT NULL, worktree_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS run_worktrees_branch_idx ON run_worktrees(repo_fingerprint, branch);
    -- Events gain run and work correlation (§6.4) so a run's history is one indexed read.
    ALTER TABLE events ADD COLUMN run_id TEXT;
    ALTER TABLE events ADD COLUMN work_item_id TEXT;
    CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, sequence);
  `,
  5: `
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      issue_type TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL REFERENCES actors(id),
      assignee_actor_id TEXT REFERENCES actors(id),
      convoy_id TEXT,
      source_trigger_id TEXT,
      metadata TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS work_items_scope_idx ON work_items(workspace_id, project_id, status);
    CREATE TABLE IF NOT EXISTS work_dependencies (
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      depends_on_id TEXT NOT NULL REFERENCES work_items(id),
      type TEXT NOT NULL,
      PRIMARY KEY(work_item_id, depends_on_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      from_address TEXT NOT NULL,
      to_address TEXT,
      queue TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      delivery TEXT NOT NULL,
      thread_id TEXT,
      reply_to TEXT,
      state TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_queue_idx ON messages(queue, state, created_at);
    CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      from_actor TEXT NOT NULL REFERENCES actors(id),
      to_agent TEXT,
      cwd TEXT NOT NULL,
      summary TEXT NOT NULL,
      open_questions TEXT NOT NULL,
      files_touched TEXT NOT NULL,
      next_steps TEXT NOT NULL,
      state TEXT NOT NULL,
      owner_actor TEXT REFERENCES actors(id),
      accepted_by TEXT REFERENCES actors(id),
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS handoffs_state_idx ON handoffs(workspace_id, project_id, state, created_at);
    CREATE TABLE IF NOT EXISTS work_plans (
      work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
      body TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_by TEXT NOT NULL REFERENCES actors(id),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_plan_history (
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      revision INTEGER NOT NULL,
      body TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(work_item_id, revision)
    );
  `,
  6: `
    -- The agent identity a run belongs to (C16): interrupt mail and supervision
    -- resolve "the live session for agent X" from the run row, not from cwd guessing.
    ALTER TABLE runs ADD COLUMN agent_id TEXT;
    CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id, state);
  `,
  7: `
    -- The dispatchable fleet (§6.2): what an agent is, what it runs, what it
    -- knows, and how much it has left. Energy is the dispatcher's load signal.
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      cwd TEXT,
      skills TEXT NOT NULL,
      energy INTEGER NOT NULL,
      max_energy INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  8: `
    -- Phase 6: what was ingested, from where, and how it was parsed. The FTS
    -- table is the lexical index; sources are the change-detection truth, so
    -- the index can be wiped and rebuilt from them at any time (C12).
    CREATE TABLE IF NOT EXISTS ingest_sources (
      uri TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      parser TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ingest_sources_scope_idx ON ingest_sources(workspace_id, project_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS ingest_chunks USING fts5(
      uri UNINDEXED,
      chunk_id UNINDEXED,
      tier UNINDEXED,
      title,
      body,
      tokenize = 'porter unicode61'
    );
    -- One session per run: the durable record of who worked on what, for how
    -- long, and the deterministic summary that makes it searchable.
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT,
      agent_id TEXT,
      work_item_id TEXT,
      runtime_profile TEXT,
      branch TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      exit_signal TEXT,
      summary TEXT,
      overview TEXT,
      captured_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_scope_idx ON sessions(workspace_id, project_id, started_at);
  `,
  9: `
    -- Phase 7: the verified merge queue. Terminal states are immutable — a
    -- landed request is a record of what shipped, not a row to be edited.
    CREATE TABLE IF NOT EXISTS merge_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      work_item_id TEXT,
      run_id TEXT,
      source_branch TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      target_sha TEXT NOT NULL,
      batch_id TEXT,
      state TEXT NOT NULL,
      failure_kind TEXT,
      failure_detail TEXT,
      conflict_files TEXT,
      gate_results TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS merge_requests_state_idx ON merge_requests(workspace_id, project_id, state, created_at);
    CREATE TABLE IF NOT EXISTS merge_batches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      target_sha TEXT NOT NULL,
      merge_request_ids TEXT NOT NULL,
      state TEXT NOT NULL,
      isolation_of TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- A convoy is the WorkItem grouping that must land together; closure is a
    -- guarded transition so it happens exactly once no matter who scans.
    CREATE TABLE IF NOT EXISTS convoys (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      state TEXT NOT NULL,
      closed_by TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL
    );
  `,
  10: `
    -- Phase 7 exit gate: a protected target is approval-gated. The request is
    -- held in 'awaiting_approval' before any integration happens, so nothing is
    -- merged, gated, or pushed toward a protected branch until an approver
    -- releases it — and who released it stays on the record.
    ALTER TABLE merge_requests ADD COLUMN protected_target INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE merge_requests ADD COLUMN approved_by TEXT;
    ALTER TABLE merge_requests ADD COLUMN approved_at TEXT;
  `,
  11: `
    -- Phase 7 §6.3: the rest of the MergeRequest schema. What was asked for
    -- (source_commit), what actually shipped (merge_commit), and the claim that
    -- authorized the work (claimant + fencing token), so a merge is auditable
    -- end to end rather than only by its final state.
    ALTER TABLE merge_requests ADD COLUMN source_commit TEXT;
    ALTER TABLE merge_requests ADD COLUMN merge_commit TEXT;
    ALTER TABLE merge_requests ADD COLUMN claimed_by TEXT;
    ALTER TABLE merge_requests ADD COLUMN fencing_token INTEGER;
    ALTER TABLE merge_requests ADD COLUMN claim_expires_at TEXT;
  `,
  12: `
    -- The original table-level UNIQUE(resource_type, resource_id, state) meant a
    -- resource could hold only ONE released lease for all time, so anything
    -- leased more than once collided the second time it was released. A run is
    -- leased once (its id is the resource), so nothing noticed; a merge target is
    -- leased every pass, and the failed release left the lease active forever.
    -- The invariant actually wanted is one ACTIVE lease per resource, which is a
    -- partial index — and history stays queryable.
    PRAGMA foreign_keys = OFF;
    CREATE TABLE leases_rebuilt (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL REFERENCES actors(id),
      fencing_token INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL
    );
    INSERT INTO leases_rebuilt (id, resource_type, resource_id, owner_actor_id, fencing_token, acquired_at, expires_at, state)
      SELECT id, resource_type, resource_id, owner_actor_id, fencing_token, acquired_at, expires_at, state FROM leases;
    DROP TABLE leases;
    ALTER TABLE leases_rebuilt RENAME TO leases;
    CREATE UNIQUE INDEX leases_active_idx ON leases(resource_type, resource_id) WHERE state = 'active';
    CREATE INDEX leases_history_idx ON leases(resource_type, resource_id, fencing_token);
    PRAGMA foreign_keys = ON;
  `,
}
