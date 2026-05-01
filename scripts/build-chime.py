#!/usr/bin/env python3
"""
Synthesize a delightful high-C bell chime as a 16-bit mono WAV.

Run:
    python3 scripts/build-chime.py /tmp/chime.wav
    ffmpeg -y -i /tmp/chime.wav -af 'aecho=0.55:0.4:60|130|220:0.45|0.32|0.18' \
        -c:a libvorbis -q:a 5 web/static/chime.ogg

Tone is C6 (1046.5 Hz) plus stretched overtones (typical of struck-bell
partials) with exponential decay envelopes. ffmpeg's aecho adds a short
multi-tap reverb tail.
"""

import math
import struct
import sys
import wave

SR = 44100
DURATION = 1.6  # seconds before envelope cutoff

PARTIALS = [
    # (frequency_ratio_to_fundamental, decay_per_second, peak_amplitude)
    (1.00, 1.6, 0.55),
    (2.00, 2.7, 0.20),
    (3.01, 4.0, 0.10),
    (4.50, 5.5, 0.05),
]
FUNDAMENTAL = 1046.5  # C6

def synth(t):
    s = 0.0
    for ratio, decay, amp in PARTIALS:
        s += amp * math.exp(-t * decay) * math.sin(2 * math.pi * FUNDAMENTAL * ratio * t)
    # 4 ms attack ramp to avoid a click
    attack = min(1.0, t / 0.004)
    return s * attack

def main(path):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        n = int(SR * DURATION)
        frames = bytearray()
        for i in range(n):
            v = synth(i / SR)
            v = max(-0.95, min(0.95, v))
            frames += struct.pack("<h", int(v * 32767))
        w.writeframes(bytes(frames))

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <out.wav>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
