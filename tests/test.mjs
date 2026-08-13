import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = [];
const mkCtx = (runtime, extraOn) => ({ codeRuntime: runtime, on: (ev, cb) => { if (ev === 'dispose') extraOn?.(); } });
const fail = (msg, kind = 'exception') => ({ error: { kind, message: msg } });
const success = { value: 42, logs: [] };
const mkRuntime = (queue) => ({ run: async () => queue.length ? queue.shift() : success });

// ===== 用例 1：基础行为（去重/计数/渲染/幂等标记）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-1-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), ['---','name: ptc-code-run-guide','description: t','---','','# 正文',''].join('\n'));
  const mod = await import(new URL('./index.js', import.meta.url));
  const rt = mkRuntime([fail('ReferenceError: require is not defined'), fail('ReferenceError: require is not defined'), fail('TypeError: res.stdout.slice is not a function'), {}, fail('ReferenceError: require is not defined')]);
  mod.apply(mkCtx(rt), {});
  for (let i = 0; i < 5; i++) await rt.run({});
  await sleep(450);
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
  assert.strictEqual(Object.keys(state.entries).length, 2, '1: two causes');
  assert.strictEqual(Object.values(state.entries).find(e => e.message.includes('require')).count, 3, '1: require count 3');
  assert.ok(skill.includes('×3') && skill.startsWith('---\nname:') && !skill.includes('${'), '1: render + frontmatter');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '1: single marker');
  const state2 = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
  assert.strictEqual(Object.values(state2.entries).find(e => e.message.includes('require')).count, 3, '1: require count 3');
  assert.ok(!readdirSync(dir).some(f => f.includes('.tmp-')), '1: no tmp leftovers');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 用例 2：重复 apply 不重复计数（防重复包装）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-2-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n');
  const mod = await import(new URL('./index.js', import.meta.url));
  const rt = mkRuntime([fail('boom')]);
  mod.apply(mkCtx(rt), {});
  mod.apply(mkCtx(rt), {});   // 模拟 hot-reload 二次挂载
  await rt.run({});
  await sleep(450);
  const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
  assert.strictEqual(Object.values(state.entries)[0].count, 1, '2: no double count');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 用例 3：损坏/畸形状态文件不炸 =====
{
  const mod = await import(new URL('./index.js', import.meta.url));
  const bads = ['not json', 'null', '[]', '{"entries": null}', '{"entries": {"a": {"count": "x"}}}'];
  for (const bad of bads) {
    const dir = mkdtempSync(join(tmpdir(), 'ptc-3-'));
    process.env.PTC_FAIL_LOG_DIR = dir;
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n');
    writeFileSync(join(dir, '.failures.json'), bad);
    const rt = mkRuntime([fail('boom-' + bad.length)]);
    mod.apply(mkCtx(rt), {});
    await rt.run({});
    await sleep(450);
    const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
    assert.strictEqual(Object.keys(state.entries).length, 1, '3: recovered from: ' + bad.slice(0, 20));
    assert.strictEqual(Object.values(state.entries)[0].count, 1, '3: count ok');
    rmSync(dir, { recursive: true, force: true });
  }
}
// ===== 用例 4：残缺标记自动归位 ===== 
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-4-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  const mod = await import(new URL('./index.js', import.meta.url));
  // 只有 BEGIN（尾部残段）
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n<!-- PTC-FAIL-LOG:BEGIN -->\n旧残段\n');
  let rt = mkRuntime([fail('dangling begin')]);
  mod.apply(mkCtx(rt), {});
  await rt.run({});
  await sleep(450);
  let skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '4: begin recovered');
  assert.ok(!skill.includes('旧残段'), '4: stale fragment dropped');
  // 只有 END（游离）
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n<!-- PTC-FAIL-LOG:END -->\n');
  rt = mkRuntime([fail('dangling end')]);
  mod.apply(mkCtx(rt), {});
  await rt.run({});
  await sleep(450);
  skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '4: end recovered');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:END/g) ?? []).length, 1, '4: single end');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 用例 5：dispose 立即 flush（不依赖防抖计时器）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-5-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n');
  const mod = await import(new URL('./index.js', import.meta.url));
  let disposeCb = null;
  const rt = mkRuntime([fail('dispose flush')]);
  const ctx = { codeRuntime: rt, on: (ev, cb) => { if (ev === 'dispose') disposeCb = cb; } };
  mod.apply(ctx, { flushMs: 60000 });  // 大防抖窗口，验证 dispose 直刷
  await rt.run({});
  assert.ok(disposeCb, '5: dispose handler registered');
  disposeCb();
  const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
  assert.strictEqual(Object.keys(state.entries).length, 1, '5: flushed on dispose');
  rmSync(dir, { recursive: true, force: true });
}
// ===== 用例 6：多个完整区段折叠为一个（双进程首建残留/手工复制）=====
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-6-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), [
    '---','name: x','description: y','---','',
    '头部文字',
    '<!-- PTC-FAIL-LOG:BEGIN -->','旧区段 A','<!-- PTC-FAIL-LOG:END -->',
    '中间文字',
    '<!-- PTC-FAIL-LOG:BEGIN -->','旧区段 B','<!-- PTC-FAIL-LOG:END -->',
    '尾部文字',''
  ].join('\n'));
  const mod = await import(new URL('./index.js', import.meta.url));
  const rt = mkRuntime([fail('collapse sections')]);
  mod.apply(mkCtx(rt), {});
  await rt.run({});
  await sleep(450);
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, '6: collapsed to one section');
  assert.strictEqual((skill.match(/PTC-FAIL-LOG:END/g) ?? []).length, 1, '6: single end');
  assert.ok(skill.includes('头部文字') && skill.includes('中间文字') && skill.includes('尾部文字'), '6: other text preserved');
  assert.ok(!skill.includes('旧区段'), '6: stale sections dropped');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 用例 7：状态有界裁剪 + 空消息兜底 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-7-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n');
  const mod = await import(new URL('./index.js', import.meta.url));
  const fail = (msg) => ({ error: { kind: 'exception', message: msg } });
  const q = [];
  q.push(fail('hot-a'), fail('hot-a'), fail('hot-a'));          // count 3
  q.push(fail('hot-b'), fail('hot-b'));                          // count 2
  q.push(fail(''), fail(''));                                    // 空消息兜底 count 2
  for (let i = 0; i < 10; i++) q.push(fail('cold-' + i));        // 10 × count 1
  const rt = mkRuntime(q);
  mod.apply(mkCtx(rt), { maxEntries: 2 });
  for (let i = 0; i < 17; i++) await rt.run({});
  await sleep(450);
  const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
  assert.ok(Object.keys(state.entries).length <= 10, '7: state bounded (≤ maxEntries*5)');
  assert.ok(Object.values(state.entries).some(e => e.message === '(empty message)'), '7: empty message fallback survives prune');
  assert.strictEqual(Object.values(state.entries).find(e => e.message === 'hot-a').count, 3, '7: hot-a count 3');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('(empty message)'), '7: fallback rendered in section');
  rmSync(dir, { recursive: true, force: true });
}

// ===== 用例 8：损坏状态先备份再重置 =====
{
  const dir = mkdtempSync(join(tmpdir(), 'ptc-8-'));
  process.env.PTC_FAIL_LOG_DIR = dir;
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n');
  writeFileSync(join(dir, '.failures.json'), '{broken json!!');
  const mod = await import(new URL('./index.js', import.meta.url));
  const rt = mkRuntime([fail('after corruption')]);
  mod.apply(mkCtx(rt), {});
  await rt.run({});
  await sleep(450);
  const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
  assert.strictEqual(Object.keys(state.entries).length, 1, '8: recovered after corruption');
  assert.ok(readdirSync(dir).some(f => f.startsWith('.failures.json.bak-')), '8: corrupt file backed up');
  rmSync(dir, { recursive: true, force: true });
}

console.log('ALL TESTS PASS ✅ (8 suites)');