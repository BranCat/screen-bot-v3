// extras/test-fast-screen.js — offline checks of fast-screen.js. No RPC, no Tenderly.
//
//   node extras/test-fast-screen.js
//
// The key check: the bot's own screen() (screen-token.js), given the normal checks and
// given the fast ones, reaches the same verdict at the same gate on every path below,
// and the fast one asks for the checks in the same order.

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { ethers } = require(path.join(ROOT, 'node_modules', 'ethers'));
const { ADDR } = require(path.join(ROOT, 'config'));
const { screen } = require(path.join(ROOT, 'screen-token'));
const F = require('./fast-screen');

let passed = 0;
let failed = 0;
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL_ID = '0x' + 'ab'.repeat(32);
const V4 = { version: 'v4', tokenAddr: TOKEN, base: 'ETH', poolId: POOL_ID, hooks: ADDR.ZERO, label: 'v4 test' };
const V3 = { version: 'v3', tokenAddr: TOKEN, base: 'WETH', poolAddress: '0x2222222222222222222222222222222222222222', label: 'v3 test' };
const CREATED = 1000000;

// ---------------------------------------------------------------- clamp
function fakeBase() {
  const calls = [];
  return {
    calls,
    getLogs: async (f) => { calls.push(f); return [{ f }]; },
    getBlockNumber: async () => CREATED + 500,
    call: async () => '0x',
    _isProvider: true,
  };
}
const pmFilter = (from, to, poolId = POOL_ID) => ({ address: ADDR.UNIV4_POOL_MANAGER, topics: ['0xtopic', poolId], fromBlock: from, toBlock: to });

(async () => {
  await check('clamp: v4 chunk wholly before the creation block -> [] without an RPC call', async () => {
    const b = fakeBase();
    const { provider, stats } = F.clampProvider(b, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    assert.deepStrictEqual(await provider.getLogs(pmFilter(CREATED - 20000, CREATED - 10001)), []);
    assert.strictEqual(b.calls.length, 0);
    assert.strictEqual(stats.skipped, 1);
  });
  await check('clamp: chunk spanning the creation block starts at it', async () => {
    const b = fakeBase();
    const { provider, stats } = F.clampProvider(b, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    await provider.getLogs(pmFilter(CREATED - 5000, CREATED + 4999));
    assert.strictEqual(b.calls[0].fromBlock, CREATED);
    assert.strictEqual(b.calls[0].toBlock, CREATED + 4999);
    assert.strictEqual(stats.clamped, 1);
  });
  await check('clamp: the creation block itself is kept (Initialize is there)', async () => {
    const b = fakeBase();
    const { provider } = F.clampProvider(b, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    await provider.getLogs(pmFilter(CREATED, CREATED));
    assert.strictEqual(b.calls.length, 1);
    assert.strictEqual(b.calls[0].fromBlock, CREATED);
  });
  await check('clamp: hex block numbers are understood', async () => {
    const b = fakeBase();
    const { provider, stats } = F.clampProvider(b, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    await provider.getLogs(pmFilter('0x' + (CREATED - 100).toString(16), '0x' + (CREATED - 1).toString(16)));
    assert.strictEqual(stats.skipped, 1);
    assert.strictEqual(b.calls.length, 0);
  });
  await check('clamp: another pool, another contract, or "latest" pass through untouched', async () => {
    const b = fakeBase();
    const { provider, stats } = F.clampProvider(b, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    await provider.getLogs(pmFilter(1, 2, '0x' + 'cd'.repeat(32)));
    await provider.getLogs({ address: TOKEN, topics: ['0xrole'], fromBlock: 1, toBlock: 2 });
    await provider.getLogs(pmFilter('latest', 'latest'));
    assert.strictEqual(b.calls.length, 3);
    assert.strictEqual(b.calls[0].fromBlock, 1);
    assert.strictEqual(stats.passed, 3);
  });
  await check('clamp: v3 pool address filter is clamped; no createdBlock -> nothing clamped', async () => {
    const b = fakeBase();
    const { provider, stats } = F.clampProvider(b, { pool: V3, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    assert.deepStrictEqual(await provider.getLogs({ address: V3.poolAddress.toUpperCase().replace('0X', '0x'), fromBlock: 5, toBlock: 6 }), []);
    assert.strictEqual(stats.skipped, 1);
    const b2 = fakeBase();
    const c2 = F.clampProvider(b2, { pool: V4, createdBlock: null, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    await c2.provider.getLogs(pmFilter(5, 6));
    assert.strictEqual(b2.calls.length, 1);
  });
  await check('clamp: every other provider method is forwarded', async () => {
    const b = fakeBase();
    const { provider } = F.clampProvider(b, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    assert.strictEqual(await provider.getBlockNumber(), CREATED + 500);
    assert.strictEqual(provider._isProvider, true);
  });
  await check('clamp: a 200,000-block scan in 10,000-block chunks: 21 chunks -> 2 RPC calls, same events', async () => {
    const events = [{ blockNumber: CREATED }, { blockNumber: CREATED + 40 }];
    const real = { getLogs: async (f) => events.filter((e) => e.blockNumber >= f.fromBlock && e.blockNumber <= f.toBlock) };
    let rpc = 0;
    const counted = { getLogs: async (f) => { rpc += 1; return real.getLogs(f); } };
    const { provider } = F.clampProvider(counted, { pool: V4, createdBlock: CREATED, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    const head = CREATED + 50;
    const all = [];
    const allPlain = [];
    for (let s = head - 200000; s <= head; s += 10000) {
      const f = pmFilter(s, Math.min(head, s + 9999));
      all.push(...await provider.getLogs(f));
      allPlain.push(...await real.getLogs(f));
    }
    assert.deepStrictEqual(all, allPlain);
    assert.strictEqual(rpc, 2);
  });

  // ---------------------------------------------------------------- screen() equivalence
  const goodSim = (over = {}) => ({ ok: true, netPct: -4.93, sellTaxBps: 0, soldBps: 10000, proceedsWei: '47544000000000000', tokensReceivedWei: '1918887730000000000000000', pinnedBlock: CREATED + 400, ...over });
  const FULL_AUDIT = { ok: true, findings: [], buyLeg: { taxBps: 0 }, sellLeg: { taxBps: 0 }, paths: { transfer: { taxBps: 0 }, transferFrom: { taxBps: 0 } } };
  const CLEAN_PROBE = { ok: true, findings: [], missing: [], privileged: [], ghosts: [], source: { scanned: true } };

  // The real checks, faked. sims: list of results, one per walletRoundTrip call in order.
  function realChecks(over = {}) {
    const calls = [];
    const delay = over.delay || 0;
    let sim = 0;
    const sims = over.sims || [goodSim(), goodSim()];
    const rec = (name, fn) => async (...a) => { calls.push({ name, args: a }); if (delay) await sleep(delay); return fn(...a); };
    const base = {
      sourceGate: rec('source', async () => over.source || ({ decision: 'PASS', reason: 'verified', verificationSubject: TOKEN })),
      controllerCheck: rec('controller', async () => over.controller || ({ verdict: 'LOCKED', reason: '100% locked', controller: '0xLOCK', lockedSharePct: 100 })),
      measureLiquidity: rec('liq', async () => ({ measured: false, note: 'v4' })),
      changeCheck: rec('change', async () => ({ checked: true, wouldBe: 'PASS', summary: 'none' })),
      walletRoundTrip: rec('sim', async () => sims[Math.min(sim++, sims.length - 1)]),
      transferAudit: rec('audit', async () => over.audit || FULL_AUDIT),
      allowanceProbe: rec('allow', async () => over.allow || CLEAN_PROBE),
      rugCheck: rec('rug', async () => over.rug || ({ decision: 'PASS', reason: 'no rug vector', probes: {} })),
      templateMatch: async () => ({ matched: false, reason: 'none' }),
    };
    return { base, calls };
  }
  const prov = { getBlockNumber: async () => CREATED + 500, getBlock: async () => ({ timestamp: 1 }), getLogs: async () => [], _isProvider: true };
  const pool = { ...V4, createdBlock: CREATED };

  async function runNormal(over) {
    const { base, calls } = realChecks(over);
    const r = await quiet(() => screen(TOKEN, { pool, deps: { ...base, provider: prov } }));
    return { r, calls };
  }
  async function runFast(over) {
    const { base, calls } = realChecks(over);
    const fast = F.fastDeps(base, {
      token: TOKEN, pool, amountEth: 0.05, provider: prov, addr: ADDR,
      freshAddress: () => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20))),
      parseEther: ethers.utils.parseEther, BigNumber: ethers.BigNumber, rugLookback: 200000,
    });
    const r = await quiet(() => screen(TOKEN, { pool, deps: { ...fast.deps, templateMatch: base.templateMatch } }));
    await fast.drain();
    return { r, calls, fast };
  }
  async function same(name, over, expect) {
    await check(`same verdict: ${name}`, async () => {
      const n = await runNormal(over);
      const f = await runFast(over);
      assert.strictEqual(f.r.verdict, n.r.verdict, `verdict ${f.r.verdict} vs ${n.r.verdict}`);
      assert.strictEqual(String(f.r.gate), String(n.r.gate), `gate ${f.r.gate} vs ${n.r.gate}`);
      assert.strictEqual(f.r.reason, n.r.reason);
      if (expect) expect(n, f);
    });
  }

  await same('all gates pass -> SNIP, all four early checks used', {}, (n, f) => {
    assert.strictEqual(n.r.verdict, 'SNIP');
    assert.deepStrictEqual(f.fast.counts, { hits: 4, misses: 0, wasted: 0 });
  });
  await same('sim #1 fails -> nothing started early', { sims: [{ ok: false, buyReverted: true, reason: 'buy reverted' }] }, (n, f) => {
    assert.strictEqual(n.r.gate, 3);
    assert.deepStrictEqual(f.fast.started(), []);
  });
  await same('sim #2 disagrees -> Gate 4, early 5b/5c/6 wasted', { sims: [goodSim(), goodSim({ proceedsWei: '40000000000000000', netPct: -20 })] }, (n, f) => {
    assert.strictEqual(String(n.r.gate), '4');
    assert.strictEqual(f.fast.counts.wasted, 3);
  });
  await same('round trip too expensive -> Gate 4', { sims: [goodSim({ netPct: -12 }), goodSim({ netPct: -12 })] });
  await same('sell capped -> Gate 5', { sims: [goodSim({ soldBps: 5000 }), goodSim({ soldBps: 5000 })] });
  await same('transfer audit high finding -> 5b DO NOT SNIP', { audit: { ...FULL_AUDIT, findings: [{ severity: 'high', title: 'hidden buy tax' }] } });
  await same('transfer audit could not complete -> 5b UNKNOWN', { audit: { ok: false, reason: 'tenderly 500' } });
  await same('allowance backdoor -> 5c DO NOT SNIP', { allow: { ...CLEAN_PROBE, findings: [{ severity: 'high', title: 'stranger can move tokens' }] } });
  await same('rug check fails -> 6 DO NOT SNIP', { rug: { decision: 'FAIL', reason: 'creator can remove liquidity', probes: {} } });
  await same('rug check inconclusive -> 6', { rug: { decision: 'SKIP', reason: 'whale dump unclear', probes: {} } });
  await same('controller UNKNOWN still reaches the sims', { controller: { verdict: 'UNKNOWN', reason: 'window' } });
  await same('creator can pull -> 1b, no sims', { controller: { verdict: 'CREATOR_CAN_PULL', reason: 'EOA holds LP', controller: '0xabc' } }, (n, f) => {
    assert.strictEqual(f.calls.filter((c) => c.name === 'sim').length, 0);
  });
  await same('source hidden -> Gate 0', { source: { decision: 'SKIP', reason: 'not published' } });
  await same('no tokensReceived -> Gate 6 UNKNOWN; rug not started early', { sims: [goodSim({ tokensReceivedWei: null }), goodSim({ tokensReceivedWei: null })] }, (n, f) => {
    assert.ok(!f.fast.started().includes('rug'));
  });

  await check('the early checks get the same inputs the bot would give them', async () => {
    const n = await runNormal({});
    const f = await runFast({});
    const strip = (c) => {
      const [x, o] = c.args;
      const { wallet, discover, prov: _p, provider: _q, ...rest } = (o || {});
      return { name: c.name, first: c.name === 'rug' ? 'pool' : String(x), rest: JSON.stringify(rest, (k, v) => (v && v.type === 'BigNumber' ? String(ethers.BigNumber.from(v)) : v)) };
    };
    const later = (calls) => calls.filter((c) => ['sim', 'audit', 'allow', 'rug'].includes(c.name)).map(strip);
    assert.deepStrictEqual(later(f.calls).sort((a, b) => a.name.localeCompare(b.name)), later(n.calls).sort((a, b) => a.name.localeCompare(b.name)));
  });

  await check('a mismatched input is not served from the early result (prefetch miss)', async () => {
    const { base, calls } = realChecks({});
    const fast = F.fastDeps(base, {
      token: TOKEN, pool, amountEth: 0.05, provider: prov, addr: ADDR,
      freshAddress: () => '0x' + '33'.repeat(20), parseEther: ethers.utils.parseEther, BigNumber: ethers.BigNumber, rugLookback: 200000,
    });
    await fast.deps.sourceGate(TOKEN);
    await fast.deps.controllerCheck(pool, {});
    await fast.deps.walletRoundTrip(TOKEN, { amountEth: 0.05 });
    await fast.deps.transferAudit(TOKEN, { amountEth: 0.05, pinnedBlock: 999 }); // bot would pin CREATED+400
    await fast.drain();
    assert.strictEqual(fast.counts.misses, 1);
    assert.strictEqual(calls.filter((c) => c.name === 'audit').length, 2);
  });

  await check('time: with 1 s per check, fast finishes well before normal', async () => {
    const t1 = Date.now(); await runNormal({ delay: 100 }); const normal = Date.now() - t1;
    const t2 = Date.now(); await runFast({ delay: 100 }); const fast = Date.now() - t2;
    assert.ok(fast < normal - 250, `fast ${fast} ms vs normal ${normal} ms`);
  });

  // ---------------------------------------------------------------- reader / compare
  await check('splitLines keeps a partial last line for the next read', async () => {
    const a = F.splitLines('', '{"event":"launched","token":"0xA"}\n{"event":"liq');
    assert.strictEqual(a.events.length, 1);
    const b = F.splitLines(a.rest, 'uidity"}\nnot json\n');
    assert.strictEqual(b.events.length, 1);
    assert.strictEqual(b.rest, '');
  });
  await check('itemsFrom: launched queues; source_found uses the stored launch; unknown source_found ignored', async () => {
    const m = new Map();
    const items = F.itemsFrom([
      { event: 'liquidity', token: '0xA' },
      { event: 'launched', token: '0xA', block: 5, createdBlock: 4 },
      { event: 'source_found', token: '0xa' },
      { event: 'source_found', token: '0xB' },
    ], m, 'now');
    assert.deepStrictEqual(items.map((i) => i.trigger), ['launched', 'source_found']);
    assert.strictEqual(items[1].launched.createdBlock, 4);
  });
  await check('compare: matches launch and after-source screens separately', async () => {
    const bot = [
      { token: '0xA', symbol: 'AAA', verdict: 'SNIP', gate: null, screenSeconds: 60, sourceRecheck: null },
      { token: '0xB', symbol: 'BBB', verdict: 'DO NOT SNIP', gate: 6, screenSeconds: 70, sourceRecheck: { foundOnCheck: 3 } },
      { token: '0xC', symbol: 'CCC', verdict: 'DO NOT SNIP', gate: '1b', screenSeconds: 20, sourceRecheck: null },
    ];
    const shadow = [
      { token: '0xA', trigger: 'launched', verdict: 'SNIP', gate: null, seconds: 12 },
      { token: '0xB', trigger: 'launched', verdict: 'SOURCE PENDING', gate: 0, seconds: 3 },
      { token: '0xB', trigger: 'source_found', verdict: 'DO NOT SNIP', gate: 6, seconds: 14 },
      { token: '0xC', trigger: 'launched', verdict: 'UNKNOWN', gate: '1b', seconds: 2 },
      { token: '0xD', trigger: 'launched', verdict: 'SNIP', gate: null, seconds: 10 },
    ];
    const { rows, summary } = F.compare(bot, shadow);
    assert.deepStrictEqual(rows.map((r) => r.match), ['same', 'pending', 'same', 'DIFFERENT', 'no bot record']);
    assert.strictEqual(summary.compared, 3);
    assert.strictEqual(summary.same, 2);
    assert.strictEqual(summary.medianBotSec, 60);
    assert.strictEqual(summary.medianFastSec, 12);
    assert.deepStrictEqual(summary.snip, { count: 1, medianBotSec: 60, medianFastSec: 12 });
  });
  await check('poolFromDetection rebuilds the v4 pool exactly as the watcher does', async () => {
    const iface = new ethers.utils.Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
    const tok = '0x' + '44'.repeat(20);
    const ev = iface.encodeEventLog(iface.getEvent('Initialize'), [POOL_ID, ADDR.ZERO, tok, 4000, 80, ADDR.ZERO, '79228162514264337593543950336', 0]);
    let asked;
    const provider = { getLogs: async (f) => { asked = f; return [{ ...ev, blockNumber: CREATED }]; } };
    const p = await F.poolFromDetection({ version: 'v4', pool: POOL_ID, createdBlock: CREATED, token: tok }, { provider, ethers, ADDR });
    assert.strictEqual(asked.fromBlock, CREATED);
    assert.strictEqual(p.tokenAddr, ethers.utils.getAddress(tok));
    assert.strictEqual(p.base, 'ETH');
    assert.strictEqual(p.poolId, POOL_ID);
    assert.strictEqual(p.poolKey.tickSpacing, 80);
    assert.strictEqual(p.fee, 4000);
    assert.ok(p.label.startsWith(`v4 ${POOL_ID.slice(0, 10)}… (native ETH pair, fee 4000, hooks none)`));
  });

  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `all checks passed (${passed})`);
  process.exit(failed ? 1 : 0);
})();
