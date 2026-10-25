FROM ubuntu:26.04

ARG HERDR_VERSION=0.9.5
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TERM=xterm-256color

# Base toolchain plus everyday CLI tools (bat ships as batcat, fd as fdfind).
# libnss-myhostname: Cloudflare's container hostnames are not in /etc/hosts (read-only there), so
# sudo would complain on every use; its package adds it to nsswitch, resolving the machine's name.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client ripgrep jq less vim-tiny procps \
      build-essential python3 python3-venv nodejs npm zsh locales sudo gpg \
      gh eza bat fd-find fzf lazygit neovim tmux htop btop tree unzip sqlite3 starship openssh-server \
      libnss-myhostname \
  && ln -s /usr/bin/batcat /usr/local/bin/bat && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# Agent browser: Google Chrome (Ubuntu's chromium is a snap) on a KasmVNC display under i3.
# KasmVNC has no resolute build yet; the noble one runs unchanged.
ARG KASMVNC_VERSION=1.5.0
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
  && curl -fsSL -o /tmp/kasmvnc.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_noble_${KASMVNC_VERSION}_amd64.deb" \
  && apt-get update && apt-get install -y --no-install-recommends \
      google-chrome-stable /tmp/kasmvnc.deb i3-wm dbus-x11 x11-xserver-utils xauth ssl-cert \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  && rm -f /tmp/kasmvnc.deb /etc/apt/sources.list.d/google.list && rm -rf /var/lib/apt/lists/*

# 1Password CLI: workspaces resolve op:// references with the owner's service account token.
RUN curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main" \
      > /etc/apt/sources.list.d/1password.list \
  && apt-get update && apt-get install -y --no-install-recommends 1password-cli && rm -rf /var/lib/apt/lists/*

# chrome-devtools-mcp gives agents CDP tools (navigate, click, screenshot, console, network).
RUN npm install -g chrome-devtools-mcp@latest && npm cache clean --force

# Herdr: static binary from the official release.
RUN curl -fsSL -o /usr/local/bin/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64" \
  && chmod +x /usr/local/bin/herdr

# mise (per-user language runtimes; they live in ~/.local/share/mise, so they travel with the home
# archive) and atuin (searchable shell history in ~/.local/share/atuin).
ARG MISE_VERSION=2026.10.19
ARG ATUIN_VERSION=18.24.2
RUN curl -fsSL -o /usr/local/bin/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
  && chmod +x /usr/local/bin/mise \
  && curl -fsSL "https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/atuin-x86_64-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 --wildcards '*/atuin' \
  && mise --version && atuin --version

# Unprivileged user who owns all work. Passwordless sudo so agents can apt-get install.
# ssl-cert group: KasmVNC reads the snakeoil key at startup even with TLS off.
RUN useradd -m -s /bin/zsh -G ssl-cert dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
COPY --chmod=755 browser/agent-chrome /usr/local/bin/agent-chrome
USER dev
WORKDIR /home/dev

# Claude Code (native installer, lands in ~/.local/bin) and uv.
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH=/home/dev/.local/bin:$PATH

RUN mkdir -p ~/.vnc ~/work ~/.herdr-cloud && touch ~/.zshrc

USER root
# Image-owned config lives outside /home/dev, so restoring an older home archive onto a
# newer image cannot hide it (browser.sh re-registers Claude's browser MCP for the same reason).
# git over HTTPS to GitHub uses GITHUB_TOKEN from the environment, or else gh's login (gh auth
# login, saved and carried between workspaces by the Durable Object).
RUN git config --system credential.https://github.com.helper \
      '!f() { test "$1" = get || return 0; t=${GITHUB_TOKEN:-$(gh auth token 2>/dev/null)}; test -n "$t" && printf "username=x-access-token\\npassword=%s\\n" "$t"; }; f'
# New shells open in ~/work; a pane Herdr reopens in another folder stays there.
# atuin takes Ctrl+R; the up arrow keeps zsh's own history.
RUN printf 'export PATH=$HOME/.local/bin:$PATH\neval "$(starship init zsh)"\neval "$(mise activate zsh)"\n[[ -o interactive ]] && eval "$(atuin init zsh --disable-up-arrow)"\n[ "$PWD" = "$HOME" ] && cd ~/work 2>/dev/null\n. /opt/herdr-cloud/shell-state.zsh\n' >> /etc/zsh/zshrc
# SSH, for Herdr clients and ssh on laptops. sshd is reachable only through the Worker's /ssh/
# route, after Cloudflare Access has checked who you are, so that is the login: dev has an empty
# password, which sshd accepts as its "none" method. The image's shared host keys are removed; each
# workspace makes its own (init.sh), kept in the home folder so it survives image upgrades. The
# Durable Object signs it with the herdr-cloud SSH CA (the certificate appears after the first SSH
# connection), so laptops check it strictly. ClientAlive closes sessions whose laptop went away.
RUN rm -f /etc/ssh/ssh_host_* && passwd -d dev \
  && printf '%s\n' 'HostKey /home/dev/.herdr-cloud/ssh/ssh_host_ed25519_key' \
      'HostCertificate /home/dev/.herdr-cloud/ssh/ssh_host_ed25519_key-cert.pub' \
      'ClientAliveInterval 30' 'ClientAliveCountMax 4' 'AllowUsers dev' 'PermitRootLogin no' \
      'PasswordAuthentication yes' 'PermitEmptyPasswords yes' 'KbdInteractiveAuthentication no' 'UsePAM no' \
      'PrintMotd no' 'AcceptEnv LANG LC_* COLORTERM TERM_PROGRAM' > /etc/ssh/sshd_config.d/herdr-cloud.conf
# kasmvncserver will not start without at least one user. -DisableBasicAuth means the
# password is never used; access control is Cloudflare Access in front of the Worker.
RUN p=$(head -c 24 /dev/urandom | base64) && printf '%s\n%s\n' "$p" "$p" \
      | kasmvncpasswd -u dev -w /etc/kasmpasswd >/dev/null && chown dev /etc/kasmpasswd
COPY scripts/ /opt/herdr-cloud/
COPY browser/ /opt/herdr-cloud/browser/
COPY herdr-plugin/ /opt/herdr-cloud/herdr-plugin/
RUN chmod +x /opt/herdr-cloud/*.sh /opt/herdr-cloud/browser/xstartup
# What the image itself installed, so save-packages.sh can record only what users add.
RUN apt-mark showmanual | sort > /opt/herdr-cloud/apt-base.txt \
  && find /etc/apt/sources.list.d /etc/apt/keyrings /etc/apt/trusted.gpg.d /usr/share/keyrings -type f 2>/dev/null \
      | sort > /opt/herdr-cloud/apt-files-base.txt

# Starts the agent browser, then stays up; the Durable Object drives everything else through exec().
CMD ["/opt/herdr-cloud/init.sh"]
