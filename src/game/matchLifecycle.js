import * as THREE from "three";
import { el } from "./dom.js";
import { EYE_HEIGHT, STAMINA_MAX } from "./player.js";
import { Enemy, randomSpawnPoint } from "./entities.js";
import { sharedHumanoidParts, buildHumanoidBody, breakApartHumanoid } from "./humanoidParts.js";
import { RemotePlayer } from "./remotePlayer.js";
import { GRENADE_DEF, WEAPON_DEFS, CLASSES } from "./weaponDefs.js";
import { Rocket } from "./projectiles.js";
import { DEFAULT_MAP_ID } from "./world.js";
import { formatGrenadeCount } from "./hud.js";
import { MINE_BLAST_RADIUS } from "./abilities.js";
import { RESPAWN_DELAY, INVINCIBLE_DURATION, ABILITY_DURATIONS } from "../../shared/abilityConstants.js";

// Single-player reset/respawn, the whole multiplayer match lifecycle (start/spawn/damage/
// respawn/elim/end/disconnect), and the network relay handler that ties incoming peer
// messages back into all of it. This is the most heavily cross-cutting module in the split —
// it calls into combat (explodeVisualOnly), abilities (clearAllAbilityEffects, mine/shield
// relay handlers), hud (gameplay UI + scoreboard), lobbyUi (screen transitions), and vfx
// (tracer/spark echoes for a peer's shot) — always through `ctx`, never a captured reference,
// since every one of those modules is constructed after this one in main.js.
export function createMatchLifecycle(ctx) {
  function spawnEnemy() {
    const { x, z } = randomSpawnPoint(14);
    ctx.enemies.push(new Enemy(ctx.scene, x, z));
  }

  // Shared by single-player reset and multiplayer match start/respawn — everything about
  // the local player's own state that has nothing to do with AI enemies or the kill counter.
  function resetPlayerState(x, z, y = 1.7) {
    // Applied before health/stamina below are reset to their caps, since which class is
    // equipped determines what those caps actually are (see Player.applyClassModifiers) —
    // every class but Assassin passes no overrides here and gets the same 1/1/1 baseline
    // every class shared until Assassin needed to diverge from it.
    const cls = CLASSES.find((c) => c.id === ctx.selectedClassId);
    ctx.player.applyClassModifiers(cls);

    ctx.player.health = ctx.player.maxHealth;
    ctx.player.velocity.set(0, 0, 0);
    ctx.player.onGround = true;
    ctx.player.jumpsUsed = 0;
    ctx.camera.position.set(x, y, z);
    ctx.camera.rotation.set(0, 0, 0);
    ctx.fovKick = 0;
    ctx.aimHeld = false;
    ctx.input.crouch = false; // otherwise a toggle-crouch left on could spawn/respawn the player stuck crouched
    ctx.player.crouching = false;
    ctx.player.eyeHeight = EYE_HEIGHT; // reset instantly (no lerp) so respawn doesn't visibly crouch-transition from wherever it last was
    ctx.player.stamina = STAMINA_MAX * ctx.player.staminaMult;
    ctx.player.staminaLocked = false;
    ctx.leftMouseHeld = false;
    ctx.burstShotsQueued = 0; // a fresh life starts clean, not mid-burst from whatever the last one was doing
    ctx.burstCooldownRemaining = 0;
    ctx.controls.pointerSpeed = ctx.settings.lookSensitivity;
    el.scopeVignette.classList.add("hidden");

    ctx.loadout.reset();
    ctx.combat.stopHoldingGrenade();

    ctx.grenadeCount = ctx.INFINITE_GRENADES ? Infinity : GRENADE_DEF.count;
    ctx.grenadeCooldown = 0;
    ctx.abilityCooldownUntil = 0; // fresh life, ability immediately available again — matches the full-ammo reset above
    ctx.invisibleUntil = 0; // fresh life starts visible regardless of how the last one ended
    ctx.overclockUntil = 0; // fresh life, no leftover buff from the last one
    el.grenadeCount.textContent = formatGrenadeCount(ctx.grenadeCount);
    for (const g of ctx.grenades) g.destroy();
    ctx.grenades.length = 0;
    for (const r of ctx.rockets) r.destroy();
    ctx.rockets.length = 0;
  }

  // Every gameplay-only Three.js object that isn't the base map/world itself, torn down in one
  // place — shared by startSession() below and endSession() further down. Previously five
  // different "leave/end a match" code paths each cleared a different subset of this (see the
  // gap-matrix in the menu/gameplay-separation plan this replaces); this is what makes it
  // structurally impossible for a leftover corpse/grenade/shield/enemy to still be sitting in
  // the scene under the menu's flyover camera after any of them.
  function clearGameplayObjects() {
    for (const e of ctx.enemies) e.die(ctx.scene);
    ctx.enemies.length = 0;
    ctx.pendingSpawns.length = 0;
    for (const p of ctx.corpseParts) if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    ctx.corpseParts.length = 0;
    for (const g of ctx.grenades) g.destroy();
    ctx.grenades.length = 0;
    for (const r of ctx.rockets) r.destroy();
    ctx.rockets.length = 0;
    for (const r of ctx.remoteRockets) r.destroy();
    ctx.remoteRockets.length = 0;
    ctx.abilities.clearAllAbilityEffects();
  }

  // The one authoritative way to begin either a fresh single-player round or a multiplayer
  // match — replaces the old resetGame()/beginMatch() pair, which did overlapping but not
  // identical resets (only resetGame ever cleared grenades/rockets up front, for instance).
  // Always does the full shared reset first, then branches only on what's genuinely different
  // between the two modes.
  function startSession({ mode, config }) {
    ctx.respawnAt = 0;
    ctx.pendingInvincibleUntil = 0;
    ctx.deadPauseMenuOpen = false;
    el.respawnOverlay.classList.add("hidden");
    endDeathRagdoll();
    clearInvincible();
    el.scoreboardPanel.classList.add("hidden");
    ctx.scoreboardVisible = false;
    clearGameplayObjects(); // abilities must clear before loadMap() below re-points obstacles/obstacleMeshes at the new map's fresh arrays

    if (mode === "multiplayer") {
      ctx.matchConfig = config;
      ctx.inMatch = true;
      ctx.loadMap(config.mapId || DEFAULT_MAP_ID);

      for (const rp of ctx.remotePlayers.values()) rp.destroy(ctx.scene);
      ctx.remotePlayers.clear();
      ctx.remoteEffectUntil.clear();
      ctx.scores.clear();

      let idx = 0;
      for (const p of ctx.currentPlayers) {
        ctx.scores.set(p.id, { name: p.name, kills: 0 });
        if (p.id !== ctx.myPlayerId) {
          const { x, z } = randomSpawnPoint(12, ctx.world.arenaBound);
          ctx.remotePlayers.set(p.id, new RemotePlayer(ctx.scene, p.id, p.name, idx, x, z));
        }
        idx++;
      }
      ctx.hud.renderScoreboard();
      ctx.hud.updateKillsHud();

      ctx.lobbyUi.showMpScreen(null);
      ctx.sounds.resume();
      ctx.loadout.setForceHidden(false);
      // Class-select comes before the local player actually spawns in — keeps showMenuBackdrop/
      // HUD as they are (menu flyover, no HUD yet) until spawnIntoMatch() actually places them.
      ctx.showClassSelect(true);
    } else {
      ctx.kills = 0;
      el.kills.textContent = `0 / ${ctx.TOTAL_KILLS_TO_WIN}`;
      resetPlayerState(0, 8);
      for (let i = 0; i < 3; i++) spawnEnemy();
    }
  }

  // The one authoritative way to leave a session, for any reason — win, single-player exit-to-
  // menu or death, leaving to the room, or an abrupt disconnect. Unconditionally tears down
  // every gameplay-only object/timer every time; callers only need to handle their own
  // reason-specific UI afterward (which screen to show, what messages to set). `nextState` is
  // applied *before* `controls.unlock()` below fires its "unlock" event, the same ordering
  // trick the old endMatch()/endGame() each separately remembered to get right — now guaranteed
  // in the one place that actually calls unlock().
  function endSession(nextState = "menu") {
    ctx.state = nextState;
    ctx.inMatch = false;
    ctx.respawnAt = 0;
    ctx.pendingInvincibleUntil = 0;
    ctx.deadPauseMenuOpen = false;
    el.respawnOverlay.classList.add("hidden");
    endDeathRagdoll();
    clearInvincible();
    el.scoreboardPanel.classList.add("hidden");
    ctx.scoreboardVisible = false;
    clearGameplayObjects();

    for (const rp of ctx.remotePlayers.values()) rp.destroy(ctx.scene);
    ctx.remotePlayers.clear();
    ctx.remoteEffectUntil.clear();

    ctx.matchConfig = null;

    ctx.controls.unlock();
    ctx.hud.hideGameplayUI();
  }

  function setInvincible(until) {
    ctx.invincibleUntil = until;
    el.invincibleVignette.classList.remove("hidden");
    el.invincibleIndicator.classList.remove("hidden");
    el.invincibleTimerEl.textContent = `${Math.max(0, Math.ceil((until - Date.now()) / 1000))}s`;
  }

  function clearInvincible() {
    ctx.invincibleUntil = 0;
    el.invincibleVignette.classList.add("hidden");
    el.invincibleIndicator.classList.add("hidden");
  }

  // Builds a full humanoid body for the LOCAL player (who normally has no visible body at all
  // in first person) at the moment of death, and immediately blasts it apart with the same
  // ragdoll physics an eliminated peer's avatar already gets — reusing breakApartHumanoid
  // keeps this consistent with how everyone else's death already looks. Disables mouse-look
  // (not a full pointer-lock unlock, which would incorrectly trigger the pause overlay via the
  // "unlock" listener) and hides the held-weapon viewmodel, since both would otherwise keep
  // rigidly following the camera into its new third-person vantage point.
  function beginDeathRagdoll(blast = null) {
    const s = sharedHumanoidParts();
    const built = buildHumanoidBody(s);
    const yaw = ctx.getNetworkYaw();
    built.visual.rotation.y = yaw;
    built.group.position.set(ctx.camera.position.x, ctx.camera.position.y - ctx.player.eyeHeight, ctx.camera.position.z);
    ctx.scene.add(built.group);

    const parts = [built.torso, built.head, built.leftLeg, built.rightLeg, built.leftArm, built.rightArm];
    const blastVec = blast ? { origin: new THREE.Vector3(blast.origin.x, blast.origin.y, blast.origin.z), strength: blast.strength } : null;
    const tracked = breakApartHumanoid(ctx.scene, built.group, parts, blastVec);
    ctx.corpseParts.push(...tracked);
    ctx.deathHeadPart = tracked.find((t) => t.mesh === built.head) || null;

    // A fixed offset (computed once, from the facing direction at the moment of death) behind
    // and above wherever the head currently is — a chase cam, not a camera glued to the head
    // mesh itself, which would just show the inside of a box from point-blank range.
    const yawSin = Math.sin(yaw);
    const yawCos = Math.cos(yaw);
    ctx.deathCamOffset.set(yawSin * 3, 2.2, yawCos * 3);

    ctx.controls.enabled = false;
    ctx.loadout.setForceHidden(true);
  }

  function endDeathRagdoll() {
    ctx.deathHeadPart = null;
    ctx.controls.enabled = true;
    ctx.loadout.setForceHidden(false);
  }

  // Called once the player clicks the Respawn button (see main.js) once eligible — a fresh spawn
  // point, full reset, pause-hint's death UI dismissed, and the post-respawn invincibility window
  // started.
  function respawnNow() {
    // An absolute timestamp, unlike the old countdown, doesn't naturally go permanently-false
    // once it's passed — without this explicit reset, respawnAt would stay "in the past" forever.
    ctx.respawnAt = 0;
    const spawn = randomSpawnPoint(12, ctx.world.arenaBound);
    resetPlayerState(spawn.x, spawn.z);
    endDeathRagdoll();
    // pendingInvincibleUntil is the server's own timestamp (see handleRespawnScheduled) — the
    // fallback only covers the (should-be-rare) case where this fires before that broadcast has
    // arrived yet.
    setInvincible(ctx.pendingInvincibleUntil || Date.now() + INVINCIBLE_DURATION * 1000);
    ctx.pendingInvincibleUntil = 0;
  }

  // Actually places the LOCAL player into the match world — a fresh spawn point, full health/
  // ammo, and whatever class was just selected. Used both for the very first spawn right after
  // a match starts and for every subsequent mid-match class change (see the Spawn In click
  // handler) — both are "you appear somewhere new with a clean slate" in exactly the same way.
  function spawnIntoMatch() {
    ctx.showMenuBackdrop = false;
    ctx.hud.showGameplayUI();
    // Harmless when already 0 (the common case) — but Change Class is reachable while dead too
    // (main.js's Spawn In handler blocks it until the respawn timer actually passes, same as the
    // dedicated Respawn button), and once it does, picking a class and spawning in this way *is*
    // a real respawn, so the death UI needs to actually clear rather than keep showing over a
    // now-alive player.
    ctx.respawnAt = 0;
    // Same reasoning — if this respawn came from a death (Change Class after dying), the ragdoll
    // view left ctx.controls.enabled=false and the weapon force-hidden (see beginDeathRagdoll).
    // respawnNow() already cleans this up for the dedicated Respawn button; this path needs the
    // exact same cleanup, or the player ends up alive but permanently unable to look around.
    endDeathRagdoll();
    const spawn = randomSpawnPoint(12, ctx.world.arenaBound);
    resetPlayerState(spawn.x, spawn.z);
    ctx.posBroadcastAccum = 0;
    ctx.requestPlayLock();
    // (Re)registers this player's server-side combat ledger (health/ammo/grenades) for the class
    // just spawned into — see server/index.js's handleSpawnReady. Single-player has no lobby.
    if (ctx.inMatch && ctx.lobby) ctx.lobby.spawnReady(ctx.selectedClassId);
  }

  function startRespawnSequence(killerId, killerName, blast = null) {
    ctx.respawnAt = Date.now() + RESPAWN_DELAY * 1000;
    ctx.invisibleUntil = 0; // dying cancels Invisibility immediately, even mid-duration
    ctx.overclockUntil = 0; // dying cancels Overclock immediately, even mid-duration
    ctx.eliminatedMessage = killerId ? `Eliminated by ${killerName}` : "Eliminated";
    // Always starts on the minimal respawn screen, not the full pause menu — Esc/the touch pause
    // button toggles over to that (see main.js's handlePauseToggle) and back again.
    ctx.deadPauseMenuOpen = false;
    beginDeathRagdoll(blast);
    // Releases the real OS pointer lock so the respawn overlay's button is actually clickable —
    // this fires the same "unlock" listener a real Escape press would, but enterPausedState()
    // there explicitly ignores it while ctx.respawnAt is set, since death has its own separate UI.
    ctx.controls.unlock();
    ctx.updateDeathUI(); // immediate correctness — don't wait for the next animate() frame
    // The scoreboard tally (and, for a peer, their ragdoll) is no longer applied directly from
    // here — it now happens uniformly for every player's death (including this one) via
    // handleRespawnScheduled, reacting to the server's own respawn_scheduled broadcast, which
    // arrives moments after this purely-local/visual death UI already ran.
  }

  // Every client applies the same server-broadcast elimination the same way — see
  // handleRespawnScheduled below, the sole trigger for this now (both for this player's own
  // death and a peer's).
  function applyElim(victimId, victimName, killerId, killerName, blast = null) {
    if (!ctx.scores.has(victimId)) ctx.scores.set(victimId, { name: victimName, kills: 0 });
    if (killerId && killerId !== victimId) {
      if (!ctx.scores.has(killerId)) ctx.scores.set(killerId, { name: killerName, kills: 0 });
      ctx.scores.get(killerId).kills++;
    } else {
      // A suicide — either no killerId at all, or a self-targeted hit (own grenade/rocket/mine
      // splash, killerId === victimId) — costs the victim a kill rather than just denying credit
      // to nobody, same "own goal" convention most shooters use. Allowed to go negative — that's
      // the whole point of the penalty.
      ctx.scores.get(victimId).kills--;
    }
    ctx.hud.renderScoreboard();
    // The suicide branch above changes the local player's own tally with no killerId to key
    // off of, so the usual "only the killer's client refreshes its own kills HUD" check needs
    // a second condition to still catch that case.
    if (killerId === ctx.myPlayerId || (!killerId && victimId === ctx.myPlayerId)) ctx.hud.updateKillsHud();

    // "Explode" the eliminated player's avatar the same way an AI enemy dies — only ever
    // meaningful for a peer (there's no RemotePlayer standing in for the local client itself).
    const rp = ctx.remotePlayers.get(victimId);
    if (rp) {
      const blastVec = blast
        ? { origin: new THREE.Vector3(blast.origin.x, blast.origin.y, blast.origin.z), strength: blast.strength }
        : null;
      ctx.corpseParts.push(...rp.breakApart(ctx.scene, blastVec));
      ctx.remotePlayers.delete(victimId); // recreated lazily off that player's next "pos" tick post-respawn
    }

    // Deciding the match is over is the server's job (it tallies the same elimination this
    // function is reacting to, and broadcasts "match_ended" once a kill-target/time-limit is hit
    // — see server/index.js's recordElim/finalizeMatch and lobbyUi.js's onMatchEnded). ctx.scores
    // here stays purely a local, cosmetic scoreboard display, not the source of truth for ending
    // anything.
  }

  function handleRelay(from, payload) {
    if (!payload) return;
    switch (payload.t) {
      case "pos": {
        let rp = ctx.remotePlayers.get(from);
        if (!rp) {
          // No avatar for them yet — either the very first tick after joining, or they were
          // just ragdolled on elimination and this is their first tick after respawning.
          const info = ctx.currentPlayers.find((p) => p.id === from);
          const idx = Math.max(0, ctx.currentPlayers.findIndex((p) => p.id === from));
          rp = new RemotePlayer(ctx.scene, from, info?.name || "Player", idx, payload.x, payload.z);
          ctx.remotePlayers.set(from, rp);
        }
        // health no longer rides on a position tick (see handleDamageApplied/handlePlayerSpawned)
        // — the server is the sole source of health now, never a self-report.
        rp.updateFromNetwork(payload.x, payload.y, payload.z, payload.rotY, payload.isMoving, payload.weaponId, payload.pitch);
        break;
      }
      case "left_match": {
        const rp = ctx.remotePlayers.get(from);
        if (rp) {
          rp.destroy(ctx.scene);
          ctx.remotePlayers.delete(from);
        }
        ctx.remoteEffectUntil.delete(from);
        break;
      }
      case "mine_explode": {
        // Visual/audio echo only — never deals damage here. If this hit *me*, the owner's own
        // client already reported that to the server (see combat.js's explodeAt) and I'll learn
        // the result via handleDamageApplied, same as any other explosion.
        const m = ctx.abilities.activeMines.get(payload.id);
        if (m) ctx.combat.explodeVisualOnly(new THREE.Vector3(m.x, 0.15, m.z), MINE_BLAST_RADIUS);
        ctx.abilities.despawnLocalMine(payload.id);
        break;
      }
    }
  }

  // A plain visual/audio echo of a peer's shot — the server already validated it (ammo/fire-rate)
  // before broadcasting this, and damage (if any) arrives separately via handleDamageApplied, so
  // there's no authority decided here at all, same as the old client-decided "fire" relay this
  // replaces. Own shots are already fully handled locally in combat.js's fireWeapon(); `rp` is
  // naturally absent for the local player's own id (never present in ctx.remotePlayers), so this
  // silently no-ops for the self-echo without needing a separate check.
  function handleFireConfirmed(from, payload) {
    const rp = ctx.remotePlayers.get(from);
    if (!rp) return;
    const def = WEAPON_DEFS.find((d) => d.id === payload.weaponId);
    if (!def) return;

    rp.setWeapon(payload.weaponId);
    rp.triggerMuzzleFlash();
    ctx.sounds.play(`fire_${def.soundId ?? def.id}`, { volume: 0.55, rate: 0.98 + Math.random() * 0.04 });

    const muzzleWorld = rp.getMuzzleWorldPosition(new THREE.Vector3());
    const hitVec = new THREE.Vector3(payload.hitPoint.x, payload.hitPoint.y, payload.hitPoint.z);
    if (def.hitscan) {
      // Same "no tracer for a knife" treatment as the shooter's own client (combat.js).
      if (!def.melee) ctx.vfx.bolt(muzzleWorld, hitVec, payload.hitPlayer ? 0x4de3ff : 0x8a8172);
      ctx.vfx.sparkBurst(hitVec, payload.hitPlayer ? 0x9be9ff : 0xbfae8a);
    } else {
      const rocket = new Rocket(ctx.scene, muzzleWorld, hitVec, def.projectileSpeed);
      rocket.splashRadius = def.splashRadius;
      ctx.remoteRockets.push(rocket);
    }
  }

  // A player's combat ledger (and therefore health) was just (re)registered server-side for a
  // fresh spawn — see server/index.js's handleSpawnReady. The local player's own health/UI
  // already reset synchronously in resetPlayerState; this only matters for resetting a peer's
  // health bar to full at the same moment, replacing the old implicit reset via a self-reported
  // pos.health field.
  function handlePlayerSpawned(playerId, maxHealth) {
    if (playerId === ctx.myPlayerId) return;
    const rp = ctx.remotePlayers.get(playerId);
    if (rp) {
      rp.maxHealth = maxHealth;
      rp.health = maxHealth;
    }
  }

  // Health/damage authority — the server computed and applied this already (see
  // server/index.js's handleReportHit); every recipient just reflects the result, never decides
  // it. This is what closes the old god-mode gap: the local player's own health is no longer
  // something this client can simply choose to ignore.
  function handleDamageApplied({ targetId, fromId, fromName, newHealth, blast }) {
    if (targetId === ctx.myPlayerId) {
      ctx.player.health = newHealth;
      ctx.player.timeSinceDamage = 0; // keeps the local passive-regen delay in sync with the server's own
      ctx.vfx.flashHit();
      if (newHealth <= 0) startRespawnSequence(fromId, fromName, blast);
      return;
    }
    const rp = ctx.remotePlayers.get(targetId);
    if (rp) rp.health = newHealth;
  }

  // A top-level message (not a `relay` envelope) — the server validated this activation and
  // computed `until` itself (see server/index.js's handleUseAbility), so every recipient
  // (including the actor, reconciling its own optimistic local estimate) treats it as
  // authoritative. `from` is the server-verified sender id, not a self-reported field.
  function handleAbilityUsed(from, abilityId, payload) {
    const { id, x, z, rotY, until } = payload;
    if (abilityId === "overclock") {
      // Self-only — a peer never renders or reacts to Overclock in any way, so only the actor's
      // own optimistic estimate needs reconciling against the server-issued timestamp.
      if (from === ctx.myPlayerId) ctx.overclockUntil = until;
      return;
    }
    if (abilityId === "invisibility") {
      if (from === ctx.myPlayerId) {
        ctx.invisibleUntil = until;
      } else {
        const entry = ctx.remoteEffectUntil.get(from) || {};
        entry.invisibleUntil = until;
        ctx.remoteEffectUntil.set(from, entry);
      }
      return;
    }
    const store = abilityId === "shield" ? ctx.abilities.activeShields : abilityId === "mine" ? ctx.abilities.activeMines : null;
    if (!store) return;
    const existing = store.get(id);
    if (existing) {
      existing.until = until; // owner's own optimistic copy — just correct the timing
      return;
    }
    if (abilityId === "shield") ctx.abilities.spawnLocalShield(id, x, z, rotY, from, until);
    else ctx.abilities.spawnLocalMine(id, x, z, from, until);
  }

  // The server computes and broadcasts this the instant recordElim runs (see server/index.js),
  // itself triggered only by the server's own detection of a tracked health value reaching 0
  // (handleReportHit) — no client self-report of any kind is trusted here anymore, for the
  // respawn timing OR for who-killed-whom. This is the single trigger for applyElim now, for
  // both this player's own death and a peer's.
  function handleRespawnScheduled({ victimId, victimName, killerId, killerName, blast, respawnAt, invincibleUntil }) {
    if (victimId === ctx.myPlayerId) {
      ctx.respawnAt = respawnAt; // reconciles the optimistic estimate startRespawnSequence already set
      ctx.pendingInvincibleUntil = invincibleUntil; // applied by respawnNow() at the actual moment of respawn
    } else {
      const entry = ctx.remoteEffectUntil.get(victimId) || {};
      entry.invincibleUntil = invincibleUntil;
      ctx.remoteEffectUntil.set(victimId, entry);
    }
    applyElim(victimId, victimName, killerId, killerName, blast);
  }

  function endMatch(winnerId) {
    // Read before endSession() below zeroes ctx.matchConfig — scores itself is deliberately
    // left alone by endSession (unlike matchConfig), since the end screen still needs it.
    const winnerName = winnerId ? ctx.scores.get(winnerId)?.name ?? "Someone" : null;
    const message = winnerId ? `First to ${ctx.matchConfig.target} eliminations.` : "Final scoreboard:";

    endSession("menu");

    el.endTitle.classList.remove("lose");
    el.endTitle.textContent = winnerId ? (winnerId === ctx.myPlayerId ? "You Win!" : `${winnerName} Wins!`) : "Time's Up";
    el.endMessage.textContent = message;
    ctx.hud.renderEndScoreboard();
    el.endScoreboardList.classList.remove("hidden");
    el.restartBtn.classList.add("hidden");
    el.backToRoomBtn.classList.remove("hidden");
    // Also covers the case where the match ends (kill target hit / time ran out) while this
    // player was still on the class-select screen, never having spawned in at all — showScreen
    // hides whatever was open, not just a specifically-anticipated one.
    ctx.screens.showScreen(el.endScreen);
  }

  el.backToRoomBtn.addEventListener("click", () => {
    el.endScoreboardList.classList.add("hidden");
    el.restartBtn.classList.remove("hidden");
    el.backToRoomBtn.classList.add("hidden");
    ctx.showMenuBackdrop = true;
    ctx.loadout.setForceHidden(true);
    ctx.lobbyUi.renderRoomScreen();
    ctx.lobbyUi.showMpScreen(el.roomScreen);
  });

  // Leaving mid-match via the pause menu — stays connected to the room/lobby (unlike
  // leaving the room entirely), so the group can start another match right after.
  function leaveMatchToRoom() {
    endSession("menu");
    if (ctx.lobby) ctx.lobby.relayToRoom({ t: "left_match", id: ctx.myPlayerId });
    ctx.lobbyUi.renderRoomScreen();
    ctx.lobbyUi.showMpScreen(el.roomScreen);
  }

  // Disconnect mid-match (server dropped / network blip) — clean up game state only;
  // the onDisconnected handler that called this is the one showing the error/screen.
  function endMatchAbruptly() {
    endSession("menu");
    ctx.showMenuBackdrop = true;
    ctx.loadout.setForceHidden(true);
  }

  return {
    spawnEnemy,
    resetPlayerState,
    startSession,
    endSession,
    setInvincible,
    clearInvincible,
    beginDeathRagdoll,
    endDeathRagdoll,
    respawnNow,
    spawnIntoMatch,
    startRespawnSequence,
    applyElim,
    handleRelay,
    handleFireConfirmed,
    handlePlayerSpawned,
    handleDamageApplied,
    endMatch,
    leaveMatchToRoom,
    endMatchAbruptly,
    handleAbilityUsed,
    handleRespawnScheduled,
  };
}
