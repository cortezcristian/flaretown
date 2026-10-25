# Flaretown default desktop image (task 014, SPEC-containers 0).
# Minimal Linux + Xvfb + minimal XFCE + Chromium + noVNC + agent-browser.
# Size budget: under 1.5 GB. Runs as the agent's container (ctx.container), default instance standard-1.
FROM docker.io/library/debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    SCREEN_GEOMETRY=1440x900x24 \
    LANG=C.UTF-8 \
    PROFILE_SYNC_MINUTES=5

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils procps ca-certificates curl tar gzip \
      xvfb x11vnc websockify xclip dbus-x11 \
      xfwm4 xfce4-panel xfce4-terminal xfconf \
      chromium fonts-liberation \
      less vim tmux \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* \
       /usr/share/locale/* /var/cache/debconf/*-old

# noVNC web client: pinned upstream release, static files only (references/noVNC is 1.7.0).
ARG NOVNC_VERSION=1.7.0
RUN curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" | tar -xz -C /tmp \
    && mkdir -p /opt/novnc \
    && cd /tmp/noVNC-${NOVNC_VERSION} \
    && cp -r app core vendor vnc.html vnc_lite.html defaults.json mandatory.json /opt/novnc/ \
    && rm -rf /tmp/noVNC-${NOVNC_VERSION}

# agent-browser native binary, pinned (references/agent-browser is 0.39.2).
ARG AGENT_BROWSER_VERSION=0.39.2
RUN curl -fsSL -o /usr/local/bin/agent-browser \
      "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-linux-x64" \
    && chmod +x /usr/local/bin/agent-browser

RUN useradd -m -s /bin/bash desktop
COPY agent-browser.json /etc/agent-browser.json
COPY flaretown-env.sh /etc/profile.d/flaretown.sh
COPY pbcopy pbpaste profile-sync.sh start.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/pbcopy /usr/local/bin/pbpaste /usr/local/bin/profile-sync.sh /usr/local/bin/start.sh

EXPOSE 6080
CMD ["/usr/local/bin/start.sh"]
