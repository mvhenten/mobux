// Minimal Node-compatible EventEmitter shim — libterm.js asks for
// `require("events").EventEmitter`. The real Node `events` module is
// large; libterm only uses on/off/emit/removeListener.

'use strict';

class EventEmitter {
  constructor() { this._h = Object.create(null); }
  on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this; }
  addListener(ev, fn) { return this.on(ev, fn); }
  off(ev, fn) {
    const a = this._h[ev]; if (!a) return this;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    return this;
  }
  removeListener(ev, fn) { return this.off(ev, fn); }
  emit(ev, ...args) {
    const a = this._h[ev]; if (!a) return false;
    for (const fn of a.slice()) fn.apply(this, args);
    return true;
  }
  once(ev, fn) {
    const wrap = (...args) => { this.off(ev, wrap); fn.apply(this, args); };
    return this.on(ev, wrap);
  }
}

exports.EventEmitter = EventEmitter;
