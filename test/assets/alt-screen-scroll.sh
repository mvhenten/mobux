#!/bin/bash
# A full-screen app that scrolls by cursor positioning: lines written on the
# pane's bottom row and scrolled by a linefeed, then inside a scroll region
# above a status line, scrolled by a linefeed and by CSI S. It opens by
# repainting the same ten lines three times.
rows=$(stty size | cut -d' ' -f1)
region=$((rows - 1))
printf '\e[?1049h'
for pass in 1 2 3; do
  printf '\e[H\e[2J'
  for i in $(seq 1 10); do printf '\e[%d;1Hrepaint-line-%d' "$i" "$i"; done
  sleep 0.1
done
printf '\e[H\e[2J'
for i in $(seq 1 20); do printf '\e[%d;1Hbottom-line-%d\n' "$rows" "$i"; done
sleep 0.2
printf '\e[H\e[2J\e[1;%dr\e[%d;1Hstatus-line' "$region" "$rows"
for i in $(seq 1 20); do printf '\e[%d;1Hregion-line-%d\n' "$region" "$i"; done
for i in $(seq 1 20); do printf '\e[%d;1Hsu-line-%d\e[S' "$region" "$i"; done
sleep 0.2
printf '\e[r\e[?1049l'
echo SCROLL-DONE
