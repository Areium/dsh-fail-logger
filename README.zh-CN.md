# ptc-fail-logger

给 DSH（DeepSeek Harness）的 **PTC 模式（Code Mode）** 装一个自动错因记录器：模型每次 `run_code` 失败，插件把错因自动写进 `ptc-code-run-guide` skill 的机器维护区段（按错因去重、计数、按频次排序），下次会话模型加载该 skill 时直接看到高频错因——**错误越记越少**。

## 效果

```
<!-- PTC-FAIL-LOG:BEGIN -->
## 自动实录（机器维护，勿手改；由 ptc-fail-logger 插件写入）

- [exception] ReferenceError: require is not defined — ×3（最近 2026-08-14 02:00）
- [exception] TypeError: res.stdout.slice is not a function — ×1（最近 2026-08-14 02:00）
<!-- PTC-FAIL-LOG:END -->
```

## 安装

```sh
dsh plugin --profile web add "github:<你的用户名>/ptc-fail-logger"
# 或已发布 npm 后：
# dsh plugin --profile web add ptc-fail-logger
# 或手动挂载：把 cordis.patch.yml 的 insert 条目加进 ~/.dsh/profiles/web/cordis.patch.yml
```

重启 `dsh --profile web` 生效（无需任何配置，开箱即用）。

## 工作原理

- `inject: ['codeRuntime']` 拿到宿主 code runtime 服务实例，包一层 `run()`：失败即捕获 `{kind, message}`，成功/超时/中止原样透传；
- SHA1(kind + 首行消息) 去重，同错因只记一条、次数递增；
- 按出现次数降序保留最近 `maxEntries` 条（默认 10），写入 `~/.dsh/skills/ptc-code-run-guide/SKILL.md` 的 `<!-- PTC-FAIL-LOG:BEGIN/END -->` 区段；
- 状态存于 `.failures.json`，删除即重置历史。

## 配置（patch 条目 `config:`，全部可选）

```yaml
- insert:
    - id: ptc-fail-logger
      name: 'ptc-fail-logger'
      config:
        logDir: /Users/me/.dsh/skills/ptc-code-run-guide  # 记录目录
        maxEntries: 10    # 实录最多行数
        maxMsg: 200       # 每条消息保留字符数
        marker: PTC-FAIL-LOG  # 区段标记 id
```

## 与社区同类插件的区别

社区已有的技能维护类插件（`distill` 对话蒸馏成技能、`dsh-skillport` 技能库导入）都是**主动**生成/导入技能；本插件是**被动自动**记录运行失败事实，两者互补。

## 开发与测试

```sh
npm run check   # node --check lib/index.js
npm test        # 单元测试：去重/计数/区段渲染/幂等/自定义配置
```

## License

MIT
