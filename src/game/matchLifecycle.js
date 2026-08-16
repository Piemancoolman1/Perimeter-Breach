import * as THREE from "three";
import { el } from "./dom.js";
import { EYE_HEIGHT, STAMINA_MAX } from "./player.js";
import { Enemy, randomSpawnPoint } from "./entities.js";
import { sharedHumanoidParts, buildHumanoidBody, breakApartHumanoid } from "./humanoidParts.js";
import { RemotePlayer } from "./remotePlayer.js";
import { GRENADE_DEF, WEAPON_DEFS } from "./weaponDefs.js";
import { Rocket } from "./projectiles.js";
import { DEFAULT_MAP_ID } from "./world.js";
import { formatGrenadeCount } from "./hud.js";
import { loadPlayerName } from "./lobbyUi.js";
import { SHIELD_DURATION, MINE_BLAST_RADIUS } from "./abilities.js";

const RESPAWN_DELAY = 3;
const INVINCIBLE_DURATION = 3;

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
    ctx.player.stamina = STAMINA_MAX;
    ctx.player.staminaLocked = false;
    ctx.leftMouseHeld = false;
    ctx.controls.pointerSpeed = ctx.settings.lookSensitivity;
    el.scopeVignette.classList.add("hidden");

    ctx.loadout.reset();
    ctx.combat.stopHoldingGrenade();

    ctx.grenadeCount = ctx.INFINITE_GRENADES ? Infinity : GRENADE_DEF.count;
    ctx.grenadeCooldown = 0;
    ctx.abilityCooldownRemaining = 0; // fresh life, ability immediately available again — matches the full-ammo reset above
    el.grenadeCount.textContent = formatGrenadeCount(ctx.grenadeCount);
    for (const g of ctx.grenades) g.destroy();
    ctx.grenades.length = 0;
    for (const r of ctx.rockets) r.destroy();
    ctx.rockets.length = 0;
  }

  function resetGame() {
    ctx.kills = 0;
    el.kills.textContent = `0 / ${ctx.TOTAL_KILLS_TO_WIN}`;
    resetPlayerState(0, 8);

    for (const e of ctx.enemies) e.die(ctx.scene);
    ctx.enemies.length = 0;
    ctx.pendingSpawns.length = 0;
    for (const p of ctx.corpseParts) if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    ctx.corpseParts.length = 0;
    ctx.abilities.clearAllAbilityEffects();
    for (let i = 0; i < 3; i++) spawnEnemy();
  }

  function setInvincible(seconds) {
    ctx.invincibleTimer = seconds;
    el.invincibleVignette.classList.remove("hidden");
    el.invincibleIndicator.classList.remove("hidden");
    el.invincibleTimerEl.textContent = `${Math.ceil(ctx.invincibleTimer)}s`;
  }

  function clearInvincible() {
    ctx.invincibleTimer = 0;
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

  // Called once from the animate() loop the instant respawnTimer counts down to zero — a
  // fresh spawn point, full reset, overlay dismissed, and the post-respawn invincibility
  // window started.
  function respawnNow() {
    const spawn = randomSpawnPoint(12, ctx.world.arenaBound);
    resetPlayerState(spawn.x, spawn.z);
    el.respawnOverlay.classList.add("hidden");
    endDeathRagdoll();
    setInvincible(INVINCIBLE_DURATION);
  }

  // Fires for every client, including the host — the server broadcasts match_started to
  // the whole room rather than skipping the sender, so nobody needs special-case logic.
  function beginMatch(config, startedAt) {
    ctx.matchConfig = config;
    ctx.matchStartedAt = startedAt;
    ctx.inMatch = true;
    ctx.respawnTimer = 0;
    // Before loadMap() reassigns obstacles/obstacleMeshes to the new map's fresh arrays — a
    // shield left over from a previous match (or an exited single-player round) needs its
    // splice-out to happen against the *old* arrays it was actually pushed into, not silently
    // no-op against arrays that already forgot it existed. Its visual mesh would otherwise also
    // just leak in the scene forever, since shields/mines live outside buildWorld's own dispose().
    ctx.abilities.clearAllAbilityEffects();
    ctx.loadMap(config.mapId || DEFAULT_MAP_ID);
    el.respawnOverlay.classList.add("hidden");
    endDeathRagdoll();
    clearInvincible();

    // Multiplayer never has AI hostiles at all — but if a single-player round was left
    // mid-game (exited without ever calling resetGame(), which is the only thing that
    // normally clears these), enemies/pendingSpawns/their corpses would otherwise still be
    // sitting here and the animate loop would keep them fighting the player right through a
    // "multiplayer" match. Defensive, not just reactive: also enforced by the `!inMatch`
    // gate around the enemy update/spawn logic itself, so this holds even if some other path
    // ever leaves stale enemies around too.
    for (const e of ctx.enemies) e.die(ctx.scene);
    ctx.enemies.length = 0;
    ctx.pendingSpawns.length = 0;
    for (const p of ctx.corpseParts) if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
    ctx.corpseParts.length = 0;

    for (const rp of ctx.remotePlayers.values()) rp.destroy(ctx.scene);
    ctx.remotePlayers.clear();
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
  }

  // Actually places the LOCAL player into the match world — a fresh spawn point, full health/
  // ammo, and whatever class was just selected. Used both for the very first spawn right after
  // a match starts and for every subsequent mid-match class change (see the Spawn In click
  // handler) — both are "you appear somewhere new with a clean slate" in exactly the same way.
  function spawnIntoMatch() {
    ctx.showMenuBackdrop = false;
    ctx.hud.showGameplayUI();
    const spawn = randomSpawnPoint(12, ctx.world.arenaBound);
    resetPlayerState(spawn.x, spawn.z);
    ctx.posBroadcastAccum = 0;
    ctx.requestPlayLock();
  }

  // Applies damage to the LOCAL player only — never touches anyone else's health. A hit
  // on a remote player instead sends *them* a message (see fireWeapon/explodeAt) and lets
  // their own client decide what happens, same trust model as the rest of this game.
  // `blast`, when given as {origin:{x,y,z}, strength}, is what makes an eliminated player's
  // avatar (as their peers see it) scatter apart hard from an explosive kill instead of the
  // plain-gunshot collapse — the same distinction Enemy/registerKill already makes.
  function damageLocalPlayer(amount, killerId, killerName, blast = null) {
    if (!ctx.inMatch || ctx.respawnTimer > 0 || ctx.invincibleTimer > 0) return;
    ctx.player.takeDamage(amount);
    ctx.vfx.flashHit();
    if (ctx.player.health <= 0) startRespawnSequence(killerId, killerName, blast);
  }

  function startRespawnSequence(killerId, killerName, blast = null) {
    ctx.respawnTimer = RESPAWN_DELAY;
    el.respawnTitle.textContent = killerId ? `Eliminated by ${killerName}` : "Eliminated";
    el.respawnOverlay.classList.remove("hidden");
    beginDeathRagdoll(blast);

    const myName = loadPlayerName();
    if (ctx.lobby) ctx.lobby.relayToRoom({ t: "elim", victimId: ctx.myPlayerId, victimName: myName, killerId, killerName, blast });
    applyElim(ctx.myPlayerId, myName, killerId, killerName, blast); // tally locally too, symmetric with how peers see it
  }

  // Every client tallies the same broadcast "elim" events independently — there's no
  // single scorekeeper. Fine for this scope; near-simultaneous kills could in principle
  // land in a slightly different order per client (documented v1 simplification).
  function applyElim(victimId, victimName, killerId, killerName, blast = null) {
    if (!ctx.scores.has(victimId)) ctx.scores.set(victimId, { name: victimName, kills: 0 });
    if (killerId && killerId !== victimId) {
      if (!ctx.scores.has(killerId)) ctx.scores.set(killerId, { name: killerName, kills: 0 });
      ctx.scores.get(killerId).kills++;
    }
    ctx.hud.renderScoreboard();
    if (killerId === ctx.myPlayerId) ctx.hud.updateKillsHud();

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

    if (ctx.matchConfig?.mode === "killTarget" && killerId) {
      const killer = ctx.scores.get(killerId);
      if (killer.kills >= ctx.matchConfig.target) endMatch(killerId);
    }
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
        rp.updateFromNetwork(
          payload.x,
          payload.y,
          payload.z,
          payload.rotY,
          payload.health,
          payload.isMoving,
          payload.weaponId,
          payload.pitch,
          payload.invincible
        );
        break;
      }
      case "hit":
        damageLocalPlayer(payload.damage, payload.fromId, payload.fromName, payload.blast);
        break;
      case "elim":
        applyElim(payload.victimId, payload.victimName, payload.killerId, payload.killerName, payload.blast);
        break;
      case "left_match": {
        const rp = ctx.remotePlayers.get(from);
        if (rp) {
          rp.destroy(ctx.scene);
          ctx.remotePlayers.delete(from);
        }
        break;
      }
      case "fire": {
        // A plain visual/audio echo of someone else's shot — no damage authority here
        // (that's still only ever decided by whoever actually gets hit, via "hit" above).
        const rp = ctx.remotePlayers.get(from);
        if (!rp) break;
        const def = WEAPON_DEFS.find((d) => d.id === payload.weaponId);
        if (!def) break;

        rp.setWeapon(payload.weaponId);
        rp.triggerMuzzleFlash();
        ctx.sounds.play(`fire_${def.id}`, { volume: 0.55, rate: 0.98 + Math.random() * 0.04 });

        const muzzleWorld = rp.getMuzzleWorldPosition(new THREE.Vector3());
        const hitVec = new THREE.Vector3(payload.hitPoint.x, payload.hitPoint.y, payload.hitPoint.z);
        if (def.hitscan) {
          ctx.vfx.bolt(muzzleWorld, hitVec, payload.hitPlayer ? 0x4de3ff : 0x8a8172);
          ctx.vfx.sparkBurst(hitVec, payload.hitPlayer ? 0x9be9ff : 0xbfae8a);
        } else {
          const rocket = new Rocket(ctx.scene, muzzleWorld, hitVec, def.projectileSpeed);
          rocket.splashRadius = def.splashRadius;
          ctx.remoteRockets.push(rocket);
        }
        break;
      }
      // `from` (the server-verified sender id), not payload.ownerId, is used as the owner for
      // both of these — no reason to trust a self-reported field when the relay already hands
      // us the real one for free.
      case "shield_place":
        if (!ctx.abilities.activeShields.has(payload.id)) {
          ctx.abilities.spawnLocalShield(payload.id, payload.x, payload.z, payload.rotY, from, payload.duration ?? SHIELD_DURATION);
        }
        break;
      case "shield_remove":
        ctx.abilities.despawnLocalShield(payload.id);
        break;
      case "mine_place":
        if (!ctx.abilities.activeMines.has(payload.id)) ctx.abilities.spawnLocalMine(payload.id, payload.x, payload.z, from);
        break;
      case "mine_explode": {
        // Visual/audio echo only — never deals damage here. If this hit *me*, the owner's own
        // client already decided that independently (via explodeAt's splashDamagePlayer check
        // against every RemotePlayer it knows about, same as any other explosion) and sent me a
        // separate "hit" relay_to_player message for it, same as the "fire" case above.
        const m = ctx.abilities.activeMines.get(payload.id);
        if (m) ctx.combat.explodeVisualOnly(new THREE.Vector3(m.x, 0.15, m.z), MINE_BLAST_RADIUS);
        ctx.abilities.despawnLocalMine(payload.id);
        break;
      }
    }
  }

  function endMatch(winnerId) {
    ctx.inMatch = false;
    ctx.state = "menu"; // set before unlock() so the pause-hint doesn't pop up, same trick endGame() uses
    ctx.controls.unlock();
    ctx.hud.hideGameplayUI();
    el.respawnOverlay.classList.add("hidden");
    el.scoreboardPanel.classList.add("hidden");
    ctx.scoreboardVisible = false;
    // Defensive: the match can end (another player hit the kill target, or time ran out) while
    // this player is still on the class-select screen, never having spawned in at all.
    el.classSelectScreen.classList.add("hidden");
    ctx.abilities.clearAllAbilityEffects();

    const winnerName = winnerId ? ctx.scores.get(winnerId)?.name ?? "Someone" : null;
    el.endTitle.classList.remove("lose");
    el.endTitle.textContent = winnerId ? (winnerId === ctx.myPlayerId ? "You Win!" : `${winnerName} Wins!`) : "Time's Up";
    el.endMessage.textContent = winnerId ? `First to ${ctx.matchConfig.target} eliminations.` : "Final scoreboard:";
    ctx.hud.renderEndScoreboard();
    el.endScoreboardList.classList.remove("hidden");
    el.restartBtn.classList.add("hidden");
    el.backToRoomBtn.classList.remove("hidden");
    el.endScreen.classList.remove("hidden");

    for (const rp of ctx.remotePlayers.values()) rp.destroy(ctx.scene);
    ctx.remotePlayers.clear();
  }

  el.backToRoomBtn.addEventListener("click", () => {
    el.endScreen.classList.add("hidden");
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
    // Its only current caller (el.exitToMenuBtn's handler in main.js) already sets `state`
    // first, but relying on that precondition is fragile — leaving it unset here means
    // `state` stays "playing" for anyone who calls this directly, which leaves the global
    // mousedown/mouseup listeners still treating clicks as in-game fire input instead of
    // ordinary page clicks.
    ctx.state = "menu";
    ctx.inMatch = false;
    ctx.respawnTimer = 0;
    el.respawnOverlay.classList.add("hidden");
    endDeathRagdoll();
    clearInvincible();
    el.scoreboardPanel.classList.add("hidden");
    ctx.scoreboardVisible = false;
    if (ctx.lobby) ctx.lobby.relayToRoom({ t: "left_match", id: ctx.myPlayerId });
    for (const rp of ctx.remotePlayers.values()) rp.destroy(ctx.scene);
    ctx.remotePlayers.clear();
    ctx.abilities.clearAllAbilityEffects();
    ctx.lobbyUi.renderRoomScreen();
    ctx.lobbyUi.showMpScreen(el.roomScreen);
  }

  // Disconnect mid-match (server dropped / network blip) — clean up game state only;
  // the onDisconnected handler that called this is the one showing the error/screen.
  function endMatchAbruptly() {
    ctx.inMatch = false;
    ctx.respawnTimer = 0;
    el.respawnOverlay.classList.add("hidden");
    endDeathRagdoll();
    clearInvincible();
    el.scoreboardPanel.classList.add("hidden");
    ctx.scoreboardVisible = false;
    ctx.state = "menu";
    ctx.controls.unlock();
    ctx.showMenuBackdrop = true;
    ctx.loadout.setForceHidden(true);
    ctx.hud.hideGameplayUI();
    // Defensive: a disconnect could land while the class-select screen is up (match started,
    // but the player hadn't hit Spawn In yet) — showMpScreen only manages the lobby screens,
    // not this one, so it'd otherwise be left showing on top of whatever comes next.
    el.classSelectScreen.classList.add("hidden");
    for (const rp of ctx.remotePlayers.values()) rp.destroy(ctx.scene);
    ctx.remotePlayers.clear();
    ctx.abilities.clearAllAbilityEffects();
  }

  return {
    spawnEnemy,
    resetPlayerState,
    resetGame,
    setInvincible,
    clearInvincible,
    beginDeathRagdoll,
    endDeathRagdoll,
    respawnNow,
    beginMatch,
    spawnIntoMatch,
    damageLocalPlayer,
    startRespawnSequence,
    applyElim,
    handleRelay,
    endMatch,
    leaveMatchToRoom,
    endMatchAbruptly,
  };
}
