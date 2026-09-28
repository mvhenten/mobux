#!/bin/bash
# Writes the next $3 bytes the pane reads, raw, to $1. With $2 = on it asks
# for bracketed paste (DECSET 2004) first; with off it turns it off.
stty raw -echo
if [ "$2" = on ]; then printf '\e[?2004h'; else printf '\e[?2004l'; fi
printf 'PASTE-READY\r\n'
dd bs=1 count="$3" of="$1" 2>/dev/null
printf '\e[?2004l'
stty sane
