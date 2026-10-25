#!/usr/bin/env bash
# Image contract for containers/<name>/ (task 014, containers/README.md). Needs Docker.
#   pnpm check:images            all images
#   pnpm check:images desktop    one image
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
budget_mb() { # half of the default instance disk, desktop has its own budget
  case "$1" in
    desktop) echo 1536 ;;
    *) echo 2048 ;; # custom images default to basic (4 GB disk)
  esac
}

[ -f containers/.dockerignore ] || { echo "✘ containers/.dockerignore missing"; fail=1; }

for dir in containers/*/; do
  name=$(basename "$dir")
  [ -f "$dir/Dockerfile" ] || continue
  if [ $# -gt 0 ] && [ "$1" != "$name" ]; then continue; fi
  echo "── $name"
  [ -f "$dir/.dockerignore" ] || { echo "  ✘ .dockerignore missing (start with '*' and allow only what the Dockerfile copies)"; fail=1; }

  refs=$(grep -c "\"$name\": { \"dockerfile\": \"./containers/$name/Dockerfile\" }" wrangler.jsonc || true)
  [ "$refs" -ge 3 ] || { echo "  ✘ not in images of all three containers entries in wrangler.jsonc (found $refs)"; fail=1; }

  tag="flaretown-check-$name"
  if ! docker build --platform linux/amd64 -q -t "$tag" "$dir" >/dev/null; then
    echo "  ✘ docker build failed"; fail=1; continue
  fi
  arch=$(docker image inspect -f '{{.Architecture}}' "$tag")
  [ "$arch" = "amd64" ] || { echo "  ✘ architecture is $arch, must be amd64"; fail=1; }

  size_mb=$(( $(docker image inspect -f '{{.Size}}' "$tag") / 1024 / 1024 ))
  max=$(budget_mb "$name")
  if [ "$size_mb" -gt "$max" ]; then echo "  ✘ ${size_mb} MB, budget ${max} MB"; fail=1; else echo "  ✔ ${size_mb} MB (budget ${max} MB)"; fi

  if docker run --rm --platform linux/amd64 --entrypoint bash "$tag" -lc 'command -v timeout >/dev/null'; then
    echo "  ✔ bash and timeout"
  else
    echo "  ✘ needs bash and coreutils timeout (sandbox_run uses timeout ... bash -lc)"; fail=1
  fi

  if [ "$name" = "desktop" ]; then
    missing=$(docker run --rm --platform linux/amd64 --entrypoint bash "$tag" -lc \
      'for c in Xvfb xfwm4 xfce4-panel xfce4-terminal chromium x11vnc websockify agent-browser xclip pbcopy pbpaste less vim tmux curl profile-sync.sh; do command -v "$c" >/dev/null || echo "$c"; done; [ -f /opt/novnc/vnc.html ] || echo novnc')
    if [ -n "$missing" ]; then echo "  ✘ missing: $(echo $missing)"; fail=1; else echo "  ✔ desktop tools present"; fi
  fi
done

[ $fail -eq 0 ] && echo "All images OK" || { echo "Image check failed"; exit 1; }
