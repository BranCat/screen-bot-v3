// test-screen-token.js — offline checks of screen-token.js gate ORDER and the
// new Gate 1b (who controls the liquidity). No RPC, no Tenderly, no key: every
// step is replaced through screen(..., { deps }).
//
//   node test-screen-token.js

const assert = require('assert');
const { screen, judgeRoundTrips, rankPools, otherPoolFlags, discoverPool, poolHintsFromLaunches } = require('./screen-token');
const { ethers } = require('ethers');
const { ADDR } = require('./config');

let passed = 0;
let failed = 0;
const quiet = async (fn) => {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
};
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const TOKEN = '0x1111111111111111111111111111111111111111';
const V4_POOL = { version: 'v4', tokenAddr: TOKEN, base: 'ETH', poolId: '0x' + 'ab'.repeat(32), hooks: '0x0000000000000000000000000000000000000000', label: 'v4 test (native ETH)' };
const USDG_POOL = { ...V4_POOL, base: 'USDG', label: 'v4 test (USDG)' };
const V3_POOL = { version: 'v3', tokenAddr: TOKEN, base: 'WETH', poolAddress: '0x2222222222222222222222222222222222222222', label: 'v3 test' };

// a wallet-round-trip.js result: CRTN's real numbers from 2026-10-08
const goodSim = (over = {}) => ({ ok: true, netPct: -4.93, sellTaxBps: 0, soldBps: 10000, proceedsWei: '47544000000000000', tokensReceivedWei: '1918887730000000000000000', ...over });

// A transfer audit in which every part was measured and nothing was found.
const FULL_AUDIT = { buyLeg: { taxBps: 0 }, sellLeg: { taxBps: 0 }, paths: { transfer: { taxBps: 0 }, transferFrom: { taxBps: 0 } } };

// A Gate 5c allowance probe that ran completely and found nothing.
const CLEAN_PROBE = { ok: true, findings: [], missing: [], privileged: [{ address: '0x' + 'de'.repeat(20), roles: ['creator'], isContract: false }], ghosts: [], source: { scanned: true } };

// Build a deps set that records which steps ran, in order.
function deps(over = {}) {
  const calls = [];
  const rec = (name, fn) => async (...a) => { calls.push(name); return fn(...a); };
  const d = {
    sourceGate: rec('source', async () => ({ decision: 'PASS', reason: 'verified' })),
    discoverPool: rec('pool', async () => V4_POOL),
    controllerCheck: rec('controller', async () => ({ verdict: 'LOCKED', reason: '100% locked', controller: '0xLOCK', lockedSharePct: 100 })),
    measureLiquidity: rec('liq', async () => ({ measured: false, note: 'v4' })),
    walletRoundTrip: rec('sim', async () => goodSim()),
    transferAudit: rec('audit', async () => ({ ok: true, findings: [], ...FULL_AUDIT })),
    allowanceProbe: rec('allow', async () => ({ ...CLEAN_PROBE })),
    rugCheck: rec('rug', async () => ({ decision: 'PASS', reason: 'no rug vector', probes: {} })),
    provider: {},
  };
  const NAMES = { sourceGate: 'source', discoverPool: 'pool', controllerCheck: 'controller', measureLiquidity: 'liq', walletRoundTrip: 'sim', transferAudit: 'audit', allowanceProbe: 'allow', rugCheck: 'rug' };
  for (const [k, fn] of Object.entries(over)) d[k] = rec(NAMES[k] || k, fn);
  return { d, calls };
}

(async () => {
  await check('hidden source stops at Gate 0 — nothing else runs', async () => {
    const { d, calls } = deps({ sourceGate: async () => ({ decision: 'SKIP', reason: 'not published on Sourcify' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, 0);
    assert.deepStrictEqual(calls, ['source']);
    assert.strictEqual(r.controller, null);
  });

  await check('source lookup error stops at Gate 0 as UNKNOWN', async () => {
    const { d, calls } = deps({ sourceGate: async () => ({ decision: 'ERROR', reason: 'timeout' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.deepStrictEqual(calls, ['source']);
  });

  await check('CREATOR_CAN_PULL stops at Gate 1b before any simulation', async () => {
    const { d, calls } = deps({ controllerCheck: async () => ({ verdict: 'CREATOR_CAN_PULL', reason: 'an ordinary wallet holds 100%', controller: '0xEOA', eoaSharePct: 100 }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, '1b');
    assert.deepStrictEqual(calls, ['source', 'pool', 'controller']);
    assert.strictEqual(r.controller.verdict, 'CREATOR_CAN_PULL');
    assert.strictEqual(r.controller.controller, '0xEOA');
    assert.ok(/CREATOR_CAN_PULL/.test(r.reason));
  });

  await check('DRAINED stops at Gate 1b', async () => {
    const { d, calls } = deps({ controllerCheck: async () => ({ verdict: 'DRAINED', reason: 'positions empty' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, '1b');
    assert.deepStrictEqual(calls, ['source', 'pool', 'controller']);
  });

  await check('LOCKED continues through every gate to SNIP, no flags', async () => {
    const { d, calls } = deps();
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'SNIP');
    assert.deepStrictEqual(calls, ['source', 'pool', 'controller', 'liq', 'sim', 'sim', 'audit', 'allow', 'rug']);
    assert.deepStrictEqual(r.flags, []);
    assert.strictEqual(r.controller.verdict, 'LOCKED');
  });

  await check('UNKNOWN controller continues but is flagged on the final verdict', async () => {
    const { d, calls } = deps({ controllerCheck: async () => ({ verdict: 'UNKNOWN', reason: 'held by an unknown contract' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'SNIP');
    assert.strictEqual(calls.length, 9); // + Gate 5b transfer audit + Gate 5c allowance probe
    assert.strictEqual(r.flags.length, 1);
    assert.ok(/controller UNKNOWN/.test(r.flags[0]));
  });

  await check('controller check throwing is UNKNOWN + flag, never a crash', async () => {
    const { d } = deps({ controllerCheck: async () => { throw new Error('rpc down'); } });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.controller.verdict, 'UNKNOWN');
    assert.ok(/rpc down/.test(r.flags[0]));
  });

  await check('v3 pool: controller reports UNKNOWN (not covered) and screen continues, flagged', async () => {
    // the real controllerCheck answers v3 without any RPC call
    const { controllerCheck } = require('./controller-check');
    const { d, calls } = deps({
      discoverPool: async () => V3_POOL,
      controllerCheck: (p, o) => controllerCheck(p, o),
      measureLiquidity: async () => ({ measured: true, baseEth: 5 }),
    });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.controller.verdict, 'UNKNOWN');
    assert.ok(/v3 pools are not covered/.test(r.flags[0]));
    assert.ok(calls.includes('sim'));
  });

  await check('USDG pool: gates 0-1b run, then UNKNOWN without spending simulations', async () => {
    const { d, calls } = deps({ discoverPool: async () => USDG_POOL });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.ok(/USDG/.test(r.reason));
    assert.deepStrictEqual(calls, ['source', 'pool', 'controller']);
  });

  await check('USDG pool with a pullable controller is DO NOT SNIP, not UNKNOWN', async () => {
    const { d } = deps({
      discoverPool: async () => USDG_POOL,
      controllerCheck: async () => ({ verdict: 'CREATOR_CAN_PULL', reason: 'wallet holds 100%' }),
    });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
  });

  await check('Gate 1 asks discoverPool to allow a USDG fallback', async () => {
    let seenOpts = null;
    const { d } = deps({ discoverPool: async (t, o) => { seenOpts = o; return null; } });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.strictEqual(r.gate, 1);
    assert.strictEqual(seenOpts.allowUsdg, true);
  });

  await check('a pool passed in by the caller skips discovery', async () => {
    const { d, calls } = deps();
    const r = await quiet(() => screen(TOKEN, { deps: d, pool: V4_POOL }));
    assert.strictEqual(r.verdict, 'SNIP');
    assert.ok(!calls.includes('pool'));
  });

  await check('controller is checked BEFORE liquidity and simulations', async () => {
    const { d, calls } = deps();
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.ok(calls.indexOf('controller') < calls.indexOf('liq'));
    assert.ok(calls.indexOf('controller') < calls.indexOf('sim'));
    assert.strictEqual(calls[0], 'source');
  });

  await check('existing gates still fire after 1b: a reverted sell is DO NOT SNIP at Gate 3', async () => {
    const { d } = deps({ walletRoundTrip: async () => ({ ok: false, sellReverted: true, reason: 'every sell attempt reverted' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, 3);
    assert.strictEqual(r.controller.verdict, 'LOCKED');
  });

  await check('rug UNPROVEN is still not a pass after 1b', async () => {
    const { d } = deps({ rugCheck: async () => ({ decision: 'UNPROVEN', reason: 'removal inconclusive', probes: {} }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'PASSED GATES 0-5');
  });

  // ---- Gates 3-5 through wallet-round-trip.js
  await check('round trips use two DIFFERENT fresh wallets and the exact screened pool', async () => {
    const seen = [];
    const TRAP = { ...V4_POOL, poolId: '0x' + 'ee'.repeat(32), fee: 883131, label: 'trap' };
    const { d } = deps({
      walletRoundTrip: async (t, o) => { seen.push(o); return goodSim(); },
      discoverPool: async () => TRAP, // a fresh search would land on the trap
    });
    await quiet(() => screen(TOKEN, { deps: d, pool: V4_POOL }));
    assert.strictEqual(seen.length, 2);
    assert.notStrictEqual(seen[0].wallet, seen[1].wallet);
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(seen[0].wallet));
    assert.strictEqual(await seen[0].discover(TOKEN), V4_POOL, 'discover must return the screened pool, never search again');
  });
  await check('CRTN-like 4.93% Pons round trip passes the 7% limit and reaches Gate 6', async () => {
    const { d, calls } = deps();
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'SNIP');
    assert.ok(calls.includes('rug'));
    assert.ok(/4\.93%/.test(r.reason), r.reason);
  });
  await check('Gate 6 is sized from the tokens the Gate 3 buy really returned', async () => {
    let base = null;
    const { d } = deps({ rugCheck: async (p, a, o) => { base = o.baselineTokenOutWei; return { decision: 'PASS', reason: 'ok', probes: {} }; } });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(base.toString(), goodSim().tokensReceivedWei);
  });
  await check('Gate 6 is handed the Gate 1b verdict and the share Gate 5 sold', async () => {
    let o = null;
    const { d } = deps({ rugCheck: async (p, a, opts) => { o = opts; return { decision: 'PASS', reason: 'ok', probes: {} }; } });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.ok(o.controller && typeof o.controller.verdict === 'string', JSON.stringify(o.controller));
    assert.strictEqual(o.startSellBps, 10000);
  });
  await check('a round trip that cannot be measured is UNKNOWN, never "ok"', async () => {
    const { d, calls } = deps({ walletRoundTrip: async () => ({ ok: false, reason: 'proceeds could not be read' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.strictEqual(r.gate, 3);
    assert.ok(!calls.includes('rug'));
  });
  await check('a simulation that throws is UNKNOWN, not a crash', async () => {
    const { d } = deps({ walletRoundTrip: async () => { throw new Error('tenderly 500'); } });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.ok(/tenderly 500/.test(r.reason));
  });

  // ---- judgeRoundTrips (pure)
  const J = (a, b) => judgeRoundTrips(goodSim(a), goodSim(b));
  await check('judge: clean 4.93% passes', async () => { const j = J(); assert.ok(j.pass); assert.strictEqual(j.costPct, 4.93); });
  await check('judge: 7.5% cost is DO NOT SNIP at Gate 4', async () => {
    const j = J({ netPct: -7.5 }); assert.strictEqual(j.verdict, 'DO NOT SNIP'); assert.strictEqual(j.gate, 4); assert.ok(/7\.50%.*7% limit/.test(j.reason), j.reason);
  });
  await check('judge: exactly 7.00% still passes', async () => { assert.ok(J({ netPct: -7 }, { netPct: -7 }).pass); });
  // 2026-10-19: the limit is 7%. The Pons fee tiers on either side of it:
  await check('judge: 2.99%-fee Pons trade with 0.5% impact (6.4%) now passes', async () => { assert.ok(J({ netPct: -6.4 }, { netPct: -6.4 }).pass); });
  await check('judge: 3.99%-fee Pons trade (7.82%, PALLADIUM/WATER) is still rejected', async () => {
    const j = J({ netPct: -7.8228 }, { netPct: -7.8215 }); assert.strictEqual(j.verdict, 'DO NOT SNIP'); assert.strictEqual(j.gate, 4);
  });
  await check('MAX_ROUND_TRIP_COST_PCT is 7', async () => { assert.strictEqual(require('./screen-token').MAX_ROUND_TRIP_COST_PCT, 7); });
  await check('judge: hidden token tax 1% is DO NOT SNIP even when total cost is cheap', async () => {
    const j = J({ sellTaxBps: 100, netPct: -2 }); assert.strictEqual(j.verdict, 'DO NOT SNIP'); assert.ok(/hidden token tax/.test(j.reason));
  });
  await check('judge: 0.5% tax is within rounding room', async () => { assert.ok(J({ sellTaxBps: 50 }).pass); });
  await check('judge: unmeasured tax passes but is flagged', async () => {
    const j = J({ sellTaxBps: null }); assert.ok(j.pass); assert.ok(/could not be measured/.test(j.flags[0]));
  });
  await check('judge: wallets 3% apart is DO NOT SNIP (wallet-dependent)', async () => {
    const j = J({}, { proceedsWei: '46100000000000000' }); assert.strictEqual(j.verdict, 'DO NOT SNIP'); assert.ok(/depends on the wallet/.test(j.reason));
  });
  await check('judge: only 95% sellable is DO NOT SNIP at Gate 5', async () => {
    const j = J({ soldBps: 9500 }); assert.strictEqual(j.gate, 5); assert.ok(/95%/.test(j.reason));
  });
  await check('judge: 99% sellable passes, flagged (unpinned: drift may explain it)', async () => {
    const j = J({ soldBps: 9900 }); assert.ok(j.pass); assert.ok(/99% went through.*not pinned/.test(j.flags[0]), j.flags[0]);
  });
  await check('judge: 99% sellable on a pinned block is flagged as a sell cap or rounding', async () => {
    const j = J({ soldBps: 9900, pinnedBlock: 1 }, { pinnedBlock: 1 }); assert.ok(j.pass); assert.ok(/fixed block.*sell cap or rounding/.test(j.flags[0]), j.flags[0]);
  });
  await check('judge: buy drift between probe and measurement is flagged', async () => {
    const j = J({ buyDriftBps: -150 }); assert.ok(j.pass); assert.ok(j.flags.some((f) => /different amount.*-1\.5%/.test(f)), j.flags.join(' | '));
  });
  await check('judge: coming out ahead is UNKNOWN (the 0xdEaD lesson)', async () => {
    const j = J({ netPct: 2193 }); assert.strictEqual(j.verdict, 'UNKNOWN'); assert.ok(/came out ahead/.test(j.reason));
  });
  await check('judge: buy revert in sim #1 is DO NOT SNIP at Gate 3', async () => {
    const j = judgeRoundTrips({ ok: false, buyReverted: true, reason: 'the buy reverted: X' }, null);
    assert.strictEqual(j.verdict, 'DO NOT SNIP'); assert.strictEqual(j.gate, 3);
  });
  await check('judge: sim #2 cannot sell where #1 could -> wallet-dependent DO NOT SNIP', async () => {
    const j = judgeRoundTrips(goodSim(), { ok: false, sellReverted: true, reason: 'every sell reverted' });
    assert.strictEqual(j.verdict, 'DO NOT SNIP'); assert.strictEqual(j.gate, 4); assert.ok(/depends on the wallet/.test(j.reason));
  });

  // ---- pool ranking (pure)
  const PONS = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
  const NOHOOK = '0x0000000000000000000000000000000000000000';
  await check('rank: the Passkeys case — Pons pool beats an 88%-fee hookless pool that has more liquidity', async () => {
    const trap = { version: 'v4', fee: 883131, hooks: NOHOOK, liquidity: '900000000000', label: 'trap' };
    const pons = { version: 'v4', fee: 0, hooks: PONS, liquidity: '100', label: 'pons' };
    assert.strictEqual(rankPools([trap, pons])[0].label, 'pons');
  });
  await check('rank: a live Pons pool beats a deeper ordinary pool with a sane fee', async () => {
    const pons = { version: 'v4', fee: 0, hooks: PONS, liquidity: '100', label: 'pons' };
    const deep = { version: 'v4', fee: 10000, hooks: NOHOOK, liquidity: '900000', label: 'deep' };
    assert.strictEqual(rankPools([deep, pons])[0].label, 'pons');
  });
  await check('rank: an empty launchpad pool loses to a live ordinary pool', async () => {
    const pons = { version: 'v4', fee: 0, hooks: PONS, liquidity: '0', label: 'pons-empty' };
    const live = { version: 'v4', fee: 10000, hooks: NOHOOK, liquidity: '5', label: 'live' };
    assert.strictEqual(rankPools([pons, live])[0].label, 'live');
  });
  await check('rank: a sane fee beats an absurd one; then the deepest wins', async () => {
    const absurd = { version: 'v4', fee: 500000, hooks: NOHOOK, liquidity: '999', label: 'absurd' };
    const shallow = { version: 'v4', fee: 10000, hooks: NOHOOK, liquidity: '10', label: 'shallow' };
    const deep = { version: 'v4', fee: 10000, hooks: NOHOOK, liquidity: '20', label: 'deep' };
    assert.deepStrictEqual(rankPools([absurd, shallow, deep]).map((x) => x.label), ['deep', 'shallow', 'absurd']);
  });
  await check('rank: the dynamic-fee flag (0x800000) is not treated as an absurd fee', async () => {
    const dyn = { version: 'v4', fee: 0x800000, hooks: NOHOOK, liquidity: '30', label: 'dyn' };
    const plain = { version: 'v4', fee: 3000, hooks: NOHOOK, liquidity: '20', label: 'plain' };
    assert.strictEqual(rankPools([plain, dyn])[0].label, 'dyn');
  });
  await check('otherPoolFlags names a trap pool and counts the others', async () => {
    const f = otherPoolFlags({ otherPools: [{ label: 'v4 0x5680… fee 883131', fee: 883131 }, { label: 'v3 x', fee: 3000 }] });
    assert.ok(/88\.3% fee/.test(f[0]), f[0]);
    assert.ok(/2 other pool/.test(f[1]));
    assert.deepStrictEqual(otherPoolFlags({}), []);
  });
  await check('screen carries other-pool flags onto the verdict', async () => {
    const { d } = deps();
    const r = await quiet(() => screen(TOKEN, { deps: d, pool: { ...V4_POOL, otherPools: [{ label: 'trap', fee: 883131 }] } }));
    assert.ok(r.flags.some((f) => /88\.3% fee/.test(f)));
  });

  // ---- 2026-10-10: Gate 5b, the transfer audit --------------------------------
  const HOOK_INFO = { severity: 'info', kind: 'hookFee', title: "the pool's hook takes 2.46% of each buy" };
  await check('Gate 5b: a hidden tax (high finding) is DO NOT SNIP, and Gate 6 is not spent', async () => {
    const { d, calls } = deps({ transferAudit: async () => ({ ok: true, findings: [HOOK_INFO, { severity: 'high', title: 'hidden buy tax of 5.00%' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, '5b');
    assert.ok(/hidden buy tax of 5\.00%/.test(r.reason), r.reason);
    assert.ok(!calls.includes('rug'));
  });
  await check('Gate 5b: transfer() vs transferFrom() asymmetry is DO NOT SNIP', async () => {
    const { d } = deps({ transferAudit: async () => ({ ok: true, findings: [{ severity: 'high', title: 'transfer() and transferFrom() are taxed differently (0.00% vs 10.00%)' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.ok(/transferFrom/.test(r.reason));
  });
  await check('Gate 5b: an unexplained (medium) finding is UNKNOWN, never SNIP', async () => {
    const { d, calls } = deps({ transferAudit: async () => ({ ok: true, findings: [{ severity: 'medium', title: '2.46% of the buy did not arrive, and the hook is allowed to take it' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.strictEqual(r.gate, '5b');
    assert.ok(!calls.includes('rug'));
  });
  await check('Gate 5b: an audit that cannot complete or throws is UNKNOWN', async () => {
    for (const fn of [async () => ({ ok: false, reason: 'could not read the pool balance' }), async () => { throw new Error('tenderly 429'); }]) {
      const { d } = deps({ transferAudit: fn });
      const r = await quiet(() => screen(TOKEN, { deps: d }));
      assert.strictEqual(r.verdict, 'UNKNOWN');
      assert.strictEqual(r.gate, '5b');
    }
  });
  await check('Gate 5b: a visible hook fee only (info) is noted and the screen goes on to SNIP', async () => {
    const { d, calls } = deps({ transferAudit: async () => ({ ok: true, findings: [HOOK_INFO], buyLeg: { taxBps: 246 }, sellLeg: { taxBps: 0 }, paths: { transfer: { taxBps: 0 }, transferFrom: { taxBps: 0 } } }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'SNIP', r.reason);
    assert.ok(calls.includes('rug'));
    assert.ok(r.flags.some((f) => /hook takes 2\.46%/.test(f)), JSON.stringify(r.flags));
    assert.strictEqual(r.audit.transferFromTaxBps, 0);
  });
  await check('Gate 5b: a part that was not measured is UNKNOWN, never "agree"', async () => {
    const cases = [
      { ...FULL_AUDIT, buyLeg: { error: 'indeterminate step in the buy audit' } },
      { ...FULL_AUDIT, sellLeg: { taxBps: null } },
      { ...FULL_AUDIT, paths: { error: 'indeterminate step in the transfer audit' } },
      { ...FULL_AUDIT, paths: { transfer: { taxBps: 0 }, transferFrom: { taxBps: null } } },
      { findings: [] },
    ];
    for (const c of cases) {
      const { d, calls } = deps({ transferAudit: async () => ({ ok: true, findings: [], ...c }) });
      const r = await quiet(() => screen(TOKEN, { deps: d }));
      assert.strictEqual(r.verdict, 'UNKNOWN', JSON.stringify(c));
      assert.strictEqual(r.gate, '5b');
      assert.ok(/not measured/.test(r.reason), r.reason);
      assert.ok(!calls.includes('rug'));
    }
  });
  await check('Gate 5b: a high finding still wins over a missing part (DO NOT SNIP, not UNKNOWN)', async () => {
    const { d } = deps({ transferAudit: async () => ({ ok: true, findings: [{ severity: 'high', title: 'transferFrom() reverted with a valid unlimited allowance' }], ...FULL_AUDIT, paths: { transfer: { taxBps: 0 }, transferFrom: { taxBps: null, reverted: true } } }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
  });
  await check('Gate 5b audits the exact screened pool from a fresh random wallet', async () => {
    let args = null;
    const { d } = deps({ transferAudit: async (t, o) => { args = { t, o, pool: await o.discover(t) }; return { ok: true, findings: [], ...FULL_AUDIT }; } });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(args.t, TOKEN);
    assert.strictEqual(args.pool, V4_POOL);
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(args.o.wallet));
    assert.ok(!/dead$/i.test(args.o.wallet));
    assert.strictEqual(args.o.amountEth, 0.05);
  });
  // 2026-10-19 (CAPA): the audit runs on Gate 3's pinned block.
  await check('Gate 5b is given Gate 3\'s pinned block', async () => {
    let opts = null;
    const { d } = deps({
      walletRoundTrip: async () => goodSim({ pinnedBlock: 92348719 }),
      transferAudit: async (t, o) => { opts = o; return { ok: true, findings: [], ...FULL_AUDIT, pinnedBlock: o.pinnedBlock }; },
    });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(opts.pinnedBlock, 92348719);
    assert.strictEqual(r.audit.pinnedBlock, 92348719);
  });
  await check('Gate 5b gets no pin (pins itself) when Gate 3 was not pinned', async () => {
    let opts = null;
    const { d } = deps({ transferAudit: async (t, o) => { opts = o; return { ok: true, findings: [], ...FULL_AUDIT }; } });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(opts.pinnedBlock, null);
  });
  await check('Gate 5b: an unmeasurable (oversized) sell is UNKNOWN, not DO NOT SNIP', async () => {
    const { d, calls } = deps({ transferAudit: async () => ({
      ok: true, ...FULL_AUDIT, sellLeg: { error: 'the sell reverted: execution reverted', sellReverted: true, oversized: true },
      findings: [{ severity: 'medium', kind: 'sellUnmeasured', title: 'the sell could not be measured: it asked for more tokens than the wallet held' }],
    }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN', r.reason);
    assert.strictEqual(r.gate, '5b');
    assert.ok(!calls.includes('rug'));
  });
  await check('Gate 5b does not run when the round trips already failed', async () => {
    const { d, calls } = deps({ walletRoundTrip: async () => ({ ok: false, sellReverted: true, reason: 'every sell reverted' }) });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.ok(!calls.includes('audit'));
  });

  // ---- 2026-10-10: pools older than the ~5.5h live scan -----------------------
  // The CRTN case: launched at block 83052524 on the Pons hook; two days later
  // the live scan only sees an 81%-fee hookless trap pool created afterwards.
  const CRTN = '0x66A844fcbf4705Dbde3c97394d5a4C9822E8F35b';
  const CREATED = 83052524;
  const HEAD = CREATED + 2600000; // ~3 days later at ~10 blocks/s
  const pmIface = new ethers.utils.Interface([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'function getLiquidity(bytes32 poolId) view returns (uint128)',
    'function getPool(address,address,uint24) view returns (address)',
  ]);
  const PONS_ID = '0xc24358e11113cb53b2de3971028e3bb0e47991c3af8e5e10aab517a15b9f4a18';
  const TRAP_ID = '0x' + '77'.repeat(32);
  const initLog = (id, fee, hooks, block) => {
    const ev = pmIface.encodeEventLog(pmIface.getEvent('Initialize'), [id, ADDR.ZERO, CRTN, fee, 60, hooks, ethers.BigNumber.from(2).pow(96), 0]);
    return {
      address: ADDR.UNIV4_POOL_MANAGER, topics: ev.topics, data: ev.data,
      blockNumber: '0x' + block.toString(16), blockHash: '0x' + '11'.repeat(32), transactionHash: '0x' + '22'.repeat(32),
      transactionIndex: '0x0', logIndex: '0x0', removed: false,
    };
  };
  class FakeChain extends ethers.providers.JsonRpcProvider {
    constructor() { super('http://127.0.0.1:1', { chainId: 4663, name: 'robinhood' }); this.logQueries = []; }
    async detectNetwork() { return { chainId: 4663, name: 'robinhood' }; }
    async send(method, params) {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_blockNumber') return '0x' + HEAD.toString(16);
      if (method === 'eth_call') {
        const { to, data } = params[0];
        if (data.startsWith(pmIface.getSighash('getPool'))) return ethers.utils.hexZeroPad('0x', 32);
        if (to.toLowerCase() === ADDR.UNIV4_STATE_VIEW.toLowerCase()) {
          const id = pmIface.decodeFunctionData('getLiquidity', data)[0];
          return pmIface.encodeFunctionResult('getLiquidity', [id === PONS_ID ? 5000000 : 10]);
        }
        throw new Error(`unexpected eth_call to ${to}`);
      }
      if (method === 'eth_getLogs') {
        const f = params[0];
        this.logQueries.push(f);
        const from = parseInt(f.fromBlock, 16); const to = parseInt(f.toBlock, 16);
        if (f.topics[1] && f.topics[1].toLowerCase() === PONS_ID && from <= CREATED && to >= CREATED) {
          return [initLog(PONS_ID, 8388608, ADDR.PONS_V2_MEME_HOOK, CREATED)];
        }
        // live scan, token as currency1: only the recent trap pool is in range
        if (f.topics.length === 4 && f.topics[3]) return [initLog(TRAP_ID, 810000, ADDR.ZERO, HEAD - 1000)];
        return [];
      }
      throw new Error(`unexpected RPC ${method}`);
    }
  }

  await check('old token, no record: the live scan only finds the trap pool (the bug as seen on 10 Oct)', async () => {
    const p = await quiet(() => discoverPool(CRTN, { prov: new FakeChain(), allowUsdg: true }));
    assert.strictEqual(p.poolId, TRAP_ID);
  });
  await check('old token with its launches.jsonl record: the Pons pool is found and ranked first', async () => {
    const fc = new FakeChain();
    const p = await quiet(() => discoverPool(CRTN, { prov: fc, allowUsdg: true, hints: [{ poolId: PONS_ID, createdBlock: CREATED }] }));
    assert.strictEqual(p.poolId, PONS_ID, p.label);
    assert.strictEqual(p.hooks, ADDR.PONS_V2_MEME_HOOK);
    assert.strictEqual(p.createdBlock, CREATED);
    assert.ok(/from launches\.jsonl/.test(p.label), p.label);
    assert.strictEqual(p.poolKey.tickSpacing, 60);
    assert.ok(p.otherPools.some((o) => /fee 810000/.test(o.label)), JSON.stringify(p.otherPools));
    const exact = fc.logQueries.find((q) => q.topics[1] && q.topics[1].toLowerCase() === PONS_ID);
    assert.ok(exact && exact.fromBlock === exact.toBlock, 'the known pool is read at its exact creation block, one request');
  });
  await check('a hint already found by the live scan is not looked up twice', async () => {
    const fc = new FakeChain();
    await quiet(() => discoverPool(CRTN, { prov: fc, hints: [{ poolId: TRAP_ID, createdBlock: HEAD - 1000 }] }));
    assert.ok(!fc.logQueries.some((q) => q.topics[1] && q.topics[1].toLowerCase() === TRAP_ID));
  });
  await check('the best pool being a >10% fee pool is flagged as a likely trap', async () => {
    const TRAP = { ...V4_POOL, fee: 810000, label: 'trap' };
    const { d } = deps({ discoverPool: async () => TRAP });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.ok(r.flags.some((f) => /81\.0% fee .*probably a trap/.test(f)), JSON.stringify(r.flags));
  });
  await check('screen passes its pool hints to discoverPool', async () => {
    let o = null;
    const hints = [{ poolId: PONS_ID, createdBlock: CREATED }];
    const { d } = deps({ discoverPool: async (t, opts) => { o = opts; return null; } });
    await quiet(() => screen(TOKEN, { deps: d, poolHints: hints }));
    assert.deepStrictEqual(o.hints, hints);
  });
  await check('an old pool: Gate 1b gets aroundTime at creation, Gate 6 scans since creation', async () => {
    let ctlOpts = null; let rugOpts = null;
    const OLD = { ...V4_POOL, createdBlock: CREATED };
    const { d } = deps({
      discoverPool: async () => OLD,
      controllerCheck: async (p, o) => { ctlOpts = o; return { verdict: 'LOCKED', reason: '100% locked' }; },
      rugCheck: async (p, a, o) => { rugOpts = o; return { decision: 'PASS', reason: 'ok', probes: {} }; },
    });
    d.provider = { getBlockNumber: async () => HEAD, getBlock: async (n) => ({ number: n, timestamp: 1759903600 }) };
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(ctlOpts.aroundTime, 1759903600 * 1000);
    assert.ok(rugOpts.lookbackBlocks >= HEAD - CREATED, String(rugOpts.lookbackBlocks));
  });
  await check('a fresh pool keeps the normal windows', async () => {
    let ctlOpts = null; let rugOpts = null;
    const { d } = deps({
      discoverPool: async () => ({ ...V4_POOL, createdBlock: HEAD - 5000 }),
      controllerCheck: async (p, o) => { ctlOpts = o; return { verdict: 'LOCKED', reason: '100% locked' }; },
      rugCheck: async (p, a, o) => { rugOpts = o; return { decision: 'PASS', reason: 'ok', probes: {} }; },
    });
    d.provider = { getBlockNumber: async () => HEAD, getBlock: async () => { throw new Error('should not be asked'); } };
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(ctlOpts.aroundTime, undefined);
    assert.strictEqual(rugOpts.lookbackBlocks, 200000);
  });
  await check('poolHintsFromLaunches reads every v4 pool recorded for the token, once each', async () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const f = path.join(os.tmpdir(), `launches-test-${process.pid}.jsonl`);
    fs.writeFileSync(f, [
      JSON.stringify({ token: CRTN, version: 'v4', poolId: PONS_ID, createdBlock: CREATED }),
      JSON.stringify({ token: CRTN.toLowerCase(), version: 'v4', poolId: PONS_ID, createdBlock: CREATED }),
      JSON.stringify({ token: CRTN, version: 'v4', poolId: TRAP_ID, createdBlock: HEAD - 1000 }),
      JSON.stringify({ token: TOKEN, version: 'v4', poolId: '0x' + '99'.repeat(32), createdBlock: 5 }),
      'not json',
    ].join('\n'));
    try {
      const h = poolHintsFromLaunches(CRTN, f);
      assert.deepStrictEqual(h.map((x) => x.poolId).sort(), [PONS_ID, TRAP_ID].sort());
      assert.deepStrictEqual(poolHintsFromLaunches(CRTN, f + '.missing'), []);
    } finally { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }
  });

  // ---- Gate 5c (2026-10-12): allowance backdoor + ghost transfers ----------
  await check('Gate 5c: a stranger backdoor (high) -> DO NOT SNIP at 5c, Gate 6 never runs', async () => {
    const { d, calls } = deps({ allowanceProbe: async () => ({ ...CLEAN_PROBE, findings: [{ severity: 'high', title: 'BACKDOOR: a stranger moves your tokens to 0xdead (no approval) — and it worked' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, '5c');
    assert.ok(/allowance backdoor: BACKDOOR/.test(r.reason), r.reason);
    assert.ok(!calls.includes('rug'));
    assert.strictEqual(r.allowance.findings[0].severity, 'high');
    assert.ok(r.audit, 'the 5b summary rides along');
  });
  await check('Gate 5c: a ghost transfer (medium) -> UNKNOWN', async () => {
    const { d, calls } = deps({ allowanceProbe: async () => ({ ...CLEAN_PROBE, findings: [{ severity: 'medium', title: 'GHOST TRANSFER on you burn tokens to 0xdead' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.strictEqual(r.gate, '5c');
    assert.ok(!calls.includes('rug'));
  });
  await check('Gate 5c: probe could not complete -> UNKNOWN, never a pass', async () => {
    const { d } = deps({ allowanceProbe: async () => ({ ok: false, reason: 'the buy reverted: x' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.ok(/allowance probe could not complete/.test(r.reason));
  });
  await check('Gate 5c: probe throwing -> UNKNOWN', async () => {
    const { d } = deps({ allowanceProbe: async () => { throw new Error('tenderly down'); } });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.ok(/tenderly down/.test(r.reason));
  });
  await check('Gate 5c: a part not measured -> UNKNOWN', async () => {
    const { d } = deps({ allowanceProbe: async () => ({ ...CLEAN_PROBE, missing: ['Transfer events (Tenderly returned no logs)'] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.ok(/incomplete/.test(r.reason));
  });
  await check('Gate 5c: a high finding wins over a missing part', async () => {
    const { d } = deps({ allowanceProbe: async () => ({ ...CLEAN_PROBE, missing: ['x'], findings: [{ severity: 'high', title: 'BACKDOOR' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
  });
  await check('Gate 5c: info only (Pons factory power) is flagged and the screen reaches SNIP with the summary attached', async () => {
    const { d } = deps({ allowanceProbe: async () => ({ ...CLEAN_PROBE, findings: [{ severity: 'info', title: 'Pons launch factory can move holders\' tokens without approval (launchpad infrastructure)' }] }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'SNIP');
    assert.ok(r.flags.some((f) => /Pons launch factory/.test(f)));
    assert.ok(r.allowance && r.allowance.ok && r.allowance.sourceScanned);
  });
  await check('Gate 5c probes the exact screened pool and the verified (implementation) address for source', async () => {
    let seen = null;
    const { d } = deps({
      sourceGate: async () => ({ decision: 'PASS', reason: 'verified', verificationSubject: '0x' + '77'.repeat(20) }),
      allowanceProbe: async (t, o) => { seen = o; return { ...CLEAN_PROBE }; },
    });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(seen.p, V4_POOL);
    assert.strictEqual(seen.sourceSubject, '0x' + '77'.repeat(20));
  });
  await check('Gate 5c does not run when Gate 5b already failed', async () => {
    const { d, calls } = deps({ transferAudit: async () => ({ ok: true, findings: [{ severity: 'high', title: 'transferFrom taxed' }], ...FULL_AUDIT }) });
    await quiet(() => screen(TOKEN, { deps: d }));
    assert.ok(!calls.includes('allow'));
  });

  // ---- 2026-10-13: r.detail carries every gate's full result -----------------
  await check('detail: a full SNIP screen carries every gate\'s full result', async () => {
    const { d } = deps();
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.verdict, 'SNIP');
    for (const k of ['source', 'pool', 'controller', 'liquidity', 'roundTrips', 'roundTripJudgement', 'transferAudit', 'allowanceProbe', 'rugCheck']) {
      assert.ok(r.detail && k in r.detail, `missing detail.${k}`);
    }
    assert.strictEqual(r.detail.roundTrips.sim1.netPct, -4.93);
    assert.strictEqual(r.detail.allowanceProbe.ok, true);
  });
  await check('detail: a screen that stops at Gate 0 carries only what ran', async () => {
    const { d } = deps({ sourceGate: async () => ({ decision: 'SKIP', reason: 'not published' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.deepStrictEqual(Object.keys(r.detail), ['source']);
    assert.strictEqual(r.detail.source.decision, 'SKIP');
  });

  // ---- 2026-10-16: hidden source, 'probe' mode (the watcher) ----------------
  const HIDDEN = async () => ({ decision: 'SKIP', sourceVerified: false, reason: 'source NOT published (checked Sourcify and the block explorer)', codeSha256NoMeta: 'aa' });
  const NO_TEMPLATE = async () => ({ matched: false, reason: 'no template matched' });
  await check('probe: hidden source + CREATOR_CAN_PULL -> DO NOT SNIP at 1b, no simulation', async () => {
    const { d, calls } = deps({ sourceGate: HIDDEN, templateMatch: NO_TEMPLATE, controllerCheck: async () => ({ verdict: 'CREATOR_CAN_PULL', reason: 'an ordinary wallet holds 100%', controller: '0xEOA' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, '1b');
    assert.strictEqual(r.sourceHidden, true);
    assert.ok(/not published either/.test(r.reason), r.reason);
    assert.deepStrictEqual(calls, ['source', 'pool', 'templateMatch', 'controller']);
  });
  await check('probe: hidden source + DRAINED -> DO NOT SNIP at 1b', async () => {
    const { d } = deps({ sourceGate: HIDDEN, templateMatch: NO_TEMPLATE, controllerCheck: async () => ({ verdict: 'DRAINED', reason: 'empty' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.gate, '1b');
    assert.strictEqual(r.sourceHidden, true);
  });
  await check('probe: hidden source + LOCKED -> SOURCE PENDING, nothing simulated', async () => {
    const { d, calls } = deps({ sourceGate: HIDDEN, templateMatch: NO_TEMPLATE });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'SOURCE PENDING');
    assert.strictEqual(r.gate, 0);
    assert.strictEqual(r.pending, true);
    assert.strictEqual(r.sourceHidden, true);
    assert.strictEqual(r.controller.verdict, 'LOCKED');
    assert.deepStrictEqual(calls, ['source', 'pool', 'templateMatch', 'controller']);
    assert.strictEqual(r.detail.templateMatch.matched, false);
  });
  await check('probe: hidden source + UNKNOWN controller -> SOURCE PENDING, flagged', async () => {
    const { d, calls } = deps({ sourceGate: HIDDEN, templateMatch: NO_TEMPLATE, controllerCheck: async () => ({ verdict: 'UNKNOWN', reason: 'unknown locker' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'SOURCE PENDING');
    assert.ok(r.flags.some((f) => /controller UNKNOWN/.test(f)));
    assert.ok(!calls.includes('sim'));
  });
  await check('probe: hidden source but template match -> full screen to SNIP, flagged', async () => {
    const { d, calls } = deps({ sourceGate: HIDDEN, templateMatch: async () => ({ matched: true, name: 'PonsV2LauncherToken', reason: 'bytecode identical to the verified PonsV2LauncherToken template' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'SNIP');
    assert.ok(r.flags.some((f) => /PonsV2LauncherToken/.test(f)));
    assert.strictEqual(r.detail.templateMatch.matched, true);
    assert.deepStrictEqual(calls, ['source', 'pool', 'templateMatch', 'controller', 'liq', 'sim', 'sim', 'audit', 'allow', 'rug']);
  });
  await check('probe: template match still stops at 1b when the creator can pull', async () => {
    const { d } = deps({ sourceGate: HIDDEN, templateMatch: async () => ({ matched: true, name: 'T', reason: 'x' }), controllerCheck: async () => ({ verdict: 'CREATOR_CAN_PULL', reason: 'eoa' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.gate, '1b');
    assert.ok(!/not published either/.test(r.reason));
  });
  await check('probe: a throwing template check counts as no match (pending), never a crash', async () => {
    const { d } = deps({ sourceGate: HIDDEN, templateMatch: async () => { throw new Error('rpc down'); } });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'SOURCE PENDING');
    assert.ok(/rpc down/.test(r.detail.templateMatch.reason));
  });
  await check('probe: no bytecode / unresolved proxy still stop at Gate 0 (only "not published" is probed)', async () => {
    for (const reason of ['no bytecode at this address', 'proxy whose implementation could not be resolved']) {
      const { d, calls } = deps({ sourceGate: async () => ({ decision: 'SKIP', reason }) });
      const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
      assert.strictEqual(r.verdict, 'DO NOT SNIP');
      assert.strictEqual(r.gate, 0);
      assert.deepStrictEqual(calls, ['source']);
    }
  });
  await check('probe: lookup ERROR is still UNKNOWN at Gate 0', async () => {
    const { d, calls } = deps({ sourceGate: async () => ({ decision: 'ERROR', reason: 'timeout' }) });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'UNKNOWN');
    assert.deepStrictEqual(calls, ['source']);
  });
  await check('probe: hidden source and no pool found -> DO NOT SNIP at Gate 0 as before', async () => {
    const { d } = deps({ sourceGate: HIDDEN, discoverPool: async () => null });
    const r = await quiet(() => screen(TOKEN, { deps: d, hiddenSource: 'probe' }));
    assert.strictEqual(r.verdict, 'DO NOT SNIP');
    assert.strictEqual(r.gate, 0);
  });
  await check('default mode (CLI): a hidden source still ends at Gate 0 with only the source lookup', async () => {
    const { d, calls } = deps({ sourceGate: HIDDEN });
    const r = await quiet(() => screen(TOKEN, { deps: d }));
    assert.strictEqual(r.gate, 0);
    assert.deepStrictEqual(calls, ['source']);
  });

  console.log(failed ? `${failed} failed, ${passed} passed` : `all checks passed (${passed})`);
  process.exit(failed ? 1 : 0);
})();
