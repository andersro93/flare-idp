-- First-run state for the instance. A single row (id = 1) records whether the
-- initial admin has been created. Written by /api/setup in Phase 1.
CREATE TABLE app_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete')),
  owner_user_id TEXT,
  owner_email TEXT,
  completed_at INTEGER
);
INSERT INTO app_installation (id, status) VALUES (1, 'pending');
