// Thin wrapper around Neon Auth's plain REST endpoints (confirmed working directly against the
// real service during the accounts+stats plan's Phase 1/2 verification) and this project's own
// stats API — matches LobbyClient's style (a plain class wrapping a platform/service primitive)
// rather than pulling in an auth SDK. Sign-in is by email (Neon Auth doesn't support a separate
// username-login plugin); `user.name` is the chosen display name shown everywhere in-game instead.
const AUTH_BASE_URL = import.meta.env.VITE_NEON_AUTH_BASE_URL;
const API_BASE_URL = import.meta.env.VITE_API_URL;

const TOKEN_KEY = "perimeterBreach.accountToken";
const NAME_KEY = "perimeterBreach.accountName";

function readStorage(key) {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}
function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage unavailable — session just won't persist across reloads */
  }
}

export class AccountClient {
  constructor() {
    this.token = readStorage(TOKEN_KEY);
    this.name = readStorage(NAME_KEY);
  }

  get signedIn() {
    return !!this.token;
  }

  async signUp(email, password, displayName) {
    const res = await fetch(`${AUTH_BASE_URL}/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: displayName }),
    });
    return this._applyAuthResponse(res);
  }

  async signIn(email, password) {
    const res = await fetch(`${AUTH_BASE_URL}/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return this._applyAuthResponse(res);
  }

  async _applyAuthResponse(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Something went wrong.");
    this.token = data.token;
    this.name = data.user?.name ?? null;
    writeStorage(TOKEN_KEY, this.token);
    writeStorage(NAME_KEY, this.name);
    return data.user;
  }

  signOut() {
    this.token = null;
    this.name = null;
    writeStorage(TOKEN_KEY, null);
    writeStorage(NAME_KEY, null);
  }

  // { kills, deaths, wins, matches_played } — see server/stats.js. Throws if not signed in or the
  // request fails; callers are expected to only call this while this.signedIn is true.
  async fetchStats() {
    const res = await fetch(`${API_BASE_URL}/stats/me`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load stats.");
    return data;
  }
}
