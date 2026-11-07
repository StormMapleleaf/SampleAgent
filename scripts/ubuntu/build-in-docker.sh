#!/bin/sh
# Build the Ubuntu distribution inside a container, so a host that is not the
# release architecture can still produce Linux artifacts.
#
# The repository is copied out of the working tree with local build residue
# excluded, and the container runs as the invoking user so the copied artifacts
# keep host ownership.
set -eu

target=""
keep=0
build=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    linux-x64|linux-arm64) target="$1"; shift ;;
    --keep) keep=1; shift ;;
    --skip-build) build=0; shift ;;
    -h|--help)
      echo "usage: build-in-docker.sh [linux-x64|linux-arm64] [--keep] [--skip-build]" >&2
      exit 0
      ;;
    *) echo "build-in-docker.sh: unknown argument $1" >&2; exit 2 ;;
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
work="$(mktemp -d)"
cleanup() {
  if [ "$keep" = "1" ]; then
    echo "build-in-docker.sh: kept $work" >&2
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT INT TERM

commit="$(git -C "$repository" rev-parse HEAD)"
mkdir -p "$work/src" "$work/home"
echo "build-in-docker.sh: staging sources at $commit in $work"
# Copy top-level entries by name: tar exclude patterns match every path
# component, so "dist" would also drop the committed apps/web/dist payload.
(
  cd "$repository"
  for entry in *; do
    [ -e "$entry" ] || continue
    case "$entry" in
      node_modules|dist|dist-exe|.dsh) continue ;;
    esac
    cp -R "$entry" "$work/src/"
  done
  for entry in .[!.]*; do
    [ -e "$entry" ] || continue
    case "$entry" in
      .git|.dsh) continue ;;
    esac
    cp -R "$entry" "$work/src/"
  done
)

echo "build-in-docker.sh: building $target on $platform"
docker run --rm \
  --platform "$platform" \
  -v "$work:/work" \
  -w /work/src \
  -u "$(id -u):$(id -g)" \
  -e HOME=/work/home \
  -e CI=1 \
  -e TARGET="$target" \
  -e DSH_CLIENT_COMMIT_HASH="$commit" \
  -e SKIP_BUILD="$((1 - build))" \
  -e PATH="/work/home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e npm_config_prefix=/work/home/.npm-global \
  -e npm_config_cache=/work/home/.npm \
  node:24-bookworm \
  bash -eu -c '
    npm install --global pnpm@11.28.5 --silent
    pnpm install --frozen-lockfile
    if [ "${SKIP_BUILD:-0}" = "1" ]; then
      echo "build-in-docker.sh: reusing the build artifacts copied from the host"
    else
      pnpm run build
    fi
    node --import tsx scripts/ubuntu/build-runtime.ts --target "$TARGET"
    node --import tsx scripts/ubuntu/build-deb.ts --target "$TARGET"
  '

mkdir -p "$repository/dist/ubuntu"
for file in "$work"/src/dist/ubuntu/*.deb "$work"/src/dist/ubuntu/*.tar.gz "$work"/src/dist/ubuntu/SHA256SUMS \
  "$work"/src/dist/ubuntu/VERSION "$work"/src/dist/ubuntu/install.sh; do
  [ -f "$file" ] || continue
  cp "$file" "$repository/dist/ubuntu/"
done
echo "build-in-docker.sh: artifacts are in $repository/dist/ubuntu"
