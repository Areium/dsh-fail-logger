/**
 * dsh-fail-logger: automatically record tool failures from EVERY execution mode
 * into the machine-maintained section of a skill (default
 * ~/.dsh/skills/ptc-code-run-guide/SKILL.md) — deduplicated by message, counted,
 * ranked deterministically, pruned to a bound.
 *
 * Coverage (all through the session log, the same observation point the official
 * session telemetry plugin uses):
 *   - native mode tools (bash/read/edit/...): `tool/call` + `tool/result` (isError)
 *   - PTC/Code Mode run_code failures: `tool/result` (isError), kind parsed out
 *   - nested tool failures inside a code program: `tool/code-dispatch` (isError)
 *
 * Pure observer: no service injection, never mutates the runtime, cannot break
 * a code run. Writes are direct node fs calls (no tool sandbox applies).
 *
 * Config (patch entry `config:` field, all optional):
 *   logDir     - skill directory to maintain (default ~/.dsh/skills/ptc-code-run-guide)
 *   maxEntries - max rows in the auto section (default 10, min 1)
 *   maxMsg     - max chars kept per message (default 200, min 1)
 *   marker     - section marker id, [A-Za-z0-9-] only (default PTC-FAIL-LOG)
 *   flushMs    - trailing debounce for burst failures (default 300ms; flushed on dispose)
 * Env override for testing: PTC_FAIL_LOG_DIR.
 *
 * Robustness: state cached in memory (dedup correct under bursts), files written
 * atomically (tmp + rename — safe when web & headless profiles run concurrently,
 * at worst one process loses a count increment, never corruption), corrupt state
 * is backed up before reset, entries are pruned to stay bounded, and record/write
 * errors never break anything.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

export const name = 'dsh-fail-logger';

const MARKER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const RUN_CODE_RE = /^code run failed \(([a-z-]+)\): (.*)$/;
const CALL_MAP_CAP = 2048;

function hashOf(kind, msg) {
  return createHash('sha1').update(kind + '|' + msg).digest('hex').slice(0, 16);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function apply(ctx, config = {}) {
  const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh');
  const LOG_DIR = process.env.PTC_FAIL_LOG_DIR || config.logDir || join(DSH_HOME, 'skills', 'ptc-code-run-guide');
  const SKILL_FILE = join(LOG_DIR, 'SKILL.md');
  const STATE_FILE = join(LOG_DIR, '.failures.json');
  const MAX_ENTRIES = Math.max(1, Math.floor(Number(config.maxEntries) || 10));
  const MAX_MSG = Math.max(1, Math.floor(Number(config.maxMsg) || 200));
  const MARKER = typeof config.marker === 'string' && MARKER_RE.test(config.marker) ? config.marker : 'PTC-FAIL-LOG';
  const FLUSH_MS = Math.max(0, Number(config.flushMs) || 300);
  const BEGIN_MARK = '<!-- ' + MARKER + ':BEGIN -->';
  const END_MARK = '<!-- ' + MARKER + ':END -->';
  const SECTION_RE = new RegExp(escapeRe(BEGIN_MARK) + '[\\s\\S]*?' + escapeRe(END_MARK), 'g');

  const writeAtomic = (file, data) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  };

  const normMessage = (msg) => String(msg ?? '').split(/\r?\n/)[0].trim().slice(0, MAX_MSG) || '(empty message)';

  const loadState = () => {
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('bad shape');
      if (!s.entries || typeof s.entries !== 'object' || Array.isArray(s.entries)) throw new Error('bad entries');
      for (const [key, v] of Object.entries(s.entries)) {
        if (!v || typeof v !== 'object' || typeof v.count !== 'number'
          || typeof v.kind !== 'string' || typeof v.message !== 'string'
          || typeof v.last !== 'string') delete s.entries[key];
      }
      return s;
    } catch {
      try { renameSync(STATE_FILE, STATE_FILE + '.bak-' + Date.now()); } catch {}
      return { entries: {} };
    }
  };

  // 确定性全序：count 降序 → last 降序 → first 降序 → hash 升序（消除同毫秒并列的抽签淘汰）
  const rankCompare = (a, b) =>
    b.count - a.count
    || b.last.localeCompare(a.last)
    || b.first.localeCompare(a.first)
    || hashOf(a.kind, a.message).localeCompare(hashOf(b.kind, b.message));

  const renderSection = (entries) => {
    const rows = Object.values(entries)
      .sort(rankCompare)
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
      if (statSync(SKILL_FILE).size > 0) return;
    } catch {}
    try {
      const dirBase = LOG_DIR.split(/[\\/]/).filter(Boolean).pop() || 'ptc-code-run-guide';
      const nameOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(dirBase) ? dirBase : 'ptc-code-run-guide';
      writeAtomic(SKILL_FILE, ['---', 'name: ' + nameOk, 'description: 自动记录的工具失败实录（由 dsh-fail-logger 维护）', '---', ''].join('\n') + '\n');
    } catch {}
  };

  const writeSection = (section) => {
    ensureSkillFile();
    let text = '';
    try { text = readFileSync(SKILL_FILE, 'utf8'); } catch {}
    const matches = text.match(SECTION_RE);
    if (matches) {
      let first = true;
      const next = text.replace(SECTION_RE, () => (first ? ((first = false), section) : ''));
      if (next !== text) writeAtomic(SKILL_FILE, next);
      return;
    }
    // 游离 BEGIN：BEGIN 起直到文件尾都是残缺机器区内容，整体替换
    const bi = text.indexOf(BEGIN_MARK);
    if (bi !== -1) {
      writeAtomic(SKILL_FILE, text.slice(0, bi).trimEnd() + '\n\n' + section + '\n');
      return;
    }
    // 游离 END：仅剥离标记本身（其后可能是正文），再追加区段
    const stripped = text.split(END_MARK).join('').trimEnd();
    writeAtomic(SKILL_FILE, (stripped ? stripped + '\n\n' : '') + section + '\n');
  };

  let memState = null;
  let timer = null;
  let dirty = false;
  const flush = () => {
    if (!dirty || !memState) return;
    dirty = false;
    try {
      writeAtomic(STATE_FILE, JSON.stringify(memState, null, 2));
      writeSection(renderSection(memState.entries));
    } catch (e) {
      console.error('[dsh-fail-logger] flush failed:', e?.message ?? e);
    }
  };
  const schedule = () => {
    dirty = true;
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  };
  ctx.on('dispose', () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    flush();
  });

  const record = (kind, message) => {
    try {
      memState = memState ?? loadState();
      const msg = normMessage(message);
      const key = hashOf(kind, msg);
      const now = new Date().toISOString();
      const prev = memState.entries[key];
      memState.entries[key] = prev
        ? { kind, message: msg, count: prev.count + 1, first: prev.first, last: now }
        : { kind, message: msg, count: 1, first: now, last: now };
      // 状态有界：超出上限裁剪低频旧条目
      const all = Object.values(memState.entries);
      if (all.length > MAX_ENTRIES * 5) {
        const keep = new Set(all
          .sort(rankCompare)
          .slice(0, MAX_ENTRIES * 3)
          .map((e) => hashOf(e.kind, e.message)));
        for (const k of Object.keys(memState.entries)) if (!keep.has(k)) delete memState.entries[k];
      }
      schedule();
    } catch (e) {
      console.error('[dsh-fail-logger] record failed:', e?.message ?? e);
    }
  };

  // run_code 失败解析出官方 kind 与原始消息；其他工具统一带 [工具名] 前缀
  const recordToolFailure = (toolName, content) => {
    const text = normMessage(content);
    if (toolName === 'run_code') {
      const m = text.match(RUN_CODE_RE);
      if (m) { record(m[1], m[2]); return; }
    }
    record('tool', '[' + toolName + '] ' + text);
  };

  // 会话事件观察者：与官方遥测插件相同的观测点，覆盖全部执行模式
  const callNames = new Map();
  ctx.on('session/event', (_session, event) => {
    try {
      if (event.type === 'tool/call') {
        const d = event.data;
        if (d && typeof d.callId === 'string' && typeof d.name === 'string') {
          if (callNames.size >= CALL_MAP_CAP) callNames.delete(callNames.keys().next().value);
          callNames.set(d.callId, d.name);
        }
        return;
      }
      if (event.type === 'tool/result') {
        const m = event.data?.message;
        if (!m || m.isError !== true) return;
        recordToolFailure(callNames.get(m.callId) ?? 'unknown', m.content);
        return;
      }
      if (event.type === 'tool/code-dispatch') {
        const d = event.data;
        if (!d || d.isError !== true) return;
        recordToolFailure(d.name ?? 'unknown', d.content);
      }
    } catch {}
  });
}
