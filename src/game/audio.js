// Web Audio-based sound bank. Uses AudioBufferSourceNode rather than <audio> elements so
// overlapping plays (rapid AK-47 fire, footsteps) don't need manual pooling/cloning — each
// play() spins up a fresh, cheap source node from the same decoded buffer.
const BASE_VOLUME = 0.8;

export class SoundBank {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.buffers = new Map();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = BASE_VOLUME;
    this.masterGain.connect(this.ctx.destination);
  }

  // Two browser windows open side by side (the normal way to test multiplayer solo, or just
  // an unfocused tab in the background) still share the same physical speakers — each is a
  // separate, fully independent Web Audio context, so there's no way for one client's sounds
  // to literally reach another networked player, but muting whichever tab isn't the one
  // you're actually looking at stops its sounds from bleeding into whichever one you are.
  setTabMuted(muted) {
    this.masterGain.gain.value = muted ? 0 : BASE_VOLUME;
  }

  async load(name, url) {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.buffers.set(name, audioBuffer);
  }

  async loadAll(entries) {
    await Promise.all(entries.map(([name, url]) => this.load(name, url)));
  }

  // Safe to call even if a name failed to load (e.g. offline) — just silently does nothing.
  // offset/duration let a longer ambient loop (e.g. a footstep-loop recording) be carved into
  // one short one-shot per call, so a single asset can stand in for a discrete cue.
  play(name, { volume = 1, rate = 1, detune = 0, offset = 0, duration } = {}) {
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    if (detune) source.detune.value = detune;

    const gain = this.ctx.createGain();
    gain.gain.value = volume;

    source.connect(gain).connect(this.masterGain);
    if (duration !== undefined) {
      source.start(0, offset, duration);
    } else {
      source.start(0);
    }
  }

  resume() {
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
}
