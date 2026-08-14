[中文](README.zh-CN.md) | English

# dsh-fail-logger

[![CI](https://github.com/Areium/dsh-fail-logger/actions/workflows/ci.yml/badge.svg)](https://github.com/Areium/dsh-fail-logger/actions/workflows/ci.yml) [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/) [![npm](https://img.shields.io/npm/v/dsh-fail-logger)](https://www.npmjs.com/package/dsh-fail-logger)

An all-mode tool failure recorder for DeepSeek Harness: whether the agent runs in **native mode** or **PTC (Code Mode)**, any tool failure is automatically written into the machine-maintained section of a skill — normalized-dedup, counted, deterministically ranked, TTL-pruned, and redacted — so the next session's model sees the most common failure causes when it loads the skill. **Fail less over time.**

## Coverage matrix & trigger conditions

| Execution mode | Failure source | Recorded as (kind / message) |
|---|---|---|
| Native tools (read/grep/write and third-party plugin tools…) | `tool/call` + `tool/result` (tool-result block isError=true) | `tool` / `[read] ENOENT: no such file …` |
| PTC `run_code` failures | `tool/result` (isError=true) | official kind (`exception`/`timeout`/`abort`/…) / raw message |
| Nested tool calls inside a code program (`tools.*` throwing) | `tool/code-dispatch` (isError=true) | `tool` / `[bash] exit code: 1` |

> **Trigger condition**: a failure is recorded only when the tool result is marked `isError: true`. **A non-zero shell exit code does NOT trigger recording** (e.g. `exit 1` is presented as plain text `[exit code: 1]`, not an error) — only genuinely thrown tool calls (read on a missing file, grep failure, run_code crash, …) enter the log.

The observation point is the **session log** (`session/event`) — the exact same hook the official telemetry plugin uses. Pure observer: no service injection, no runtime wrapping, can never affect execution.

| Session failures (captured automatically) | Skill auto-log section |
|:---:|:---:|
| ![Session failure example](assets/demo-session.png) | ![Skill auto-log section](assets/demo-skill.png) |

*Legend — left: tool failures in a session are captured automatically; right: the causes accumulate in the skill's auto-log section (deduplicated, counted, ranked by frequency).*

## Section preview

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

## Install

```sh
# npm (recommended)
dsh plugin --profile web add dsh-fail-logger

# or pin to an exact version
dsh plugin --profile web add dsh-fail-logger@0.4.2

# or GitHub release tag (no npm registry dependency; auditability & rollback)
dsh plugin --profile web add "github:Areium/dsh-fail-logger#v0.4.2"

# or manually: merge cordis.patch.yml's insert entry into ~/.dsh/profiles/web/cordis.patch.yml
```

Restart `dsh --profile web`. Zero configuration, works out of the box. Same for headless: `dsh plugin --profile headless add …`.

## Config (patch entry `config:`, all optional)

```yaml
- insert:
    - id: dsh-fail-logger
      name: 'dsh-fail-logger'
      config:
        logDir: ~/.dsh/skills/fail-log-guide   # target skill directory
        maxEntries: 10     # max rows per category
        maxMsg: 200        # chars kept per message
        marker: FAIL-LOG   # section marker id ([A-Za-z0-9-])
        flushMs: 300       # burst-coalescing debounce window
        ttlDays: 30        # drop entries with no new occurrence for N days (0 = keep forever)
        redact: []         # extra redaction regexes (string array)
        ignore: []         # ignore list (tool-name/message regexes, e.g. ['^read
```

## How it works

- Listens to `session/event`, consuming three event kinds: `tool/call` (callId→{tool name, args} map), `tool/result` (parses the real rc.6 shape: `message.content[].type === 'tool-result'` block's `isError`/`toolCallId`; legacy shape still supported), `tool/code-dispatch` (recorded only when isError). A one-time visible warning fires on unexpected shapes.
- **Normalized dedup**: paths (quoted / drive-letter / absolute → `<path>`) and long numbers (→ `<n>`) are normalized before the SHA1 key — the same EPERM on `/Users/a/x` and `/Users/b/y` merges into one entry; `data.error.code` (e.g. `SEARCH_FAILED`) joins the key when present.
- **Redaction & sanitization**: defaults cover `sk-…` keys, `Bearer`/`Basic` auth, `-u user:pass` and inline URL credentials, `api_key/token/secret/password=` assignments, credential file paths, and private IPs; extend via `config.redact`. Control chars stripped, markdown pipes/backticks escaped (anti inline injection).
- **Cross-process lock-merge**: flush takes an exclusive lock (`wx`, stale >5s recycled) and re-reads + merges the on-disk state before writing — web/headless concurrency no longer loses increments; failed writes keep dirty and retry after 2s.
- **Trend & TTL**: per-day counters render a "last 7 days" trend line; entries with no new occurrence for `ttlDays` are archived.
- **Categorized rendering**: grouped under filesystem / permissions & sandbox / timeout & budget / network & remote / other, with rule-based 💡 suggestions; deterministic total-order ranking (count↓ → last↓ → first↓ → hash↑); state pruned beyond `maxEntries×5`.
- All writes are atomic (tmp + rename); corrupt state is backed up as `.bak-<timestamp>` before reset; a visible startup line logs activation and probes logDir writability.

## Known limitations

- **Only failures that reach the session log**: catastrophic process death during tool execution is out of scope.
- **Corrupt state is backed up**: an unparseable `.failures.json` is renamed to `.failures.json.bak-<timestamp>` before reset.
- **Non-zero exit codes are not recorded**: see the trigger conditions (DSH semantics, not a plugin bug).
- **Dedup is heuristic**: keyed on the normalized first 1-3 lines of text; the same root cause with different wording may split, and different causes with identical wording may merge — acceptable, but be aware.
- **Display keeps the original text**: path/username normalization affects the dedup key only; messages display the original (except redaction rules). For stricter privacy, configure `config.redact` per workspace.

## Community

- **npm**: [dsh-fail-logger](https://www.npmjs.com/package/dsh-fail-logger) (`dsh plugin --profile web add dsh-fail-logger`)
- **GitHub topic**: [dsh-plugin](https://github.com/topics/dsh-plugin) (`deepseek-harness` / `dsh` / `skill` / `fail-logger`)
- **Curated list**: [awesome-dsh-plugin](https://awesome-dsh-plugin.com/)

## How it differs from similar community plugins

- `distill` (conversation distillation) and `dsh-skillport` (skill library import): *proactive* skill generation/import; this plugin *passively* records run facts. Complementary.
- `dsh-trace` / `dsh-telemetry-redactor` (telemetry export to external platforms): external observability; this plugin targets *local skill self-healing* with no external channel.
- `dsh-notify` (error notifications): alerts only; this plugin accumulates a searchable long-term memory.

## Design boundaries (explicit non-goals)

- **No LLM summarization**: calling a model per failure adds cost, network and external dependencies, breaking the pure-observer positioning; rule-based suggestions suffice.
- **No external export**: keeps a distinct niche from dsh-trace/telemetry.
- **No proactive fixes**: record only, never auto-change behavior — avoids amplifying risk.
- Roadmap: per-workspace failure memory isolation (`logDir` template / `@workspace` tags on entries).

## Development & tests

```sh
npm run check   # node --check lib/index.js
npm test        # 14 suites: real event-shape parsing/legacy compat/normalized dedup/redaction/pruning/TTL/corruption recovery/marker healing/debounce/dispose/lock contention/ignore list/log replay
```

**Real-log replay** (against fake-green tests): `FAIL_LOG_REPLAY=<session.jsonl> npm test` feeds real session events into the same handler. Session logs live at `~/.dsh/sessions/**/session.jsonl` (run `zstd -d` first if compressed). `tests/fixtures/session.jsonl` is a real-shape fixture run by CI on every push.

**Post-install smoke test**:

```sh
dsh --profile headless "use the read tool on a file that does not exist"   # trigger a guaranteed failure
tail -20 ~/.dsh/skills/fail-log-guide/SKILL.md                              # FAIL-LOG section with the cause should appear
```

## License

MIT, 'deliberate|noise'])
```

## How it works

- Listens to `session/event`, consuming three event kinds: `tool/call` (callId→{tool name, args} map), `tool/result` (parses the real rc.6 shape: `message.content[].type === 'tool-result'` block's `isError`/`toolCallId`; legacy shape still supported), `tool/code-dispatch` (recorded only when isError). A one-time visible warning fires on unexpected shapes.
- **Normalized dedup**: paths (quoted / drive-letter / absolute → `<path>`) and long numbers (→ `<n>`) are normalized before the SHA1 key — the same EPERM on `/Users/a/x` and `/Users/b/y` merges into one entry; `data.error.code` (e.g. `SEARCH_FAILED`) joins the key when present.
- **Redaction & sanitization**: defaults cover `sk-…` keys, `Bearer` tokens, `api_key/token/secret/password=` assignments, and credential file paths; extend via `config.redact`. Control chars stripped, markdown table pipes escaped (anti prompt-injection).
- **Cross-process lock-merge**: flush takes an exclusive lock (`wx`, stale >5s recycled) and re-reads + merges the on-disk state before writing — web/headless concurrency no longer loses increments; failed writes keep dirty and retry after 2s.
- **Trend & TTL**: per-day counters render a "last 7 days" trend line; entries with no new occurrence for `ttlDays` are archived.
- **Categorized rendering**: grouped under filesystem / permissions & sandbox / timeout & budget / network & remote / other, with rule-based 💡 suggestions; deterministic total-order ranking (count↓ → last↓ → first↓ → hash↑); state pruned beyond `maxEntries×5`.
- All writes are atomic (tmp + rename); corrupt state is backed up as `.bak-<timestamp>` before reset; a visible startup line logs activation and probes logDir writability.

## Known limitations

- **Only failures that reach the session log**: catastrophic process death during tool execution is out of scope.
- **Corrupt state is backed up**: an unparseable `.failures.json` is renamed to `.failures.json.bak-<timestamp>` before reset.
- **Non-zero exit codes are not recorded**: see the trigger conditions (DSH semantics, not a plugin bug).

## How it differs from similar community plugins

- `distill` (conversation distillation) and `dsh-skillport` (skill library import): *proactive* skill generation/import; this plugin *passively* records run facts. Complementary.
- `dsh-trace` / `dsh-telemetry-redactor` (telemetry export to external platforms): external observability; this plugin targets *local skill self-healing* with no external channel.
- `dsh-notify` (error notifications): alerts only; this plugin accumulates a searchable long-term memory.

## Design boundaries (explicit non-goals)

- **No LLM summarization**: calling a model per failure adds cost, network and external dependencies, breaking the pure-observer positioning; rule-based suggestions suffice.
- **No external export**: keeps a distinct niche from dsh-trace/telemetry.
- **No proactive fixes**: record only, never auto-change behavior — avoids amplifying risk.
- Roadmap: per-workspace failure memory isolation (`logDir` template / `@workspace` tags on entries).

## Development & tests

```sh
npm run check   # node --check lib/index.js
npm test        # 12 suites: real event-shape parsing/legacy compat/normalized dedup/redaction/pruning/TTL/corruption recovery/marker healing/debounce/dispose/lock retry/log replay
```

**Real-log replay** (against fake-green tests): `FAIL_LOG_REPLAY=<session.jsonl> npm test` feeds real session events into the same handler. Session logs live at `~/.dsh/sessions/**/session.jsonl` (run `zstd -d` first if compressed). `tests/fixtures/session.jsonl` is a real-shape fixture run by CI on every push.

**Post-install smoke test**:

```sh
dsh --profile headless "use the read tool on a file that does not exist"   # trigger a guaranteed failure
tail -20 ~/.dsh/skills/fail-log-guide/SKILL.md                              # FAIL-LOG section with the cause should appear
```

## License

MIT