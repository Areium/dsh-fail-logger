# ptc-fail-logger

An automatic failure recorder for **PTC mode (Code Mode)** in DeepSeek Harness (DSH): every time the model's `run_code` fails, this plugin writes the cause into the machine-maintained section of the `ptc-code-run-guide` skill — deduplicated by message, counted, and sorted by frequency — so the next session's model sees the most common failure causes when it loads the skill. **Fail less over time.**

## Effect

```
<!-- PTC-FAIL-LOG:BEGIN -->
## 自动实录（机器维护，勿手改；由 ptc-fail-logger 插件写入）

- [exception] ReferenceError: require is not defined — ×3（最近 2026-08-14 02:00）
- [exception] TypeError: res.stdout.slice is not a function — ×1（最近 2026-08-14 02:00）
<!-- PTC-FAIL-LOG:END -->
```

## Install

```sh
dsh plugin --profile web add "github:<your-user>/ptc-fail-logger"
# or once published on npm:
# dsh plugin --profile web add ptc-fail-logger
# or manually: merge cordis.patch.yml's insert entry into ~/.dsh/profiles/web/cordis.patch.yml
```

Restart `dsh --profile web`. Zero configuration, works out of the box.

## How it works

- `inject: ['codeRuntime']` grabs the host code-runtime service and wraps its `run()`: failures are captured as `{kind, message}`; successes/timeouts/aborts pass through untouched.
- SHA1(kind + first-line message) dedup: the same cause is one entry, its counter increments.
- Top `maxEntries` (default 10) causes by count are written into `~/.dsh/skills/ptc-code-run-guide/SKILL.md` between `<!-- PTC-FAIL-LOG:BEGIN/END -->` markers.
- State lives in `.failures.json` next to the skill; delete it to reset history.

## Config (patch entry `config:`, all optional)

```yaml
- insert:
    - id: ptc-fail-logger
      name: 'ptc-fail-logger'
      config:
        logDir: /Users/me/.dsh/skills/ptc-code-run-guide  # log directory
        maxEntries: 10    # max rows in the auto section
        maxMsg: 200       # chars kept per message
        marker: PTC-FAIL-LOG  # section marker id
```

## How it differs from similar community plugins

Skill-maintenance plugins like `distill` (conversation distillation into skills) and `dsh-skillport` (skill library import) are *proactive*: they generate/import skills on demand. This plugin is *passive*: it records factual run failures automatically. They complement each other.

## Development & tests

```sh
npm run check   # node --check lib/index.js
npm test        # unit tests: dedup/counts/section render/idempotence/custom config
```

## License

MIT

## Known limitations

- **Cross-process counts are best-effort**: with both web and headless profiles mounted, each holds its own in-memory counts. Flushes are atomic (tmp + rename, never corrupting files), but one process may occasionally overwrite a single increment — causes are never lost, only exact counts.
- **Corrupt state is backed up**: an unparseable `.failures.json` is renamed to `.failures.json.bak-<timestamp>` before reset, so old data stays recoverable.
- **Wraps the runtime instance present at apply time**: if another plugin replaces the whole `codeRuntime` service afterwards, this wrapper is bypassed (ordering-dependent).

