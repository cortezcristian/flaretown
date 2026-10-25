#!/usr/bin/env bash
# Chromium profile <-> R2, through http://flaretown.internal/profile (intercepted by the Worker:
# the ProfileSync entrypoint reads and writes this agent's R2 key; no credentials in here).
#   profile-sync.sh pull   restore at boot (before Chromium starts)
#   profile-sync.sh push   upload now
#   profile-sync.sh loop   push every PROFILE_SYNC_MINUTES
set -uo pipefail
PROFILE_DIR=/home/desktop/.config/chromium
URL=http://flaretown.internal/profile
MAX_BYTES=$((200 * 1024 * 1024))

pull() {
  mkdir -p "$PROFILE_DIR"
  if curl -fsS -o /tmp/profile.tar.gz "$URL"; then
    tar -xzf /tmp/profile.tar.gz -C "$PROFILE_DIR" && echo "profile-sync: restored"
  else
    echo "profile-sync: no saved profile"
  fi
  rm -f /tmp/profile.tar.gz
  chown -R desktop:desktop /home/desktop/.config
}

push() {
  [ -d "$PROFILE_DIR" ] || return 0
  tar -czf /tmp/profile.tar.gz -C "$PROFILE_DIR" \
    --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='CacheStorage' \
    --exclude='ScriptCache' --exclude='GrShaderCache' --exclude='ShaderCache' --exclude='Singleton*' \
    --exclude='Crashpad' . 2>/dev/null
  local size
  size=$(stat -c %s /tmp/profile.tar.gz)
  if [ "$size" -gt "$MAX_BYTES" ]; then
    echo "profile-sync: archive is $size bytes, over the 200 MB limit; not saved" >&2
  elif curl -fsS -X PUT --data-binary @/tmp/profile.tar.gz -H 'content-type: application/gzip' "$URL" >/dev/null; then
    echo "profile-sync: saved ($size bytes)"
  else
    echo "profile-sync: upload failed" >&2
  fi
  rm -f /tmp/profile.tar.gz
}

case "${1:-}" in
  pull) pull ;;
  push) push ;;
  loop) while sleep "$(( ${PROFILE_SYNC_MINUTES:-5} * 60 ))"; do push; done ;;
  *) echo "usage: profile-sync.sh pull|push|loop" >&2; exit 2 ;;
esac
