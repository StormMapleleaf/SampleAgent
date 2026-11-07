# Ubuntu distribution packaging

English | [中文](README.zh.md)

Self-contained Linux distribution of DSH. The Debian package, the release tarball, and `install.sh` all carry Node.js, pnpm, ripgrep, and the production plugin closure, so an installation needs no system Node.js and no native build toolchain.

## Installed layout

The Debian package installs one prefix under `/opt/dsh` and links `/usr/bin/dsh` to its launcher. `install.sh` installs the same tree under `~/.local/lib/dsh/<version>` and links `~/.local/bin/dsh`.

| Path | Contents |
|---|---|
| `bin/dsh` | POSIX launcher; resolves its own links, then runs the bundled interpreter |
| `app/` | Symlink-free production closure of `dsh-ubuntu-closure` |
| `runtime/node/` | Locked Node.js from `scripts/primary-runtime/lock.json` |
| `runtime/pnpm/` | Repository pnpm plus the PATH shim `dsh plugin` resolves |
| `VERSION`, `runtime.json` | Distribution identity |

User state stays in `~/.dsh`. Removing the package never deletes it.

## Build

Build artifacts must exist before assembly, and the target architecture must match the build host because the closure carries platform-optional native packages.

```sh
pnpm install
pnpm run build
node --import tsx scripts/ubuntu/build-runtime.ts --target linux-x64
node --import tsx scripts/ubuntu/build-deb.ts --target linux-x64
```

`build-runtime.ts` deploys the closure with the same flags as the single-executable build, materializes every package link, prunes documentation and type declarations, stages Node.js and pnpm, verifies the `node-pty` and ripgrep payload, writes the launcher, and packs `dsh-<version>-linux-<arch>.tar.gz` with `SHA256SUMS`.

`build-deb.ts` wraps that tree: it copies the prefix, links `/usr/bin/dsh`, renders the control file, the systemd user unit, the desktop entry, and the copyright file, then runs `dpkg-deb --root-owner-group --build`.

Both scripts refuse to run on a host that cannot produce the target. Build on `ubuntu-24.04` for x64 and `ubuntu-24.04-arm` for arm64, or run `scripts/ubuntu/build-in-docker.sh <target>` from another host that has Docker; `--skip-build` reuses artifacts already built in the working tree.

## Install and run

```sh
sudo apt install ./dsh_0.2.2~rc.1-1_amd64.deb
dsh web
```

`dsh web` binds `127.0.0.1:3080` and prints a launch URL carrying a one-time token. The bare address answers 401, so open the printed URL. Over SSH the CLI skips opening a browser; forward the port and open the printed URL through the tunnel.

The optional background service serves the same UI without opening a browser:

```sh
systemctl --user enable --now dsh-web
journalctl --user -u dsh-web -f
```

The package depends on `bubblewrap` because the sandbox runner chain is bubblewrap then Landlock, and a host with neither refuses confined commands instead of running them unconfined. Landlock needs Linux 5.13 or newer.

## Remote access

The Web UI rejects wildcard bind addresses. Reach a remote installation through SSH port forwarding, or terminate TLS in a reverse proxy and advertise it:

```sh
dsh web --no-open --public-url https://dsh.example.com/ --trusted-host dsh.example.com --tls-cert chain.pem --tls-key key.pem
```

## Uninstall

`apt remove dsh` deletes `/opt/dsh`, `/usr/bin/dsh`, and the integration files. `install.sh --uninstall` removes the same pieces for a prefix installation. Neither touches `~/.dsh`.

## Fork checklist

- `branding.json` owns the package name, binary name, display name, maintainer, homepage, install directory, port, and the optional icon.
- Do not ship the official icon or the "DeepSeek Harness" name; [BRAND_GUIDELINES.md](../../BRAND_GUIDELINES.md) describes the naming rules for derivative distributions.
- `packaging/ubuntu/package.json` is the closure manifest: adding a plugin to the distribution means adding one dependency line there, then rebuilding.
- Debian versions come from the root `package.json`; a prerelease maps to `X.Y.Z~<prerelease>-1`.
