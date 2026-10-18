#!/usr/bin/env bash
# Codespace workspace image setup.
#
# Runs as the Image Builder component (CODESPACE_VARIANT is set from the recipe) and also by hand
# on a fresh Ubuntu 22.04 instance as root:
#
#   sudo CODESPACE_VARIANT=cpu-arm64 bash setup.sh
#
# Idempotent: every step checks or overwrites its own state, so re-running is safe.
#
# Under Image Builder the script runs twice. The first pass installs everything and switches the
# SSM agent from the snap to AWS's .deb, but can't remove the snap agent that is running it. It
# exits 194, AWSTOE reboots the instance and re-runs the step, now under the .deb agent, and the
# second pass purges snapd and records a boot profile.
# Contract: docs/aws-cutover.md, "Image contents". Paths must match src/server/workspaces.ts.
set -euo pipefail
set -x

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
export HOME=/root
export PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

TTYD_VERSION=1.7.7
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.63.0}"
BROWSERS_DIR=/opt/ms-playwright

log() { set +x; printf '\n==> %s\n' "$*"; set -x; }
die() { set +x; printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "expected Ubuntu, got ${ID:-unknown}"
[ "${VERSION_ID:-}" = "22.04" ] || echo "WARNING: built for Ubuntu 22.04, this is ${VERSION_ID:-unknown}" >&2

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

VARIANT="${CODESPACE_VARIANT:-}"
case "$VARIANT" in
  gpu-*) GPU=1 ;;
  cpu-*) GPU=0 ;;
  "") if command -v nvidia-smi >/dev/null 2>&1; then GPU=1; else GPU=0; fi ;;
  *) die "unknown CODESPACE_VARIANT $VARIANT" ;;
esac
log "variant=${VARIANT:-auto} gpu=$GPU arch=$(uname -m)"

# A fresh instance may still be running cloud-init (and its apt runs) when this starts.
if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null || true; fi

apt_get() { apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }

# True when an ancestor process matches: by executable path prefix ("exe:/snap/...") or name.
ancestor() {
  local want="$1" pid="$PPID" exe comm
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
    case "$want" in
      exe:*) [[ "$exe" == "${want#exe:}"* ]] && return 0 ;;
      *) [ "$comm" = "$want" ] && return 0 ;;
    esac
    pid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)"
  done
  return 1
}
under_snap_agent() { ancestor exe:/snap/amazon-ssm-agent/; }
under_toe() { ancestor awstoe; }
NEED_REBOOT=0

# ---- Keep snap browsers out ------------------------------------------------------------------
# On 22.04 the chromium-browser and firefox debs are shims that install snaps. Snaps don't run
# well as root under a bare Xvfb, so forbid them; the browser comes from Playwright below.
cat >/etc/apt/preferences.d/codespace-no-snap-browsers <<'EOF'
Package: chromium-browser chromium-browser-l10n chromium-chromedriver firefox
Pin: release o=Ubuntu
Pin-Priority: -1
EOF

# ---- Base packages ---------------------------------------------------------------------------
log "Base packages"
apt_get update -q
apt_get install -y -q --no-install-recommends \
  ca-certificates curl gnupg jq git ripgrep tmux build-essential python3 python3-pip python3-venv \
  unzip xz-utils less procps openssh-server cloud-init
if [ "$GPU" = 0 ]; then
  apt_get install -y -q --no-install-recommends ec2-hibinit-agent
fi

# ---- Desktop: Xvfb + XFCE + x11vnc + noVNC/websockify ---------------------------------------
# --no-install-recommends keeps screensavers, lockers and snap-backed browsers out.
log "Desktop"
apt_get install -y -q --no-install-recommends \
  xvfb x11vnc novnc websockify python3-numpy \
  xfce4 xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar \
  dbus-x11 x11-xserver-utils xdg-utils fonts-dejavu-core fonts-liberation fonts-noto-color-emoji
[ -d /usr/share/novnc ] || die "/usr/share/novnc missing after installing novnc"

# ---- gh (official apt repo) ------------------------------------------------------------------
log "GitHub CLI"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg.new
mv /etc/apt/keyrings/githubcli-archive-keyring.gpg.new /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  >/etc/apt/sources.list.d/github-cli.list
apt_get update -q
apt_get install -y -q gh

# ---- Node LTS into /usr/local ----------------------------------------------------------------
log "Node LTS"
NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version')"
[ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" != null ] || die "could not resolve the Node LTS version"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  tarball="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm -rf "$tmp"
fi
/usr/local/bin/node --version
/usr/local/bin/npm --version

# ---- ttyd ------------------------------------------------------------------------------------
log "ttyd $TTYD_VERSION"
if ! /usr/local/bin/ttyd --version 2>/dev/null | grep -q "$TTYD_VERSION"; then
  tmp="$(mktemp -d)"
  asset="ttyd.$(uname -m)"
  curl -fsSL -o "$tmp/$asset" "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}"
  curl -fsSL -o "$tmp/SHA256SUMS" "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS"
  (cd "$tmp" && grep " ${asset}\$" SHA256SUMS | sha256sum -c -)
  install -m 0755 "$tmp/$asset" /usr/local/bin/ttyd
  rm -rf "$tmp"
fi
/usr/local/bin/ttyd --version

# ---- Browser: Playwright's Chromium build ----------------------------------------------------
# Why: Ubuntu 22.04's chromium is a snap, Google Chrome has no supported Linux arm64 build, and a
# third-party PPA would add an unvetted package source. Playwright publishes first-party Chromium
# builds for Ubuntu 22.04 on both x86_64 and arm64, as plain files with their apt dependencies
# installed by --with-deps. It's also what Playwright-based MCP servers drive. It doesn't
# auto-update; the weekly (or manual) image rebuild refreshes it.
log "Chromium (Playwright $PLAYWRIGHT_VERSION)"
install -d -m 0755 "$BROWSERS_DIR"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" /usr/local/bin/npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps --no-shell chromium
CHROME_BIN="$(find "$BROWSERS_DIR" -maxdepth 3 -type f -name chrome -path '*/chromium-*/*' | sort -V | tail -n1)"
[ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ] || die "Playwright Chromium binary not found under $BROWSERS_DIR"
chmod -R a+rX "$BROWSERS_DIR"
# Root needs --no-sandbox; /dev/shm is small on some instance types.
cat >/usr/local/bin/chromium <<EOF
#!/bin/sh
exec "$CHROME_BIN" --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check "\$@"
EOF
chmod 0755 /usr/local/bin/chromium
update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/chromium 200
update-alternatives --set x-www-browser /usr/local/bin/chromium
cat >/usr/share/applications/codespace-chromium.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Chromium
GenericName=Web Browser
Exec=/usr/local/bin/chromium %U
Icon=web-browser
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
EOF
install -d /usr/share/xfce4/helpers /etc/xdg/xfce4
cat >/usr/share/xfce4/helpers/codespace-chromium.desktop <<'EOF'
[Desktop Entry]
Version=1.0
Type=X-XFCE-Helper
Name=Chromium
Icon=web-browser
X-XFCE-Category=WebBrowser
X-XFCE-Commands=/usr/local/bin/chromium
X-XFCE-CommandsWithParameter=/usr/local/bin/chromium "%s"
EOF
printf 'WebBrowser=codespace-chromium\n' >/etc/xdg/xfce4/helpers.rc
cat >/etc/xdg/mimeapps.list <<'EOF'
[Default Applications]
text/html=codespace-chromium.desktop
x-scheme-handler/http=codespace-chromium.desktop
x-scheme-handler/https=codespace-chromium.desktop
EOF
# Lets Playwright tooling run as root find this browser without downloading another copy.
grep -q '^PLAYWRIGHT_BROWSERS_PATH=' /etc/environment 2>/dev/null \
  && sed -i "s|^PLAYWRIGHT_BROWSERS_PATH=.*|PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR|" /etc/environment \
  || echo "PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR" >>/etc/environment

# ---- Claude Code for root --------------------------------------------------------------------
log "Claude Code"
curl -fsSL https://claude.ai/install.sh | bash
[ -x /root/.local/bin/claude ] || die "claude not at /root/.local/bin/claude"
/root/.local/bin/claude --version

# ---- sshd: loopback only, root by key ---------------------------------------------------------
# SSH arrives through SSM (AWS-StartSSHSession dials localhost:22). sshd_config on 22.04 includes
# sshd_config.d/*.conf first, and the first value for a keyword wins, hence the 00- prefix.
log "sshd"
cat >/etc/ssh/sshd_config.d/00-codespace.conf <<'EOF'
ListenAddress 127.0.0.1
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AcceptEnv CLAUDE_* CS_* MCP_* DISABLE_* ANTHROPIC_*
# The app multiplexes every thread, port forward and command over one connection per workspace;
# the default of 10 channels is too low.
MaxSessions 64
# cloud-init generates only these two on first boot (RSA keygen is the slow one).
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_ecdsa_key
EOF
grep -Eq '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config \
  || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
ssh-keygen -A
sshd -t
systemctl enable ssh.service
systemctl is-active --quiet ssh.service && systemctl reload ssh.service || true

# ---- Root's .ssh, and cloud-init ----------------------------------------------------------------
# The app's user-data (cloud-config, deferred write_files append) adds its key to
# /root/.ssh/authorized_keys on first boot. Image Builder's cleanup deletes authorized_keys, so a
# tmpfiles rule recreates the directory with the right mode at every boot before cloud-init runs.
log "cloud-init and /root/.ssh"
install -d -m 0700 -o root -g root /root/.ssh
cat >/etc/tmpfiles.d/codespace.conf <<'EOF'
d /root/.ssh 0700 root root -
d /run/codespace 0755 root root -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/codespace.conf
rm -f /etc/cloud/cloud-init.disabled
# Trimmed to what a workspace needs; the stock lists also run apt mirror rewrites, snap, lxd,
# landscape, ubuntu-advantage, ntp, keyboard/locale, fan, byobu and so on, on every first boot.
# Kept: users-groups, write_files (early and `defer: true`), ssh host keys + root key policy,
# hostname, growpart/resizefs for bigger root volumes, mounts (swap/ephemeral), and the
# bootcmd/runcmd/scripts hooks so user-data scripts and the DLAMI's own hooks still run.
# The 99- prefix sorts after the image's own cloud.cfg.d files, so these keys win.
cat >/etc/cloud/cloud.cfg.d/99-codespace.cfg <<'EOF'
# Codespace logs in as root with a key supplied in user-data.
disable_root: false
datasource_list: [ Ec2 ]
ssh_deletekeys: true
ssh_genkeytypes: [ ed25519, ecdsa ]
ssh_quiet_keygen: true
cloud_init_modules:
  - migrator
  - seed_random
  - bootcmd
  - write_files
  - growpart
  - resizefs
  - disk_setup
  - mounts
  - set_hostname
  - update_hostname
  - update_etc_hosts
  - users_groups
  - ssh
cloud_config_modules:
  - runcmd
cloud_final_modules:
  - scripts_vendor
  - scripts_per_once
  - scripts_per_boot
  - scripts_per_instance
  - scripts_user
  - write_files_deferred
EOF
cloud-init schema --system >/dev/null 2>&1 || cloud-init schema --config-file /etc/cloud/cloud.cfg.d/99-codespace.cfg
systemctl enable cloud-init-local.service cloud-init.service cloud-config.service cloud-final.service
# write_files `defer: true` (used by the app) needs cloud-init 21.3+; the contract asks for 22.1+.
CI_VERSION="$(cloud-init --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
[ "$(printf '%s\n22.1\n' "$CI_VERSION" | sort -V | head -n1)" = "22.1" ] || die "cloud-init $CI_VERSION is older than 22.1"

# ---- amazon-ssm-agent: the .deb, not the snap -------------------------------------------------
# The snap agent waits on snapd (seeding, squashfs mounts, apparmor) at every boot, which is most
# of the delay before SSM answers. AWS's .deb runs as a plain systemd service.
log "amazon-ssm-agent (.deb)"
if ! dpkg-query -W -f='${Status}' amazon-ssm-agent 2>/dev/null | grep -q "install ok installed"; then
  deb_arch="$(dpkg --print-architecture)"
  token="$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  region="$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)"
  tmp="$(mktemp -d)"
  if [ -z "$region" ] || ! curl -fsSL -o "$tmp/amazon-ssm-agent.deb" \
      "https://s3.${region}.amazonaws.com/amazon-ssm-${region}/latest/debian_${deb_arch}/amazon-ssm-agent.deb"; then
    curl -fsSL -o "$tmp/amazon-ssm-agent.deb" \
      "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/debian_${deb_arch}/amazon-ssm-agent.deb"
  fi
  # Don't let the package start a second agent next to the one that may be running this script.
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod 0755 /usr/sbin/policy-rc.d
  dpkg -i "$tmp/amazon-ssm-agent.deb" || { rm -f /usr/sbin/policy-rc.d; die "dpkg -i amazon-ssm-agent.deb failed"; }
  rm -f /usr/sbin/policy-rc.d
  rm -rf "$tmp"
fi
systemctl enable amazon-ssm-agent.service
SNAP_AGENT_UNIT=snap.amazon-ssm-agent.amazon-ssm-agent.service
if under_snap_agent; then
  # The snap agent is running us (Image Builder, or a Session Manager shell). Keep it alive for
  # now, make sure the .deb agent isn't running beside it, and stop the snap one from coming back.
  systemctl stop amazon-ssm-agent.service 2>/dev/null || true
  systemctl disable "$SNAP_AGENT_UNIT" 2>/dev/null || true
  systemctl mask "$SNAP_AGENT_UNIT"
  NEED_REBOOT=1
else
  if systemctl cat "$SNAP_AGENT_UNIT" >/dev/null 2>&1; then
    systemctl disable --now "$SNAP_AGENT_UNIT" 2>/dev/null || true
    systemctl mask "$SNAP_AGENT_UNIT"
  fi
  systemctl start amazon-ssm-agent.service
fi

# ---- Hibernation (CPU variants) ---------------------------------------------------------------
if [ "$GPU" = 0 ]; then
  log "Hibernation: hibinit agent, KASLR off"
  HIBINIT_UNIT="$(systemctl list-unit-files --no-legend 'hibinit*' | awk '{print $1}' | head -n1)"
  [ -n "$HIBINIT_UNIT" ] || die "ec2-hibinit-agent installed no systemd unit"
  systemctl enable "$HIBINIT_UNIT"
  # AWS recommends disabling KASLR for hibernation on Ubuntu. Appended after the cloud image's
  # 50-cloudimg-settings.cfg, which sets GRUB_CMDLINE_LINUX_DEFAULT.
  cat >/etc/default/grub.d/99-codespace-nokaslr.cfg <<'EOF'
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT nokaslr"
EOF
fi

# ---- Boot loader and kernel cmdline -----------------------------------------------------------
# No menu wait, and no 30s recordfail pause after an unclean stop (spot reclaim, forced stop).
# `quiet` keeps kernel messages off the serial console, which is slow to write to; the console
# log still shows systemd's failures. resume=/resume_offset (set by the hibinit agent) and the
# DLAMI's own parameters are left alone.
log "GRUB"
cat >/etc/default/grub.d/98-codespace-boot.cfg <<'EOF'
GRUB_TIMEOUT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_RECORDFAIL_TIMEOUT=0
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT quiet"
EOF
update-grub
if [ "$GPU" = 0 ]; then grep -q nokaslr /boot/grub/grub.cfg || die "nokaslr missing from grub.cfg"; fi

# ---- Spot interruption watcher ----------------------------------------------------------------
# Polls IMDSv2 every 5s. On a notice, writes the JSON body to /run/codespace/interruption; clears
# it when the notice is gone (e.g. after resuming from a spot hibernation).
log "Spot watcher"
cat >/usr/local/sbin/codespace-spot-watcher <<'EOF'
#!/usr/bin/env bash
set -u
IMDS=http://169.254.169.254
OUT=/run/codespace/interruption
mkdir -p /run/codespace
while true; do
  token="$(curl -fsS -m 2 -X PUT "$IMDS/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' 2>/dev/null || true)"
  if [ -n "$token" ]; then
    code="$(curl -sS -m 2 -o /run/codespace/.instance-action -w '%{http_code}' \
      -H "X-aws-ec2-metadata-token: $token" "$IMDS/latest/meta-data/spot/instance-action" 2>/dev/null || echo 000)"
    if [ "$code" = 200 ]; then
      if ! cmp -s /run/codespace/.instance-action "$OUT" 2>/dev/null; then
        mv -f /run/codespace/.instance-action "$OUT"
        logger -t codespace-spot "interruption notice: $(cat "$OUT")"
      fi
    elif [ "$code" = 404 ]; then
      rm -f "$OUT"
    fi
    rm -f /run/codespace/.instance-action
  fi
  sleep 5
done
EOF
chmod 0755 /usr/local/sbin/codespace-spot-watcher
cat >/etc/systemd/system/codespace-spot-watcher.service <<'EOF'
[Unit]
Description=Codespace spot interruption watcher (IMDSv2 spot/instance-action)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/sbin/codespace-spot-watcher
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable codespace-spot-watcher.service
systemctl restart codespace-spot-watcher.service

# ---- Boot trimming ------------------------------------------------------------------------------
# Units that do work at boot (or soon after) that a workspace doesn't need. Masked rather than
# purged where other packages depend on them, so nothing pulls them back in on start.
log "Boot trimming"
systemctl set-default multi-user.target
for unit in apt-daily.timer apt-daily-upgrade.timer motd-news.timer fwupd-refresh.timer ua-timer.timer \
    apt-daily.service apt-daily-upgrade.service unattended-upgrades.service motd-news.service \
    fwupd.service fwupd-refresh.service ModemManager.service multipathd.service multipathd.socket \
    lxd-agent.service landscape-client.service ubuntu-advantage.service ua-reboot-cmds.service \
    esm-cache.service apport.service pollinate.service keyboard-setup.service console-setup.service \
    e2scrub_reap.service secureboot-db.service; do
  systemctl disable "$unit" >/dev/null 2>&1 || true
  systemctl mask "$unit" >/dev/null 2>&1 || true
done
# udisks2 stays installed (Thunar can use it) but only starts on demand over D-Bus.
systemctl disable udisks2.service >/dev/null 2>&1 || true
# Nothing patches itself behind the user's back; image rebuilds deliver updates.
cat >/etc/apt/apt.conf.d/99codespace-periodic <<'EOF'
APT::Periodic::Enable "0";
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Unattended-Upgrade "0";
APT::Periodic::Download-Upgradeable-Packages "0";
APT::Periodic::AutocleanInterval "0";
EOF
[ -f /etc/default/motd-news ] && sed -i 's/^ENABLED=.*/ENABLED=0/' /etc/default/motd-news
# pam_motd runs these on every SSH login.
chmod -x /etc/update-motd.d/* 2>/dev/null || true
# Return as soon as one interface is up, and never wait more than 10s.
for wo in /lib/systemd/systemd-networkd-wait-online /usr/lib/systemd/systemd-networkd-wait-online; do
  if [ -x "$wo" ]; then
    install -d /etc/systemd/system/systemd-networkd-wait-online.service.d
    printf '[Service]\nExecStart=\nExecStart=%s --any --timeout=10\n' "$wo" \
      >/etc/systemd/system/systemd-networkd-wait-online.service.d/10-codespace.conf
    break
  fi
done
# Packages with nothing to offer here. pollinate makes a network call to seed entropy on first
# boot; the others only add services or login banners. None is part of the NVIDIA stack.
purge=()
for pkg in modemmanager lxd-agent-loader landscape-common landscape-client pollinate; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" && purge+=("$pkg")
done
if [ "${#purge[@]}" -gt 0 ]; then apt_get purge -y -q "${purge[@]}"; fi
systemctl daemon-reload

# ---- snapd: gone, and kept out ------------------------------------------------------------------
# Only once the .deb agent is the one running (second pass under Image Builder, or a plain SSH
# session by hand): removing snapd stops every snap service, including a snap SSM agent.
cat >/etc/apt/preferences.d/codespace-no-snapd <<'EOF'
Package: snapd
Pin: release a=*
Pin-Priority: -1
EOF
if [ "$NEED_REBOOT" = 0 ] && dpkg-query -W -f='${Status}' snapd 2>/dev/null | grep -q "install ok installed"; then
  log "Purging snapd"
  # Metapackages that depend on snapd (e.g. ubuntu-server) go with it. Mark what they pulled in as
  # manually installed first, so a later `apt autoremove` doesn't strip the system.
  for meta in $(apt-get -s purge snapd 2>/dev/null | awk '/^(Purg|Remv) / {print $2}'); do
    case "$meta" in
      ubuntu-*)
        deps="$(apt-cache depends --installed "$meta" 2>/dev/null | awk '/(Depends|Recommends):/ {print $2}' | grep -v '^<' | sort -u || true)"
        # shellcheck disable=SC2086
        [ -n "$deps" ] && apt-mark manual $deps >/dev/null
        ;;
    esac
  done
  apt_get purge -y -q snapd
fi
apt-mark hold snapd >/dev/null 2>&1 || true
if ! command -v snap >/dev/null 2>&1; then
  rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd /root/snap /home/*/snap
fi
systemctl daemon-reload

# ---- GPU sanity --------------------------------------------------------------------------------
# The DLAMI ships the driver and CUDA; nothing to install. Build instances have no GPU, so a
# failing nvidia-smi is only a warning here.
if [ "$GPU" = 1 ]; then
  log "GPU sanity"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi || echo "WARNING: nvidia-smi failed (expected on a build instance without a GPU)" >&2
  else
    echo "WARNING: nvidia-smi not found; is the parent the DLAMI?" >&2
  fi
fi

# ---- Verify ------------------------------------------------------------------------------------
log "Verify"
for bin in node npm npx git gh ttyd rg jq tmux python3 make gcc Xvfb x11vnc websockify startxfce4 chromium; do
  command -v "$bin" >/dev/null || die "missing $bin"
done
[ -x /root/.local/bin/claude ] || die "missing /root/.local/bin/claude"
[ -d /usr/share/novnc ] || die "missing /usr/share/novnc"
"$CHROME_BIN" --version
systemctl is-enabled codespace-spot-watcher.service ssh.service >/dev/null

# ---- Shrink ------------------------------------------------------------------------------------
apt_get clean
rm -rf /var/lib/apt/lists/* /root/.npm/_cacache 2>/dev/null || true

# ---- Reboot handoff, or boot profile ------------------------------------------------------------
if [ "$NEED_REBOOT" = 1 ]; then
  if under_toe; then
    log "Rebooting so the .deb SSM agent takes over; AWSTOE re-runs this step afterwards"
    exit 194
  fi
  set +x
  echo "The snap SSM agent is running this shell, so snapd can't be purged yet." >&2
  echo "Reboot, reconnect (the .deb agent takes over), and run this script again." >&2
  exit 0
fi
# This boot already ran without snapd's agent, so it shows where the remaining time goes.
{
  echo "# codespace boot profile, $(date -u +%FT%TZ), variant=${VARIANT:-auto}, $(uname -r)"
  echo "## systemd-analyze"; systemd-analyze 2>&1 || true
  echo "## systemd-analyze blame | head -20"; systemd-analyze blame 2>&1 | head -20 || true
  echo "## systemd-analyze critical-chain amazon-ssm-agent.service"
  systemd-analyze critical-chain amazon-ssm-agent.service 2>&1 || true
} >/var/log/codespace-boot-profile.txt
cat /var/log/codespace-boot-profile.txt

log "Codespace image setup complete (variant=${VARIANT:-auto})"
