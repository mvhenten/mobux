#!/bin/sh
# Fresh host key on every container start (never baked into the image,
# so containers never share one) and a tmux server that only exists
# inside this container's own PID/mount namespace.
set -e
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
exec /usr/sbin/sshd -D -e
