#!/bin/sh
# Install a self-contained DSH runtime without root privileges.
#
# The runtime archive already carries Node.js, pnpm, ripgrep, and the plugin
# closure, so this script only downloads, verifies, unpacks, and links.
set -eu

DEFAULT_PREFIX="${HOME}/.local"
DEFAULT_REPO="StormMapleleaf/SampleAgent"
DEFAULT_PORT="3080"

prefix="$DEFAULT_PREFIX"
version=""
base_url=""
repo="${DSH_DIST_REPO:-$DEFAULT_REPO}"
port="${DSH_WEB_PORT:-$DEFAULT_PORT}"
install_systemd=1
install_desktop=1
action="install"

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --version <v>       Release version to install (default: the release marked latest)
  --prefix <dir>      Installation prefix (default: ~/.local)
  --base-url <url>    Directory holding the release artifacts, overriding the GitHub release URL
  --repo <owner/name> GitHub repository publishing the release (default: StormMapleleaf/SampleAgent)
  --port <n>          Port the optional systemd user unit serves (default: 3080)
  --no-systemd        Skip the systemd user unit
  --no-desktop        Skip the desktop entry
  --uninstall         Remove the installed version links and unit files
  -h, --help          Show this help
USAGE
}

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail "--version needs a value"; version="$2"; shift 2 ;;
    --prefix) [ "$#" -ge 2 ] || fail "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --base-url) [ "$#" -ge 2 ] || fail "--base-url needs a value"; base_url="$2"; shift 2 ;;
    --repo) [ "$#" -ge 2 ] || fail "--repo needs a value"; repo="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || fail "--port needs a value"; port="$2"; shift 2 ;;
    --no-systemd) install_systemd=0; shift ;;
    --no-desktop) install_desktop=0; shift ;;
    --uninstall) action="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done

case "$(uname -s)" in
  Linux) ;;
  *) fail "this archive targets Linux; other platforms install from source" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

lib_dir="$prefix/lib/sampleagent"
bin_dir="$prefix/bin"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

if [ "$action" = "uninstall" ]; then
  rm -f "$bin_dir/sampleagent" "$bin_dir/dsh"
  rm -rf "$lib_dir"
  rm -f "$config_home/systemd/user/sampleagent-web.service"
  rm -f "$data_home/applications/sampleagent.desktop"
  echo "install.sh: removed $lib_dir, $bin_dir/sampleagent, and the optional unit files"
  echo "install.sh: the SampleAgent home (profiles, sessions, settings) was left untouched"
  exit 0
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

if [ -n "$base_url" ]; then
  base="${base_url%/}"
  if [ -z "$version" ]; then
    tmp_version="$(mktemp)"
    fetch "$base/VERSION" "$tmp_version" || fail "cannot read $base/VERSION; pass --version"
    version="$(tr -d '[:space:]' < "$tmp_version")"
    rm -f "$tmp_version"
  fi
else
  if [ -n "$version" ]; then
    base="https://github.com/${repo}/releases/download/ubuntu-v${version}"
  else
    base="https://github.com/${repo}/releases/latest/download"
    tmp_version="$(mktemp)"
    fetch "$base/VERSION" "$tmp_version"
    version="$(tr -d '[:space:]' < "$tmp_version")"
    rm -f "$tmp_version"
  fi
fi

[ -n "$version" ] || fail "no version resolved; pass --version"

archive="sampleagent-${version}-linux-${arch}.tar.gz"
[ -w "$prefix" ] || mkdir -p "$prefix" 2>/dev/null || fail "$prefix is not writable; pass --prefix to a directory you own"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

echo "install.sh: downloading sampleagent ${version} for linux-${arch}"
fetch "$base/$archive" "$tmp_dir/$archive" || fail "cannot download $base/$archive"
fetch "$base/SHA256SUMS" "$tmp_dir/SHA256SUMS" || fail "cannot download $base/SHA256SUMS"

expected="$(awk -v name="$archive" '$2 == name {print $1}' "$tmp_dir/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $archive"
actual="$(sha256_of "$tmp_dir/$archive")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

mkdir -p "$tmp_dir/unpacked" "$lib_dir"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir/unpacked"
[ -x "$tmp_dir/unpacked/sampleagent/bin/sampleagent" ] || fail "archive does not contain sampleagent/bin/sampleagent"

target="$lib_dir/$version"
rm -rf "$target"
mv "$tmp_dir/unpacked/sampleagent" "$target"
ln -sfn "$version" "$lib_dir/current"

mkdir -p "$bin_dir"
ln -sfn "../lib/sampleagent/current/bin/sampleagent" "$bin_dir/sampleagent"
ln -sfn "sampleagent" "$bin_dir/dsh"

if [ "$install_systemd" = "1" ]; then
  mkdir -p "$config_home/systemd/user"
  cat > "$config_home/systemd/user/sampleagent-web.service" <<UNIT
[Unit]
Description=SampleAgent Web UI
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=DSH_HOME=%h/.dsh
ExecStart=${bin_dir}/sampleagent web --no-open --port ${port}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
UNIT
fi

if [ "$install_desktop" = "1" ]; then
  mkdir -p "$data_home/applications"
  cat > "$data_home/applications/sampleagent.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=SampleAgent
Comment=Open the SampleAgent Web UI
Exec=${bin_dir}/sampleagent web
Icon=sampleagent
Terminal=false
Categories=Development;
StartupNotify=false
DESKTOP
fi

echo "install.sh: installed sampleagent ${version} to $target"
echo "install.sh: run '$bin_dir/sampleagent web' (add $bin_dir to PATH if it is not there yet)"
if [ "$install_systemd" = "1" ]; then
  echo "install.sh: optional background service: systemctl --user enable --now sampleagent-web"
  echo "install.sh: the startup URL lands in: journalctl --user -u sampleagent-web"
fi
if ! command -v bwrap >/dev/null 2>&1; then
  echo "install.sh: bubblewrap is absent; command sandboxing falls back to Landlock (Linux 5.13+)" >&2
fi
