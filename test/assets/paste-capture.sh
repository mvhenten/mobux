#!/bin/bash
# Writes the next $3 bytes the pane reads, raw, to $1. With $2 = on it asks
# for bracketed paste (DECSET 2004) first; with off it turns it off. Gives up
# after 10 seconds so a paste that never comes cannot leave the pane raw.
stty raw -echo
if [ "$2" = on ]; then printf '\e[?2004h'; else printf '\e[?2004l'; fi
printf 'PASTE-READY\r\n'
timeout --foreground 10 dd bs=1 count="$3" of="$1" 2>/dev/null
printf '\e[?2004l'
stty sane
