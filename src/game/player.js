import * as THREE from "three";
import { resolveCollisions, getGroundHeight, ARENA_BOUND } from "./world.js";

export const EYE_HEIGHT = 1.7;
const EYE_HEIGHT_CROUCH = 1.0;
const CROUCH_TRANSITION_RATE = 10; // per-second lerp rate between standing/crouched eye height
const RADIUS = 0.45;
const WALK_SPEED = 6.5;
const SPRINT_MULT = 1.6;
const CROUCH_SPEED_MULT = 0.5;
const ACCEL = 40;
const DAMPING = 10;
const GRAVITY = -22;
const JUMP_SPEED = 8;
const MAX_JUMPS = 2;
const FLY_SPEED = 20; // dev tool — fast enough to cross a whole map in a few seconds
const HEAD_CLEARANCE = 0.15; // how far above the eye-height camera position the top of the head sits

export const STAMINA_MAX = 100;
const STAMINA_DRAIN_RATE = 28; // per second while actually sprinting AND moving — a full bar lasts ~3.6s of sprint
const STAMINA_REGEN_RATE = 16; // per second whenever not draining
// Once stamina hits empty, sprint stays locked out until it regens back above this — a plain
// "sprint allowed whenever stamina > 0" would flicker on/off right at empty as it ticks up by
// fractions of a point each frame while still held.
const STAMINA_LOCK_RECOVER_THRESHOLD = 25;

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.velocity = new THREE.Vector3();
    this.onGround = true;
    this.jumpsUsed = 0;
    this.flying = false; // dev tool (F5) — true noclip, ignores gravity/collision entirely
    this.crouching = false;
    this.eyeHeight = EYE_HEIGHT; // smoothly lerps toward EYE_HEIGHT/EYE_HEIGHT_CROUCH each frame
    this.stamina = STAMINA_MAX;
    this.staminaLocked = false; // true once stamina hits 0; stays true until it regens back above STAMINA_LOCK_RECOVER_THRESHOLD

    this.speedMult = 1;
    this.staminaMult = 1;
    this.maxHealth = 100;
    this.health = this.maxHealth;

    this.camera.position.set(0, EYE_HEIGHT, 8);
  }

  get position() {
    return this.camera.position;
  }

  // Applies a class's stat divergence from the shared baseline every class used to share
  // identically — called once per (re)spawn (see matchLifecycle.js's resetPlayerState,
  // which looks up the currently-selected class) rather than at construction time, since
  // the class can change mid-session (death and re-pick, or a single-player class swap).
  // Health/stamina are left for the caller to actually reset to the new cap — this only
  // updates what the cap *is*.
  applyClassModifiers({ speedMult = 1, staminaMult = 1, healthMult = 1 } = {}) {
    this.speedMult = speedMult;
    this.staminaMult = staminaMult;
    this.maxHealth = 100 * healthMult;
  }

  takeDamage(amount) {
    this.health = Math.max(0, this.health - amount);
  }

  setFlying(flying) {
    this.flying = flying;
    this.velocity.set(0, 0, 0); // drop any residual walk/fall speed crossing the mode switch
    this.onGround = false; // stops footstep sfx from playing while airborne-flying; recomputed correctly the instant flying turns back off
  }

  // Scout's ability: an instant horizontal speed burst in the given (world-space, normalized
  // internally) direction. Directly *sets* horizontal velocity rather than adding to it, so
  // the dash always feels like the same-strength burst regardless of current speed — the
  // normal ACCEL-based damping in update() then gradually reins it back in to WALK_SPEED just
  // like any other movement, no separate dash-decay logic needed.
  dash(dirX, dirZ, speed) {
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.0001) return;
    this.velocity.x = (dirX / len) * speed;
    this.velocity.z = (dirZ / len) * speed;
  }

  update(dt, input, obstacles, arenaBound = ARENA_BOUND, ceilingHeight = Infinity) {
    if (this.flying) {
      this.updateFlying(dt, input);
      return;
    }

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

    // input.moveX/moveZ are an optional analog contribution (-1..1 each) from a touch
    // joystick — keyboard only ever sets the boolean fields below. Clamping the combined
    // vector to length 1 (rather than always normalizing) preserves keyboard behavior
    // exactly (boolean-only input is always length 1 cardinal or sqrt(2) diagonal pre-clamp,
    // and clamping sqrt(2) down to 1 is identical to the old unconditional normalize) while
    // letting a partial joystick tilt pass through un-boosted for real analog walk/run speed.
    let moveX = input.moveX || 0;
    let moveZ = input.moveZ || 0;
    if (input.forward) moveZ += 1;
    if (input.back) moveZ -= 1;
    if (input.right) moveX += 1;
    if (input.left) moveX -= 1;

    const moveVec = new THREE.Vector3();
    moveVec.addScaledVector(forward, moveZ);
    moveVec.addScaledVector(right, moveX);
    if (moveVec.lengthSq() > 1) moveVec.normalize();

    this.crouching = !!input.crouch;
    const wantsSprint = input.sprint && !this.crouching;
    const isMoving = moveVec.lengthSq() > 0;

    // Resolved BEFORE computing canSprint/speed below — otherwise the exact frame stamina
    // crosses to empty would still apply one full frame of sprint speed before the lock takes
    // effect (imperceptible in practice at 1 frame, but just as easy to get exactly right).
    // Only actually drains while genuinely sprinting — holding Shift while standing still (or
    // while crouched, where it can't apply anyway) costs nothing, matching how "sprint" only
    // ever meant something while actually covering ground. This is *why Dash exists at all*
    // now: sprint is a limited resource, so a burst of speed you can call on demand (its own
    // separate cooldown, not stamina) actually adds something sprint alone can't always cover.
    if (wantsSprint && !this.staminaLocked && isMoving) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN_RATE * dt);
      if (this.stamina <= 0) this.staminaLocked = true;
    } else {
      this.stamina = Math.min(STAMINA_MAX * this.staminaMult, this.stamina + STAMINA_REGEN_RATE * dt);
      if (this.staminaLocked && this.stamina >= STAMINA_LOCK_RECOVER_THRESHOLD) this.staminaLocked = false;
    }
    const canSprint = wantsSprint && !this.staminaLocked; // recomputed after any lock/unlock above

    // Crouching overrides sprint outright (can't sprint-crouch) rather than stacking/competing
    // multipliers — simplest rule, and matches how most FPSes treat the two as mutually exclusive.
    const speed = (this.crouching ? WALK_SPEED * CROUCH_SPEED_MULT : WALK_SPEED * (canSprint ? SPRINT_MULT : 1)) * this.speedMult;
    const targetVX = moveVec.x * speed;
    const targetVZ = moveVec.z * speed;

    this.velocity.x += (targetVX - this.velocity.x) * Math.min(1, ACCEL * dt);
    this.velocity.z += (targetVZ - this.velocity.z) * Math.min(1, ACCEL * dt);
    if (moveVec.lengthSq() === 0) {
      this.velocity.x -= this.velocity.x * Math.min(1, DAMPING * dt);
      this.velocity.z -= this.velocity.z * Math.min(1, DAMPING * dt);
    }

    if (this.onGround) this.jumpsUsed = 0;

    if (input.jumpQueued) {
      if (this.jumpsUsed < MAX_JUMPS) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
        this.jumpsUsed++;
      }
      input.jumpQueued = false;
    }

    this.velocity.y += GRAVITY * dt;

    const pos = this.camera.position;
    pos.x += this.velocity.x * dt;
    pos.z += this.velocity.z * dt;
    pos.y += this.velocity.y * dt;

    // A fully-indoor map's ceiling (see world.js's `map.ceiling` flag) is a flat plane with no
    // notion of a per-obstacle footprint to push against — it spans the whole arena, so the
    // simplest correct model is a hard cap on how high the camera (and therefore the head, a
    // small clearance above eye level) can ever get, same spirit as the arena's own outer-bound
    // clamp on pos.x/pos.z further down. Outdoor maps pass Infinity (the default), so this is a
    // no-op everywhere except a ceilinged map. Killing upward velocity on contact (rather than
    // just clamping position every frame) is what makes hitting it actually feel like a real
    // ceiling — otherwise a jump would silently stall in midair with velocity.y still positive.
    if (pos.y + HEAD_CLEARANCE > ceilingHeight) {
      pos.y = ceilingHeight - HEAD_CLEARANCE;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    // Eye height lerps smoothly toward the standing/crouched target rather than snapping, so
    // the camera visibly sinks/rises over CROUCH_TRANSITION_RATE rather than popping instantly.
    // Feet stay anchored to the ground either way: feetY/feetTarget below are always derived
    // from *this current* (possibly mid-transition) eyeHeight, not the standing constant, so as
    // eyeHeight shrinks the camera drops to match — exactly the "crouch down" effect — rather
    // than the feet themselves shifting.
    const targetEyeHeight = this.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT;
    this.eyeHeight += (targetEyeHeight - this.eyeHeight) * Math.min(1, CROUCH_TRANSITION_RATE * dt);

    const groundHeight = getGroundHeight(pos.x, pos.z, pos.y - this.eyeHeight, obstacles);
    const feetTarget = groundHeight + this.eyeHeight;
    if (pos.y <= feetTarget) {
      pos.y = feetTarget;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    resolveCollisions(pos, RADIUS, obstacles, pos.y - this.eyeHeight, arenaBound);
  }

  // True noclip: moves along the camera's actual look direction (including pitch, so looking
  // up/down and flying forward climbs/dives) plus a world-space up/down axis from dedicated
  // keys, ignores gravity entirely, and skips resolveCollisions/getGroundHeight — a dev tool
  // for freely inspecting the map (through walls/roofs/ground), not a gameplay movement mode.
  updateFlying(dt, input) {
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();

    const moveVec = new THREE.Vector3();
    if (input.forward) moveVec.addScaledVector(forward, 1);
    if (input.back) moveVec.addScaledVector(forward, -1);
    if (input.right) moveVec.addScaledVector(right, 1);
    if (input.left) moveVec.addScaledVector(right, -1);
    if (input.up) moveVec.y += 1;
    if (input.sprint) moveVec.y -= 1; // sprint doubles as "descend" while flying — no other use for it here
    if (moveVec.lengthSq() > 0) moveVec.normalize();

    this.camera.position.addScaledVector(moveVec, FLY_SPEED * dt);
  }
}
