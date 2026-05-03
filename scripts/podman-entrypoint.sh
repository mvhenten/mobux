#!/bin/sh
# Start a tmux server inside the container before launching mobux.
# Without this, `tmux list-sessions` on a fresh server fails with
# "error connecting to /tmp/tmux-0/default" and mobux's home page
# returns 400. The placeholder session is harmless and keeps the
# server alive across mobux restarts inside the container.
set -e
tmux start-server 2>/dev/null || true
exec /usr/local/bin/mobux "$@"
