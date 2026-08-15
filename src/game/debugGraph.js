const HISTORY = 180; // ~3s of samples at 60fps; scrolls at whatever rate frames actually arrive
const FRAME_SCALE_MS = 50; // bars clip above this; still shows full-height red so spikes are obvious
const GOOD_MS = 1000 / 60;
const OK_MS = 1000 / 30;

function colorForFrameMs(ms) {
  if (ms <= GOOD_MS) return "#4de3ff";
  if (ms <= OK_MS) return "#ffd35c";
  return "#ff4d5e";
}

class Sparkline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.values = [];
  }

  push(value) {
    this.values.push(value);
    if (this.values.length > HISTORY) this.values.shift();
  }

  get last() {
    return this.values.length ? this.values[this.values.length - 1] : 0;
  }
}

export class DebugGraphs {
  constructor({ frameCanvas, geoCanvas, loadCanvas, frameLegendEl, geoLegendEl, loadLegendEl }) {
    this.frame = new Sparkline(frameCanvas);
    this.geo = new Sparkline(geoCanvas);
    this.enemies = new Sparkline(loadCanvas);
    this.fx = [];
    this.frameLegendEl = frameLegendEl;
    this.geoLegendEl = geoLegendEl;
    this.loadLegendEl = loadLegendEl;

    this.events = []; // { age, type: 'shot' | 'kill' }
  }

  markShot() {
    this.events.push({ age: 0, type: "shot" });
  }

  markKill() {
    this.events.push({ age: 0, type: "kill" });
  }

  push(frameMs, geoCount, enemyCount, fxCount) {
    this.frame.push(frameMs);
    this.geo.push(geoCount);
    this.enemies.push(enemyCount);
    this.fx.push(fxCount);
    if (this.fx.length > HISTORY) this.fx.shift();

    for (const e of this.events) e.age++;
    this.events = this.events.filter((e) => e.age < HISTORY);
  }

  draw() {
    this._drawFrameGraph();
    this._drawGeoGraph();
    this._drawLoadGraph();
  }

  _clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }

  _drawFrameGraph() {
    const { canvas, ctx, values } = this.frame;
    const w = canvas.width;
    const h = canvas.height;
    this._clear(ctx, w, h);

    const barW = w / HISTORY;

    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.setLineDash([2, 3]);
    for (const ms of [GOOD_MS, OK_MS]) {
      const y = h - (ms / FRAME_SCALE_MS) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    values.forEach((ms, i) => {
      const x = i * barW;
      const barH = Math.min(1, ms / FRAME_SCALE_MS) * h;
      ctx.fillStyle = colorForFrameMs(ms);
      ctx.fillRect(x, h - barH, Math.max(1, barW - 1), barH);
    });

    for (const e of this.events) {
      const x = w - (e.age / HISTORY) * w;
      ctx.fillStyle = e.type === "shot" ? "#4de3ff" : "#ff4d5e";
      ctx.beginPath();
      ctx.arc(x, 4, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const max = values.length ? Math.max(...values) : 0;
    this.frameLegendEl.textContent = `avg ${avg.toFixed(1)} / max ${max.toFixed(1)} ms`;
  }

  _drawGeoGraph() {
    const { canvas, ctx, values } = this.geo;
    const w = canvas.width;
    const h = canvas.height;
    this._clear(ctx, w, h);
    if (values.length < 2) return;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max(1, (max - min) * 0.2);
    const lo = min - pad;
    const hi = max + pad;
    const range = hi - lo || 1;

    const stepX = w / (HISTORY - 1);
    const offset = HISTORY - values.length;

    ctx.strokeStyle = "#9be9ff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = (offset + i) * stepX;
      const y = h - ((v - lo) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const rising = values[values.length - 1] > values[0] + Math.max(2, values[0] * 0.1);
    this.geoLegendEl.textContent = rising
      ? `cur ${this.geo.last} (climbing — possible leak)`
      : `cur ${this.geo.last} (min ${min} / max ${max})`;
    this.geoLegendEl.style.color = rising ? "#ff4d5e" : "";
  }

  _drawLoadGraph() {
    const { canvas, ctx, values: enemyValues } = this.enemies;
    const fxValues = this.fx;
    const w = canvas.width;
    const h = canvas.height;
    this._clear(ctx, w, h);
    if (enemyValues.length < 2) return;

    const maxScale = Math.max(6, ...enemyValues, ...fxValues);
    const stepX = w / (HISTORY - 1);
    const offsetE = HISTORY - enemyValues.length;
    const offsetF = HISTORY - fxValues.length;

    const drawLine = (vals, offset, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      vals.forEach((v, i) => {
        const x = (offset + i) * stepX;
        const y = h - (v / maxScale) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawLine(fxValues, offsetF, "#4de3ff");
    drawLine(enemyValues, offsetE, "#ff9a4d");

    this.loadLegendEl.textContent = `enemies ${this.enemies.last} · fx ${this.fx[this.fx.length - 1] ?? 0}`;
  }
}
