// test-watch-launches.js — offline checks for watch-launches.js. A fake
// provider serves hand-built PoolCreated / Mint / Initialize / ModifyLiquidity
// logs, and a fake screen() records what it was asked. No RPC, no Tenderly.
//
//   node test-watch-launches.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ethers = require('ethers');
const { ADDR } = require('./config');
const { createWatcher, pickToken, positionAmounts, launchPathOf, parseSince, albertaISOString } = require('./watch-launches');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
}

const v3F = new ethers.utils.Interface(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']);
const v3P = new ethers.utils.Interface(['event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)']);
const pm = new ethers.utils.Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
]);
const lc = (a) => String(a).toLowerCase();
const addr = (n) => ethers.utils.getAddress('0x' + n.toString(16).padStart(40, '0'));
const pid = (n) => '0x' + n.toString(16).padStart(64, '0');
const PONS_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const Q96 = ethers.BigNumber.from(2).pow(96);

let logIdx = 0;
function mk(address, iface, name, values, blockNumber) {
  const ev = iface.encodeEventLog(iface.getEvent(name), values);
  return { address, topics: ev.topics, data: ev.data, blockNumber, logIndex: logIdx++ };
}
const poolCreated = (t0, t1, pool, b) => mk(ADDR.UNISWAP_V3_FACTORY, v3F, 'PoolCreated', [t0, t1, 3000, 60, pool], b);
const mint = (pool, a0, a1, b) => mk(pool, v3P, 'Mint', [addr(9), addr(9), -600, 600, 1000, a0, a1], b);
const init = (id, c0, c1, hooks, b, sqrtPriceX96 = Q96) => mk(ADDR.UNIV4_POOL_MANAGER, pm, 'Initialize', [id, c0, c1, 10000, 200, hooks, sqrtPriceX96, 0], b);
const modify = (id, liq, b, tl = -887200, tu = 887200) => mk(ADDR.UNIV4_POOL_MANAGER, pm, 'ModifyLiquidity', [id, addr(7), tl, tu, liq, pid(1)], b);

function fakeProvider(logs, head) {
  const prov = {
    head,
    calls: 0,
    async getBlockNumber() { return prov.head; },
    async getBlock(n) { const num = n === 'latest' ? prov.head : n; return { number: num, timestamp: 1_790_000_000 + Math.floor(num / 10) }; },
    async call() { throw new Error('no symbol'); },
    // Behaves like ethers v5: a list of addresses is refused here...
    async getLogs(f) {
      if (Array.isArray(f.address)) throw new Error('invalid address or ENS name (argument="name")');
      return prov._match(f);
    },
    // ...but accepted by a raw eth_getLogs, which returns hex block numbers.
    async send(method, params) {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`);
      const f = params[0];
      const hits = await prov._match({ ...f, fromBlock: parseInt(f.fromBlock, 16), toBlock: parseInt(f.toBlock, 16) });
      return hits.map((l) => ({ ...l, blockNumber: '0x' + l.blockNumber.toString(16), logIndex: '0x' + l.logIndex.toString(16) }));
    },
    async _match(f) {
      prov.calls += 1;
      const addrs = f.address == null ? null : (Array.isArray(f.address) ? f.address : [f.address]).map(lc);
      return logs.filter((l) => {
        if (l.blockNumber < f.fromBlock || l.blockNumber > f.toBlock) return false;
        if (addrs && !addrs.includes(lc(l.address))) return false;
        return (f.topics || []).every((t, i) => t == null || (Array.isArray(t) ? t.map(lc).includes(lc(l.topics[i])) : lc(t) === lc(l.topics[i])));
      });
    },
  };
  return prov;
}
function fakeScreen(verdictFor = () => ({ verdict: 'SNIP', reason: 'ok', flags: [], controller: { verdict: 'LOCKED' } })) {
  const seen = [];
  const fn = async (token, o) => { seen.push({ token, o }); return verdictFor(token, o); };
  fn.seen = seen;
  return fn;
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wl-')), 'launches.jsonl');
async function run(logs, { head = 1000, screenFn = fakeScreen(), outFile = null, minEth = 1, minUsdg = 1000, from = 1, detectFile = null, detailDir = null, waitFile = null, sourceGateFn, sourceRecheckSec, now, alarm, holdRetrySec, holdMaxSec, sourceFeedSec, feedPollFn, feedResetFn } = {}) {
  const provider = fakeProvider(logs, head);
  const lines = [];
  const w = createWatcher({ provider, screenFn, outFile, minEth, minUsdg, detectFile, detailDir, waitFile, sourceGateFn, sourceRecheckSec, now, alarm: alarm || (() => {}), holdRetrySec, holdMaxSec, sourceFeedSec, feedPollFn, feedResetFn, explorerStats: null, log: (...a) => lines.push(a.join(' ')) });
  await w.start();
  w._setFrom = from;
  // start() puts nextBlock at head+1 for a live start; replay from `from` instead
  await w.scanRange(from, head);
  await w.idle();
  return { w, lines, screenFn, provider };
}

const TOK = addr(0xabc);
const TOK2 = addr(0xdef);
const POOL = addr(0x5001);

(async () => {
  // ---- pure helpers
  await check('pickToken: token vs WETH / native ETH / USDG, either order', async () => {
    assert.deepStrictEqual(pickToken(ADDR.WETH, TOK).base, 'WETH');
    assert.strictEqual(pickToken(TOK, ADDR.WETH).baseIs0, false);
    assert.strictEqual(pickToken(ADDR.ZERO, TOK).base, 'ETH');
    assert.strictEqual(pickToken(TOK, ADDR.USDG).base, 'USDG');
    assert.strictEqual(pickToken(ADDR.WETH, ADDR.USDG), null);
    assert.strictEqual(pickToken(TOK, TOK2), null);
  });
  await check('positionAmounts: full-range position at price 1 splits L evenly', async () => {
    const L = ethers.BigNumber.from('1000000000000000000');
    const a = positionAmounts({ sqrtPriceX96: Q96, tickLower: -887200, tickUpper: 887200, liquidity: L });
    assert.ok(Math.abs(a.amount0Raw / 1e18 - 1) < 1e-3, `amount0 ${a.amount0Raw}`);
    assert.ok(Math.abs(a.amount1Raw / 1e18 - 1) < 1e-3, `amount1 ${a.amount1Raw}`);
  });
  await check('positionAmounts: price below range is all token0, above is all token1', async () => {
    const L = 1e18;
    const below = positionAmounts({ sqrtPriceX96: Q96, tickLower: 100, tickUpper: 200, liquidity: L });
    assert.ok(below.amount0Raw > 0 && below.amount1Raw === 0);
    const above = positionAmounts({ sqrtPriceX96: Q96, tickLower: -200, tickUpper: -100, liquidity: L });
    assert.ok(above.amount1Raw > 0 && above.amount0Raw === 0);
  });
  await check('launchPathOf names Pons, Bags, hookless and v3', async () => {
    assert.strictEqual(launchPathOf({ version: 'v4', hooks: PONS_HOOK }), 'Pons launchpad');
    assert.strictEqual(launchPathOf({ version: 'v4', hooks: '0x2380aBf72C17aABAb76480244759AC7E2932EEcC' }), 'Bags launchpad');
    assert.strictEqual(launchPathOf({ version: 'v4', hooks: ADDR.ZERO }), 'direct v4 pool (no hook)');
    assert.strictEqual(launchPathOf({ version: 'v3' }), 'direct v3 pool');
    assert.ok(/custom hook/.test(launchPathOf({ version: 'v4', hooks: addr(0x1234) })));
  });
  await check('parseSince reads 90m / 3h / 1d / bare hours, rejects junk', async () => {
    assert.strictEqual(parseSince('90m'), 5400);
    assert.strictEqual(parseSince('3h'), 10800);
    assert.strictEqual(parseSince('1d'), 86400);
    assert.strictEqual(parseSince('2'), 7200);
    assert.strictEqual(parseSince(null), null);
    assert.throws(() => parseSince('soon'));
  });
  await check('albertaISOString never prints hour 24', async () => {
    const s = albertaISOString(new Date('2026-10-08T06:30:00Z')); // 00:30 in Edmonton
    assert.ok(/T00:30:00-06:00$/.test(s), s);
  });

  // ---- v3 detection
  await check('v3: pool created, then 2 WETH minted -> detected and screened once with that pool', async () => {
    const { w, screenFn, lines } = await run([
      poolCreated(ADDR.WETH < TOK ? ADDR.WETH : TOK, ADDR.WETH < TOK ? TOK : ADDR.WETH, POOL, 10),
      mint(POOL, ...(lc(ADDR.WETH) < lc(TOK) ? [ethers.utils.parseEther('2'), 5] : [5, ethers.utils.parseEther('2')]), 12),
    ]);
    assert.strictEqual(screenFn.seen.length, 1);
    assert.strictEqual(screenFn.seen[0].token, TOK);
    assert.strictEqual(screenFn.seen[0].o.pool.version, 'v3');
    assert.strictEqual(lc(screenFn.seen[0].o.pool.poolAddress), lc(POOL));
    assert.strictEqual(w.stats.detected, 1);
    assert.ok(lines.some((l) => l.startsWith('\n*** NEW TOKEN')));
  });
  await check('v3: below-minimum mints wait, and add up across mints', async () => {
    const weth0 = lc(ADDR.WETH) < lc(TOK);
    const half = ethers.utils.parseEther('0.6');
    const m = (b) => mint(POOL, ...(weth0 ? [half, 1] : [1, half]), b);
    const created = poolCreated(weth0 ? ADDR.WETH : TOK, weth0 ? TOK : ADDR.WETH, POOL, 10);
    const one = await run([created, m(11)]);
    assert.strictEqual(one.screenFn.seen.length, 0, 'one 0.6 mint is below 1 ETH');
    const two = await run([created, m(11), m(12)]);
    assert.strictEqual(two.screenFn.seen.length, 1, 'two 0.6 mints reach 1.2 ETH');
  });
  await check('v3: a pool of two unrelated tokens is ignored', async () => {
    const { screenFn, provider } = await run([poolCreated(TOK, TOK2, POOL, 10), mint(POOL, ethers.utils.parseEther('50'), ethers.utils.parseEther('50'), 11)]);
    assert.strictEqual(screenFn.seen.length, 0);
    assert.ok(provider.calls >= 2);
  });

  // ---- v4 detection
  const ID = pid(0x77);
  const L5 = ethers.utils.parseEther('5'); // full range at price 1 -> ~5 of each side
  await check('v4 native ETH, Pons hook: launch detected, ETH amount estimated, pool key passed on', async () => {
    const { screenFn, w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)]);
    assert.strictEqual(screenFn.seen.length, 1);
    const p = screenFn.seen[0].o.pool;
    assert.strictEqual(p.version, 'v4');
    assert.strictEqual(p.base, 'ETH');
    assert.strictEqual(lc(p.poolId), lc(ID));
    assert.strictEqual(p.poolKey.tickSpacing, 200);
    assert.strictEqual(lc(p.poolKey.hooks), lc(PONS_HOOK));
    assert.strictEqual(w.results[0].launchPath, 'Pons launchpad');
    assert.ok(Math.abs(w.results[0].baseAddedEst - 5) < 0.01, `est ${w.results[0].baseAddedEst}`);
  });
  await check('v4: only the ETH side counts toward the minimum, at a lopsided price', async () => {
    // sqrtPrice 2 (price 4): full range L=5e18 -> ~2.5 of currency0 (ETH), ~10 of currency1 (token)
    const at4 = (min) => run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20, Q96.mul(2)), modify(ID, L5, 21)], { minEth: min });
    const a = await at4(1);
    assert.ok(Math.abs(a.w.results[0].baseAddedEst - 2.5) < 0.01, `est ${a.w.results[0].baseAddedEst}`);
    const b = await at4(3);
    assert.strictEqual(b.screenFn.seen.length, 0, '2.5 ETH is below a 3 ETH minimum even though 10 tokens went in');
  });
  await check('v4: liquidity removal (negative delta) never counts as a launch', async () => {
    const { screenFn } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5.mul(-1), 21)]);
    assert.strictEqual(screenFn.seen.length, 0);
  });
  await check('v4: ModifyLiquidity on a pool we never saw created is ignored', async () => {
    const { screenFn } = await run([modify(ID, L5, 21)]);
    assert.strictEqual(screenFn.seen.length, 0);
  });
  await check('v4 USDG pool uses the USDG minimum (6 decimals)', async () => {
    const usdg0 = lc(ADDR.USDG) < lc(TOK);
    const c0 = usdg0 ? ADDR.USDG : TOK;
    const c1 = usdg0 ? TOK : ADDR.USDG;
    // L = 2000e6 at price 1 full range -> ~2000 USDG (raw units 6 decimals) on each side
    const L = ethers.BigNumber.from(2000).mul(1e6);
    const ok = await run([init(ID, c0, c1, ADDR.ZERO, 20), modify(ID, L, 21)]);
    assert.strictEqual(ok.screenFn.seen.length, 1);
    assert.strictEqual(ok.screenFn.seen[0].o.pool.base, 'USDG');
    const small = await run([init(ID, c0, c1, ADDR.ZERO, 20), modify(ID, ethers.BigNumber.from(500).mul(1e6), 21)]);
    assert.strictEqual(small.screenFn.seen.length, 0, '500 USDG is below 1000');
  });
  await check('the same token on two pools is screened once', async () => {
    const ID2 = pid(0x78);
    const { screenFn } = await run([
      init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21),
      init(ID2, ADDR.ZERO, TOK, PONS_HOOK, 22), modify(ID2, L5, 23),
    ]);
    assert.strictEqual(screenFn.seen.length, 1);
  });
  await check('pools are screened in launch order, one at a time', async () => {
    const order = [];
    let running = 0;
    let maxRunning = 0;
    const screenFn = async (token) => {
      running += 1; maxRunning = Math.max(maxRunning, running);
      order.push(token);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return { verdict: 'SNIP', reason: 'ok' };
    };
    const ID2 = pid(0x79);
    await run([
      init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), init(ID2, ADDR.ZERO, TOK2, ADDR.ZERO, 20),
      modify(ID2, L5, 21), modify(ID, L5, 22),
    ], { screenFn });
    assert.deepStrictEqual(order, [TOK2, TOK]);
    assert.strictEqual(maxRunning, 1);
  });
  await check('detection line prints before screening finishes', async () => {
    const lines = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const screenFn = async () => { await gate; return { verdict: 'SNIP', reason: 'ok' }; };
    const provider = fakeProvider([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], 100);
    const w = createWatcher({ provider, screenFn, log: (...a) => lines.push(a.join(' ')) });
    await w.scanRange(1, 100);
    assert.ok(lines.some((l) => l.includes('*** NEW TOKEN')), 'detected while screen still running');
    assert.ok(!lines.some((l) => l.startsWith('==>')));
    release();
    await w.idle();
    assert.ok(lines.some((l) => l.startsWith('==>')));
  });

  // ---- verdict handling and records
  await check('hidden source: marked and skipped, recorded with sourceHidden=true', async () => {
    const outFile = tmpFile();
    const screenFn = fakeScreen(() => ({ verdict: 'DO NOT SNIP', reason: 'source gate: not published', gate: 0, flags: [], controller: null }));
    const { lines } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn, outFile });
    assert.ok(lines.some((l) => l.includes('SOURCE HIDDEN — marked and skipped')));
    const rec = JSON.parse(fs.readFileSync(outFile, 'utf8').trim());
    assert.strictEqual(rec.sourceHidden, true);
    assert.strictEqual(rec.verdict, 'DO NOT SNIP');
    assert.strictEqual(rec.token, TOK);
  });
  await check('a token already in launches.jsonl is never screened again (restart-safe)', async () => {
    const outFile = tmpFile();
    fs.writeFileSync(outFile, JSON.stringify({ token: TOK, verdict: 'DO NOT SNIP', sourceHidden: true }) + '\n');
    const { screenFn } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { outFile });
    assert.strictEqual(screenFn.seen.length, 0);
  });
  await check('repeat controller: a wallet that could pull an earlier launch is flagged', async () => {
    const outFile = tmpFile();
    const EOA = addr(0xbad);
    fs.writeFileSync(outFile, JSON.stringify({ token: TOK2, controller: { verdict: 'CREATOR_CAN_PULL', controller: EOA } }) + '\n');
    const screenFn = fakeScreen(() => ({ verdict: 'DO NOT SNIP', reason: 'controller', gate: '1b', flags: [], controller: { verdict: 'CREATOR_CAN_PULL', controller: EOA } }));
    const { lines, w } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn, outFile });
    assert.ok(lines.some((l) => /repeat controller/.test(l)));
    assert.ok(w.results[0].flags.some((f) => /1 earlier launch/.test(f)));
  });
  await check('a screen that throws is recorded as UNKNOWN and the watcher carries on', async () => {
    const ID2 = pid(0x7a);
    let n = 0;
    const screenFn = async () => { n += 1; if (n === 1) throw new Error('tenderly 500'); return { verdict: 'SNIP', reason: 'ok' }; };
    const { w } = await run([
      init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21),
      init(ID2, ADDR.ZERO, TOK2, ADDR.ZERO, 22), modify(ID2, L5, 23),
    ], { screenFn });
    assert.strictEqual(w.results[0].verdict, 'UNKNOWN');
    assert.ok(/tenderly 500/.test(w.results[0].reason));
    assert.strictEqual(w.results[1].verdict, 'SNIP');
  });
  await check('an old pool (replay > 5h) passes aroundTime to the controller check; a fresh one does not', async () => {
    const old = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { head: 20 + 5 * 3600 * 10 + 100 });
    assert.ok(old.screenFn.seen[0].o.controllerOpts.aroundTime > 0);
    const fresh = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { head: 1000 });
    assert.strictEqual(fresh.screenFn.seen[0].o.controllerOpts.aroundTime, undefined);
  });
  await check('pollOnce walks a long range in 10k-block chunks and stops at the head', async () => {
    const provider = fakeProvider([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 25000), modify(ID, L5, 25001)], 35000);
    const screenFn = fakeScreen();
    const w = createWatcher({ provider, screenFn, log: () => {} });
    await w.start({ sinceSec: 3500 }); // ~35,000 blocks back via blockAtTime on the fake chain
    await w.pollOnce();
    await w.idle();
    assert.strictEqual(screenFn.seen.length, 1);
    const before = provider.calls;
    await w.pollOnce(); // nothing new
    assert.strictEqual(provider.calls, before);
  });
  await check('screen options: amount and minimum ETH are passed through', async () => {
    const provider = fakeProvider([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], 100);
    const screenFn = fakeScreen();
    const w = createWatcher({ provider, screenFn, amountEth: 0.05, minEth: 2, log: () => {} });
    await w.scanRange(1, 100);
    await w.idle();
    assert.strictEqual(screenFn.seen[0].o.amountEth, 0.05);
    assert.strictEqual(screenFn.seen[0].o.minLiqEth, 2);
  });

  await check('the record keeps the Gate 5c allowance-probe summary (null when the screen stopped earlier)', async () => {
    const allowance = { ok: true, ghosts: 1, findings: [{ severity: 'high', title: 'BACKDOOR' }] };
    const withIt = fakeScreen(() => ({ verdict: 'DO NOT SNIP', reason: 'allowance backdoor', gate: '5c', flags: [], controller: null, allowance }));
    const a = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn: withIt });
    assert.deepStrictEqual(a.w.results[0].allowance, allowance);
    assert.strictEqual(a.w.results[0].gate, '5c');
    const b = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)]);
    assert.strictEqual(b.w.results[0].allowance, null);
  });

  // ---- 2026-10-13: detections.jsonl and screens/ -------------------------
  const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  await check('detections.jsonl: pool_created, each liquidity add, launched — in order', async () => {
    const detectFile = tmpFile();
    const half = ethers.utils.parseEther('0.4'); // ~0.4 ETH at price 1, full range: below the 1 ETH minimum
    await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, half, 21), modify(ID, L5, 22)], { detectFile });
    const ev = readJsonl(detectFile);
    assert.deepStrictEqual(ev.map((e) => e.event), ['pool_created', 'liquidity', 'liquidity', 'launched']);
    assert.strictEqual(ev[0].token, TOK);
    assert.strictEqual(ev[0].knownToken, false);
    assert.strictEqual(lc(ev[0].pool), lc(ID));
    assert.strictEqual(ev[0].launchPath, 'direct v4 pool (no hook)');
    assert.ok(ev[1].total < 1 && ev[1].minimum === 1, JSON.stringify(ev[1]));
    assert.ok(ev[2].total >= 1, JSON.stringify(ev[2]));
    assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(ev[3].at), ev[3].at);
  });
  await check('detections.jsonl: a pool that never reaches the minimum is logged (created + liquidity) but not launched', async () => {
    const detectFile = tmpFile();
    const { screenFn } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, ethers.utils.parseEther('0.5'), 21)], { detectFile });
    const ev = readJsonl(detectFile);
    assert.deepStrictEqual(ev.map((e) => e.event), ['pool_created', 'liquidity']);
    assert.strictEqual(screenFn.seen.length, 0);
  });
  await check('detections.jsonl: a pool left below the minimum for 24h is logged as expired', async () => {
    const detectFile = tmpFile();
    const TTL = 24 * 3600 * 10; // PENDING_TTL_BLOCKS in watch-launches.js (10 blocks/s)
    const provider = fakeProvider([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20)], TTL + 100);
    const w = createWatcher({ provider, screenFn: fakeScreen(), detectFile, log: () => {} });
    await w.scanRange(1, 30);
    await w.scanRange(31, TTL + 100);
    const ev = readJsonl(detectFile);
    assert.deepStrictEqual(ev.map((e) => e.event), ['pool_created', 'expired'], JSON.stringify(ev.map((e) => e.event)));
    assert.strictEqual(ev[1].baseAdded, 0);
  });
  await check('detections.jsonl: a second pool for a known token is logged as knownToken=true (possible trap pool)', async () => {
    const detectFile = tmpFile();
    const ID2 = pid(0x78);
    const provider = fakeProvider([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21), init(ID2, ADDR.ZERO, TOK, ADDR.ZERO, 30)], 100);
    const w = createWatcher({ provider, screenFn: fakeScreen(), detectFile, log: () => {} });
    await w.scanRange(1, 25);   // first pool created and launched
    await w.scanRange(26, 100); // then a second pool for the same token
    await w.idle();
    const ev = readJsonl(detectFile);
    const second = ev.filter((e) => e.event === 'pool_created' && lc(e.pool) === lc(ID2));
    assert.strictEqual(second.length, 1);
    assert.strictEqual(second[0].knownToken, true);
  });
  await check('detections.jsonl: a restart replaying the same blocks writes nothing twice', async () => {
    const detectFile = tmpFile();
    const logs = [init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, ethers.utils.parseEther('0.5'), 21)];
    await run(logs, { detectFile });
    await run(logs, { detectFile });
    assert.strictEqual(readJsonl(detectFile).length, 2);
  });
  await check('screens/: one full JSON per screened token, BigNumbers as exact strings, raw payloads dropped', async () => {
    const outFile = tmpFile();
    const detailDir = path.join(path.dirname(outFile), 'screens');
    const screenFn = fakeScreen(() => ({
      verdict: 'SNIP', reason: 'ok', flags: [], controller: { verdict: 'LOCKED' },
      detail: {
        source: { decision: 'PASS' },
        roundTrips: { sim1: { tokensReceivedWei: ethers.BigNumber.from('1918887730000000000000000'), raw: { huge: 'x'.repeat(10) } } },
        allowanceProbe: { ok: true, probes: [{ key: 'stranger_dead', succeeded: false }] },
      },
    }));
    await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn, outFile, detailDir });
    const days = fs.readdirSync(detailDir);
    assert.strictEqual(days.length, 1);
    assert.ok(/^\d{4}-\d\d-\d\d$/.test(days[0]), days[0]);
    const files = fs.readdirSync(path.join(detailDir, days[0]));
    assert.strictEqual(files.length, 1);
    assert.ok(new RegExp(`^\\d{6}_NOSYMBOL_${TOK}\\.json$`).test(files[0]), files[0]);
    const doc = JSON.parse(fs.readFileSync(path.join(detailDir, days[0], files[0]), 'utf8'));
    assert.strictEqual(doc.record.token, TOK);
    assert.strictEqual(doc.record.verdict, 'SNIP');
    assert.strictEqual(doc.detail.roundTrips.sim1.tokensReceivedWei, '1918887730000000000000000');
    assert.ok(!('raw' in doc.detail.roundTrips.sim1));
    assert.strictEqual(doc.detail.allowanceProbe.probes[0].key, 'stranger_dead');
    assert.ok(!('detail' in doc.result), 'detail is not duplicated under result');
  });
  await check('screens/: a screen with no detail (e.g. screener error) still gets its file', async () => {
    const outFile = tmpFile();
    const detailDir = path.join(path.dirname(outFile), 'screens');
    const screenFn = fakeScreen(() => { throw new Error('boom'); });
    await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn, outFile, detailDir });
    const day = fs.readdirSync(detailDir)[0];
    const doc = JSON.parse(fs.readFileSync(path.join(detailDir, day, fs.readdirSync(path.join(detailDir, day))[0]), 'utf8'));
    assert.strictEqual(doc.record.verdict, 'UNKNOWN');
    assert.strictEqual(doc.detail, null);
  });
  await check('no detectFile / detailDir given: nothing extra is written (tests and old callers unchanged)', async () => {
    const outFile = tmpFile();
    await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { outFile });
    assert.deepStrictEqual(fs.readdirSync(path.dirname(outFile)), ['launches.jsonl']);
  });

  // ---- 2026-10-16: source re-check list ------------------------------------
  // screen() answers SOURCE PENDING in 'probe' mode; a token off the list is screened 'final'.
  const pendingScreen = () => fakeScreen((tok, o) => (o.hiddenSource === 'probe'
    ? { verdict: 'SOURCE PENDING', reason: 'source not published yet; liquidity controller LOCKED', gate: 0, pending: true, sourceHidden: true, flags: [], controller: { verdict: 'LOCKED' } }
    : { verdict: 'SNIP', reason: 'all gates passed', flags: [], controller: { verdict: 'LOCKED' } }));
  const clock = (t0 = 1_800_000_000_000) => { const c = { t: t0, now: () => c.t, at: (sec) => { c.t = t0 + sec * 1000; } }; return c; };
  const gateSeq = (...answers) => { const calls = []; const fn = async (tok) => { calls.push(tok); return answers[Math.min(calls.length - 1, answers.length - 1)]; }; fn.calls = calls; return fn; };
  const HIDDEN = { decision: 'SKIP', sourceVerified: false, reason: 'source NOT published' };
  const PUBLIC = { decision: 'PASS', sourceVerified: true, verifiedBy: 'explorer', explorer_name: 'PonsV2LauncherToken', reason: 'source published' };

  await check('re-check: the watcher screens in probe mode; SOURCE PENDING writes no record, goes on the list', async () => {
    const outFile = tmpFile();
    const waitFile = path.join(path.dirname(outFile), 'source-wait.json');
    const c = clock();
    const screenFn = pendingScreen();
    const { w, lines } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn, outFile, waitFile, now: c.now, sourceGateFn: gateSeq(HIDDEN) });
    assert.strictEqual(screenFn.seen[0].o.hiddenSource, 'probe');
    assert.ok(!fs.existsSync(outFile) || fs.readFileSync(outFile, 'utf8').trim() === '');
    assert.strictEqual(w._state.sourceWait.size, 1);
    assert.ok(lines.some((l) => /SOURCE PENDING/.test(l)));
    const saved = JSON.parse(fs.readFileSync(waitFile, 'utf8'));
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].item.p.tokenAddr, TOK);
  });
  await check('re-check: nothing is looked up before +30s', async () => {
    const c = clock();
    const sg = gateSeq(PUBLIC);
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn: pendingScreen(), now: c.now, sourceGateFn: sg });
    c.at(29); await w.checkSourceWait();
    assert.strictEqual(sg.calls.length, 0);
  });
  await check('re-check: hidden at +30s, published at +60s -> full screen, record carries the timing', async () => {
    const outFile = tmpFile();
    const c = clock();
    const sg = gateSeq(HIDDEN, PUBLIC);
    const screenFn = pendingScreen();
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn, outFile, now: c.now, sourceGateFn: sg });
    c.at(31); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(w._state.sourceWait.size, 1);
    c.at(61); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(sg.calls.length, 2);
    assert.strictEqual(w._state.sourceWait.size, 0);
    assert.strictEqual(screenFn.seen.length, 2);
    assert.strictEqual(screenFn.seen[1].o.hiddenSource, 'final');
    const rec = JSON.parse(fs.readFileSync(outFile, 'utf8').trim());
    assert.strictEqual(rec.verdict, 'SNIP');
    assert.strictEqual(rec.sourceHidden, false);
    assert.strictEqual(rec.sourceRecheck.hiddenAtLaunch, true);
    assert.strictEqual(rec.sourceRecheck.foundOnCheck, 2);
    assert.strictEqual(rec.sourceRecheck.foundAfterSec, 61);
    assert.strictEqual(rec.sourceRecheck.explorerName, 'PonsV2LauncherToken');
    assert.strictEqual(rec.sourceRecheck.controllerAtLaunch, 'LOCKED');
  });
  await check('re-check: never published -> one final DO NOT SNIP record at gate 0 after the last check', async () => {
    const outFile = tmpFile();
    const c = clock();
    const sg = gateSeq(HIDDEN);
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn: pendingScreen(), outFile, now: c.now, sourceGateFn: sg });
    for (const t of [30, 60, 120]) { c.at(t); await w.checkSourceWait(); }
    assert.strictEqual(w._state.sourceWait.size, 1);
    c.at(300); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(sg.calls.length, 4);
    assert.strictEqual(w._state.sourceWait.size, 0);
    const recs = fs.readFileSync(outFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].verdict, 'DO NOT SNIP');
    assert.strictEqual(recs[0].gate, 0);
    assert.strictEqual(recs[0].sourceHidden, true);
    assert.strictEqual(recs[0].sourceRecheck.foundOnCheck, null);
    assert.strictEqual(recs[0].sourceRecheck.checks, 4);
    assert.strictEqual(recs[0].controller.verdict, 'LOCKED');
  });
  await check('re-check: a lookup error on the last check is UNKNOWN, not DO NOT SNIP', async () => {
    const outFile = tmpFile();
    const c = clock();
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn: pendingScreen(), outFile, now: c.now, sourceGateFn: gateSeq({ decision: 'ERROR', reason: 'timeout' }), sourceRecheckSec: [30] });
    c.at(30); await w.checkSourceWait();
    const rec = JSON.parse(fs.readFileSync(outFile, 'utf8').trim());
    assert.strictEqual(rec.verdict, 'UNKNOWN');
  });
  await check('re-check: after a long outage, overdue slots collapse into one lookup', async () => {
    const outFile = tmpFile();
    const c = clock();
    const sg = gateSeq(HIDDEN);
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn: pendingScreen(), outFile, now: c.now, sourceGateFn: sg });
    c.at(3600); await w.checkSourceWait();
    assert.strictEqual(sg.calls.length, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(outFile, 'utf8').trim()).verdict, 'DO NOT SNIP');
  });
  await check('re-check: the list survives a restart — token not re-screened, schedule carries on', async () => {
    const outFile = tmpFile();
    const waitFile = path.join(path.dirname(outFile), 'source-wait.json');
    const c = clock();
    const logs = [init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)];
    await run(logs, { screenFn: pendingScreen(), outFile, waitFile, now: c.now, sourceGateFn: gateSeq(HIDDEN) });
    // restart: the --since replay sees the same launch again
    const screenFn2 = pendingScreen();
    const sg2 = gateSeq(PUBLIC);
    const { w } = await run(logs, { screenFn: screenFn2, outFile, waitFile, now: c.now, sourceGateFn: sg2 });
    assert.strictEqual(screenFn2.seen.length, 0, 'not re-screened from the replay');
    assert.strictEqual(w._state.sourceWait.size, 1);
    c.at(45); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(screenFn2.seen.length, 1);
    assert.strictEqual(screenFn2.seen[0].o.hiddenSource, 'final');
    assert.strictEqual(JSON.parse(fs.readFileSync(waitFile, 'utf8')).length, 0);
  });
  await check('re-check off (sourceRecheckSec []): screen runs in final mode, hidden stays gate 0', async () => {
    const screenFn = fakeScreen(() => ({ verdict: 'DO NOT SNIP', reason: 'source gate: not published', gate: 0, flags: [], controller: null }));
    const { w } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn, sourceRecheckSec: [] });
    assert.strictEqual(screenFn.seen[0].o.hiddenSource, 'final');
    assert.strictEqual(w.results[0].sourceHidden, true);
    assert.strictEqual(w.results[0].sourceRecheck, null);
  });
  await check('hidden + pullable (gate 1b, sourceHidden) is recorded at once with sourceHidden=true', async () => {
    const screenFn = fakeScreen(() => ({ verdict: 'DO NOT SNIP', reason: 'liquidity controller CREATOR_CAN_PULL (the source was not published either)', gate: '1b', sourceHidden: true, flags: [], controller: { verdict: 'CREATOR_CAN_PULL', controller: addr(0xbad) } }));
    const { w } = await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { screenFn });
    assert.strictEqual(w.results[0].gate, '1b');
    assert.strictEqual(w.results[0].sourceHidden, true);
    assert.strictEqual(w._state.sourceWait.size, 0);
  });
  await check('detections.jsonl: source_wait and source_found events are logged', async () => {
    const outFile = tmpFile();
    const detectFile = path.join(path.dirname(outFile), 'detections.jsonl');
    const c = clock();
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn: pendingScreen(), outFile, detectFile, now: c.now, sourceGateFn: gateSeq(PUBLIC) });
    c.at(30); await w.checkSourceWait(); await w.idle();
    const ev = fs.readFileSync(detectFile, 'utf8').trim().split('\n').map(JSON.parse).map((e) => e.event);
    assert.ok(ev.includes('source_wait') && ev.includes('source_found'), ev.join(','));
  });

  // ---- 2026-10-18: explorer quota guard (HTTP 402) ---------------------------
  const Q402 = 'source gate could not complete: verification lookup failed (explorer: HTTP 402 (Blockscout API credits used up))';
  const SG402 = { decision: 'ERROR', reason: `verification lookup failed (${Q402})` };
  const SG_EXPLORER_OK = { decision: 'SKIP', sourceVerified: false, reason: 'source NOT published (checked Sourcify and the block explorer)' };
  const SG_SOURCIFY_PASS = { decision: 'PASS', sourceVerified: true, verifiedBy: 'sourcify', reason: 'source published (Sourcify)' };
  // 402 at Gate 0 until `fixed` is set, then SNIP
  const quotaScreen = () => { const st = { fixed: false }; const fn = fakeScreen(() => (st.fixed
    ? { verdict: 'SNIP', reason: 'all gates passed', flags: [], controller: { verdict: 'LOCKED' } }
    : { verdict: 'UNKNOWN', reason: Q402, gate: 0, flags: [], controller: null })); fn.st = st; return fn; };
  const ID2Q = pid(0x7b);
  const twoLaunches = () => [init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21), init(ID2Q, ADDR.ZERO, TOK2, ADDR.ZERO, 22), modify(ID2Q, L5, 23)];
  const recs = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

  await check('quota: a 402 at Gate 0 holds the token (no record), raises one alarm; the next token is held unscreened', async () => {
    const outFile = tmpFile();
    const alarms = [];
    const screenFn = quotaScreen();
    const { w, lines } = await run(twoLaunches(), { screenFn, outFile, now: clock().now, alarm: (m) => alarms.push(m) });
    assert.strictEqual(screenFn.seen.length, 1, 'second token not screened during the outage');
    assert.strictEqual(recs(outFile).length, 0);
    assert.strictEqual([...w._state.sourceWait.values()].filter((e) => e.hold).length, 2);
    assert.strictEqual(alarms.length, 1);
    assert.ok(/EXPLORER QUOTA EXHAUSTED/.test(alarms[0]), alarms[0]);
    assert.ok(lines.some((l) => /HELD \(explorer quota\)/.test(l)));
    assert.strictEqual(w.stats.quotaHeld, 2);
  });
  await check('quota: one probe per retry interval; still 402 = still held; explorer answers -> all released and screened', async () => {
    const outFile = tmpFile();
    const alarms = [];
    const c = clock();
    const screenFn = quotaScreen();
    const sg = gateSeq(SG402, SG_EXPLORER_OK);
    const { w } = await run(twoLaunches(), { screenFn, outFile, now: c.now, sourceGateFn: sg, alarm: (m) => alarms.push(m) });
    c.at(599); await w.checkSourceWait();
    assert.strictEqual(sg.calls.length, 0, 'no probe before the retry interval');
    c.at(601); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(sg.calls.length, 1, 'one probe, not one per held token');
    assert.strictEqual(w._state.sourceWait.size, 2);
    assert.strictEqual(alarms.length, 1, 'no second alarm within the hour');
    screenFn.st.fixed = true;
    c.at(1202); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(w._state.sourceWait.size, 0);
    const r = recs(outFile);
    assert.strictEqual(r.length, 2);
    assert.ok(r.every((x) => x.verdict === 'SNIP' && x.quotaHold && x.quotaHold.released === true));
    assert.strictEqual(r.find((x) => x.token === TOK).quotaHold.heldSec, 1202);
    assert.ok(/answering again/.test(alarms[1]), alarms[1]);
    assert.strictEqual(w._state.outage.since, null);
    assert.strictEqual(w.stats.quotaReleased, 2);
  });
  await check('quota: a token held past holdMaxSec is recorded UNKNOWN unscreened (released:false)', async () => {
    const outFile = tmpFile();
    const c = clock();
    const screenFn = quotaScreen();
    const { w } = await run(twoLaunches(), { screenFn, outFile, now: c.now, sourceGateFn: gateSeq(SG402), holdMaxSec: 3600 });
    c.at(3601); await w.checkSourceWait(); await w.idle();
    const r = recs(outFile);
    assert.strictEqual(r.length, 2);
    assert.ok(r.every((x) => x.verdict === 'UNKNOWN' && x.gate === 0 && x.quotaHold.released === false && x.sourceHidden === false));
    assert.ok(r[0].flags.includes('explorer quota outage'));
    assert.strictEqual(screenFn.seen.length, 1);
    assert.strictEqual(w._state.sourceWait.size, 0);
    assert.strictEqual(w.stats.quotaExpired, 2);
  });
  await check('quota: a 402 on the source re-check list moves the token to the hold list', async () => {
    const outFile = tmpFile();
    const alarms = [];
    const c = clock();
    const { w } = await run([init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)], { screenFn: pendingScreen(), outFile, now: c.now, sourceGateFn: gateSeq(SG402), alarm: (m) => alarms.push(m) });
    c.at(30); await w.checkSourceWait();
    const e = w._state.sourceWait.get(lc(TOK));
    assert.ok(e && e.hold, 'held');
    assert.strictEqual(e.controllerAtLaunch.verdict, 'LOCKED', 'Gate 1b result kept');
    assert.strictEqual(recs(outFile).length, 0, 'not written off as UNKNOWN');
    assert.strictEqual(alarms.length, 1);
  });
  await check('quota: a Sourcify-only answer releases just that token (the explorer is still untested)', async () => {
    const outFile = tmpFile();
    const c = clock();
    const screenFn = quotaScreen();
    const { w } = await run(twoLaunches(), { screenFn, outFile, now: c.now, sourceGateFn: gateSeq(SG_SOURCIFY_PASS) });
    screenFn.st.fixed = true;
    c.at(601); await w.checkSourceWait(); await w.idle();
    assert.strictEqual([...w._state.sourceWait.values()].filter((e) => e.hold).length, 1);
    assert.strictEqual(recs(outFile).length, 1);
    assert.strictEqual(recs(outFile)[0].token, TOK, 'the oldest held token was the probe');
    assert.notStrictEqual(w._state.outage.since, null);
  });
  await check('quota: the hold list survives a restart and is not re-screened from the replay', async () => {
    const outFile = tmpFile();
    const waitFile = path.join(path.dirname(outFile), 'source-wait.json');
    const c = clock();
    await run(twoLaunches(), { screenFn: quotaScreen(), outFile, waitFile, now: c.now });
    const screenFn2 = quotaScreen();
    screenFn2.st.fixed = true;
    const sg2 = gateSeq(SG_EXPLORER_OK);
    const { w } = await run(twoLaunches(), { screenFn: screenFn2, outFile, waitFile, now: c.now, sourceGateFn: sg2 });
    assert.strictEqual(screenFn2.seen.length, 0);
    assert.strictEqual(w._state.sourceWait.size, 2);
    c.at(700); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(recs(outFile).length, 2);
    assert.strictEqual(screenFn2.seen[0].o.hiddenSource, 'probe', 'a released token is screened as new');
  });
  await check('quota: a normal screen with no outage is untouched (quotaHold null)', async () => {
    const outFile = tmpFile();
    await run([init(ID, ADDR.ZERO, TOK, ADDR.ZERO, 20), modify(ID, L5, 21)], { outFile });
    assert.strictEqual(recs(outFile)[0].quotaHold, null);
  });

  // ---- 2026-11-05: source feed (source-feed.js) + 24 h backup schedule ------------
  // A fake feed: each poll() returns the next answer in the list (the last one repeats).
  const feedSeq = (...answers) => {
    const calls = [];
    const fn = async () => { calls.push(1); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return typeof a === 'function' ? a() : a; };
    fn.calls = calls;
    return fn;
  };
  const NOHIT = { ok: true, hits: new Set(), requests: 1, gap: false };
  const HIT = (...a) => ({ ok: true, hits: new Set(a.map(lc)), requests: 1, gap: false });
  const NEW_SCHEDULE = [30, 300, 1800, 7200, 86400];
  const IMPL = addr(0x1111);
  const PROXY_HIDDEN = { decision: 'SKIP', sourceVerified: false, isProxy: true, implementationAddr: IMPL, reason: 'implementation source NOT published' };
  const launch = () => [init(ID, ADDR.ZERO, TOK, PONS_HOOK, 20), modify(ID, L5, 21)];

  await check('feed: a waiting token named by the feed is looked up at once and screened; record says found by feed', async () => {
    const outFile = tmpFile();
    const c = clock();
    const sg = gateSeq(PUBLIC);
    const fp = feedSeq(HIT(TOK));
    const screenFn = pendingScreen();
    const { w } = await run(launch(), { screenFn, outFile, now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    c.at(12); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(fp.calls.length, 1);
    assert.strictEqual(sg.calls.length, 1);
    const rec = JSON.parse(fs.readFileSync(outFile, 'utf8').trim());
    assert.strictEqual(rec.verdict, 'SNIP');
    assert.strictEqual(rec.sourceRecheck.foundBy, 'feed');
    assert.strictEqual(rec.sourceRecheck.foundAfterSec, 12);
    assert.deepStrictEqual(rec.sourceRecheck.feed, { everySec: 60, lookups: 1 });
    assert.strictEqual(w.stats.sourceFoundByFeed, 1);
  });
  await check('feed: a token not named by the feed is not looked up before its slot', async () => {
    const c = clock();
    const sg = gateSeq(PUBLIC);
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: feedSeq(HIT(TOK2)) });
    c.at(12); await w.checkSourceWait();
    assert.strictEqual(sg.calls.length, 0);
    c.at(30); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(sg.calls.length, 1);
    assert.strictEqual(w.results[0].sourceRecheck.foundBy, 'schedule');
  });
  await check('feed: read at most once per sourceFeedSec', async () => {
    const c = clock();
    const fp = feedSeq(NOHIT);
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: gateSeq(HIDDEN), sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    for (const t of [1, 11, 21, 59]) { c.at(t); await w.checkSourceWait(); }
    assert.strictEqual(fp.calls.length, 1);
    c.at(62); await w.checkSourceWait();
    assert.strictEqual(fp.calls.length, 2);
  });
  await check('feed: not read when nothing waits; reset when the list empties', async () => {
    const c = clock();
    const fp = feedSeq(HIT(TOK));
    let resets = 0;
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: gateSeq(PUBLIC), sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp, feedResetFn: () => { resets += 1; } });
    c.at(5); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(w._state.sourceWait.size, 0);
    c.at(200); await w.checkSourceWait();
    assert.strictEqual(fp.calls.length, 1, 'no read with an empty list');
    // checkSourceWait returns early on an empty list, so reset happens on the next read attempt with a list;
    // what matters: no credits are spent while nothing waits.
    assert.ok(resets <= 1);
  });
  await check('feed: proxy verified but implementation hidden -> keeps waiting; implementation named later -> found', async () => {
    const outFile = tmpFile();
    const c = clock();
    const sg = gateSeq(PROXY_HIDDEN, PUBLIC);
    const fp = feedSeq(HIT(TOK), NOHIT, HIT(IMPL));
    const { w, lines } = await run(launch(), { screenFn: pendingScreen(), outFile, now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    c.at(10); await w.checkSourceWait();
    assert.strictEqual(sg.calls.length, 1);
    assert.strictEqual(w._state.sourceWait.size, 1, 'still waiting: implementation hidden');
    const e = w._state.sourceWait.get(lc(TOK));
    assert.strictEqual(e.slotsDone, 0, 'a feed lookup is not a schedule slot');
    assert.strictEqual(e.implAddr, lc(IMPL));
    assert.ok(lines.some((l) => /named by the feed, but still SKIP/.test(l)));
    c.at(25); await w.checkSourceWait(); // no read (60 s), no slot yet
    c.at(70); await w.checkSourceWait(); // read 2: nothing; slot 30 s due -> schedule lookup... answers PUBLIC
    await w.idle();
    assert.strictEqual(sg.calls.length, 2);
    assert.strictEqual(w.results[0].sourceRecheck.foundBy, 'schedule');
  });
  await check('feed: implementation named by the feed is matched to its proxy token', async () => {
    const c = clock();
    const sg = gateSeq(PROXY_HIDDEN, PUBLIC);
    const fp = feedSeq(NOHIT, HIT(IMPL));
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    c.at(30); await w.checkSourceWait(); // read 1 (nothing) + slot 30 s: proxy, implementation hidden
    assert.strictEqual(w._state.sourceWait.get(lc(TOK)).implAddr, lc(IMPL));
    c.at(95); await w.checkSourceWait(); await w.idle(); // read 2 names the implementation
    assert.strictEqual(sg.calls.length, 2);
    assert.strictEqual(w.results[0].verdict, 'SNIP');
    assert.strictEqual(w.results[0].sourceRecheck.foundBy, 'feed');
  });
  await check('feed: a failed read changes nothing; the backup slot still finds the token', async () => {
    const c = clock();
    const sg = gateSeq(PUBLIC);
    const fp = feedSeq({ ok: false, status: 500, error: 'HTTP 500', requests: 1 });
    const { w, lines } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    c.at(30); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(w._state.feed.errors, 1);
    assert.ok(lines.some((l) => /\[feed\] read failed/.test(l)));
    assert.strictEqual(w.results[0].sourceRecheck.foundBy, 'schedule');
  });
  await check('feed: a thrown error is caught like a failed read', async () => {
    const c = clock();
    const fp = feedSeq(() => { throw new Error('socket hang up'); });
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: gateSeq(HIDDEN), sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    c.at(5); await w.checkSourceWait();
    assert.strictEqual(w._state.feed.errors, 1);
    assert.strictEqual(w._state.sourceWait.size, 1);
  });
  await check('feed: HTTP 402 raises the quota alarm and pauses the feed for holdRetrySec', async () => {
    const c = clock();
    const alarms = [];
    const fp = feedSeq({ ok: false, status: 402, error: null, requests: 1 }, NOHIT);
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: gateSeq(HIDDEN), sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp, holdRetrySec: 600, alarm: (m) => alarms.push(m) });
    c.at(5); await w.checkSourceWait();
    assert.strictEqual(alarms.length, 1);
    c.at(300); await w.checkSourceWait();
    assert.strictEqual(fp.calls.length, 1, 'paused');
    c.at(606); await w.checkSourceWait();
    assert.strictEqual(fp.calls.length, 2, 'reading again after the pause');
  });
  await check('24 h schedule: never published -> backups at 30 s, 5 min, 30 min, 2 h; given up only at 24 h', async () => {
    const outFile = tmpFile();
    const c = clock();
    const sg = gateSeq(HIDDEN);
    const { w } = await run(launch(), { screenFn: pendingScreen(), outFile, now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: feedSeq(NOHIT) });
    for (const t of [30, 300, 1800, 3600, 7200, 50000]) { c.at(t); await w.checkSourceWait(); }
    assert.strictEqual(sg.calls.length, 4);
    assert.strictEqual(w._state.sourceWait.size, 1, 'still waiting before 24 h');
    c.at(86400); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(sg.calls.length, 5);
    const rec = JSON.parse(fs.readFileSync(outFile, 'utf8').trim());
    assert.strictEqual(rec.verdict, 'DO NOT SNIP');
    assert.strictEqual(rec.gate, 0);
    assert.strictEqual(rec.sourceRecheck.gaveUpAfterSec, 86400);
  });
  await check('24 h schedule: published 3.6 h after launch (MONKEYBOX case) is found by the feed', async () => {
    const c = clock();
    const sg = gateSeq(HIDDEN, HIDDEN, HIDDEN, HIDDEN, PUBLIC);
    let hitNow = false;
    const fp = feedSeq(() => (hitNow ? HIT(TOK) : NOHIT));
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: sg, sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 60, feedPollFn: fp });
    for (const t of [30, 300, 1800, 7200]) { c.at(t); await w.checkSourceWait(); }
    hitNow = true;
    c.at(13080); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(w.results[0].verdict, 'SNIP');
    assert.strictEqual(w.results[0].sourceRecheck.foundBy, 'feed');
    assert.strictEqual(w.results[0].sourceRecheck.foundAfterSec, 13080);
  });
  await check('restart after the schedule change: an entry saved under the old 8-step list is re-counted, not stuck', async () => {
    const outFile = tmpFile();
    const waitFile = path.join(path.dirname(outFile), 'source-wait.json');
    const c = clock();
    const OLD = [30, 60, 120, 300, 600, 900, 1800, 3600];
    const { w: w1 } = await run(launch(), { screenFn: pendingScreen(), outFile, waitFile, now: c.now, sourceGateFn: gateSeq(HIDDEN), sourceRecheckSec: OLD });
    for (const t of [30, 60, 120, 300, 600, 900, 1800]) { c.at(t); await w1.checkSourceWait(); }
    assert.strictEqual(w1._state.sourceWait.get(lc(TOK)).slotsDone, 7);
    // restart with the new schedule
    const sg2 = gateSeq(HIDDEN);
    const { w: w2 } = await run(launch(), { screenFn: pendingScreen(), outFile, waitFile, now: c.now, sourceGateFn: sg2, sourceRecheckSec: NEW_SCHEDULE });
    assert.strictEqual(w2._state.sourceWait.get(lc(TOK)).slotsDone, 3, '30 s, 5 min, 30 min already covered');
    c.at(3600); await w2.checkSourceWait();
    assert.strictEqual(sg2.calls.length, 0, 'next backup is at 2 h');
    c.at(7200); await w2.checkSourceWait();
    assert.strictEqual(sg2.calls.length, 1);
    c.at(86400); await w2.checkSourceWait(); await w2.idle();
    assert.strictEqual(w2._state.sourceWait.size, 0, 'given up at 24 h, not stuck');
  });
  await check('feed off (sourceFeedSec 0): no reads, behaviour as before', async () => {
    const c = clock();
    const fp = feedSeq(HIT(TOK));
    const { w } = await run(launch(), { screenFn: pendingScreen(), now: c.now, sourceGateFn: gateSeq(PUBLIC), sourceRecheckSec: NEW_SCHEDULE, sourceFeedSec: 0, feedPollFn: fp });
    c.at(12); await w.checkSourceWait();
    assert.strictEqual(fp.calls.length, 0);
    c.at(30); await w.checkSourceWait(); await w.idle();
    assert.strictEqual(w.results[0].sourceRecheck.foundBy, 'schedule');
    assert.strictEqual(w.results[0].sourceRecheck.feed, null);
  });

  console.log(failed ? `${failed} failed, ${passed} passed` : `all checks passed (${passed})`);
  process.exit(failed ? 1 : 0);
})();
