// Player-facing changelog, newest version first. Nothing here is read by the game logic — it's
// purely for the Patch Notes screen (see patchNotesUi.js) and, eventually, a public changelog
// page outside the game itself — kept as a plain, append-only data file for exactly that reuse.
// Add one new entry per version bump, written as we build toward it, so by the time a version
// actually goes live its notes are already done rather than reconstructed after the fact from
// commit history. Never edit or remove an existing entry once added — this is meant to be a
// permanent, growing history, not just "whatever's newest."
export const PATCH_NOTES = [
  {
    version: "0.1.16",
    date: "2026-08-16",
    highlights: [
      "New: Assassin class — a melee knife and an Invisibility ability that fades your whole body (including eyes, mouth, and held weapon) and blinds AI enemies while it's active",
      "New: F6 spectator tool for stepping outside your own body",
      "New: Quit Game option on the main menu and the in-game pause menu, with a confirmation prompt",
      "New: a brief loading screen when a fresh single-player game or multiplayer match actually starts",
      "New: passive health regen — after 15 seconds without taking damage, you heal back up over time",
      "New: joining a multiplayer lobby now checks for a version mismatch first, so you can't accidentally end up in a match with someone on a different build",
      "New: a full military/tactical UI theme for every menu screen — gunmetal panels with clipped corners and amber HUD-style brackets, a new typeface set, and a steel-and-amber button treatment (the in-match HUD keeps its original look)",
      "New: every class now carries a pistol sidearm alongside its primary weapon — scroll the mouse wheel to switch between them",
      "New: player accounts — sign in from the main menu to track your kills, deaths, and wins across matches. Multiplayer still works without an account, just untracked",
      "New: respawning in multiplayer is now a button you press once it's ready, instead of an automatic countdown — you decide exactly when you come back in",
      "Changed: Scout now carries an SMG instead of a pistol as their primary",
      "Changed: Assault now fires 3-round bursts from a new Battle Rifle instead of the old full-auto AK-47",
      "Changed: Scout's Dash replaced with Overclock — a temporary boost to fire rate, accuracy, and recoil control on whatever weapon they're holding",
      "Changed: players and enemies now use a fully modeled character instead of the old primitive box-and-cylinder rig",
      "Changed: rock obstacles now use sculpted rock models instead of procedurally generated boulders",
      "Fixed: the knife view model was oversized and gapped",
      "Fixed: Invisibility could get stuck on and never expire in single-player",
      "Fixed: an invisible Assassin still cast a visible shadow on the ground",
      "Fixed: Recon Pulse could reveal an invisible Assassin's position",
      "Fixed: rockets could fly through obstacles without exploding",
      "Fixed: the gameplay HUD could show through on the main menu right after launching the app",
      "Fixed: everyone in a multiplayer lobby could get disconnected after sitting idle for a few minutes waiting for a match to start",
      "Fixed: exiting a single-player round to the main menu could leave dead enemies, corpses, live grenades, and ability effects sitting in view under the menu's flyover camera",
      "Fixed: a few menus (Settings, Patch Notes, Quit) could occasionally return to the wrong previous screen when opened from within another menu",
      "Fixed: pausing during a multiplayer match could freeze post-respawn invincibility and any active ability effect until you unpaused, and could get you stuck unable to ever respawn",
      "Fixed: in multiplayer, Shield Wall, Proximity Mine, and Invisibility are now verified by the server instead of trusted from your own game, closing off a way a modified client could fake them",
      "Fixed: in multiplayer, ammo, reloading, grenades, and health/damage are now tracked by the server instead of trusted from your own game, closing off more ways a modified client could cheat (infinite ammo, infinite grenades, or ignoring damage)",
      "Balance: Assassin's speed and stamina bonuses increased by 10%",
      "Balance: killing yourself now costs a kill instead of nothing",
      "The app version number moved out of the corner (hidden during gameplay) and into the pause menu",
      "Patch Notes moved from the main menu into its own corner button, next to the version badge",
      "The in-page fullscreen button is hidden in the desktop app (redundant next to the real window controls) but still available in the browser version",
    ],
  },
];
