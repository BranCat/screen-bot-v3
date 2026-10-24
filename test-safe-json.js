// Offline tests for safe-json.js (2026-10-13).   node test-safe-json.js
const assert = require('assert');
const { ethers } = require('ethers');
const { toPlain, safeStringify } = require('./safe-json');

let passed = 0;
let failed = 0;
const check = (name, fn) => { try { fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.message}`); } };

check('BigNumber -> exact decimal string', () => {
  assert.strictEqual(toPlain(ethers.BigNumber.from('1918887730000000000000000')), '1918887730000000000000000');
  assert.strictEqual(toPlain({ a: ethers.constants.MaxUint256 }).a, ethers.constants.MaxUint256.toString());
});
check('already-serialised BigNumber shape -> decimal string', () => {
  assert.strictEqual(toPlain({ type: 'BigNumber', hex: '0x0de0b6b3a7640000' }), '1000000000000000000');
});
check('BigInt -> string', () => assert.strictEqual(toPlain(123n), '123'));
check('key "raw" dropped at any depth', () => {
  const p = toPlain({ a: { raw: { big: 1 }, keep: 2 }, raw: 3 });
  assert.deepStrictEqual(p, { a: { keep: 2 } });
});
check('long strings trimmed with the length noted', () => {
  const p = toPlain('0x' + 'ab'.repeat(5000));
  assert.ok(p.length < 4100 && /trimmed, 10002 chars/.test(p), p.slice(-40));
});
check('a cycle becomes "[circular]" instead of hanging', () => {
  const a = { name: 'a' }; a.self = a;
  assert.deepStrictEqual(toPlain(a), { name: 'a', self: '[circular]' });
});
check('the same object in two branches is kept both times', () => {
  const shared = { x: 1 };
  assert.deepStrictEqual(toPlain({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } });
});
check('Map, Set, Error, undefined, functions', () => {
  const p = toPlain({ m: new Map([['k', 1]]), s: new Set([1, 2]), e: new Error('boom'), u: undefined, f: () => 1, arr: [undefined, 1] });
  assert.deepStrictEqual(p, { m: { k: 1 }, s: [1, 2], e: { error: 'boom' }, arr: [null, 1] });
});
check('NaN / Infinity become strings (valid JSON)', () => {
  assert.deepStrictEqual(JSON.parse(safeStringify({ a: NaN, b: Infinity })), { a: 'NaN', b: 'Infinity' });
});

console.log(failed ? `${failed} failed, ${passed} passed` : `all checks passed (${passed})`);
process.exit(failed ? 1 : 0);
