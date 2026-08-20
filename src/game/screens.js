import { el } from "./dom.js";

// The mutually-exclusive top-level "screens" of the app (landing, every multiplayer lobby
// screen, settings, account/sign-in, the single/multiplayer briefing menu, class-select, pause,
// end-screen, quit confirm) — previously each hand-toggled at its own call site across 7 files
// (~50 call sites),
// which is exactly how bugs like "gameplay HUD/a leftover screen shows through on the menu" kept
// recurring: nothing guaranteed any two of those call sites agreed on what "hide everything else"
// meant. `showScreen(target)` is now the one place that decides.
//
// Deliberately excludes a few elements that also carry `class="overlay"` in index.html but are
// NOT part of this mutually-exclusive set: `loadingScreen` (a fixed-duration curtain shown *over*
// whatever's underneath, with its own independent timer — folding it in here would let a
// same-tick pointer-lock grant hide it before its GAME_LOAD_MIN_MS floor elapses) and
// `rotateDevicePrompt` (re-derived from scratch, both shown and hidden, every single animate()
// frame based on orientation/touch/state — it doesn't need or want a "screen transition" to
// manage it, and folding it in would just fight that per-frame logic). Gameplay HUD sub-indicators
// (scope vignette, respawn overlay, scoreboard, etc.) are a separate concern entirely — several
// can be visible at once, so they were never a good fit for a single-active-screen model.
const SCREEN_KEYS = [
  "landing",
  "patchNotesScreen",
  "accountScreen",
  "multiplayerScreen",
  "createRoomScreen",
  "browseRoomsScreen",
  "roomScreen",
  "settingsScreen",
  "menu",
  "classSelectScreen",
  "pauseHint",
  "endScreen",
  "quitConfirmScreen",
];

export function createScreenManager() {
  const screens = SCREEN_KEYS.map((key) => el[key]);

  // Matches whatever index.html actually renders by default (only `landing` lacks the `hidden`
  // class) rather than hardcoding an assumption, so this stays correct if the markup ever changes.
  let current = screens.find((s) => !s.classList.contains("hidden")) || el.landing;

  // A real stack, not a single remembered slot — settings/quit-confirm/patch-notes are each
  // reachable from more than one place AND from each other (e.g. Settings -> Patch Notes ->
  // Back -> Settings -> Back must land on wherever Settings was originally opened from, not
  // back on Patch Notes). A single "previous" variable gets clobbered by that kind of detour;
  // pushing the outgoing screen on every switch and popping on showPreviousScreen() handles
  // arbitrary nesting correctly, the same way browser history back-navigation does.
  const history = [];

  function applyScreen(target) {
    current = target || null;
    for (const s of screens) s.classList.toggle("hidden", s !== target);
  }

  // `target` may be `null`/`undefined` to mean "hide all of them" (entering actual gameplay has
  // no screen of its own — the HUD is a separate, non-overlay concern). That's also a natural
  // point to drop the accumulated history — nothing should ever "Back" past the start of a
  // gameplay session, and it keeps the stack from growing for the whole life of the app.
  function showScreen(target) {
    if (target) {
      if (target !== current) history.push(current);
    } else {
      history.length = 0; // entering gameplay — nothing left to "Back" into
    }
    applyScreen(target);
  }

  // Deliberately calls applyScreen(), not showScreen() — going back must only *consume* a
  // history entry, never also push one (routing this through showScreen would push the screen
  // being left back onto the stack, which a later showPreviousScreen() could then incorrectly
  // pop back to, effectively "un-consuming" a Back that already happened).
  function showPreviousScreen() {
    applyScreen(history.pop() || el.landing);
  }

  return { showScreen, showPreviousScreen, current: () => current };
}
