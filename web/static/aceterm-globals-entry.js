// Tiny entrypoint that bundles aceterm + libterm into an IIFE and
// pins the constructor to `window.__Aceterm`. terminal-core.js
// (loaded as an ES module) reads it from there.
'use strict';
window.__Aceterm = require('./vendor/aceterm/aceterm.js');
