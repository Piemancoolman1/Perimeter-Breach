-- Our own tables, additive on top of Neon Auth's `neon_auth.user` (id uuid, already provisioned —
-- see the accounts+stats plan). Kept intentionally minimal for now: kills/deaths/wins only.
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES neon_auth.user(id) ON DELETE CASCADE,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (match_id, user_id)
);

-- Every read this phase does (GET /stats/me) filters by user_id across all their matches.
CREATE INDEX IF NOT EXISTS idx_match_participants_user_id ON match_participants (user_id);
