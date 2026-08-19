# Repo2Skill 中文操作手册

[English guide](USER_GUIDE.md)

## 1. 安装与验证

安装 Node.js 20+ 和 Git，然后执行：

```sh
git clone https://github.com/mason2048/repo2skill.git
cd repo2skill
npm ci
npm run check
npm test
```

依赖安装过程不会扫描其他仓库，也不会执行目标仓库命令。

## 2. 使用本地 UI

```sh
npm run ui
```

打开 <http://127.0.0.1:4173>。选择“本地仓库”或“公开 GitHub”，填写来源并选择目标 Agent，然后执行检查。审核仓库身份、revision、扫描范围、候选、冲突和安全发现；取消不正确候选，指定仓库外尚不存在的新输出目录，再执行生成。回到终端按 `Ctrl+C` 停止服务。

也可以指定其他回环端口：

```sh
./src/cli.js serve --port 4300
```

服务拒绝非回环地址。浏览器生成请求绑定已检查的仓库身份、revision 和 snapshot；仓库变化后必须重新检查。

## 3. 使用 CLI 检查

```sh
./src/cli.js inspect /absolute/path/to/local-git-repository
./src/cli.js inspect https://github.com/owner/repository
```

JSON 预览包含锁定 revision、扫描元数据、候选、已选工作流、冲突和安全阻断。所有候选命令都只是静态证据，没有被执行。

为公开仓库指定独立缓存：

```sh
./src/cli.js inspect https://github.com/owner/repository \
  --cache /absolute/path/to/repo2skill-cache
```

只支持无凭据的公开 GitHub HTTPS URL。

## 4. 生成

```sh
./src/cli.js generate /absolute/path/to/repository \
  --output /absolute/path/to/new-generated-skill \
  --target generic
```

输出目录必须尚不存在，并且位于输入仓库之外。目标值：

- `generic`：通用 Agent Skills 安装说明；
- `codex`：额外生成 `agents/openai.yaml`；
- `claude`：Claude Code 安装说明；
- `copilot`：GitHub Copilot 安装说明。

排除审核后不需要的候选 ID：

```sh
./src/cli.js generate /absolute/path/to/repository \
  --output /absolute/path/to/new-generated-skill \
  --target codex \
  --exclude cmd-example1,cmd-example2
```

生成至少需要 3 条已验证、无冲突工作流。被阻断的生成仍会留下可审计报告，但退出码为 `2`；不要安装或使用这种包。

## 5. 复验

```sh
./src/cli.js validate /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill
```

复验会检查包结构、仓库身份、revision、来源是否存在、哈希、权限、命令映射、目标元数据、当前冲突、安全发现和三工作流下限。默认原子更新 `reports/validation.json`。

只读检查：

```sh
./src/cli.js validate /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill \
  --no-write
```

## 6. 对比 revision

```sh
./src/cli.js diff /absolute/path/to/repository \
  --skill /absolute/path/to/generated-skill
```

报告将映射分类为 `unchanged`、`changed`、`superseded`、`missing`、`unverified` 或 `conflicted`。不加 `--no-write` 时会写入 `reports/staleness.json`。

退出码：

- `0`：完成且没有阻断；`diff` 为 current；
- `1`：参数或运行、网络、文件系统错误；
- `2`：阻断，包括 `insufficient-workflows`；
- `3`：`diff` 完成，但 Skill 已过期。

## 7. 人工安装

打开生成包的 `agents/INSTALL.md`，复制任何文件前至少确认：

1. `reports/security.md` 没有未处理阻断；
2. `reports/validation.json` 不是 blocked；
3. `references/source-map.json` 对应预期仓库与 revision；
4. 每条已选命令和来源都符合预期；
5. 目标位置是该 Agent 正确的项目级 Skill 目录。

Repo2Skill 不执行安装、链接、全局配置或命令。

## 8. 清理

生成包是独立目录。核对精确路径后，只把不需要的生成目录移到系统废纸篓。输入仓库绝不能作为输出目录。

公开仓库缓存位置见 README。先停止 Repo2Skill，核对精确缓存命名空间，然后只把该缓存目录移到废纸篓即可释放空间；之后可从公开 URL 重建。不要删除宽泛的用户目录或系统缓存目录。

卸载源码预览时，停止服务后只删除克隆的 `repo2skill` 目录。工具不保存账户或云端数据。

## 9. 故障处理

- **`insufficient-workflows`：**当前选择少于 3 个已验证且无冲突的类别；补充仓库证据或选择更多合法候选，不要绕过门禁；
- **输出已存在：**选择新路径，Repo2Skill 不覆盖；
- **输出位于仓库内：**改用仓库之外的同级或临时目录；
- **预览后仓库变化：**重新检查后再生成；
- **公开 URL 被拒绝：**使用精确且无凭据的 `https://github.com/owner/repository`，当前不支持私有仓库；
- **缓存不安全或被占用：**停止并发任务，检查精确缓存项是否含链接或异常文件；无法确认时使用新的空缓存根；
- **可执行脚本阻断：**人工审核引用的脚本，Repo2Skill 不会执行；
- **复验提示来源变化：**审核差异后，从预期的新 revision 重新生成；
- **端口占用：**用 `serve --port` 选择 0–65535 的其他值；`0` 表示由系统分配。

可复现且不含敏感信息的普通问题请创建 GitHub Issue；安全问题使用 Private Vulnerability Reporting。
