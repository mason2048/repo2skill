# Repo2Skill UI design system

This file records the implementation contract extracted from the approved desktop and mobile concepts.

## Surface and layout

- True white `#ffffff` canvas; no gradients or tinted page background.
- Desktop: 24px page gutter, one open bordered work surface, main candidate region plus a 344px inspector rail.
- Mobile: 16px gutter, one column, candidate rows stack without horizontal scrolling, inspector follows candidates.
- Borders are cool gray 1px rules. Panels use 8px radii; controls use 7px radii. Avoid nested cards.

## Type

- UI: Inter-like system sans (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif).
- Commands and paths: `SFMono-Regular`, `Consolas`, monospace.
- Page mark 24/700, section 16/700, body/control 14/500, metadata 12/500.

## Color tokens

- Ink `#111318`; muted `#667085`; rule `#d9dee8`; soft surface `#f7f9fc`.
- Action `#0b5cff`, hover `#004bd6`, focus ring `rgba(11, 92, 255, .22)`.
- Verified `#16885a`; warning `#b86800`; blocker `#d92d20`.
- Semantic fills remain below 7% opacity and never replace a text label.

## Component families

- Segmented source control, text/path fields, target select, primary/secondary buttons.
- Repository definition list, excluded-directory tokens, candidate rows with native checkboxes.
- Status label with small inline SVG icon; conflicts expand as ruled detail regions.
- Inspector sections separated by rules, not cards; report tabs use an underline.
- Responsive table labels become metadata captions inside stacked candidate rows.

## Required interaction states

- Idle, scanning, scan error, scanned preview, candidate cancellation, generating, generated, validating, staleness diff.
- Buttons expose disabled/loading text and remain keyboard reachable.
- Cancelling a candidate preserves focus on that checkbox; report tabs use a roving `tabindex` and Left/Right/Home/End navigation.
- Dynamic messages use the `role=status` live region; focus is visible; motion respects `prefers-reduced-motion`.

## Allowed primary-screen copy

- Repo2Skill, 本地静态编译器, 代码不会被执行
- 本地仓库, 公开 GitHub, 仓库路径, GitHub URL, 目标 Agent, 扫描仓库
- 仓库版本, 扫描范围, 排除目录, 语言 / 框架, 包管理器
- 候选工作流, 全选, 已选, 命令, 状态, 来源, 已验证, 未证实, 需要人工确认
- 校验摘要, 阻断项, 警告, 安全发现, 输出目录, 生成 Skill 包
- 校验报告, 安全报告, 过期差异, 当前一致, 已变更, 已移除, 已替代
- Skill 包生成成功, 打开报告, 尚未扫描, 重新扫描以查看差异

No marketing headline, fake metrics, settings/help navigation, decorative badge, or invented product claim is allowed.
