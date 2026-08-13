import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const dir = mkdtempSync(join(tmpdir(), 'ptc-logger-test-'));
process.env.PTC_FAIL_LOG_DIR = dir;

const initSkill = ['---','name: ptc-code-run-guide','description: test','---','','# 正文','','**测试。**',''].join('\n');
writeFileSync(join(dir, 'SKILL.md'), initSkill);

const mod = await import(join(process.cwd(), 'lib/index.js'));

const fail1 = { error: { kind: 'exception', message: 'ReferenceError: require is not defined' } };
const fail2 = { error: { kind: 'exception', message: 'TypeError: res.stdout.slice is not a function' } };
const success = { value: 42, logs: [] };
const seq = [fail1, fail1, fail2, success, fail1];
const fakeRuntime = { run: async () => seq.shift() ?? success };
mod.apply({ codeRuntime: fakeRuntime }, {});

for (let i = 0; i < 5; i++) await fakeRuntime.run({});

const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
const state = JSON.parse(readFileSync(join(dir, '.failures.json'), 'utf8'));
const entries = Object.values(state.entries);

// 1) dedup + counts
assert.strictEqual(entries.length, 2, 'two distinct causes');
assert.strictEqual(entries.find(e => e.message.includes('require is not defined')).count, 3, 'dedup count 3');
assert.strictEqual(entries.find(e => e.message.includes('stdout.slice')).count, 1, 'single count 1');
// 2) section rendered, frontmatter intact, no literal interpolation
assert.ok(skill.includes('自动实录'), 'section present');
assert.ok(skill.includes('×3'), 'count rendered');
assert.ok(skill.startsWith('---\nname: ptc-code-run-guide'), 'frontmatter intact');
assert.ok(!skill.includes('${e.kind}'), 'no literal interpolation');
// 3) re-apply idempotent (no duplicate markers)
mod.apply({ codeRuntime: fakeRuntime }, {});
await fakeRuntime.run({});
const skill2 = readFileSync(join(dir, 'SKILL.md'), 'utf8');
assert.strictEqual((skill2.match(/PTC-FAIL-LOG:BEGIN/g) ?? []).length, 1, 'single marker');
// 4) custom marker + maxEntries via config
const dir2 = mkdtempSync(join(tmpdir(), 'ptc-logger-test2-'));
process.env.PTC_FAIL_LOG_DIR = dir2;
writeFileSync(join(dir2, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\nbody\n');
const fake2 = { run: async () => fail1 };
mod.apply({ codeRuntime: fake2 }, { marker: 'MY-LOG', maxEntries: 1 });
await fake2.run({});
const skill3 = readFileSync(join(dir2, 'SKILL.md'), 'utf8');
assert.ok(skill3.includes('MY-LOG:BEGIN'), 'custom marker');

console.log('ALL TESTS PASS ✅');
rmSync(dir, { recursive: true, force: true });
rmSync(dir2, { recursive: true, force: true });
