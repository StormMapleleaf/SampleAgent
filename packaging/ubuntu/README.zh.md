# Ubuntu 发行版打包

[English](README.md) | 中文

SampleAgent 的自包含 Linux 发行版。Debian 包、发布 tarball 与 `install.sh` 都携带 Node.js、pnpm、ripgrep 和生产插件闭包，因此安装不需要系统 Node.js，也不需要原生构建工具链。

## 安装布局

Debian 包在 `/opt/sampleagent` 下安装一个前缀，并把 `/usr/bin/sampleagent` 链接到它的启动器；`/usr/bin/dsh` 仍然作为别名保留。`install.sh` 把同一棵树安装到 `~/.local/lib/sampleagent/<version>`，并链接 `~/.local/bin/sampleagent` 与 `~/.local/bin/dsh`。

| 路径 | 内容 |
|---|---|
| `bin/sampleagent` | POSIX 启动器；先解析自身链接，再用内置解释器运行 CLI |
| `bin/dsh` | `bin/sampleagent` 的别名 |
| `app/` | `dsh-ubuntu-closure` 的无软链生产闭包 |
| `runtime/node/` | 取自 `scripts/primary-runtime/lock.json` 的锁定 Node.js |
| `runtime/pnpm/` | 仓库自带 pnpm，以及 `sampleagent plugin` 解析用的 PATH 垫片 |
| `VERSION`、`runtime.json` | 发行版标识 |

用户数据保留在 `~/.dsh`。卸载软件包绝不会删除它。

## 构建

组装前必须已存在构建产物，且目标架构必须与构建主机一致，因为闭包携带按平台可选的预编译包。

```sh
pnpm install
pnpm run build
pnpm run dist:ubuntu --target linux-x64
pnpm run dist:ubuntu:deb --target linux-x64
```

`build-runtime.ts` 用与单文件可执行构建相同的参数 deploy 闭包，把每个包链接展开为真实文件，裁剪文档与类型声明，装载 Node.js 与 pnpm，校验 `node-pty` 与 ripgrep 载荷，写入启动器，并打包 `sampleagent-<version>-linux-<arch>.tar.gz` 与 `SHA256SUMS`。

`build-deb.ts` 包装这棵树：复制前缀，链接 `/usr/bin/sampleagent` 与 `/usr/bin/dsh`，渲染 control、systemd user 单元、桌面入口与 copyright，然后执行 `dpkg-deb --root-owner-group --build`。

两个脚本都会拒绝在无法生成目标的主机上运行。x64 在 `ubuntu-24.04` 上构建，arm64 在 `ubuntu-24.04-arm` 上构建，或在有其他主机上运行 `scripts/ubuntu/build-in-docker.sh <target>`（需要 Docker）；`--skip-build` 复用工作区中已构建的产物。

## 安装与运行

```sh
sudo apt install ./sampleagent_0.2.2~rc.1-1_amd64.deb
sampleagent web
```

`sampleagent web` 绑定 `127.0.0.1:3080`，并打印带一次性 token 的启动 URL。裸地址返回 401，因此要打开打印出的 URL。通过 SSH 运行时 CLI 不打开浏览器；转发端口后经隧道打开打印的 URL。

可选的后台服务提供同一个界面，但不打开浏览器：

```sh
systemctl --user enable --now sampleagent-web
journalctl --user -u sampleagent-web -f
```

软件包依赖 `bubblewrap`，因为沙箱 runner 链是先 bubblewrap 再 Landlock，而两者都不可用的主机会拒绝受限命令，而不是无限制运行。Landlock 需要 Linux 5.13 或更新版本。

## 远程访问

Web UI 拒绝通配绑定地址。远程安装要么通过 SSH 端口转发访问，要么在反向代理终止 TLS 后声明地址：

```sh
sampleagent web --no-open --public-url https://sampleagent.example.com/ --trusted-host sampleagent.example.com --tls-cert chain.pem --tls-key key.pem
```

## 卸载

`apt remove sampleagent` 删除 `/opt/sampleagent`、`/usr/bin/sampleagent`、`/usr/bin/dsh` 与集成文件。`install.sh --uninstall` 为前缀安装删除同样的部分。两者都不会触碰 `~/.dsh`。

## 二次开发清单

- `branding.json` 拥有包名、命令名、别名、显示名、维护者、主页、安装目录、端口与可选图标。
- 不要分发官方图标或 "DeepSeek Harness" 名称；[BRAND_GUIDELINES.zh.md](../../BRAND_GUIDELINES.zh.md) 规定衍生发行版的命名规则。
- `packaging/ubuntu/package.json` 是闭包清单：给发行版增加插件就是在其中增加一行依赖，然后重新构建。
- Debian 版本来自根 `package.json`；预发布版本映射为 `X.Y.Z~<prerelease>-1`。
