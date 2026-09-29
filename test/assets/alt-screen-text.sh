#!/bin/bash
# A full-screen app on the pane's alternate screen: every argument but the
# last on its own row from the top, the last on the pane's bottom row, until
# it reads a line.
rows=$(stty size | cut -d' ' -f1)
printf '\e[?1049h\e[H\e[2J'
for line in "${@:1:$#-1}"; do printf '%s\r\n' "$line"; done
printf '\e[%s;1H%s' "$rows" "${!#}"
read -r _
printf '\e[?1049l'
