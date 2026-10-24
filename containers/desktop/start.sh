#!/usr/bin/env bash
# Starts the desktop. Exits when any process dies, so the container stops instead of half-working.
set -euo pipefail

profile-sync.sh pull || true

Xvfb :1 -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done

# Minimal XFCE: window manager + panel (terminal from the panel's launcher or right-click).
su desktop -c "dbus-launch --exit-with-session sh -c 'xfwm4 & xfce4-panel & wait'" &

su desktop -c "chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --start-maximized --user-data-dir=/home/desktop/.config/chromium \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank" &

# VNC on localhost only; noVNC (websockify) on 6080 is reached only through the Worker.
x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -localhost -quiet &
websockify --web /opt/novnc 6080 localhost:5900 &

profile-sync.sh loop &

wait -n
exit 1
