-- Maintained running totals, one row per account — updated incrementally when a match ends (see
-- server/stats.js's recordMatchResult), not recomputed from match_participants on every read.
-- match_participants stays exactly as-is: the permanent per-match history this table is a
-- maintained cache of, kept for future per-match features (and so these totals are always
-- reconstructable/auditable against real match history if they ever need to be).
CREATE TABLE IF NOT EXISTS player_stats (
  user_id UUID PRIMARY KEY REFERENCES neon_auth.user(id) ON DELETE CASCADE,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill from whatever match history already exists (this project already has real matches
-- recorded before this table existed) so nobody's totals silently reset to zero.
INSERT INTO player_stats (user_id, kills, deaths, wins, matches_played)
SELECT
  user_id,
  COALESCE(SUM(kills), 0),
  COALESCE(SUM(deaths), 0),
  COUNT(*) FILTER (WHERE is_winner),
  COUNT(*)
FROM match_participants
GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;
