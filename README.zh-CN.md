# Repo2Skill

[English](README.md) · [中文操作手册](docs/USER_GUIDE.zh-CN.md) · [安全策略](SECURITY.md)

Repo2Skill 将本地 Git 仓库或公开 GitHub 仓库静态编译成可审计的 Agent Skill 包。它从仓库证据中识别安装、测试、构建、格式化、检查和发布前工作流，为每条选中命令建立来源映射，并生成面向不同 Agent 的人工安装说明。

当前 `0.3.0` 是**实验性源码版本**。静态生成和复验不会运行仓库命令，也不证明目标项目能构建、通过测试或用于生产。

## 快速开始

需要 Node.js 20+ 和 Git。

```sh
git clone https://github.com/mason2048/repo2skill.git
cd repo2skill
npm ci
npm test
npm run ui
```

打开 <http://127.0.0.1:4173>，回到终端按 `Ctrl+C` 停止本地服务。

也可以直接使用 CLI：

```sh
./src/cli.js --help
./src/cli.js inspect /absolute/path/to/a/local-git-repository
./src/cli.js inspect https://github.com/owner/repository
```

## 生成 Skill

先检查仓库并审核候选 ID，再把结果写入输入仓库之外、尚不存在的新目录：

```sh
./src/cli.js generate /absolute/path/to/repository \
  --output /absolute/path/to/new-generated-skill \
  --target codex \
  --exclude cmd-example1,cmd-example2
```

`--target` 支持 `generic`、`codex`、`claude` 和 `copilot`。Repo2Skill 只会在新输出目录中写文件，不会自动安装，也不会写入 Agent 配置目录。

至少需要 3 条已验证且无冲突的工作流。未达到门禁时，`generate`、`validate` 和 `diff` 都会返回 `insufficient-workflows`，退出码均为 `2`。

## 复验与差异

```sh
./src/cli.js validate /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill

./src/cli.js diff /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill
```

增加 `--no-write` 可以只打印结果，不更新包内报告。`diff` 当前一致时返回 `0`，过期时返回 `3`，阻断时返回 `2`；参数或运行错误返回 `1`。

## 生成结构

```text
generated-skill/
├── SKILL.md
├── references/source-map.json
├── reports/validation.json
├── reports/security.md
├── reports/staleness.json       # 执行可写 diff 后出现
├── agents/target.json
├── agents/INSTALL.md
├── agents/openai.yaml           # 仅 Codex
└── context-package.json
```

每条映射工作流都带仓库身份、锁定 revision、来源定位、内容哈希、文件权限和验证证据。

## 公开 GitHub 输入

只接受不含凭据的精确 `https://github.com/<owner>/<repo>[.git]`。SSH、`file://`、其他主机、query、fragment、嵌入凭据和私有仓库不在当前范围。公开来源会浅克隆到隔离缓存，并以干净 detached HEAD 读取。

默认缓存位置：

- macOS：`~/Library/Caches/repo2skill/github-v1/`
- Linux：`${XDG_CACHE_HOME:-~/.cache}/repo2skill/github-v1/`
- Windows：`%LOCALAPPDATA%/repo2skill-cache/github-v1/`

使用 `--cache /absolute/path/to/cache` 可指定其他缓存目录。

## 安全边界

仓库内容始终是不可信数据。Repo2Skill 不执行仓库脚本、Git hook、生成指令或发现的命令；危险 Shell 语法、疑似秘密、未经审核的可执行脚本、不安全展示元数据、仓库身份不一致、来源变化和工作流不足都会阻断。安装或运行任何内容前，仍需人工检查 source map 与 security report。

## 本地验证

```sh
npm run check
npm test
npm audit
```

完整 UI/CLI 流程、人工安装、缓存清理、输出清理和故障处理请见[中文操作手册](docs/USER_GUIDE.zh-CN.md)。

## 参与贡献与许可证

提交 Pull Request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

项目采用 [Apache License 2.0](LICENSE)。
