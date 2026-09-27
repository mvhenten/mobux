#!/bin/bash
# A full-screen app on the pane's alternate screen that appends every byte it
# reads to $1. With $2 = mouse it asks for mouse tracking (SGR), like Claude
# Code; without it, like less.
restore() {
  printf '\e[?1000l\e[?1006l\e[?1049l'
  stty sane
}
trap 'restore; exit' INT TERM
stty -icanon -echo
printf '\e[?1049h\e[H\e[2J'
[ "$2" = mouse ] && printf '\e[?1000h\e[?1006h'
echo ALT-INPUT-READY
cat >> "$1"
