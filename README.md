[中文](README.zh-CN.md) | English

# dsh-fail-logger

A failure recorder for every execution mode in DeepSeek Harness: whether the agent runs in **native mode** or **PTC (Code Mode)**, any tool failure is automatically written into the machine-maintained section of a skill — deduplicated, counted, deterministically ranked, and bounded — so the next session's model sees the most common failure causes when it loads the skill. **Fail less over time.**

## Coverage matrix

| Execution mode | Failure source | Recorded as (kind / message) |
|---|---|---|
| Native tools (bash/read/edit/web_search/third-party plugin tools…) | `tool/call` + `tool/result` (isError) | `tool` / `[bash] EPERM: operation not permitted …` |
| PTC `run_code` failures | `tool/result` (isError) | official kind (`exception`/`timeout`/`abort`/…) / raw message |
| Nested tool calls inside a code program (`tools.*` throwing) | `tool/code-dispatch` (isError) | `tool` / `[read] ENOENT: no such file …` |

The observation point is the **session log** (`session/event`) — the exact same hook the official telemetry plugin uses. Pure observer: no service injection, no runtime wrapping, can never affect execution.

## Effect

```
<!-- FAIL-LOG:BEGIN -->
## 自动实录（机器维护，勿手改；由 dsh-fail-logger 插件写入）

- [exception] ReferenceError: require is not defined — ×3（最近 2026-08-14 02:00）
- [tool] [bash] EPERM: operation not permitted, open '/Users/me/.dsh/x' — ×2（最近 2026-08-14 02:00）
- [timeout] compute budget exhausted (60000ms busy) — ×1（最近 2026-08-14 02:00）
<!-- FAIL-LOG:END -->
```

| Session failures (captured automatically) | Skill auto-log section |
|:---:|:---:|
| ![Session failure example](assets/demo-session.png) | ![Skill auto-log section](assets/demo-skill.png) |

*(Sanitized illustrations: content comes from real session failures, paths and usernames replaced with placeholders, and vision-verified to contain no API keys or other sensitive data)*

## Install

```sh
dsh plugin --profile web add "github:Areium/dsh-fail-logger"
# or once published on npm:
# dsh plugin --profile web add dsh-fail-logger
# or manually: merge cordis.patch.yml's insert entry into ~/.dsh/profiles/web/cordis.patch.yml
```

Restart `dsh --profile web`. Zero configuration, works out of the box. Same for headless: `dsh plugin --profile headless add …`.

## Config (patch entry `config:`, all optional)

```yaml
- insert:
    - id: dsh-fail-logger
      name: 'dsh-fail-logger'
      config:
        logDir: /Users/me/.dsh/skills/fail-log-guide  # target skill dir (companion fail-log-guide by default)
        maxEntries: 10    # max rows in the auto section
        maxMsg: 200       # chars kept per message
        marker: FAIL-LOG  # section marker id ([A-Za-z0-9-])
        flushMs: 300      # burst-coalescing debounce window
```

## How it works

- Listens to `session/event`, consuming three event kinds only: `tool/call` (builds a callId→tool-name map, capped at 2048), `tool/result` (recorded only when isError), `tool/code-dispatch` (recorded only when isError).
- `run_code` failure text is parsed into the official `CodeRunFailure.kind` plus the raw message; other tools are prefixed with `[tool-name]`.
- SHA1(kind + first-line message) dedup: the same cause is one entry, its counter increments; ranking is a deterministic total order (count↓ → last↓ → first↓ → hash↑).
- State lives in `.failures.json` next to the skill and is pruned beyond `maxEntries×5`; the section is written between `<!-- …:BEGIN/END -->` markers in SKILL.md — multiple sections collapse, dangling markers self-heal.
- All writes are atomic (tmp + rename); corrupt state is backed up as `.bak-<timestamp>` before reset.

## Known limitations

- **Only failures that reach the session log**: catastrophic process death during tool execution, which cannot produce a `tool/result`, is out of scope.
- **Cross-process counts are best-effort**: with both web and headless profiles mounted, each holds its own in-memory counts. Atomic writes guarantee files never corrupt; at worst one process overwrites a single increment — causes are never lost, only exact counts.
- **Corrupt state is backed up**: an unparseable `.failures.json` is renamed to `.failures.json.bak-<timestamp>` before reset.

## How it differs from similar community plugins

- `distill` (conversation distillation) and `dsh-skillport` (skill library import): *proactive* skill generation/import; this plugin *passively* records run facts. Complementary.
- `dsh-trace` / `dsh-telemetry-redactor` (telemetry export to external platforms): external observability; this plugin targets *local skill self-healing* with no external channel.
- `dsh-notify` (error notifications): alerts only; this plugin accumulates a searchable long-term memory.

## Development & tests

```sh
npm run check   # node --check lib/index.js
npm test        # 10 suites: all-mode event parsing/dedup/pruning/corruption recovery/marker healing/debounce/dispose flush
```

## License

MIT