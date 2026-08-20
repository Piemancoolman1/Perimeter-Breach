import { pool } from "./db.js";

// Read straight from the maintained player_stats row (see recordMatchResult below) rather than
// aggregating match_participants — that table stays the full per-match history, this is just its
// running-totals cache. A player with no row yet (never finished a match) reads as all zeros.
export async function getStatsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT kills, deaths, wins, matches_played FROM player_stats WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || { kills: 0, deaths: 0, wins: 0, matches_played: 0 };
}

// Called once by the server when it declares a match over (see index.js's finalizeMatch) — never
// by a client. `participants` is [{ userId, kills, deaths, isWinner }, ...] for whichever players
// in the room actually resolved to a real account; guests play normally but leave no row here.
// A match with zero authenticated participants writes nothing at all.
//
// Everything below runs in one transaction: the match record, its per-match participant rows,
// and each participant's running totals all commit together, so player_stats can never drift out
// of sync with the match_participants history it's a cache of.
export async function recordMatchResult({ mapId, mode, startedAt, participants }) {
  if (participants.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO matches (map_id, mode, started_at, ended_at) VALUES ($1, $2, $3, now()) RETURNING id`,
      [mapId, mode, startedAt]
    );
    const matchId = rows[0].id;

    for (const p of participants) {
      await client.query(
        `INSERT INTO match_participants (match_id, user_id, kills, deaths, is_winner) VALUES ($1, $2, $3, $4, $5)`,
        [matchId, p.userId, p.kills, p.deaths, p.isWinner]
      );
      await client.query(
        `INSERT INTO player_stats (user_id, kills, deaths, wins, matches_played, updated_at)
         VALUES ($1, $2, $3, $4, 1, now())
         ON CONFLICT (user_id) DO UPDATE SET
           kills = player_stats.kills + EXCLUDED.kills,
           deaths = player_stats.deaths + EXCLUDED.deaths,
           wins = player_stats.wins + EXCLUDED.wins,
           matches_played = player_stats.matches_played + 1,
           updated_at = now()`,
        [p.userId, p.kills, p.deaths, p.isWinner ? 1 : 0]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
