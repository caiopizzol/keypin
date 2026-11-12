CREATE TABLE signups (
  user_id TEXT PRIMARY KEY,
  github_login TEXT,
  email TEXT,
  use TEXT NOT NULL CHECK (use IN ('solo', 'team')),
  team_size TEXT CHECK (team_size IN ('2-10', '11-50', '51+')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
