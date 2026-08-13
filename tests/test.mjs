import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = new URL('../lib/index.js', import.meta.url);
const SKILL = '---\nname: x\ndescription: y\n---\n\nbody\n';

const mkCtx = () => ({
  handlers: {},
  on(ev, cb) { this.handlers[ev] = cb; },
  emit(type, data) { this.handlers['session/event']?.(null, { type, data }); },
  dispose() { this.handlers['dispose']?.(); }
});
const call = (callId, name) => ({ turn: 1, step: 1, callId, name, arguments: {} });
const result = (callId, content, isError = true) => ({ turn: 1, step: 1, message: { callId, content, isError } });
const dispatch = (name, content, isError = true) => ({ rootCallId: 'r', parentCallId: 'p', subCallId: 's', name, arguments: {}, isError, content });
const readState = (dir) => JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));

// ===== 1：原生工具失败（call/result 关联 + 去重 + 非错误忽略）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'f1-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/call', call('c1', 'bash'));
  ctx.emit('tool/result', result('c1', "EPERM: operation not permitted, open '/Users/x/.dsh/y'", true));
  ctx.emit('tool/result', result('c1', "EPERM: operation not permitted, open '/Users/x/.dsh/y'", true));
  ctx.emit('tool/result', result('c1', 'fine', false));   // 非错误不记
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '1: one entry');
  const e = Object.values(s.entries)[0];
  assert.strictEqual(e.count, 2, '1: dedup count 2');
  assert.strictEqual(e.kind, 'tool', '1: kind tool');
  assert.ok(e.message.startsWith('[bash] EPERM:'), '1: tool prefix');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 2：run_code 失败解析官方 kind + unknown 兜底 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f2-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/call', call('c2', 'run_code'));
  ctx.emit('tool/result', result('c2', 'code run failed (exception): ReferenceError: require is not defined', true));
  ctx.emit('tool/result', result('c2', 'code run failed (timeout): compute budget exhausted (60000ms busy)', true));
  ctx.emit('tool/result', result('c99', 'boom without call record', true));  // unknown 兜底
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 3, '2: three entries');
  assert.ok(Object.values(s.entries).some(e => e.kind === 'exception' && e.message === 'ReferenceError: require is not defined'), '2: exception parsed');
  assert.ok(Object.values(s.entries).some(e => e.kind === 'timeout' && e.message.startsWith('compute budget')), '2: timeout parsed');
  assert.ok(Object.values(s.entries).some(e => e.kind === 'tool' && e.message === '[unknown] boom without call record'), '2: unknown fallback');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 3：PTC 内嵌工具失败（tool/code-dispatch）+ 非错误忽略 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f3-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('read', 'ENOENT: no such file or directory, open \'/x\'', true));
  ctx.emit('tool/code-dispatch', dispatch('bash', 'exit code: 1', false));   // 非错误不记
  await sleep(450);
  const s = readState(dir);
  assert.strictEqual(Object.keys(s.entries).length, 1, '3: one entry');
  assert.ok(Object.values(s.entries)[0].message.startsWith('[read] ENOENT:'), '3: dispatch prefix');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 4：非工具事件忽略 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f4-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), SKILL);
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('user/message', { content: 'hi' });
  ctx.emit('session/title', { title: 't' });
  ctx.emit('llm/request', {});
  ctx.emit('tool/result', result('c', 'x', false));
  await sleep(450);
  let s = { entries: {} };
  try { s = readState(dir); } catch {}   // 无失败记录 → 文件本就不应存在
  assert.strictEqual(Object.keys(s.entries).length, 0, '4: non-failure events ignored');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 5：损坏/畸形状态文件不炸（5 形态，各自独立目录）=====
{
  const mod = await import(MOD);
  const bads = ['not json', 'null', '[]', '{"entries": null}', '{"entries": {"a": {"count": "x"}}}'];
  for (const bad of bads) {
    const dir = mkdtempSync(join(tmpdir(), 'f5-'));
    process.env.PTC_FAIL_LOG_DIR = dir;
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
  process.env.PTC_FAIL_LOG_DIR = dir;
  const mod = await import(MOD);
  writeFileSync(join(dir, 'SKILL.md'), SKILL + '<!-- PTC-FAIL-LOG:BEGIN -->\n旧残段\n');
  let ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'dangling begin', true));
  await sleep(450);
  let skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '6: begin recovered');
  assert.ok(!skill.includes('旧残段'), '6: stale fragment dropped');
  writeFileSync(join(dir, 'SKILL.md'), SKILL + '<!-- PTC-FAIL-LOG:END -->\n');
  ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'dangling end', true));
  await sleep(450);
  skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '6: end recovered');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 7：多区段折叠 + 其他文字保留 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f7-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), [
    '---','name: x','description: y','---','',
    '头部','<!-- PTC-FAIL-LOG:BEGIN -->','A','<!-- PTC-FAIL-LOG:END -->',
    '中间','<!-- PTC-FAIL-LOG:BEGIN -->','B','<!-- PTC-FAIL-LOG:END -->','尾部',''
  ].join('\n'));
  const mod = await import(MOD);
  const ctx = mkCtx();
  mod.apply(ctx, {});
  ctx.emit('tool/code-dispatch', dispatch('bash', 'collapse', true));
  await sleep(450);
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '7: single section');
  assert.ok(skill.includes('头部') && skill.includes('中间') && skill.includes('尾部') && !skill.includes('\nA\n') && !skill.includes('\nB\n'), '7: text preserved, stale dropped');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 8：有界裁剪 + 空消息兜底 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f8-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
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
  rmSync(dir, { recursive: true, force: true });
}

// ===== 9：dispose 立即 flush ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f9-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
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

// ===== 10：损坏状态先备份再重置 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'f10-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
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

console.log('ALL TESTS PASS ✅ (10 suites)');