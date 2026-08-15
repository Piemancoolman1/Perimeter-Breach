import * as THREE from "three";

// Touch pixel-delta look sensitivity — a separate tuning constant from
// PointerLockControls' own internal `_MOUSE_SENSITIVITY` (0.002), since a touch drag and a
// real mouse `movementX` aren't the same unit/magnitude per equivalent turn. Still multiplied
// by `controls.pointerSpeed` below (which already blends the user's lookSensitivity/
// scopedSensitivity settings by aim progress), so the existing sensitivity settings apply to
// touch look for free without any touch-specific slider.
const TOUCH_LOOK_SCALE = 0.006;
const PI_2 = Math.PI / 2;
const LOOK_PITCH_EPSILON = 0.01; // keeps the camera just short of straight up/down, avoiding a gimbal flip
const JOYSTICK_MAX_RADIUS = 55; // px — how far the thumb visual can travel from its floating origin

// Touch is a pure input-translation layer: every gesture here either writes into the same
// `input` object keyboard already writes into, or calls the exact same functions mouse/keyboard
// already call (fireWeapon, setAiming, useAbility, etc.) — no gameplay logic lives here.
export class TouchControls {
  constructor({ camera, controls, input, moveZone, lookZone, joystickBase, joystickThumb, buttons, forced }) {
    this.camera = camera;
    this.controls = controls;
    this.input = input;
    this.joystickBase = joystickBase;
    this.joystickThumb = joystickThumb;
    this.buttons = buttons; // { fire: {el,onStart,onEnd}, aim: {...}, jump: {...}, ability: {...}, pause: {...} }
    this._forced = forced;

    this._joystickTouchId = null;
    this._joystickOriginX = 0;
    this._joystickOriginY = 0;
    this._lookTouchId = null;
    this._lookLastX = 0;
    this._lookLastY = 0;
    this._euler = new THREE.Euler(0, 0, 0, "YXZ");

    this._media = window.matchMedia("(pointer: coarse)");
    this._applyActive();
    this._media.addEventListener("change", () => this._applyActive());

    this._wireJoystick(moveZone);
    this._wireLook(lookZone);
    this._wireButtons();
  }

  get active() {
    return this._active;
  }

  setForced(forced) {
    this._forced = forced;
    this._applyActive();
  }

  _applyActive() {
    this._active = this._forced || this._media.matches;
    document.body.classList.toggle("touch-controls-active", this._active);
  }

  _wireJoystick(zone) {
    const start = (e) => {
      if (this._joystickTouchId !== null) return;
      const t = e.changedTouches[0];
      this._joystickTouchId = t.identifier;
      this._joystickOriginX = t.clientX;
      this._joystickOriginY = t.clientY;
      this.joystickBase.style.left = `${t.clientX}px`;
      this.joystickBase.style.top = `${t.clientY}px`;
      this.joystickBase.classList.add("visible");
      this.joystickThumb.style.transform = "translate(-50%, -50%)";
      e.preventDefault();
    };
    const move = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._joystickTouchId) continue;
        let dx = t.clientX - this._joystickOriginX;
        let dy = t.clientY - this._joystickOriginY;
        const dist = Math.hypot(dx, dy);
        if (dist > JOYSTICK_MAX_RADIUS) {
          dx = (dx / dist) * JOYSTICK_MAX_RADIUS;
          dy = (dy / dist) * JOYSTICK_MAX_RADIUS;
        }
        this.joystickThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        // Screen-down drag reads as "pull back" (input.moveZ negative), matching the existing
        // camera-forward convention Player.update() already applies moveZ against.
        this.input.moveX = dx / JOYSTICK_MAX_RADIUS;
        this.input.moveZ = -dy / JOYSTICK_MAX_RADIUS;
        e.preventDefault();
      }
    };
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._joystickTouchId) continue;
        this._joystickTouchId = null;
        this.input.moveX = 0;
        this.input.moveZ = 0;
        this.joystickBase.classList.remove("visible");
      }
    };
    zone.addEventListener("touchstart", start, { passive: false });
    // touchmove/touchend are tracked at window level (not the zone element) and filtered by
    // identifier — a finger that drifts outside its starting element still needs to keep
    // driving the joystick/look it started, which per-element listeners would silently drop.
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  // Shared by the look-zone's own touchstart AND the Fire button's drag-to-aim (see
  // _wireButtons) — either one just needs to claim `_lookTouchId`, since the window-level
  // touchmove/touchend listeners below already track by identifier alone, not by which element
  // the touch actually started on.
  _startLookTouch(touch) {
    if (this._lookTouchId !== null) return;
    this._lookTouchId = touch.identifier;
    this._lookLastX = touch.clientX;
    this._lookLastY = touch.clientY;
  }

  _wireLook(zone) {
    const start = (e) => {
      this._startLookTouch(e.changedTouches[0]);
      e.preventDefault();
    };
    const move = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._lookTouchId) continue;
        const dx = t.clientX - this._lookLastX;
        const dy = t.clientY - this._lookLastY;
        this._lookLastX = t.clientX;
        this._lookLastY = t.clientY;
        // Same Euler order/extraction PointerLockControls itself uses internally, so touch-look
        // and mouse-look are two input sources feeding the identical rotation math.
        this._euler.setFromQuaternion(this.camera.quaternion);
        const scale = TOUCH_LOOK_SCALE * this.controls.pointerSpeed;
        this._euler.y -= dx * scale;
        this._euler.x -= dy * scale;
        this._euler.x = Math.max(-PI_2 + LOOK_PITCH_EPSILON, Math.min(PI_2 - LOOK_PITCH_EPSILON, this._euler.x));
        this.camera.quaternion.setFromEuler(this._euler);
        e.preventDefault();
      }
    };
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._lookTouchId) continue;
        this._lookTouchId = null;
      }
    };
    zone.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  _wireButtons() {
    for (const key of Object.keys(this.buttons)) {
      const { el, onStart, onEnd, dragToAim } = this.buttons[key];
      el.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          e.stopPropagation(); // don't let a button tap also register as a look-drag start
          // dragToAim (Fire button): the same touch that starts firing also claims the look
          // touch, so dragging the thumb away from the button (finger stays down throughout —
          // touchmove/touchend keep targeting this element regardless of current position, but
          // still bubble to the window-level listeners in _wireLook, which track by identifier
          // rather than by origin element) keeps aiming while fire stays held.
          if (dragToAim) this._startLookTouch(e.changedTouches[0]);
          onStart?.();
        },
        { passive: false }
      );
      if (onEnd) {
        const release = (e) => {
          e.preventDefault();
          onEnd();
        };
        el.addEventListener("touchend", release);
        el.addEventListener("touchcancel", release);
      }
    }
  }
}
