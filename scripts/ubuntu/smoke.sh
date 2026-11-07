#!/bin/sh
# Install the built Debian package in clean Ubuntu containers and drive it:
# version, bundled package manager, sandbox runner, and the tokenized Web URL.
set -eu

target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    linux-x64|linux-arm64) target="$1"; shift ;;
    -h|--help)
      echo "usage: smoke.sh [linux-x64|linux-arm64]" >&2
      exit 0
      ;;
    *) echo "smoke.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$target" ]; then
  case "$(uname -m)" in
    aarch64|arm64) target="linux-arm64" ;;
    *) target="linux-x64" ;;
  esac
fi
case "$target" in
  linux-x64) platform="linux/amd64" ;;
  linux-arm64) platform="linux/arm64" ;;
esac

repository="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
dist="$repository/dist/ubuntu"
if [ ! -f "$dist/VERSION" ]; then
  echo "smoke.sh: $dist/VERSION is missing; build the distribution first" >&2
  exit 1
fi
version="$(cat "$dist/VERSION")"

for release in 22.04 24.04; do
  echo "smoke.sh: ubuntu:$release ($target)"
  docker run --rm \
    --platform "$platform" \
    -v "$dist:/dist:ro" \
    -e EXPECTED="$version" \
    "ubuntu:$release" \
    bash -eu -c '
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends curl /dist/*.deb >/dev/null

      reported="$(sampleagent --version)"
      [ "$reported" = "$EXPECTED" ] || { echo "smoke: sampleagent --version reported $reported, expected $EXPECTED" >&2; exit 1; }
      echo "smoke: sampleagent $reported"

      command -v bwrap >/dev/null || { echo "smoke: bubblewrap is not installed" >&2; exit 1; }
      echo "smoke: sandbox runner $(command -v bwrap)"

      /opt/sampleagent/runtime/pnpm/bin/pnpm --version >/dev/null
      echo "smoke: bundled pnpm ok"

      [ "$(dsh --version)" = "$EXPECTED" ] || { echo "smoke: the dsh alias does not run" >&2; exit 1; }
      sampleagent web --no-open --port 0 > /tmp/web.log 2>&1 &
      server=$!
      trap "kill $server 2>/dev/null || true" EXIT

      for _ in $(seq 1 120); do
        grep -q "sampleagent web: http" /tmp/web.log && break
        sleep 0.5
      done
      url="$(sed -n "s/^sampleagent web: \(http[^ ]*\).*/\1/p" /tmp/web.log | head -1)"
      [ -n "$url" ] || { echo "smoke: no startup URL" >&2; cat /tmp/web.log >&2; exit 1; }

      # The token query mints a cookie and redirects to the directory-relative URL.
      tokenized="$(curl -sL -c /tmp/jar -o /dev/null -w "%{http_code}" "$url")"
      [ "$tokenized" = "200" ] || { echo "smoke: tokenized URL returned $tokenized after redirects" >&2; exit 1; }
      redirect="$(curl -s -o /dev/null -w "%{http_code}" "$url")"
      [ "$redirect" = "303" ] || [ "$redirect" = "302" ] || { echo "smoke: tokenized URL returned $redirect, expected a redirect" >&2; exit 1; }

      port="$(printf "%s" "$url" | sed -n "s|http://[^:/]*:\([0-9]*\)/.*|\1|p")"
      bare="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/")"
      [ "$bare" = "401" ] || { echo "smoke: bare URL returned $bare, expected 401" >&2; exit 1; }
      echo "smoke: web UI served on $port (tokenized 200, bare 401)"
    '
done

echo "smoke.sh: all containers passed"
