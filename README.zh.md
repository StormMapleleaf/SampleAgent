# SampleAgent

[English](README.md) | 中文

SampleAgent 是一个开源 agent harness（智能体框架），作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的派生分支由 [DeepSeek AI](https://deepseek.com) 的代码构建而来，提供 `sampleagent` 命令。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

上游文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

SampleAgent 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 在 Ubuntu 上运行

自包含的 Debian 包携带 Node.js、pnpm、ripgrep 与插件闭包，因此机器无需安装 Node.js：

```sh
sudo apt install ./sampleagent_<version>_<arch>.deb
sampleagent web
```

`dsh` 仍作为 `sampleagent` 的别名安装。压缩包、`install.sh` 与 systemd user 单元的说明见[发行版说明](packaging/ubuntu/README.zh.md)。

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 加入上游 <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord 社区</a>。

## 贡献

见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

## 开发

从[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)开始。

`pnpm run dev:web` 会在同一终端内构建、启动服务并在源码改动时重建客户端 bundle；`make help` 列出 Web 与 Desktop 对应的 Make 目标；完整表格见指南的应用命令一节。

面向 agent 的工作流见 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
