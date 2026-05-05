// Tiny entrypoint that bundles aceterm + libterm into an IIFE and
// pins the constructor to `window.__Aceterm`. terminal-core.js
// (loaded as an ES module) reads it from there.
//
// We also expose libterm's `Terminal` class as `__Aceterm.Terminal` so
// terminal-core.js can reach the static `setColors` / `colors` /
// `scrollback` properties. Reaching them via `instance.constructor`
// does NOT work: libterm sets `Terminal.prototype = new EventEmitter()`,
// which replaces `prototype.constructor` with `EventEmitter`. Without
// this explicit pin, `instance.constructor.setColors` is undefined and
// every palette/scrollback override silently no-ops.
'use strict';
const Aceterm = require('./vendor/aceterm/aceterm.js');
Aceterm.Terminal = require('./vendor/aceterm/libterm.js');
window.__Aceterm = Aceterm;
