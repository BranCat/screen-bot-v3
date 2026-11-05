// test-source-feed.js — offline checks for source-feed.js (2026-11-05). A fake explorer
// serves pages of the "recently verified contracts" list. No network.
//
//   node test-source-feed.js

const assert = require('assert');
const { makeFeed, addressesOf } = require('./source-feed');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
}

// A fake explorer: `list` is newest first; pages of `per`; next_page_params = { i }.
function fakeExplorer(list, { per = 3, fail = null } = {}) {
  const calls = [];
  const get = async (params) => {
    calls.push(params);
    if (fail) return fail;
    const i = params ? params.i : 0;
    const items = list.slice(i, i + per);
    return { status: 200, json: { items, next_page_params: i + per < list.length ? { i: i + per } : null }, error: null };
  };
  get.calls = calls;
  return get;
}
const item = (n, t, impls) => ({ address: { hash: `0x${n.toString(16).padStart(40, '0')}` }, verified_at: `2026-11-05T00:00:${String(t).padStart(2, '0')}Z`, implementations: impls });
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;

(async () => {
  await check('first poll only marks the newest page as seen: no hits, one request', async () => {
    const get = fakeExplorer([item(3, 3), item(2, 2), item(1, 1), item(0, 0)]);
    const f = makeFeed({ get });
    const r = await f.poll();
    assert.ok(r.ok);
    assert.strictEqual(r.hits.size, 0);
    assert.strictEqual(r.requests, 1);
    assert.strictEqual(r.gap, false);
  });
  await check('next poll: only the new entries are hits, stops at the first seen one', async () => {
    const list = [item(3, 3), item(2, 2), item(1, 1)];
    const get = fakeExplorer(list);
    const f = makeFeed({ get });
    await f.poll();
    list.unshift(item(5, 5), item(4, 4));
    const r = await f.poll();
    assert.deepStrictEqual([...r.hits].sort(), [A(4), A(5)]);
    assert.strictEqual(r.requests, 1);
    assert.strictEqual(r.gap, false);
  });
  await check('more new entries than one page: pages back until the last seen one', async () => {
    const list = [item(1, 1)];
    const get = fakeExplorer(list, { per: 2 });
    const f = makeFeed({ get });
    await f.poll();
    list.unshift(item(6, 6), item(5, 5), item(4, 4), item(3, 3), item(2, 2));
    const r = await f.poll();
    assert.strictEqual(r.hits.size, 5);
    assert.strictEqual(r.requests, 3);
    assert.strictEqual(r.gap, false);
  });
  await check('falls behind by more than maxPages: hits returned, gap reported', async () => {
    const list = [item(1, 1)];
    const get = fakeExplorer(list, { per: 1 });
    const f = makeFeed({ get, maxPages: 2 });
    await f.poll();
    list.unshift(item(4, 4), item(3, 3), item(2, 2));
    const r = await f.poll();
    assert.strictEqual(r.hits.size, 2);
    assert.strictEqual(r.gap, true);
  });
  await check('a proxy entry names its implementations too', async () => {
    const it = item(9, 9, [{ address_hash: A(0x99), name: null }]);
    assert.deepStrictEqual(addressesOf(it), [A(9), A(0x99)]);
    const list = [item(1, 1)];
    const f = makeFeed({ get: fakeExplorer(list) });
    await f.poll();
    list.unshift(it);
    const r = await f.poll();
    assert.ok(r.hits.has(A(0x99)) && r.hits.has(A(9)));
  });
  await check('addresses are lower case (checksummed input)', async () => {
    const it = { address: { hash: '0xAbCdEf0000000000000000000000000000000001' }, verified_at: 'x' };
    assert.deepStrictEqual(addressesOf(it), ['0xabcdef0000000000000000000000000000000001']);
  });
  await check('a failed read reports ok:false and does not move the starting point', async () => {
    const list = [item(1, 1)];
    let fail = null;
    const base = fakeExplorer(list);
    const get = async (p) => (fail || base(p));
    const f = makeFeed({ get });
    await f.poll();
    fail = { status: 402, json: null, error: null };
    const bad = await f.poll();
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.status, 402);
    fail = null;
    list.unshift(item(2, 2));
    const r = await f.poll();
    assert.ok(r.ok && r.hits.has(A(2)));
  });
  await check('reset(): the next poll is a fresh start (no hits)', async () => {
    const list = [item(1, 1)];
    const f = makeFeed({ get: fakeExplorer(list) });
    await f.poll();
    list.unshift(item(2, 2));
    f.reset();
    const r = await f.poll();
    assert.strictEqual(r.hits.size, 0);
  });
  await check('the seen set is capped and stays usable', async () => {
    const list = [];
    for (let i = 0; i < 30; i += 1) list.unshift(item(i + 1, i));
    const f = makeFeed({ get: fakeExplorer(list, { per: 50 }), maxSeen: 10 });
    await f.poll();
    list.unshift(item(100, 59));
    const r = await f.poll();
    assert.ok(r.ok && r.hits.has(A(100)));
  });

  console.log(failed ? `${failed} failed, ${passed} passed` : `all checks passed (${passed})`);
  process.exit(failed ? 1 : 0);
})();
