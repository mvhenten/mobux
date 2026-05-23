// Bridge: aceterm.js was written for Cloud9's RequireJS module loader
// where `require("ace/...")` resolved against ace's own module system.
// In our build esbuild handles bare `./foo` paths but not `ace/...`,
// so this stub re-exports the bits aceterm asks for from the global
// Ace bundle (loaded via <script src="vendor/ace.js"> before our entry).
//
// Each file in this vendor dir that needs ace pulls from here:
//   const { dom, Range, ... } = require("./ace-stub");
// instead of:
//   const dom = require("ace/lib/dom");

'use strict';

function aceReq(path) {
  if (typeof window === 'undefined' || !window.ace) {
    throw new Error('ace-stub: window.ace not loaded — include vendor/ace.js first');
  }
  return window.ace.require(path);
}

module.exports = {
  get dom() { return aceReq('ace/lib/dom'); },
  get Range() { return aceReq('ace/range').Range; },
  get AceEditor() { return aceReq('ace/editor').Editor; },
  get EditSession() { return aceReq('ace/edit_session').EditSession; },
  get VirtualRenderer() { return aceReq('ace/virtual_renderer').VirtualRenderer; },
};
