import { pool } from "./db.js";

// Neon Auth (Better Auth) stores sessions server-side in neon_auth.session, keyed by the same
// plain `token` value the client gets back from sign-up/sign-in (and sends as a Bearer header
// here) — a direct lookup in the same Postgres database we already have full access to, rather
// than JWT/JWKS verification. Deliberately not using Neon Auth's JWT plugin: it requires
// explicitly enabling a currently-beta dashboard feature we haven't touched, whereas this reads
// data that's already there today, confirmed by directly inspecting a real session row.
// Never throws — every caller (the HTTP stats route, and now the WebSocket create/join handlers)
// just wants a plain "who is this, if anyone" answer, and a missing/invalid token or a transient
// DB hiccup should both just mean "treat them as a guest," not crash whatever called this. A
// WebSocket message handler that let a rejected promise escape uncaught would take down the
// entire process (every connected player's relay, not just this one lookup) the same way an
// earlier version of the HTTP handler already did before that got a top-level catch — this is the
// same fix, at the source, so every future caller gets it for free instead of re-remembering it.
export async function resolveUserId(bearerToken) {
  if (!bearerToken) return null;
  try {
    const { rows } = await pool.query(
      `SELECT "userId" FROM neon_auth.session WHERE token = $1 AND "expiresAt" > now()`,
      [bearerToken]
    );
    return rows[0]?.userId ?? null;
  } catch (err) {
    console.error("resolveUserId query failed", err);
    return null;
  }
}

export function bearerTokenFromHeader(authorizationHeader) {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  return match ? match[1] : null;
}
