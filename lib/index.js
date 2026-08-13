/**
 * ptc-fail-logger: automatically record PTC (Code Mode) code-run failures into
 * the machine-maintained section of ~/.dsh/skills/ptc-code-run-guide/SKILL.md
 * (deduplicated by message, counted, capped). Host-side cordis plugin: wraps
 * ctx.codeRuntime.run so every run_code failure is captured without the model
 * doing anything. Writes are direct node fs calls (no tool sandbox applies).
 *
 * Config (patch entry `config:` field, all optional):
 *   logDir     - skill directory to maintain (default ~/.dsh/skills/ptc-code-run-guide)
 *   maxEntries - max rows in the auto section (default 10)
 *   maxMsg     - max chars kept per message (default 200)
 *   marker     - section marker id (default PTC-FAIL-LOG)
 * Env override for testing: PTC_FAIL_LOG_DIR.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

export const name = 'ptc-fail-logger';
export const inject = ['codeRuntime'];

function hashOf(kind, msg) {
  return createHash('sha1').update(kind + '|' + msg).digest('hex').slice(0, 16);
}

export function apply(ctx, config = {}) {
  const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh');
  const LOG_DIR = process.env.PTC_FAIL_LOG_DIR || config.logDir || join(DSH_HOME, 'skills', 'ptc-code-run-guide');
  const SKILL_FILE = join(LOG_DIR, 'SKILL.md');
  const STATE_FILE = join(LOG_DIR, '.failures.json');
  const MAX_ENTRIES = config.maxEntries || 10;
  const MAX_MSG = config.maxMsg || 200;
  const MARKER = config.marker || 'PTC-FAIL-LOG';
  const BEGIN_MARK = '<!-- ' + MARKER + ':BEGIN -->';
  const END_MARK = '<!-- ' + MARKER + ':END -->';

  const normMessage = (msg) => String(msg ?? '').split(/\r?\n/)[0].trim().slice(0, MAX_MSG);
  const loadState = () => {
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { entries: {} }; }
  };
  const saveState = (state) => {
    try { mkdirSync(LOG_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  };
  const renderSection = (entries) => {
    const rows = Object.values(entries)
      .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
      .slice(0, MAX_ENTRIES);
    const body = rows.map((e) => {
      const when = e.last.slice(0, 16).replace('T', ' ');
      return '- [' + e.kind + '] ' + e.message + ' — ×' + e.count + '（最近 ' + when + '）';
    });
    const inner = ['', '## 自动实录（机器维护，勿手改；由 ' + name + ' 插件写入）', '', ...body, ''].join('\n');
    return BEGIN_MARK + '\n' + inner.trim() + '\n' + END_MARK;
  };
  const ensureSkillFile = () => {
    try {
      if (readFileSync(SKILL_FILE, 'utf8').length > 0) return;
    } catch {}
    try {
      const dirBase = LOG_DIR.split(/[\\/]/).filter(Boolean).pop() || 'ptc-fail-logger';
      const nameOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(dirBase) ? dirBase : 'ptc-fail-logger';
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(SKILL_FILE, ['---', 'name: ' + nameOk, 'description: 自动记录的 PTC 失败实录（由 ptc-fail-logger 维护）', '---', ''].join('\n') + '\n');
    } catch {}
  };
  const writeSection = (section) => {
    try {
      ensureSkillFile();
      mkdirSync(LOG_DIR, { recursive: true });
      let text;
      try { text = readFileSync(SKILL_FILE, 'utf8'); } catch { text = ''; }
      if (text.includes(BEGIN_MARK) && text.includes(END_MARK)) {
        const before = text.split(BEGIN_MARK)[0];
        const after = text.split(END_MARK).slice(1).join(END_MARK);
        const next = before + section + after;
        if (next === text) return;
        writeFileSync(SKILL_FILE, next);
        return;
      }
      writeFileSync(SKILL_FILE, text.trimEnd() + '\n\n' + section + '\n');
    } catch {}
  };
  const record = (kind, message) => {
    try {
      const state = loadState();
      const key = hashOf(kind, normMessage(message));
      const now = new Date().toISOString();
      const prev = state.entries[key];
      state.entries[key] = prev
        ? { kind, message: normMessage(message), count: prev.count + 1, first: prev.first, last: now }
        : { kind, message: normMessage(message), count: 1, first: now, last: now };
      saveState(state);
      writeSection(renderSection(state.entries));
    } catch {}
  };

  const runtime = ctx.codeRuntime;
  if (!runtime || typeof runtime.run !== 'function') return;
  const originalRun = runtime.run.bind(runtime);
  runtime.run = async (request) => {
    try {
      const result = await originalRun(request);
      if (result && result.error) record(result.error.kind, result.error.message);
      return result;
    } catch (err) {
      record('exception', 'run() rejected: ' + (err?.message ?? String(err)));
      throw err;
    }
  };
}