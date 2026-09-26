#!/bin/bash
# A full-screen app on the pane's alternate screen: paint the same 60 lines
# three times, then leave the alternate screen.
printf '\e[?1049h'
for pass in 1 2 3; do
  printf '\e[H\e[2J'
  for i in $(seq 1 60); do echo "alt-line-$i"; done
  sleep 0.3
done
printf '\e[?1049l'
echo ALT-DONE
