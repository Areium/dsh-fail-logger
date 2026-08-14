import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = new URL('../lib/index.js', import.meta.url);
const SKILL = '---\nname: x\ndescription: y\n---\n\nbody\n';

const mkCtx = () => ({
  handlers: {},
  on(ev, cb) { this.handlers[ev] = cb; },
  emit(type, data, time) { this.handlers['session/event']?.(null, { type, data, ...(time !== undefined ? { time } : {}) }); },
  dispose() { this.handlers['dispose']?.(); }
});
// —— 真实 DSH 0.1.0-rc.6 事件结构 ——
const call = (callId, name, args = {}) => ({ turn: 1, step: 1, callId, name, arguments: args });
const resultReal = (callId, text, isError = true, errMeta) => ({
  turn: 1, step: 1,
  message: {
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: typeof text === 'string' ? [{ type: 'text', text }] : text, isError }],
    role: 'user',
  },
  ...(errMeta ? { error: errMeta } : {}),
});
// —— 旧结构（向后兼容回归用）——
const resultOld = (callId, content, isError = true) => ({ turn: 1, step: 1, message: { callId, content, isError } });
const dispatch = (name, content, isError = true, args = {}) => ({ rootCallId: 'r', parentCallId: 'p', subCallId: 's', name, arguments: args, isError, content });
const readState = (dir) => JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));

// ===== 1：真实结构原生工具失败（isError 在 tool-result 块上）+ 命令参数 + 非错误忽略 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f1-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/call', call('c1', 'bash', { command: 'rm -rf /x' }));
  ctx.emit('tool/result', resultReal('c1', 'EPERM: operation not permitted, open \'/x\'', true));
  ctx.emit('tool/result', resultReal('c1', 'EPERM: operation not permitted, open \'/x\'', true));
  ctx.emit('tool/result', resultReal('c1', 'fine', false));
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '1: one entry');
  const e = Object.values(s.entries)[0];
  assert.strictEqual(e.count, 2, '1: dedup count 2');
  assert.ok(e.message.startsWith('[bash] EPERM:'), '1: tool prefix');
  assert.ok(e.args.includes('rm -rf /x'), '1: command args captured');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('｜命令:'), '1: args rendered');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 2：run_code kind 解析 + data.error.code + unknown 兜底 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f2-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/call', call('c2', 'run_code'));
  ctx.emit('tool/result', resultReal('c2', 'code run failed (exception): ReferenceError: require is not defined', true));
  ctx.emit('tool/result', resultReal('c2', 'code run failed (timeout): compute budget exhausted (60000ms busy)', true));
  ctx.emit('tool/call', call('c3', 'grep'));
  ctx.emit('tool/result', resultReal('c3', 'Search failed: pattern not found', true, { name: 'SearchError', code: 'SEARCH_FAILED' }));
  ctx.emit('tool/result', resultReal('c99', 'boom without call record', true));
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 4, '2: four entries');
  assert.ok(Object.values(s.entries).some(e => e.kind === 'exception' && e.message === 'ReferenceError: require is not defined'), '2: exception');
  assert.ok(Object.values(s.entries).some(e => e.kind === 'timeout'), '2: timeout');
  assert.ok(Object.values(s.entries).some(e => e.kind === 'tool' && e.message.startsWith('[grep]')), '2: grep');
  assert.ok(Object.values(s.entries).some(e => e.message === '[unknown] boom without call record'), '2: unknown');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 3：code-dispatch 块数组 content + 非错误忽略 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f3-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('read', [{ type: 'text', text: 'ENOENT: no such file' }, { type: 'text', text: ', open \'/x\'' }], true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'exit code: 1', false));
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '3: one entry');
  assert.ok(Object.values(s.entries)[0].message.startsWith('[read] ENOENT: no such file, open'), '3: block text joined');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 4：非工具事件忽略 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f4-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('user/message', { content: 'hi' });
  ctx.emit('session/title', { title: 't' });
  ctx.emit('tool/result', resultReal('c', 'x', false));
  await sleep(450);
  let s = { entries: {} };
  try { s = readState(dir); } catch {}
  assert.strictEqual(Object.keys(s.entries).length, 0, '4: non-failure events ignored');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 5：损坏/畸形状态文件（5 形态）=====
{
  const mod = await import(MOD);
  const bads = ['not json', 'null', '[]', '{"entries": null}', '{"entries": {"a": {"count": "x"}}}'];
  for (const bad of bads) {
    const dir = mkdtempSync(join(tmpdir(), 'f5-'));
    process.env.FAIL_LOG_DIR = dir;
    writeFileSync(join(dir, 'SKILL.md'), SKILL);
    writeFileSync(join(dir, '.failures.json'), bad);
    const ctx = mkCtx();
    mod.apply(ctx, {});
    ctx.emit('tool/code-dispatch', dispatch('bash', 'boom-' + bad.length, true));
    await sleep(450);
    const s = readState(dir);
    assert.strictEqual(Object.keys(s.entries).length, 1, '5: recovered: ' + bad.slice(0, 20));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===== 6：残缺标记自动归位 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f6-'));
  process.env.FAIL_LOG_DIR = dir;
  const mod = await import(MOD);
  writeFileSync(join(dir, 'SKILL.md'), SKILL + '<!-- FAIL-LOG:BEGIN -->\n旧残段\n');
  let ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'dangling begin', true));
  await sleep(450);
  let skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/FAIL-LOG:BEGIN/g) ?? []).length, 1, '6: begin recovered');
  assert.ok(!skill.includes('旧残段'), '6: stale dropped');
  writeFileSync(join(dir, 'SKILL.md'), SKILL + '<!-- FAIL-LOG:END -->\n');
  ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'dangling end', true));
  await sleep(450);
  skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/FAIL-LOG:BEGIN/g) ?? []).length, 1, '6: end recovered');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 7：多区段折叠 + 正文保留 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f7-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), ['---','name: x','description: y','---','','头部','<!-- FAIL-LOG:BEGIN -->','A','<!-- FAIL-LOG:END -->','中间','<!-- FAIL-LOG:BEGIN -->','B','<!-- FAIL-LOG:END -->','尾部',''].join('\n'));
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'collapse', true));
  await sleep(450);
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/FAIL-LOG:BEGIN/g) ?? []).length, 1, '7: single section');
  assert.ok(skill.includes('头部') && skill.includes('中间') && skill.includes('尾部'), '7: text preserved');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 8：有界裁剪 + 空消息 + 分类分组 + 趋势行 + 建议 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f8-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, { maxEntries: 2 });
  ctx.emit('tool/code-dispatch', dispatch('bash', 'hot-a', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'hot-a', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'hot-a', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'hot-b', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'hot-b', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', '', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', '', true));
  for (let i = 0; i < 10; i++) ctx.emit('tool/code-dispatch', dispatch('bash', 'cold-' + i, true));
  await sleep(450);
  const s = readState(dir);
  assert.ok(Object.keys(s.entries).length <= 10, '8: state bounded');
  assert.ok(Object.values(s.entries).some(e => e.message.includes('(empty message)')), '8: empty fallback survives');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('(empty message)'), '8: fallback rendered');
  assert.ok(skill.includes('近 7 天失败:'), '8: trend line');
  assert.ok(skill.includes('### 其他'), '8: category heading');
  assert.ok(skill.includes('v' + mod.VERSION), '8: version marker');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 9：dispose 直刷 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f9-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, { flushMs: 60000 });
  ctx.emit('tool/code-dispatch', dispatch('bash', 'dispose flush', true));
  ctx.dispose();
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '9: flushed on dispose');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 10：损坏状态备份 + TTL 清理 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f10-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  writeFileSync(join(dir, '.failures.json'), '{broken json!!');
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'after corruption', true));
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '10: recovered');
  assert.ok(readdirSync(dir).some(f => f.startsWith('.failures.json.bak-')), '10: backed up');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 11：旧结构向后兼容回归 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f11-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/call', call('c-o', 'bash'));
  ctx.emit('tool/result', resultOld('c-o', 'legacy boom', true));
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '11: legacy shape still recorded');
  assert.ok(Object.values(s.entries)[0].message.includes('legacy boom'), '11: legacy message');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 12：真实日志回放（fixture：真实结构 + 归一化去重 + 脱敏）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'f12-'));
  process.env.FAIL_LOG_DIR = dir;
  process.env.FAIL_LOG_REPLAY = fileURLToPath(new URL('./fixtures/session.jsonl', import.meta.url));
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  mod.apply(mkCtx(), {});   // 回放模式：同步喂事件 + 直刷，不订阅 session/event
  delete process.env.FAIL_LOG_REPLAY;
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 4, '12: replay entries: ' + Object.values(s.entries).map(e => e.message.slice(0, 30)).join(' | '));
  const eperm = Object.values(s.entries).find(e => e.message.includes('EPERM'));
  assert.strictEqual(eperm.count, 2, '12: path-normalized dedup merged two homes');
  const runCode = Object.values(s.entries).find(e => e.kind === 'exception');
  assert.ok(runCode, '12: run_code kind parsed');
  const out = readFileSync(join(dir, 'SKILL.md'), 'utf8') + '\n' + readFileSync(join(dir, '.failures.json'), 'utf8');
  assert.ok(!out.includes('sk-abcdef'), '12: API key redacted (raw secret absent)');
  assert.ok(!out.includes('abcdefABCDEF'), '12: bearer token redacted (raw secret absent)');
  assert.ok(out.includes('***'), '12: redaction markers present');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 13：跨进程锁竞争（flush 延迟重试，不丢计数）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'f13-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  writeFileSync(join(dir, '.failures.json.lock'), '99999');   // 模拟另一进程持有的新锁
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'lock contention', true));
  await sleep(450);   // 首次 flush(300ms) 拿不到锁 → 排 500ms 重试
  let written = false;
  try { readState(dir); written = true; } catch {}
  assert.ok(!written, '13: flush deferred while lock held');
  rmSync(join(dir, '.failures.json.lock'));
  await sleep(1200);  // 等待重试 timer 落盘
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '13: flushed after lock release');
  assert.ok(Object.values(s.entries)[0].message.includes('lock contention'), '13: entry present');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 14：config.ignore 忽略名单（工具名 / 消息正则）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'f14-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, { ignore: ['^read', '故意|noise'] });
  ctx.emit('tool/call', call('c-read', 'read'));
  ctx.emit('tool/result', resultReal('c-read', 'ENOENT: no such file', true));   // 工具名被忽略
  ctx.emit('tool/code-dispatch', dispatch('bash', 'some 故意 noise here', true)); // 消息被忽略
  ctx.emit('tool/code-dispatch', dispatch('bash', 'real failure', true));        // 正常记录
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '14: ignored entries skipped');
  assert.ok(Object.values(s.entries)[0].message.includes('real failure'), '14: real failure recorded');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 15：多次 flush 不翻倍（Bug 1 回归：纯增量账本语义）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'f15-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, { flushMs: 150 });
  ctx.emit('tool/code-dispatch', dispatch('bash', 'inflate check', true));
  await sleep(400);
  ctx.emit('tool/code-dispatch', dispatch('bash', 'inflate check', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'inflate check', true));
  await sleep(400);
  ctx.emit('tool/code-dispatch', dispatch('bash', 'inflate check', true));
  await sleep(400);
  ctx.dispose();
  const s = readState(dir);
  const e = Object.values(s.entries)[0];
  assert.strictEqual(e.count, 4, '15: count equals real failures (no exponential inflation)');
  const dayTotal = Object.values(s.days).reduce((a, b) => a + b, 0);
  assert.strictEqual(dayTotal, 4, '15: days total equals real failures');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 16：first/last 用事件时刻；非法时间戳回退当前时刻 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'f16-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  const t1 = 1786579200000;
  ctx.emit('tool/code-dispatch', dispatch('bash', 'ts honored', true), t1);
  ctx.emit('tool/code-dispatch', dispatch('bash', 'ts invalid fallback', true), 5);
  await sleep(450);
  const s = readState(dir);
  const honored = Object.values(s.entries).find(e => e.message.includes('ts honored'));
  assert.strictEqual(honored.last, new Date(t1).toISOString(), '16: event time honored');
  assert.strictEqual(honored.first, new Date(t1).toISOString(), '16: first equals event time');
  const fallback = Object.values(s.entries).find(e => e.message.includes('ts invalid fallback'));
  assert.ok(fallback.last.startsWith('20'), '16: bogus timestamp falls back to now (not 1970)');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 17：跨会话不翻倍（Bug 回归：内存账本绝不从磁盘播种）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'f17-'));
  process.env.FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  // 模拟两次独立进程（两个 apply = 两个内存账本，共享同一 logDir）
  const s1 = mkCtx();
  mod.apply(s1, { flushMs: 150 });
  s1.emit('tool/code-dispatch', dispatch('bash', 'cross-session', true));
  await sleep(400);
  s1.dispose();
  const s2 = mkCtx();
  mod.apply(s2, { flushMs: 150 });
  s2.emit('tool/code-dispatch', dispatch('bash', 'cross-session', true));
  await sleep(400);
  s2.dispose();
  const s3 = mkCtx();
  mod.apply(s3, { flushMs: 150 });
  s3.emit('tool/code-dispatch', dispatch('bash', 'cross-session', true));
  await sleep(400);
  s3.dispose();
  const s = readState(dir);
  const e = Object.values(s.entries)[0];
  assert.strictEqual(e.count, 3, '17: three sessions → count 3 (no 2^(n+1)-1 inflation)');
  const dayTotal = Object.values(s.days).reduce((a, b) => a + b, 0);
  assert.strictEqual(dayTotal, 3, '17: days total 3');
  rmSync(dir, { recursive: true, force: true });
}

console.log('ALL TESTS PASS ✅ (17 suites)');