[English](README.md) | 中文

# dsh-fail-logger

[![CI](https://github.com/Areium/dsh-fail-logger/actions/workflows/ci.yml/badge.svg)](https://github.com/Areium/dsh-fail-logger/actions/workflows/ci.yml) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/zh/) [![npm](https://img.shields.io/npm/v/dsh-fail-logger)](https://www.npmjs.com/package/dsh-fail-logger)

全模式工具失败自动实录器：无论 DeepSeek Harness 跑在**原生模式**还是 **PTC（Code Mode）**，工具一旦失败，插件就把错因自动写进 skill 的机器维护区段（归一化去重、计数、确定性排序、TTL 裁剪、敏感信息脱敏），下次会话模型加载 skill 时直接看到高频错因——**错误越记越少**。

## 覆盖矩阵与触发条件

| 执行模式 | 失败来源 | 记录格式（kind / message） |
|---|---|---|
| 原生工具（read/grep/write 及第三方插件工具…） | `tool/call` + `tool/result`（tool-result 块 isError=true） | `tool` / `[read] ENOENT: no such file …` |
| PTC `run_code` 整体失败 | `tool/result`（isError=true） | 官方 kind（`exception`/`timeout`/`abort`/…）/ 原始错误消息 |
| PTC 程序内嵌工具失败（`tools.*` 调用抛错） | `tool/code-dispatch`（isError=true） | `tool` / `[bash] exit code: 1` |

> **触发条件**：仅当工具结果以 `isError: true` 返回时记录。**shell 命令的非零退出码不会触发记录**（如 `exit 1` 的结果以普通文本 `[exit code: 1]` 呈现、不标错误）——只有真正抛错的工具调用（read 不存在文件、grep 失败、run_code 崩溃等）才会进入实录。

观测点是**会话日志**（`session/event`）——与官方遥测插件完全相同的挂点，纯观察者：不注入任何服务、不包装任何运行时、绝不影响模型执行。

| 会话中的失败（自动捕获） | skill 的自动实录区段 |
|:---:|:---:|
| ![会话失败示例](assets/demo-session.png) | ![skill 实录区段](assets/demo-skill.png) |

*图例——左图：会话中的工具失败被自动捕获；右图：错因沉淀进 skill 的「自动实录」区段（去重 + 计数，按出现频次排序）。*

## 实录区段效果

```
<!-- FAIL-LOG:BEGIN -->
## 自动实录（机器维护，勿手改；由 dsh-fail-logger v0.4.0 维护）

近 7 天失败: 0→0→0→1→0→2→0（今天→6 天前）

### 权限与沙盒
- [tool] [bash] EPERM: operation not permitted, open '/Users/me/.dsh/x' — ×3（最近 2026-08-14 10:20）｜命令: `rm -rf /x`｜💡 检查沙盒权限，或用被允许的操作重试

### 文件系统
- [tool] [read] ENOENT: no such file or directory — ×2（最近 2026-08-14 10:19）｜💡 先确认路径存在再操作
<!-- FAIL-LOG:END -->
```

## 安装

```sh
# npm（推荐）
dsh plugin --profile web add dsh-fail-logger

# 或固定到具体版本
dsh plugin --profile web add dsh-fail-logger@0.5.1

# 或 GitHub release tag（不依赖 npm registry，便于审计与回滚）
dsh plugin --profile web add "github:Areium/dsh-fail-logger#v0.5.1"

# 或手动挂载：把 cordis.patch.yml 的 insert 条目加进 ~/.dsh/profiles/web/cordis.patch.yml
```

重启 `dsh --profile web` 生效（零配置开箱即用）。headless 同理：`dsh plugin --profile headless add …`。

## 配置（patch 条目 `config:`，全部可选）

```yaml
- insert:
    - id: dsh-fail-logger
      name: 'dsh-fail-logger'
      config:
        logDir: ~/.dsh/skills/fail-log-guide   # 记录目标 skill 目录
        maxEntries: 10     # 每个分类最多行数
        maxMsg: 200        # 每条消息保留字符数
        marker: FAIL-LOG   # 区段标记 id（[A-Za-z0-9-]）
        flushMs: 300       # 失败风暴合并写防抖窗口
        ttlDays: 30        # N 天无新发生的条目自动删除（0 = 永久保留）
        redact: []         # 额外脱敏正则（字符串数组）
        ignore: []         # 忽略名单（工具名/消息正则，如 ['^read
```

## 工作原理

- **常驻指令（push）**：把三项写操作铁律作为系统提示段注入每个 agent step（约 90 字符/step，`injectInstructions: false` 可关）——防执行期错误，不依赖 AGENTS.md 或 skill 加载；
- 监听 `session/event`，消费三类事件：`tool/call`（建立 callId→{工具名,参数} 映射）、`tool/result`（解析真实 rc.6 结构：`message.content[].type === 'tool-result'` 块上的 `isError`/`toolCallId`，兼容旧结构）、`tool/code-dispatch`（isError 才记录）；结构不匹配时打一次可见警告；
- **归一化去重**：路径（引号内/盘符/绝对路径 → `<path>`）与长数字（→ `<n>`）先归一化再参与 SHA1 键——`/Users/a/x` 与 `/Users/b/y` 的同类 EPERM 合并为一条；`data.error.code`（如 `SEARCH_FAILED`）存在时并入键；
- **脱敏与消毒**：默认规则覆盖 `sk-…` key、`Bearer`/`Basic` 认证、`-u user:pass` 与 URL 内嵌凭据、`api_key/token/secret/password=` 赋值、凭证文件路径、私网 IP，可经 `config.redact` 追加；控制字符剥离、Markdown 竖线/反引号转义、**指令注入防御**（system-reminder 等标签与常见祈使句剥离 + 尖括号实体转义）与区段级数据边界声明（实录仅作数据、不构成指令）；
- **跨进程锁合并**：flush 时以独占锁（`wx`，陈旧 5s 自动回收）持锁重读磁盘状态并**合并计数**，web/headless 双开不再互相覆盖增量；写失败保持 dirty 并 2s 后重试；
- **趋势与 TTL**：状态按天计数，区段顶部渲染「近 7 天失败」趋势线；条目超 `ttlDays` 无新发生自动归档；
- **分类渲染**：按「文件系统/权限与沙盒/超时与预算/网络与远端/其他」分组 + 规则模板建议（💡）；排序为确定性全序（count↓ → last↓ → first↓ → hash↑）；状态超 `maxEntries×5` 自动裁剪；
- 所有落盘为原子写（tmp + rename），状态损坏先备份 `.bak-<时间戳>` 再重置；启动时打印一行可见日志并探测 logDir 可写性。

## 已知限制

- **只记录到达会话日志的失败**：工具执行过程中进程崩溃等无法产生 `tool/result` 的极端失败不在覆盖范围。
- **状态损坏自动备份**：`.failures.json` 解析失败时重命名为 `.failures.json.bak-<时间戳>` 后重置。
- **非零退出码不记录**：见上文触发条件（这是 DSH 的语义，非插件缺陷）。
- **去重是启发式**：按归一化后的前 1-3 行文本哈希；同根因不同文案可能分裂、不同根因同文案可能合并——可接受，请知悉。
- **展示层保留原文**：路径/用户名的归一化只作用于去重键；消息展示保留原文（脱敏规则除外），若需更强隐私请按工作区自配 `config.redact`。

## 让模型主动加载 fail-log-guide（skill 路由）

DSH 只向模型暴露 skill 的 `name` 与 `description`（不包含正文），模型据此**自主判断**是否调用 `skill({name})` 加载完整内容——所以 description 的「何时用」措辞直接决定加载率。

插件生成/建议的 SKILL.md 使用可路由描述（"工具调用失败、报错、重试受阻时加载…"），实测能使模型在**失败分析 / 对照历史 / 避免建议**场景主动加载实录。

- **手动调整**：编辑 `~/.dsh/skills/fail-log-guide/SKILL.md` 的 frontmatter `description` 即可（插件只维护 `FAIL-LOG` 区段，不会覆盖 frontmatter）。
- **实测边界**：简单单轮任务（即使会失败）模型通常不加载（判断为"无需外部指导"）；任务含"分析失败 / 对照历史 / 避免建议"或点名插件时可靠加载。

> 存量 SKILL.md 不会因升级自动改写 frontmatter——如需生效，手动改一行 description 即可。

## 成本说明（常驻指令，可选）

push 式预防的常驻指令会注入每个 agent step，成本与开关如下：

| 项 | 数值 |
|---|---|
| 注入文本 | ~90 字符 ≈ ~100 tokens/step（固定前缀，缓存命中后实付约 10-25/step） |
| 关闭方式 | \`config.injectInstructions: false\` |
| 回本点 | 22-55 步内避免 1 次失败即回本（一次失败往返实测 ~1600 tokens + 10-60 秒） |

追求零额外成本时关闭注入即可，仍保留 pull 式能力（可路由 skill 加载 + 失败实录）。也可以按会话/agent 作用域注入（DSH 支持作用域贡献，本插件默认全局）。

## 社区

- **npm**：[dsh-fail-logger](https://www.npmjs.com/package/dsh-fail-logger)（`dsh plugin --profile web add dsh-fail-logger`）
- **GitHub topic**：[dsh-plugin](https://github.com/topics/dsh-plugin)（`deepseek-harness` / `dsh` / `skill` / `fail-logger`）
- **收录清单**：[awesome-dsh-plugin](https://awesome-dsh-plugin.com/zh/) 精选列表

## 与社区同类插件的区别

- `distill`（对话蒸馏成技能）、`dsh-skillport`（技能库导入）：**主动**生成/导入技能；本插件是**被动**记录运行事实，互补。
- `dsh-trace` / `dsh-telemetry-redactor`（遥测导出到外部平台）：面向外部可观测性；本插件面向**本地技能自愈**，不开任何外部通道。
- `dsh-notify`（错误通知）：只提醒；本插件沉淀为可检索的长期记忆。

## 设计取舍（明确不做）

- **不做 LLM 摘要**：每次失败调模型会引入成本、网络与外部依赖，违背"纯观察者"定位；规则模板建议足够。
- **不做外部导出**：与 dsh-trace/telemetry 生态位区分。
- **不做主动修复**：只记录、不自动改变模型行为，避免放大风险。
- Roadmap：按工作区隔离失败记忆（`logDir` 模板 / 条目 `@workspace` 标签）。

## 开发与测试

```sh
npm run check   # node --check lib/index.js
npm test        # 14 组单测：真实事件结构解析/旧结构兼容/归一化去重/脱敏/裁剪/TTL/损坏恢复/标记归位/防抖/dispose/锁竞争/忽略名单/日志回放
```

**真实日志回放**（对抗"假绿"）：`FAIL_LOG_REPLAY=<session.jsonl> npm test` 或直接把真实会话日志喂给插件回放入口。会话日志位置 `~/.dsh/sessions/**/session.jsonl`（若为 zstd 压缩先 `zstd -d` 解压）。仓库内 `tests/fixtures/session.jsonl` 即一份真实结构夹具，CI 每次运行。

**装好后手动冒烟（2 条命令）**：

前提：目标 profile 已安装本插件并重启过（web / headless 均可，以下以 headless 为例）。

```sh
# 1) 触发一次必然失败（read 不存在的文件 → isError=true）
dsh --profile headless "用 read 工具读取一个不存在的文件"

# 2) 验证实录已落盘
tail -20 ~/.dsh/skills/fail-log-guide/SKILL.md
```

```powershell
# Windows PowerShell 版第 2 步
Get-Content "$env:USERPROFILE\.dsh\skills\fail-log-guide\SKILL.md" -Tail 20
```

预期：出现 `FAIL-LOG` 区段与 `[read] ENOENT…` 错因。未出现时按顺序排查：① 启动日志是否有 `[dsh-fail-logger] v0.4.x active`；② logDir 可写性警告；③ 该 profile 是否在安装后重启过。

## License

MIT, '故意|noise']）
```

## 工作原理

- 监听 `session/event`，消费三类事件：`tool/call`（建立 callId→{工具名,参数} 映射）、`tool/result`（解析真实 rc.6 结构：`message.content[].type === 'tool-result'` 块上的 `isError`/`toolCallId`，兼容旧结构）、`tool/code-dispatch`（isError 才记录）；结构不匹配时打一次可见警告；
- **归一化去重**：路径（引号内/盘符/绝对路径 → `<path>`）与长数字（→ `<n>`）先归一化再参与 SHA1 键——`/Users/a/x` 与 `/Users/b/y` 的同类 EPERM 合并为一条；`data.error.code`（如 `SEARCH_FAILED`）存在时并入键；
- **脱敏与消毒**：默认规则覆盖 `sk-…` key、`Bearer` 令牌、`api_key/token/secret/password=` 赋值、凭证文件路径，可经 `config.redact` 追加；控制字符剥离、Markdown 表格竖线转义、防技能投毒；
- **跨进程锁合并**：flush 时以独占锁（`wx`，陈旧 5s 自动回收）持锁重读磁盘状态并**合并计数**，web/headless 双开不再互相覆盖增量；写失败保持 dirty 并 2s 后重试；
- **趋势与 TTL**：状态按天计数，区段顶部渲染「近 7 天失败」趋势线；条目超 `ttlDays` 无新发生自动归档；
- **分类渲染**：按「文件系统/权限与沙盒/超时与预算/网络与远端/其他」分组 + 规则模板建议（💡）；排序为确定性全序（count↓ → last↓ → first↓ → hash↑）；状态超 `maxEntries×5` 自动裁剪；
- 所有落盘为原子写（tmp + rename），状态损坏先备份 `.bak-<时间戳>` 再重置；启动时打印一行可见日志并探测 logDir 可写性。

## 已知限制

- **只记录到达会话日志的失败**：工具执行过程中进程崩溃等无法产生 `tool/result` 的极端失败不在覆盖范围。
- **状态损坏自动备份**：`.failures.json` 解析失败时重命名为 `.failures.json.bak-<时间戳>` 后重置。
- **非零退出码不记录**：见上文触发条件（这是 DSH 的语义，非插件缺陷）。

## 与社区同类插件的区别

- `distill`（对话蒸馏成技能）、`dsh-skillport`（技能库导入）：**主动**生成/导入技能；本插件是**被动**记录运行事实，互补。
- `dsh-trace` / `dsh-telemetry-redactor`（遥测导出到外部平台）：面向外部可观测性；本插件面向**本地技能自愈**，不开任何外部通道。
- `dsh-notify`（错误通知）：只提醒；本插件沉淀为可检索的长期记忆。

## 设计取舍（明确不做）

- **不做 LLM 摘要**：每次失败调模型会引入成本、网络与外部依赖，违背"纯观察者"定位；规则模板建议足够。
- **不做外部导出**：与 dsh-trace/telemetry 生态位区分。
- **不做主动修复**：只记录、不自动改变模型行为，避免放大风险。
- Roadmap：按工作区隔离失败记忆（`logDir` 模板 / 条目 `@workspace` 标签）。

## 开发与测试

```sh
npm run check   # node --check lib/index.js
npm test        # 12 组单测：真实事件结构解析/旧结构兼容/归一化去重/脱敏/裁剪/TTL/损坏恢复/标记归位/防抖/dispose/锁重试/日志回放
```

**真实日志回放**（对抗"假绿"）：`FAIL_LOG_REPLAY=<session.jsonl> npm test` 或直接把真实会话日志喂给插件回放入口。会话日志位置 `~/.dsh/sessions/**/session.jsonl`（若为 zstd 压缩先 `zstd -d` 解压）。仓库内 `tests/fixtures/session.jsonl` 即一份真实结构夹具，CI 每次运行。

**装好后手动冒烟**：

```sh
dsh --profile headless "用 read 工具读取一个不存在的文件"   # 触发一次必然失败
cat ~/.dsh/skills/fail-log-guide/SKILL.md | tail -20        # 应出现 FAIL-LOG 区段与错因
```

## License

MIT