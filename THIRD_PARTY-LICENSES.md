# Third-Party Licenses

This document contains the full license texts and attribution notices for third-party software included in mobux.

mobux ships two interchangeable terminal renderers (selected at runtime via
`mobux:renderer` in localStorage):

- **xterm.js** — bundled into `web/static/vendor/xterm.bundle.js`
- **@kattebak/sterk** — bundled into `web/static/vendor/sterk.bundle.js`
  (sterk bundles the Ace editor as a dependency)

Monospace web fonts are copied to `web/static/vendor/fonts/`.

---

## xterm.js

**Bundled into**: `web/static/vendor/xterm.bundle.js` (with `xterm.css`)  
**Packages**: `@xterm/xterm`, `@xterm/addon-web-links`  
**License**: MIT  
**Copyright**: The xterm.js authors  
**Upstream**: https://github.com/xtermjs/xterm.js

```
Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## @kattebak/sterk

**Bundled into**: `web/static/vendor/sterk.bundle.js`  
**Package**: `@kattebak/sterk`  
**License**: MIT  
**Upstream**: https://github.com/kattebak/sterk

sterk is a clean-room, MIT-licensed terminal emulator/renderer. It bundles
the Ace editor (see below) as a runtime dependency.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## Ace Editor

**Bundled into**: `web/static/vendor/sterk.bundle.js` (as a dependency of `@kattebak/sterk`)  
**Package**: `ace-builds`  
**License**: BSD-3-Clause  
**Copyright**: Ajax.org B.V.  
**Upstream**: https://github.com/ajaxorg/ace

```
Copyright (c) 2010, Ajax.org B.V.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of Ajax.org B.V. nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL AJAX.ORG B.V. BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## Monospace fonts

**Files**: `web/static/vendor/fonts/*.woff2`  
**Provenance**: bundled with `@kattebak/sterk`

The five primary monospace fonts (JetBrains Mono, IBM Plex Mono, Cascadia
Mono, Fira Mono, Source Code Pro) are TUI-coverage subsets licensed under the
**SIL Open Font License, Version 1.1 (OFL-1.1)**. `SterkTUISymbols.woff2` is a
renamed subset of DejaVu Sans Mono (a Bitstream Vera derivative) supplying
box-drawing/dingbat glyphs, used via `unicode-range`.

The full per-font copyright notices and complete license texts are shipped
verbatim alongside the fonts in
[`web/static/vendor/fonts/LICENSES.txt`](web/static/vendor/fonts/LICENSES.txt).
