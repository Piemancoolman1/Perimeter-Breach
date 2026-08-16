import { el } from "./dom.js";

const heapSupported = typeof performance !== "undefined" && !!performance.memory;

// F3 debug overlay (fps/frame time/render stats/heap). `ctx.clock` is the same THREE.Clock
// main.js's animate() loop already advances every frame via clock.getDelta() — this only
// reads its elapsed time, never ticks it itself.
export function createDebugPanel(ctx) {
  const frameTimes = [];
  let frameMaxMs = 0;
  let frameMaxResetAt = 0;
  let debugUpdateAccum = 0;

  function updateDebugPanel(rawDt) {
    const ms = rawDt * 1000;
    frameTimes.push(ms);
    if (frameTimes.length > 90) frameTimes.shift();

    if (ctx.clock.getElapsedTime() - frameMaxResetAt > 1) {
      frameMaxMs = 0;
      frameMaxResetAt = ctx.clock.getElapsedTime();
    }
    if (ms > frameMaxMs) frameMaxMs = ms;

    debugUpdateAccum += rawDt;
    if (debugUpdateAccum < 0.2) return;
    debugUpdateAccum = 0;

    const avgMs = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    const fps = avgMs > 0 ? 1000 / avgMs : 0;

    let lightCount = 0;
    ctx.scene.traverse((obj) => {
      if (obj.isLight) lightCount++;
    });

    el.dbgFps.textContent = fps.toFixed(0);
    el.dbgFrame.textContent = `${avgMs.toFixed(1)} / ${frameMaxMs.toFixed(1)} ms`;
    el.dbgCalls.textContent = ctx.renderer.info.render.calls;
    el.dbgTris.textContent = ctx.renderer.info.render.triangles.toLocaleString();
    el.dbgGeo.textContent = ctx.renderer.info.memory.geometries;
    el.dbgTex.textContent = ctx.renderer.info.memory.textures;
    el.dbgLights.textContent = lightCount;
    el.dbgEnemies.textContent = ctx.enemies.length;
    el.dbgFx.textContent = ctx.vfx.activeFx;
    el.dbgHeap.textContent = heapSupported
      ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
      : "n/a";
  }

  return { updateDebugPanel };
}
