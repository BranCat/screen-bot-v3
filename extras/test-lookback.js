// Offline tests for extras/lookback.js. No RPC, no Tenderly.
//
//   node extras/test-lookback.js
//
// A fake chain (10 blocks a second) with a fake v4 quoter, v3 quoter and
// StateView whose prices follow a script per case. The checks are about the
// numbers: a flat price with a 2.99% fee each way must read as a 5.9% loss, a
// doubling must read as about +94%, an emptied pool as -100%.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const config = require('../config');
const L = require('./lookback');

const ADDR = config.ADDR;
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);
const E = (x) => ethers.utils.parseEther(String(x));
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

const T0 = 1_792_000_000; // unix time of block 0 in the fake chain
const TOKEN = '0xFCc86D9c23FfB9f27258534eA316C096F1Af51b9';
const TOKEN3 = '0x1111111111111111111111111111111111111111';
const PONS_KEY = { currency0: ADDR.ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: ADDR.PONS_V2_MEME_HOOK };
const POOL_ID = '0x45f0facb2ce64e344dba77b3c894f4ebfa352d161ffd785d2d4e915c754580f3';
const V3_POOL = '0x2222222222222222222222222222222222222222';

const v4q = new ethers.utils.Interface(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);
const v3q = new ethers.utils.Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const sv = new ethers.utils.Interface(['function getLiquidity(bytes32 poolId) view returns (uint128)']);
const v3p = new ethers.utils.Interface(['function liquidity() view returns (uint128)']);

// model: { head, tokensPerEth(block), feeBps, drainedFrom, historyFrom, v3Broken, liq }
function fakeChain(model) {
  const tsOf = (n) => T0 + Math.floor(n / 10);
  const calls = { getBlock: 0, call: 0, to: new Set(), sent: 0 };
  const revert = () => { const e = new Error('call revert exception'); e.code = 'CALL_EXCEPTION'; return e; };
  const p = {
    calls,
    async getBlock(n) {
      calls.getBlock += 1;
      const num = n === 'latest' ? model.head : Number(n);
      if (num > model.head) return null;
      return { number: num, timestamp: tsOf(num) };
    },
    async call(tx, blockTag) {
      calls.call += 1;
      calls.to.add(ethers.utils.getAddress(tx.to));
      const b = blockTag == null ? model.head : Number(blockTag);
      if (model.historyFrom != null && b < model.historyFrom) throw new Error('missing trie node abc (path ) state 0x… is not available');
      const drained = model.drainedFrom != null && b >= model.drainedFrom;
      const fee = (model.feeBps || 0);
      const k = model.tokensPerEth(b); // tokens per 1 ETH, as a plain number
      const toWei = (x) => ethers.utils.parseUnits(x.toFixed(6), 18);
      const swap = (isBuy, amountIn) => {
        const amt = Number(ethers.utils.formatEther(amountIn));
        const gross = isBuy ? amt * k : amt / k;
        return toWei(gross * (1 - fee / 10000));
      };
      if (lc(tx.to) === lc(ADDR.V4_QUOTER)) {
        const [pr] = v4q.decodeFunctionData('quoteExactInputSingle', tx.data);
        if (drained) throw revert();
        const tokenIsC0 = lc(pr.poolKey.currency0) === lc(TOKEN);
        const isBuy = pr.zeroForOne === !tokenIsC0;
        return v4q.encodeFunctionResult('quoteExactInputSingle', [swap(isBuy, pr.exactAmount), 100000]);
      }
      if (lc(tx.to) === lc(ADDR.V3_QUOTER)) {
        if (model.v3Broken) throw revert();
        const [pr] = v3q.decodeFunctionData('quoteExactInputSingle', tx.data);
        const isBuy = lc(pr.tokenIn) === lc(ADDR.WETH);
        return v3q.encodeFunctionResult('quoteExactInputSingle', [swap(isBuy, pr.amountIn), 0, 0, 100000]);
      }
      if (lc(tx.to) === lc(ADDR.UNIV4_STATE_VIEW)) return sv.encodeFunctionResult('getLiquidity', [drained ? 0 : (model.liq || 1000)]);
      if (lc(tx.to) === lc(V3_POOL)) return v3p.encodeFunctionResult('liquidity', [model.liq || 1000]);
      throw revert();
    },
    async sendTransaction() { calls.sent += 1; throw new Error('must never send'); },
  };
  return p;
}
const lc = (a) => String(a || '').toLowerCase();
const iso = (unix) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');

function screen({ symbol = 'HRX', token = TOKEN, verdict = 'SNIP', gate = null, version = 'v4', base = 'ETH', screenedAt, costPct = 5.9, pool = true }) {
  const r = { symbol, token, verdict, gate, version, base, screenedAt, launchPath: 'Pons launchpad', rug: { whaleRecovery: 0.75 } };
  const detail = { roundTripJudgement: { costPct } };
  if (pool && version === 'v4') detail.pool = { version: 'v4', tokenAddr: token, base, poolId: POOL_ID, poolKey: { ...PONS_KEY, currency1: token } };
  if (pool && version === 'v3') detail.pool = { version: 'v3', tokenAddr: token, base, baseAddr: ADDR.WETH, fee: 10000, poolAddress: V3_POOL };
  return { record: r, detail };
}

async function main() {
  section('1. durations');
  check('30m = 1800 s', L.parseDuration('30m') === 1800);
  check('6h = 21600 s', L.parseDuration('6h') === 21600);
  check('1d = 86400 s', L.parseDuration('1d') === 86400);
  check('0 = off', L.parseDuration('0') === 0);
  let threw = false; try { L.parseDuration('six hours'); } catch (_) { threw = true; }
  check('a bad duration is refused', threw);

  section('2. block at a time');
  {
    const head = 3_000_000; // ~83 h of blocks
    const prov = fakeChain({ head, tokensPerEth: () => 1000 });
    const clock = new L.BlockClock(prov);
    let worst = 0;
    for (const off of [5, 3600, 7200, 21600, 86400, 200000, 299000]) {
      const want = T0 + off;
      const b = await clock.at(want);
      const got = T0 + Math.floor(b / 10);
      worst = Math.max(worst, Math.abs(got - want));
    }
    check('every lookup lands within 1 s of the time asked', worst <= 1, `worst ${worst}s`);
    const before = prov.calls.getBlock;
    await clock.at(T0 + 3600);
    check('a time already looked up costs no new block reads', prov.calls.getBlock === before);
    check('a time after the head returns the head', (await clock.at(T0 + 10_000_000)) === head);
    check('lookups stay cheap (under 8 block reads each on average)', prov.calls.getBlock / 8 < 8, `${prov.calls.getBlock} reads`);
  }

  section('3. choosing tokens from the screen files');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookback-'));
  const sdir = path.join(dir, 'screens');
  const put = (day, name, obj) => { fs.mkdirSync(path.join(sdir, day), { recursive: true }); fs.writeFileSync(path.join(sdir, day, name), JSON.stringify(obj)); };
  const at = iso(T0 + 1000);
  put('2026-10-18', '010000_HRX_a.json', screen({ verdict: 'DO NOT SNIP', gate: 4, screenedAt: at }));
  put('2026-10-19', '020000_HRX_b.json', screen({ verdict: 'SNIP', screenedAt: at }));
  put('2026-10-19', '030000_SRC_c.json', screen({ symbol: 'SRC', token: '0x' + '3'.repeat(40), verdict: 'DO NOT SNIP', gate: 0, screenedAt: at, pool: false }));
  put('2026-10-19', '040000_PULL_d.json', screen({ symbol: 'PULL', token: '0x' + '4'.repeat(40), verdict: 'DO NOT SNIP', gate: '1b', screenedAt: at }));
  put('2026-10-19', '050000_ZD_e.json', screen({ symbol: 'ZD', token: TOKEN3, verdict: 'PASSED GATES 0-5', gate: 6, version: 'v3', screenedAt: at }));
  put('2026-10-19', '060000_USD_f.json', screen({ symbol: 'USD', token: '0x' + '6'.repeat(40), verdict: 'UNKNOWN', gate: 2, base: 'USDG', screenedAt: at }));
  fs.writeFileSync(path.join(sdir, '2026-10-19', 'broken.json'), '{not json');
  const screens = L.readScreens(sdir);
  check('all valid files read, the broken one skipped', screens.length === 6, `${screens.length}`);
  check('--dates keeps one day', L.readScreens(sdir, { dates: ['2026-10-18'] }).length === 1);
  const far = L.selectTokens(screens, { set: 'far' });
  check('"far" = SNIP, PASSED and Gate 2+ (HRX, ZD, USD)', far.map((t) => t.j.record.symbol).join(',') === 'HRX,ZD,USD', far.map((t) => t.j.record.symbol).join(','));
  check('a token screened twice counts once, with its latest screen', far.find((t) => t.j.record.symbol === 'HRX').j.record.verdict === 'SNIP');
  check('"1b" = the Gate 1b rejections', L.selectTokens(screens, { set: '1b' }).map((t) => t.j.record.symbol).join(',') === 'PULL');
  check('"all" includes the Gate 0 token too', L.selectTokens(screens, { set: 'all' }).length === 5);
  check('a v3 pool is read with its address and fee', far.find((t) => t.j.record.symbol === 'ZD').pool.poolAddress === V3_POOL);
  check('no pool in the file -> pool is null', L.poolOf(screen({ screenedAt: at, pool: false })) === null);
  const s1 = L.selectTokens(screens, { set: 'all', sample: 2, seed: 3 }).map((t) => t.j.record.token).join();
  const s2 = L.selectTokens(screens, { set: 'all', sample: 2, seed: 3 }).map((t) => t.j.record.token).join();
  check('a sample is the same on every run with the same seed', s1 === s2);

  const opts = (prov) => ({ provider: prov, clock: new L.BlockClock(prov), amountWei: E(0.05), points: [3600, 21600, 86400], peakStepSec: 1800, horizonSec: 86400 });
  const tok = (o) => { const j = screen({ screenedAt: iso(T0 + 1000), ...o }); return { date: '2026-10-19', time: '000000', j, pool: L.poolOf(j) }; };

  section('4. a flat price with the 2.99% Pons fee');
  {
    const prov = fakeChain({ head: 2_000_000, tokensPerEth: () => 1_000_000, feeBps: 299 });
    const row = await L.scoreToken(tok({}), opts(prov));
    check('status ok', row.status === 'ok', row.status);
    check('instant round trip reads -5.9% (Gate 4 cost)', near(row.returns['0'], -5.9, 0.02), String(row.returns['0']));
    check('+1h, +6h, +24h all read -5.9%', ['1h', '6h', '24h'].every((l) => near(row.returns[l], -5.9, 0.02)), JSON.stringify(row.returns));
    check('no cost-mismatch note when it matches Gate 4', !row.notes.some((n) => /instant round trip/.test(n)), row.notes.join(';'));
    check('only quoter and StateView were called', [...prov.calls.to].every((a) => [ADDR.V4_QUOTER, ADDR.UNIV4_STATE_VIEW].map(ethers.utils.getAddress).includes(a)), [...prov.calls.to].join());
    check('nothing was ever sent', prov.calls.sent === 0);
  }

  section('5. the price doubles after 2 hours, then falls to a quarter at 12 hours');
  {
    const entryBlock = 10_000; // T0 + 1000 s
    const k = (b) => {
      const hrs = (b - entryBlock) / 36000;
      if (hrs < 2) return 1_000_000;          // tokens per ETH: fewer tokens = higher price
      if (hrs < 12) return 500_000;           // price x2
      return 4_000_000;                       // price x0.25
    };
    const prov = fakeChain({ head: 4_000_000, tokensPerEth: k, feeBps: 299 });
    const row = await L.scoreToken(tok({}), opts(prov));
    check('+1h still -5.9%', near(row.returns['1h'], -5.9, 0.05), String(row.returns['1h']));
    check('+6h about +88% (x2 after 5.9%)', near(row.returns['6h'], 88.2, 0.3), String(row.returns['6h']));
    check('+24h about -76% (x0.25 after fees)', near(row.returns['24h'], -76.5, 0.3), String(row.returns['24h']));
    check('peak +88% found 2 h in (first sample after the jump)', near(row.peakPct, 88.2, 0.3) && row.peakAfterMin === 120, `${row.peakPct} at ${row.peakAfterMin} min`);
    check('trough found after 12 h', row.troughAfterMin >= 720, String(row.troughAfterMin));
  }

  section('6. times that have not happened yet');
  {
    // head 3 h after entry: +6h and +24h are in the future.
    const prov = fakeChain({ head: 10_000 + 3 * 36000, tokensPerEth: () => 1_000_000, feeBps: 99 });
    const row = await L.scoreToken(tok({ costPct: 2.0 }), opts(prov));
    check('+1h measured', row.returns['1h'] != null);
    check('+6h and +24h left empty', row.returns['6h'] === null && row.returns['24h'] === null, JSON.stringify(row.returns));
    check('"now" measured and how long after entry', row.returns.now != null && near(row.nowHoursAfter, 3, 0.1), `${row.returns.now} ${row.nowHoursAfter}`);
  }

  section('7. a pool emptied 4 hours after entry');
  {
    const prov = fakeChain({ head: 4_000_000, tokensPerEth: () => 1_000_000, feeBps: 299, drainedFrom: 10_000 + 4 * 36000, liq: 5000 });
    const row = await L.scoreToken(tok({}), opts(prov));
    check('+1h normal', near(row.returns['1h'], -5.9, 0.05));
    check('+6h and +24h read -100%', row.returns['6h'] === -100 && row.returns['24h'] === -100, JSON.stringify(row.returns));
    check('liquidity drop 100%', row.liqDropPct === 100, String(row.liqDropPct));
  }

  section('8. an RPC without old state');
  {
    const prov = fakeChain({ head: 4_000_000, tokensPerEth: () => 1_000_000, historyFrom: 3_900_000 });
    const row = await L.scoreToken(tok({}), opts(prov));
    check('reported as "no history", not as a token result', /no history/.test(row.status), row.status);
    check('error text recognised', L.isNoHistory(new Error('missing trie node')) && !L.isRevert(new Error('missing trie node')));
  }

  section('9. v3 pools and other bases');
  {
    const prov = fakeChain({ head: 2_000_000, tokensPerEth: () => 2_000_000, feeBps: 100 });
    const row = await L.scoreToken(tok({ symbol: 'ZD', token: TOKEN3, version: 'v3', verdict: 'PASSED GATES 0-5', gate: 6, costPct: 1.99 }), opts(prov));
    check('v3 measured through the v3 quoter', row.status === 'ok' && near(row.returns['0'], -1.99, 0.02), `${row.status} ${row.returns['0']}`);
    const prov2 = fakeChain({ head: 2_000_000, tokensPerEth: () => 2_000_000, v3Broken: true });
    const row2 = await L.scoreToken(tok({ token: TOKEN3, version: 'v3' }), opts(prov2));
    check('a v3 quoter that does not answer -> "v3 quote unavailable"', /v3 quote unavailable/.test(row2.status), row2.status);
    const rowW = await L.scoreToken(tok({ symbol: 'NVDA', token: TOKEN3, version: 'v3', base: 'WETH', costPct: 1.99 }), opts(prov));
    check('a v3 pool on WETH is measured (WETH is ETH here)', rowW.status === 'ok' && near(rowW.returns['0'], -1.99, 0.02), `${rowW.status} ${rowW.returns['0']}`);
    const row3 = await L.scoreToken(tok({ base: 'USDG' }), opts(prov));
    check('a USDG pool is skipped and says so', /USDG not covered/.test(row3.status), row3.status);
  }

  section('10. Gate 4 cross-check note');
  {
    const prov = fakeChain({ head: 2_000_000, tokensPerEth: () => 1_000_000, feeBps: 299 });
    const row = await L.scoreToken(tok({ costPct: 2.0 }), opts(prov));
    check('an instant round trip far from Gate 4 is noted', row.notes.some((n) => /instant round trip 5\.\d\d% vs Gate 4 2\.00%/.test(n)), row.notes.join(';'));
  }

  section('11. CSV and scorecard');
  {
    const rows = [
      { date: 'd', time: '1', symbol: 'A,B', token: '0x1', verdict: 'SNIP', gate: null, returns: { 0: -5.9, '1h': 10, '6h': 20, '24h': -50, now: -60 }, status: 'ok', notes: ['x'] },
      { date: 'd', time: '2', symbol: 'C', token: '0x2', verdict: 'SNIP', gate: null, returns: { 0: -5.9, '1h': -3, '6h': 40, '24h': 30, now: 0 }, status: 'ok', notes: [] },
      { date: 'd', time: '3', symbol: 'D', token: '0x3', verdict: 'DO NOT SNIP', gate: '6', returns: { 0: -5.9, '1h': -20 }, status: 'ok', notes: [] },
      { date: 'd', time: '4', symbol: 'E', token: '0x4', verdict: 'SNIP', gate: null, returns: {}, status: 'rpc has no history for the entry block', notes: [] },
    ];
    const csv = L.csvOf(rows, [3600, 21600, 86400]).trim().split('\n');
    check('header names the points', csv[0].includes('ret_1h,ret_6h,ret_24h,ret_now'), csv[0]);
    check('a comma in a symbol is quoted', csv[1].includes('"A,B"'), csv[1]);
    check('one line per row', csv.length === 5);
    const sum = L.summarise(rows, [3600, 21600, 86400]);
    const snip = sum.find((s) => s.group === 'SNIP');
    check('scorecard leaves out rows that could not be measured', snip.tokens === 2, JSON.stringify(snip));
    check('median +1h of SNIPs = 3.5%', snip['median_1h'] === 3.5, String(snip['median_1h']));
    check('in profit at +24h: 1 of 2', snip['inProfit_24h'] === '1/2', snip['inProfit_24h']);
    check('rejections grouped by gate', sum.some((s) => s.group === 'DO NOT SNIP (gate 6)'));
  }

  section('12. an RPC without old state, with Gate 3\'s amount in the file');
  {
    // 0.05 ETH at 1,000,000 tokens/ETH with the 2.99% fee = 48,505 tokens (what Gate 3 saw).
    const prov = fakeChain({ head: 2_000_000, tokensPerEth: () => 1_000_000, feeBps: 299, historyFrom: 1_999_000 });
    const t = tok({});
    t.j.detail.roundTrips = { sim1: { tokensReceivedWei: E(48505).toString() } };
    const row = await L.scoreToken(t, opts(prov));
    check('status "ok (now only)"', row.status === 'ok (now only)', row.status);
    check('entry amount from Gate 3', row.entrySource === 'gate3' && row.tokensBought === E(48505).toString());
    check('"now" measured: -5.9%', near(row.returns.now, -5.9, 0.05), String(row.returns.now));
    check('the old points are left empty, not guessed', row.returns['1h'] === null && row.returns['24h'] === null && row.peakPct === null, JSON.stringify(row.returns));
    check('it says why', row.notes.some((n) => /keeps no old state/.test(n)));
    check('counted in the scorecard', L.summarise([row], [3600]).length === 1);
    check('no Gate 3 amount -> still reported as no history', /no history/.test((await L.scoreToken(tok({}), opts(prov))).status));
  }

  section('13. live mode: checkpoints recorded as they happen');
  {
    const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
    const lscreens = path.join(ldir, 'screens');
    const entryTs = T0 + 1000; // block 10,000
    const day = '2026-10-20';
    fs.mkdirSync(path.join(lscreens, day), { recursive: true });
    const snip = screen({ verdict: 'SNIP', screenedAt: iso(entryTs) });
    snip.detail.roundTrips = { sim1: { tokensReceivedWei: E(48505).toString() } };
    fs.writeFileSync(path.join(lscreens, day, '010000_HRX_a.json'), JSON.stringify(snip));
    const early = screen({ symbol: 'G1B', token: '0x' + '4'.repeat(40), verdict: 'DO NOT SNIP', gate: '1b', screenedAt: iso(entryTs) });
    fs.writeFileSync(path.join(lscreens, day, '010001_G1B_b.json'), JSON.stringify(early));
    // Price: flat, x2 from 5 h, x0.5 from 20 h.
    const model = { head: 0, feeBps: 299, historyFrom: null, tokensPerEth: (b) => { const h = (b - 10_000) / 36000; return h < 5 ? 1_000_000 : h < 20 ? 500_000 : 2_000_000; } };
    const prov = fakeChain(model);
    const o = { liveDir: path.join(ldir, 'live'), screens: lscreens, set: 'far', amount: '0.05', points: [3600, 21600, 86400], horizon: 86400, maxLate: 1800, delay: 0 };
    // historyFrom = head: any read of an older block throws, so these runs prove
    // the live mode works on an RPC that keeps no old state at all.
    const at = (sec) => { model.head = 10_000 + sec * 10; model.historyFrom = model.head; };
    const quiet = () => {};
    at(10 * 60); let res = await L.liveRun(o, prov, { log: quiet });
    check('first run picks up the SNIP (Gate 3 amount), not the Gate 1b rejection', res.added === 1 && Object.keys(res.state.tokens).length === 1);
    at(65 * 60); res = await L.liveRun(o, prov, { log: quiet });
    const s1 = Object.values(res.state.tokens)[0];
    check('+1h recorded at the first run after it, 5 min late', s1.checkpoints['1h'] && near(s1.checkpoints['1h'].v, -5.9, 0.05) && s1.checkpoints['1h'].lateMin === 5, JSON.stringify(s1.checkpoints['1h']));
    check('a second run does not add the token again', res.added === 0);
    at(6 * 3600 + 10 * 60); res = await L.liveRun(o, prov, { log: quiet });
    const s2 = Object.values(res.state.tokens)[0];
    check('+6h recorded after the price doubled: about +88%', near(s2.checkpoints['6h'].v, 88.2, 0.3), JSON.stringify(s2.checkpoints['6h']));
    // The job stops for 2 hours around +24h: the next run is 2 h late.
    at(26 * 3600); res = await L.liveRun(o, prov, { log: quiet });
    const s3 = Object.values(res.state.tokens)[0];
    check('a checkpoint no run reached within 30 min is marked missed, not filled with a later price', s3.checkpoints['24h'].missed === true && s3.checkpoints['24h'].v === null, JSON.stringify(s3.checkpoints['24h']));
    check('peak +88% at 370 min, from the runs\' samples', near(s3.peak.v, 88.2, 0.3) && s3.peak.min === 370, JSON.stringify(s3.peak));
    check('past the horizon the token is done', s3.status === 'done');
    const csv = fs.readFileSync(path.join(o.liveDir, 'lookback-live.csv'), 'utf8').trim().split('\n');
    check('live CSV: header + 1 token, with late minutes', csv.length === 2 && csv[0].includes('late_min_1h'), csv[0]);
    at(26 * 3600 + 900); res = await L.liveRun(o, prov, { log: quiet });
    check('a done token is not quoted again', res.quoted === 0, String(res.quoted));
    fs.rmSync(ldir, { recursive: true, force: true });
  }

  section('14. early checkpoints: +2m / +5m / +10m from the minute job');
  {
    const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-'));
    const lscreens = path.join(ldir, 'screens');
    const day = '2026-10-23';
    fs.mkdirSync(path.join(lscreens, day), { recursive: true });
    const entryTs = T0 + 1000; // block 10,000
    const writeSnip = (sym, token, ts, fname) => {
      const s = screen({ symbol: sym, token, verdict: 'SNIP', screenedAt: iso(ts) });
      s.detail.roundTrips = { sim1: { tokensReceivedWei: E(48505).toString() } };
      fs.writeFileSync(path.join(lscreens, day, fname), JSON.stringify(s));
    };
    writeSnip('EAR', TOKEN, entryTs, '120000_EAR_a.json');
    // Price: flat for 4 min, x2 from 4 min, back to flat from 8 min.
    const model = { head: 0, feeBps: 299, historyFrom: null, tokensPerEth: (b) => { const m = (b - 10_000) / 600; return m >= 4 && m < 8 ? 500_000 : 1_000_000; } };
    const prov = fakeChain(model);
    const o = { liveDir: path.join(ldir, 'live'), screens: lscreens, set: 'far', amount: '0.05', points: [3600, 21600, 86400], horizon: 86400, maxLate: 1800,
      earlyPoints: [120, 300, 600], earlyMaxLate: 180, delay: 0 };
    const oe = { ...o, early: true };
    const at = (sec) => { model.head = 10_000 + sec * 10; model.historyFrom = model.head; };
    const quiet = () => {};
    const tokOf = (res, sym) => Object.values(res.state.tokens).find((x) => x.symbol === sym);

    // The minute job, minutes 1..12.
    let res;
    for (let m = 1; m <= 12; m += 1) { at(m * 60 + 20); res = await L.liveRun(oe, prov, { log: quiet }); }
    let s = tokOf(res, 'EAR');
    check('minute job picks the token up within its first minute', s && s.first && s.first.min === 1, JSON.stringify(s && s.first));
    check('+2m recorded on time: -5.9% (flat)', s.checkpoints['2m'] && near(s.checkpoints['2m'].v, -5.9, 0.05) && s.checkpoints['2m'].lateMin === 0, JSON.stringify(s.checkpoints['2m']));
    check('+5m recorded after the jump: about +88%', near(s.checkpoints['5m'].v, 88.2, 0.3) && s.checkpoints['5m'].lateMin === 0, JSON.stringify(s.checkpoints['5m']));
    check('+10m back to -5.9%', near(s.checkpoints['10m'].v, -5.9, 0.05), JSON.stringify(s.checkpoints['10m']));
    check('the minute job never records +1h', !s.checkpoints['1h']);
    check('peak +88% seen at minute 4', near(s.peak.v, 88.2, 0.3) && s.peak.min === 4, JSON.stringify(s.peak));

    // Past the early window, the minute job leaves the token alone and stays quiet.
    const logged = [];
    at(20 * 60); res = await L.liveRun(oe, prov, { log: (x) => logged.push(x) });
    check('after 13 min the minute job no longer quotes it', res.quoted === 0, String(res.quoted));
    check('a quiet minute writes no log line', logged.length === 0, logged.join('|'));
    // The 15-minute job still follows it, and does not overwrite the early points.
    at(65 * 60); res = await L.liveRun(o, prov, { log: quiet });
    s = tokOf(res, 'EAR');
    check('15-minute job records +1h as before', s.checkpoints['1h'] && s.checkpoints['1h'].lateMin === 5, JSON.stringify(s.checkpoints['1h']));
    check('early points unchanged by the 15-minute job', near(s.checkpoints['5m'].v, 88.2, 0.3));

    // A token the minute job missed (it was not running) and the 15-minute job
    // first sees 8 min in: +2m left blank, +5m recorded 3 min late, +10m missed later.
    const LATE = '0x' + '5'.repeat(40);
    const lateTs = T0 + 1000 + 3600; // screened when the chain is at +60 min
    writeSnip('LAT', LATE, lateTs, '130000_LAT_b.json');
    model.tokensPerEth = () => 1_000_000;
    const atAbs = (unix) => { model.head = (unix - T0) * 10; model.historyFrom = model.head; };
    atAbs(lateTs + 8 * 60); res = await L.liveRun(o, prov, { log: quiet });
    s = tokOf(res, 'LAT');
    check('first seen at 8 min: +2m left blank (not watched then)', s && !s.checkpoints['2m'], JSON.stringify(s && s.checkpoints));
    check('+5m recorded, 3 min late', s.checkpoints['5m'] && s.checkpoints['5m'].lateMin === 3 && s.checkpoints['5m'].v != null, JSON.stringify(s.checkpoints['5m']));
    atAbs(lateTs + 23 * 60); res = await L.liveRun(o, prov, { log: quiet });
    s = tokOf(res, 'LAT');
    check('+10m 13 min late -> missed, not filled', s.checkpoints['10m'] && s.checkpoints['10m'].missed === true && s.checkpoints['10m'].v === null, JSON.stringify(s.checkpoints['10m']));

    const csv = fs.readFileSync(path.join(o.liveDir, 'lookback-live.csv'), 'utf8').trim().split('\n');
    check('live CSV has the early columns before +1h', csv[0].includes('ret_2m,late_min_2m,ret_5m,late_min_5m,ret_10m,late_min_10m,ret_1h'), csv[0]);
    const pa = L.parseArgs(['node', 'lookback.js', '--live', '--early']);
    check('CLI: --early, default early points 2m,5m,10m,30m and 3 min late allowed', pa.early && pa.earlyPoints.join() === '120,300,600,1800' && pa.earlyMaxLate === 180, JSON.stringify([pa.early, pa.earlyPoints, pa.earlyMaxLate]));
    check('CLI: minute job window 1h; long follow 7d, hourly, +3d/+7d', pa.earlyWindow === 3600 && pa.longHorizon === 604800 && pa.longStep === 3600 && pa.longPoints.join() === '259200,604800', JSON.stringify([pa.earlyWindow, pa.longHorizon, pa.longStep, pa.longPoints]));
    check('CLI: without --early it is the normal 15-minute run', L.parseArgs(['node', 'lookback.js', '--live']).early === false);
    fs.rmSync(ldir, { recursive: true, force: true });
  }

  section('15. early mode reads only recent screen files');
  {
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
    fs.mkdirSync(path.join(sd, '2026-10-23'));
    const f1 = path.join(sd, '2026-10-23', '000001_OLD_a.json');
    const f2 = path.join(sd, '2026-10-23', '000002_NEW_b.json');
    fs.writeFileSync(f1, JSON.stringify(screen({ symbol: 'OLD', screenedAt: iso(T0) })));
    fs.writeFileSync(f2, JSON.stringify(screen({ symbol: 'NEW', screenedAt: iso(T0) })));
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(f1, old, old);
    const got = L.readScreens(sd, { modifiedSinceMs: Date.now() - 600_000 }).map((x) => x.j.record.symbol).join(',');
    check('a file written an hour ago is skipped, a fresh one read', got === 'NEW', got);
    check('without the filter both are read', L.readScreens(sd).length === 2);
    fs.rmSync(sd, { recursive: true, force: true });
  }

  section('16. minute path for the first hour, and a 7-day follow for SNIPs');
  {
    const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-'));
    const lscreens = path.join(ldir, 'screens');
    const day = '2026-10-23';
    fs.mkdirSync(path.join(lscreens, day), { recursive: true });
    const entryTs = T0 + 1000; // block 10,000
    const put = (sym, token, verdict, gate, fname) => {
      const s = screen({ symbol: sym, token, verdict, gate, screenedAt: iso(entryTs) });
      s.detail.roundTrips = { sim1: { tokensReceivedWei: E(48505).toString() } };
      fs.writeFileSync(path.join(lscreens, day, fname), JSON.stringify(s));
    };
    put('LNG', TOKEN, 'SNIP', null, '100000_LNG_a.json');
    put('REJ', '0x' + '6'.repeat(40), 'DO NOT SNIP', '4', '100001_REJ_b.json');
    put('G6H', '0x' + '7'.repeat(40), 'DO NOT SNIP', '6', '100002_G6H_c.json');
    const model = { head: 0, feeBps: 299, historyFrom: null, tokensPerEth: () => 1_000_000 };
    const prov = fakeChain(model);
    const o = { liveDir: path.join(ldir, 'live'), screens: lscreens, set: 'far', amount: '0.05', points: [3600, 21600, 86400], horizon: 86400, maxLate: 1800,
      earlyPoints: [120, 300, 600, 1800], earlyMaxLate: 180, earlyWindow: 3600, longPoints: [259200, 604800], longStep: 3600, longHorizon: 604800, delay: 0 };
    const oe = { ...o, early: true };
    const at = (sec) => { model.head = 10_000 + sec * 10; model.historyFrom = model.head; };
    const quiet = () => {};
    const get = (res, sym) => Object.values(res.state.tokens).find((x) => x.symbol === sym);

    let res;
    let quotedAt50 = 0;
    for (let m = 1; m <= 65; m += 1) { at(m * 60 + 10); res = await L.liveRun(oe, prov, { log: quiet }); if (m === 50) quotedAt50 = res.quoted; }
    check('the minute job still quotes at minute 50 (all 3 tokens)', quotedAt50 === 3, String(quotedAt50));
    check('and stops after the first hour', res.quoted === 0, String(res.quoted));
    check('+30m recorded on time', get(res, 'LNG').checkpoints['30m'] && get(res, 'LNG').checkpoints['30m'].lateMin === 0, JSON.stringify(get(res, 'LNG').checkpoints['30m']));
    check('about 60 samples per token from the minute job', get(res, 'LNG').samples >= 59, String(get(res, 'LNG').samples));
    const sl = fs.readFileSync(path.join(o.liveDir, 'samples.csv'), 'utf8').trim().split('\n');
    check('samples.csv: header + one line per token per minute (59 minutes x 3 tokens)', sl[0].startsWith('time_utc,token,symbol') && sl.length - 1 === 3 * 59, `${sl.length - 1} lines`);

    // 15-minute runs from 24 h to 26 h: the rejection stops at 24 h, the SNIP and
    // the Gate 6 hold go on, quoted once an hour.
    const n0 = get(res, 'LNG').samples;
    let quotes = 0;
    for (let t = 24 * 3600; t <= 26 * 3600; t += 900) { at(t); res = await L.liveRun(o, prov, { log: quiet }); quotes += res.quoted; }
    check('a Gate 4 rejection is done at 24 h', get(res, 'REJ').status === 'done');
    check('the SNIP and the Gate 6 hold keep watching', get(res, 'LNG').status === 'watching' && get(res, 'G6H').status === 'watching');
    const added = get(res, 'LNG').samples - n0;
    check('after 24 h the SNIP is quoted hourly (3 times over 24-26 h), not every 15 min', added === 3, String(added));

    // Jump to +3 d: the +3d checkpoint is recorded (within an hour and a bit).
    at(3 * 86400 + 600); res = await L.liveRun(o, prov, { log: quiet });
    check('+3d checkpoint recorded 10 min late', get(res, 'LNG').checkpoints['3d'] && get(res, 'LNG').checkpoints['3d'].lateMin === 10, JSON.stringify(get(res, 'LNG').checkpoints['3d']));
    check('no +3d for the rejection', !get(res, 'REJ').checkpoints['3d']);
    at(7 * 86400 + 100); res = await L.liveRun(o, prov, { log: quiet });
    check('done after 7 days, with +7d', get(res, 'LNG').status === 'done' && get(res, 'LNG').checkpoints['7d'] != null, JSON.stringify(get(res, 'LNG').checkpoints['7d']));
    const csv = fs.readFileSync(path.join(o.liveDir, 'lookback-live.csv'), 'utf8').split('\n')[0];
    check('live CSV has ret_30m, ret_3d and ret_7d', csv.includes('ret_30m') && csv.includes('ret_3d,late_min_3d,ret_7d'), csv);

    // A SNIP an older version finished at 24 h is picked up again.
    const st = JSON.parse(fs.readFileSync(path.join(o.liveDir, 'state.json'), 'utf8'));
    const k = Object.keys(st.tokens).find((x) => st.tokens[x].symbol === 'G6H');
    st.tokens[k].status = 'done'; st.tokens[k].entryTs = T0 + 1000 + 6 * 86400; st.tokens[k].lastTs = null;
    fs.writeFileSync(path.join(o.liveDir, 'state.json'), JSON.stringify(st));
    res = await L.liveRun(o, prov, { log: quiet });
    check('a long-follow token stopped at 24 h by the old version is followed again', get(res, 'G6H').status === 'watching', get(res, 'G6H').status);
    fs.rmSync(ldir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
