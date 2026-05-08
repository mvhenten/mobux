# Sterk API Gaps Blocking Mobux PR #71

## Critical: write() callback fires before buffer is populated

**Status:** Blocks all 5 failing e2e tests on CI

**Evidence:**
- Locally (fast machine): write callback resolves → buffer has all 300 injected lines
- CI (slower): write callback resolves → buffer has only 20-55 lines (10-20% of injected data)

**Root cause:**
Sterk's `Terminal.write()` calls the callback synchronously after `vtParser.write(data)`:

```typescript
write(data: string | Uint8Array, callback?: () => void): void {
  this.vtParser.write(data);
  this.aceRenderer?.scheduleUpdate();
  this.emitter.emit("write-parsed");
  if (callback) callback();  // ← Fires immediately
}
```

The VT parser doesn't guarantee all data is written to the buffer by the time this callback fires. On CI, large writes (300 lines) complete the callback before the buffer is actually populated.

**Proposed fix:**
The write callback should only fire AFTER the buffer is guaranteed to contain all parsed data. Options:
1. Make `vtParser.write()` return a Promise that resolves when buffer is updated
2. Move the callback into the final VT parser handler after the last cell is written
3. Add a `flushWrites()` method that waits for all pending writes to complete

**Workaround attempted:**
Polling for expected buffer length after write completes - but this times out on CI because the buffer NEVER reaches the expected size (data is lost, not just delayed).

**Impact on mobux:**
- Cannot reliably test terminal state after writes
- Reader view rendering depends on buffer state
- Scroll operations depend on buffer state
- All 5 failing tests (#1, #2, #3, #4, #5) are blocked by this

## Minor: No public API to check alternate screen mode

**Status:** Nice-to-have for debugging

**Current:**
`BufferNamespace.isAlternate()` is an internal method, not exposed via the public Terminal API.

**Requested:**
Add `Terminal.isAlternateScreenActive(): boolean` to help diagnose buffer state issues.

## Tests affected

1. `scroll works via touch gesture` - buffer never populated, viewportY stays 0
2. `URLs in terminal output are tappable` - URL text never appears in buffer
3. `terminal picks readable fg by bg luminance` - SGR sequences not rendered
4. `synthetic viewport: not sticky when scrolled up` - reader buffer adapter broken
5. `synthetic viewport: history smoke renders blocks` - reader rendering times out

All 5 fail because the buffer doesn't contain the expected data after writes complete.
