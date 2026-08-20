import { el } from "./dom.js";
import { AccountClient } from "../net/accountClient.js";

const MIN_PASSWORD_LENGTH = 8;

function setError(message) {
  el.accountError.textContent = message;
  el.accountError.classList.remove("hidden");
}
function clearError() {
  el.accountError.textContent = "";
  el.accountError.classList.add("hidden");
}

// Wires the Account screen (sign in / create account / sign out / stats) — reachable from the
// landing screen via el.accountBtn, using the shared screen manager like every other overlay.
// Guest play is completely unaffected by any of this: nothing here is required to play, it only
// ever adds an account on top of the existing free-typed-name flow (see main.js's multiplayerBtn
// handler, which prefers the signed-in display name as a default but never requires one).
export function createAccountUi(ctx) {
  ctx.accountClient = new AccountClient();
  let mode = "signin"; // "signin" | "signup" — which form accountSubmitBtn currently acts as

  function updateAccountBtnLabel() {
    el.accountBtn.textContent = ctx.accountClient.signedIn ? `Account: ${ctx.accountClient.name}` : "Account";
  }

  function setMode(next) {
    mode = next;
    el.accountModeSignInBtn.classList.toggle("selected", mode === "signin");
    el.accountModeSignUpBtn.classList.toggle("selected", mode === "signup");
    el.accountDisplayNameRow.classList.toggle("hidden", mode !== "signup");
    el.accountSubmitBtn.textContent = mode === "signup" ? "Create Account" : "Sign In";
    clearError();
  }

  async function refreshStats() {
    el.accountStatsError.classList.add("hidden");
    try {
      const stats = await ctx.accountClient.fetchStats();
      el.accountStatKills.textContent = stats.kills;
      el.accountStatDeaths.textContent = stats.deaths;
      el.accountStatWins.textContent = stats.wins;
      el.accountStatKd.textContent = (stats.kills / Math.max(1, stats.deaths)).toFixed(2);
    } catch (err) {
      el.accountStatsError.textContent = err.message;
      el.accountStatsError.classList.remove("hidden");
    }
  }

  function renderAccountScreen() {
    const signedIn = ctx.accountClient.signedIn;
    el.accountSignedOut.classList.toggle("hidden", signedIn);
    el.accountSignedIn.classList.toggle("hidden", !signedIn);
    if (signedIn) {
      el.accountNameDisplay.textContent = ctx.accountClient.name;
      refreshStats();
    } else {
      setMode("signin");
      el.accountEmailInput.value = "";
      el.accountDisplayNameInput.value = "";
      el.accountPasswordInput.value = "";
    }
  }

  el.accountBtn.addEventListener("click", () => {
    clearError();
    renderAccountScreen();
    ctx.screens.showScreen(el.accountScreen);
  });

  el.accountModeSignInBtn.addEventListener("click", () => setMode("signin"));
  el.accountModeSignUpBtn.addEventListener("click", () => setMode("signup"));

  el.accountSubmitBtn.addEventListener("click", async () => {
    const email = el.accountEmailInput.value.trim();
    const password = el.accountPasswordInput.value;
    const displayName = el.accountDisplayNameInput.value.trim();

    if (!email) return setError("Enter your email.");
    if (password.length < MIN_PASSWORD_LENGTH) return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (mode === "signup" && !displayName) return setError("Choose a display name.");

    clearError();
    el.accountSubmitBtn.disabled = true;
    try {
      if (mode === "signup") await ctx.accountClient.signUp(email, password, displayName);
      else await ctx.accountClient.signIn(email, password);
      updateAccountBtnLabel();
      renderAccountScreen();
    } catch (err) {
      setError(err.message);
    } finally {
      el.accountSubmitBtn.disabled = false;
    }
  });

  el.accountRefreshStatsBtn.addEventListener("click", refreshStats);

  el.accountSignOutBtn.addEventListener("click", () => {
    ctx.accountClient.signOut();
    updateAccountBtnLabel();
    renderAccountScreen();
  });

  el.accountBackBtn.addEventListener("click", () => ctx.screens.showScreen(el.landing));

  updateAccountBtnLabel();
}
