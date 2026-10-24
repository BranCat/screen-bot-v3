// extras/lookback.js — post-release scorecard. READ-ONLY: plain RPC reads
// (eth_call to the pool quoters, getBlock), no Tenderly, nothing signed or sent.
// It never touches the live bot: it only reads screens/ and writes extras/.
//
// The question: if a 0.05 ETH buy had been made when the bot finished screening
// a token, what would selling those tokens have returned 1 h, 6 h and 24 h later?
//
// How (for every selected token):
//   1. entry block = the block at the screen's finish time (record.screenedAt);
//   2. buy quote at the entry block: 0.05 ETH -> tokens (the quoter runs the
//      pool's hook, so the Pons buy fee is included);
//   3. sell quote for exactly those tokens at +0 (an instant round trip, which
//      should match Gate 4's cost), +1 h, +6 h, +24 h and now;
//   4. a sample every --peak-step (default 30 min) over the first 24 h for the
//      best and worst moment;
//   5. pool liquidity at entry and now, to see pools that were emptied.
// Returns are percentages of the 0.05 ETH, after both hook fees, before gas.
//
//   node extras/lookback.js --probe                       does this RPC keep old state?
//   node extras/lookback.js --live                        one live run (cron, every 15 min): see "live mode" below
//   node extras/lookback.js --live --early                quick run for young tokens only (cron, every minute): a price
//                                                         every minute for the first hour, +2m/+5m/+10m/+30m checkpoints
//   node extras/lookback.js                               SNIPs and tokens that reached Gate 2+, all dates
//   node extras/lookback.js --dates 2026-10-19            one day (comma-separate several)
//   node extras/lookback.js --set 1b --sample 40          40 random Gate 1b rejections
//   node extras/lookback.js --set all                     every token with a known pool (slow)
//   [--points 1h,6h,24h] [--peak-step 30m | 0] [--horizon 24h] [--amount 0.05]
//   [--out extras/lookback] [--delay 40] [--rpc URL] [--limit N] [--fresh]
//
// Output: <out>.jsonl (one line per token; a restarted run skips tokens already
// in it, --fresh starts over) and <out>.csv, rebuilt from the .jsonl at the end.
// LOOKBACK_RPC in .env, or --rpc, points it at another (archive) RPC.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) { /* optional */ }
const config = require('../config');
const ADDR = config.ADDR;

const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a || '').toLowerCase();

// Same v4 quoter shape transfer-audit.js uses (it answered on CAPA, 19 Oct).
const v4QuoterIface = new ethers.utils.Interface([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);
// Standard Uniswap QuoterV2. UNVERIFIED on this chain: a failure is recorded as
// "v3 quote unavailable", never as a finding about the token.
const v3QuoterIface = new ethers.utils.Interface([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const stateViewIface = new ethers.utils.Interface(['function getLiquidity(bytes32 poolId) view returns (uint128)']);
const v3PoolIface = new ethers.utils.Interface(['function liquidity() view returns (uint128)']);

// ---------------------------------------------------------------- small helpers

function parseDuration(s) {
  if (s == null || s === '' || s === '0') return 0;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 30m, 6h, 1d)`);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's').toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}
const label = (sec) => (sec >= 172800 && sec % 86400 === 0 ? `${sec / 86400}d` : sec % 3600 === 0 ? `${sec / 3600}h` : sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors that mean "this RPC has no state for that block" rather than "the swap
// reverted". Archive-less nodes word it differently; these cover geth/nitro.
const NO_HISTORY_RE = /missing trie node|header not found|historical state|state (is )?not available|pruned|unknown block|block not found|state histories/i;
const isNoHistory = (e) => NO_HISTORY_RE.test(String((e && (e.body || e.message)) || e));
const isRevert = (e) => {
  const s = String((e && (e.code || '')) + ' ' + ((e && (e.body || e.message)) || ''));
  return /CALL_EXCEPTION|execution reverted|revert/i.test(s) && !isNoHistory(e);
};

// One RPC call with retries for transient failures. Reverts and missing history
// are answers, not failures, so they are returned at once.
async function rpc(fn, { tries = 3, delayMs = 400 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      if (isRevert(e) || isNoHistory(e)) throw e;
      if (i < tries - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- the clock
// Block at a unix time, by secant search on real block timestamps, starting from
// the nearest block already looked at. The chain makes about 10 blocks a second,
// so a 1-second tolerance is within about 10 blocks.
class BlockClock {
  constructor(provider, { blocksPerSec = 10, toleranceSec = 1 } = {}) {
    this.p = provider;
    this.bps = blocksPerSec;
    this.tol = toleranceSec;
    this.ts = new Map(); // block -> timestamp
    this.calls = 0;
  }
  async block(n) {
    if (this.ts.has(n)) return { number: n, timestamp: this.ts.get(n) };
    this.calls += 1;
    const b = await rpc(() => this.p.getBlock(n));
    if (!b) return null;
    this.ts.set(b.number, b.timestamp);
    return b;
  }
  async head(refresh = false) {
    if (!this._head || refresh) {
      this.calls += 1;
      const b = await rpc(() => this.p.getBlock('latest'));
      this.ts.set(b.number, b.timestamp);
      this._head = { number: b.number, timestamp: b.timestamp };
    }
    return this._head;
  }
  nearest(tsSec) {
    let best = null;
    for (const [n, t] of this.ts) {
      if (!best || Math.abs(t - tsSec) < Math.abs(best.timestamp - tsSec)) best = { number: n, timestamp: t };
    }
    return best;
  }
  async at(tsSec) {
    const head = await this.head();
    if (tsSec >= head.timestamp) return head.number;
    let a = this.nearest(tsSec) || head;
    if (Math.abs(a.timestamp - tsSec) <= this.tol) return a.number;
    let guess = Math.max(1, Math.min(head.number, Math.round(a.number - (a.timestamp - tsSec) * this.bps)));
    for (let i = 0; i < 30; i += 1) {
      const b = await this.block(guess);
      if (!b) break;
      const diff = b.timestamp - tsSec;
      if (Math.abs(diff) <= this.tol) return b.number;
      const rate = a.number !== b.number && a.timestamp !== b.timestamp ? (a.number - b.number) / (a.timestamp - b.timestamp) : this.bps;
      const safe = Number.isFinite(rate) && rate > 0 ? rate : this.bps;
      a = { number: b.number, timestamp: b.timestamp };
      let next = Math.max(1, Math.min(head.number, Math.round(b.number - diff * safe)));
      if (next === guess) next = guess + (diff > 0 ? -1 : 1); // stuck on a rounding step: walk
      guess = next;
    }
    return guess;
  }
}

// ---------------------------------------------------------------- screens

function readScreens(screensDir, { dates = null, modifiedSinceMs = 0 } = {}) {
  const out = [];
  let days;
  try { days = fs.readdirSync(screensDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch (_) { return out; }
  if (dates && dates.length) days = days.filter((d) => dates.includes(d));
  for (const day of days) {
    const dir = path.join(screensDir, day);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      if (modifiedSinceMs) { // early mode: skip old files without parsing them
        try { if (fs.statSync(path.join(dir, f)).mtimeMs < modifiedSinceMs) continue; } catch (_) { continue; }
      }
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
      if (!j || !j.record) continue;
      out.push({ file: path.join(day, f), date: day, time: f.slice(0, 6), j });
    }
  }
  return out;
}

// The pool, in the shape the quoters need. null when the file has no usable pool.
function poolOf(j) {
  const r = j.record || {};
  const p = (j.detail && j.detail.pool) || null;
  if (!p) return null;
  const base = p.base || r.base;
  if (p.version === 'v4' && p.poolKey && p.poolKey.currency0 != null) {
    return { version: 'v4', token: p.tokenAddr || r.token, base, poolKey: p.poolKey, poolId: p.poolId || r.poolId };
  }
  if (p.version === 'v3' && (p.poolAddress || r.poolAddress) && p.fee != null) {
    return { version: 'v3', token: p.tokenAddr || r.token, base, baseAddr: p.baseAddr || ADDR.WETH, fee: p.fee, poolAddress: p.poolAddress || r.poolAddress };
  }
  return null;
}

const reachedGate2 = (r) => {
  if (r.verdict === 'SNIP' || String(r.verdict || '').startsWith('PASSED')) return true;
  const g = Number(r.gate);
  return Number.isFinite(g) && g >= 2;
};

// Deterministic sample (same --seed, same tokens) so a rerun is comparable.
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i -= 1) { const k = Math.floor(rnd() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; }
  return a;
}

// set: 'far' (SNIP, PASSED, or stopped at Gate 2 or later), '1b', 'all'.
// One row per token: its latest screen.
function selectTokens(screens, { set = 'far', sample = 0, seed = 7 } = {}) {
  const byToken = new Map();
  for (const s of screens) {
    const r = s.j.record;
    if (!r.token) continue;
    byToken.set(lc(r.token), s); // later files overwrite earlier ones
  }
  let list = [...byToken.values()].filter((s) => {
    const r = s.j.record;
    if (set === 'far') return reachedGate2(r);
    if (set === '1b') return String(r.gate) === '1b';
    return true;
  });
  list = list.map((s) => ({ ...s, pool: poolOf(s.j) }));
  if (sample > 0 && list.length > sample) list = seededShuffle(list, seed).slice(0, sample);
  return list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// ---------------------------------------------------------------- chain reads

// side: 'buy' (base -> token) or 'sell' (token -> base). Returns
// { out: BigNumber } or { error: 'revert' | 'no-history' | message }.
async function quote(provider, pool, side, amountWei, blockTag) {
  let to, data, iface;
  if (pool.version === 'v4') {
    const tokenIsC0 = lc(pool.poolKey.currency0) === lc(pool.token);
    // zeroForOne = selling currency0. Buying the token sells the base.
    const zeroForOne = side === 'buy' ? !tokenIsC0 : tokenIsC0;
    iface = v4QuoterIface;
    to = ADDR.V4_QUOTER;
    data = iface.encodeFunctionData('quoteExactInputSingle', [{
      poolKey: {
        currency0: pool.poolKey.currency0, currency1: pool.poolKey.currency1,
        fee: pool.poolKey.fee, tickSpacing: pool.poolKey.tickSpacing, hooks: pool.poolKey.hooks,
      },
      zeroForOne, exactAmount: amountWei, hookData: '0x',
    }]);
  } else {
    iface = v3QuoterIface;
    to = ADDR.V3_QUOTER;
    const [tokenIn, tokenOut] = side === 'buy' ? [pool.baseAddr, pool.token] : [pool.token, pool.baseAddr];
    data = iface.encodeFunctionData('quoteExactInputSingle', [{ tokenIn, tokenOut, amountIn: amountWei, fee: pool.fee, sqrtPriceLimitX96: 0 }]);
  }
  try {
    const raw = await rpc(() => provider.call({ to, data }, blockTag));
    if (!raw || raw === '0x') return { error: 'empty answer' };
    return { out: iface.decodeFunctionResult('quoteExactInputSingle', raw)[0] };
  } catch (e) {
    if (isNoHistory(e)) return { error: 'no-history' };
    if (isRevert(e)) return { error: 'revert' };
    return { error: String(e.message || e).slice(0, 160) };
  }
}

async function liquidityAt(provider, pool, blockTag) {
  try {
    if (pool.version === 'v4') {
      const raw = await rpc(() => provider.call({ to: ADDR.UNIV4_STATE_VIEW, data: stateViewIface.encodeFunctionData('getLiquidity', [pool.poolId]) }, blockTag));
      return stateViewIface.decodeFunctionResult('getLiquidity', raw)[0];
    }
    const raw = await rpc(() => provider.call({ to: pool.poolAddress, data: v3PoolIface.encodeFunctionData('liquidity', []) }, blockTag));
    return v3PoolIface.decodeFunctionResult('liquidity', raw)[0];
  } catch (_) {
    return null;
  }
}

const retPct = (outWei, inWei) => {
  if (!outWei) return null;
  const r = (Number(ethers.utils.formatEther(outWei)) / Number(ethers.utils.formatEther(inWei)) - 1) * 100;
  return Math.round(r * 100) / 100;
};

// ---------------------------------------------------------------- one token

// What Gate 3 (or the 5b audit) measured 0.05 ETH to buy, on the screen block.
function gate3Tokens(detail) {
  const d = detail || {};
  const w = (d.roundTrips && d.roundTrips.sim1 && d.roundTrips.sim1.tokensReceivedWei)
    || (d.transferAudit && d.transferAudit.tokensReceivedWei) || null;
  try { return w && BN(w).gt(0) ? BN(w) : null; } catch (_) { return null; }
}

async function scoreToken(t, { provider, clock, amountWei, points, peakStepSec, horizonSec, delayMs = 0 }) {
  const r = t.j.record;
  const d = t.j.detail || {};
  const row = {
    date: t.date, time: t.time, symbol: r.symbol, token: r.token, version: r.version || (t.pool && t.pool.version) || null,
    launchPath: r.launchPath || null, verdict: r.verdict, gate: r.gate == null ? null : String(r.gate),
    costPct: (d.roundTripJudgement && d.roundTripJudgement.costPct) ?? null,
    whaleRecovery: (r.rug && r.rug.whaleRecovery) ?? null,
    screenedAt: r.screenedAt || null, entryBlock: null, tokensBought: null, entrySource: null,
    returns: {}, peakPct: null, peakAfterMin: null, troughPct: null, troughAfterMin: null,
    liqDropPct: null, status: 'ok', notes: [],
  };
  const pause = () => (delayMs ? sleep(delayMs) : null);

  if (!t.pool) { row.status = 'no pool in screen file'; return row; }
  if (t.pool.base && !['ETH', 'WETH'].includes(t.pool.base)) { row.status = `base ${t.pool.base} not covered`; return row; }
  const entryTs = Math.floor(Date.parse(r.screenedAt) / 1000);
  if (!Number.isFinite(entryTs)) { row.status = 'no screenedAt time'; return row; }

  const head = await clock.head();
  row.entryBlock = await clock.at(entryTs);
  await pause();

  let buy = await quote(provider, t.pool, 'buy', amountWei, row.entryBlock);
  let nowOnly = false;
  if (!buy.out && buy.error === 'no-history') {
    // An RPC without old state cannot quote the entry. Gate 3 already measured
    // what 0.05 ETH bought, on the screen's own block: use that, and measure
    // only "now" (every other point is an old block too).
    const g3 = gate3Tokens(d);
    if (g3) {
      buy = { out: g3 };
      nowOnly = true;
      row.entrySource = 'gate3';
      row.status = 'ok (now only)';
      row.notes.push('this RPC keeps no old state: entry amount from Gate 3, only "now" measured');
    }
  } else if (buy.out) {
    row.entrySource = 'quoter';
  }
  if (!buy.out) {
    row.status = buy.error === 'no-history' ? 'rpc has no history for the entry block (and no Gate 3 amount in the file)'
      : t.pool.version === 'v3' ? `v3 quote unavailable (${buy.error})` : `no buy quote at entry (${buy.error})`;
    return row;
  }
  if (buy.out.isZero()) { row.status = 'buy quote returned 0 tokens'; return row; }
  row.tokensBought = buy.out.toString();

  // Every time we need a sell quote at: the fixed points, the samples, now.
  const want = new Map(); // offsetSec -> label
  want.set(0, '0');
  for (const p of points) want.set(p, label(p));
  if (peakStepSec > 0) for (let o = peakStepSec; o <= horizonSec; o += peakStepSec) if (!want.has(o)) want.set(o, null);

  const samples = [];
  let historyGone = nowOnly;
  for (const [off, lab] of [...want.entries()].sort((a, b) => a[0] - b[0])) {
    if (entryTs + off > head.timestamp || historyGone) { if (lab) row.returns[lab] = null; continue; }
    const blk = off === 0 ? row.entryBlock : await clock.at(entryTs + off);
    await pause();
    const s = await quote(provider, t.pool, 'sell', buy.out, blk);
    let v = null;
    if (s.out) v = retPct(s.out, amountWei);
    else if (s.error === 'revert') v = -100; // nothing comes back: emptied pool or a blocked sell
    else if (s.error === 'no-history') { historyGone = true; row.notes.push(`no old state from +${label(off)}: later points not measured`); }
    else row.notes.push(`+${label(off)}: ${s.error}`);
    if (lab) row.returns[lab] = v;
    if (v != null && off > 0) samples.push({ off, v });
  }

  // Now.
  const nowQ = await quote(provider, t.pool, 'sell', buy.out, head.number);
  row.returns.now = nowQ.out ? retPct(nowQ.out, amountWei) : nowQ.error === 'revert' ? -100 : null;
  row.nowHoursAfter = Math.round(((head.timestamp - entryTs) / 3600) * 10) / 10;

  if (samples.length) {
    const hi = samples.reduce((a, b) => (b.v > a.v ? b : a));
    const lo = samples.reduce((a, b) => (b.v < a.v ? b : a));
    row.peakPct = hi.v; row.peakAfterMin = Math.round(hi.off / 60);
    row.troughPct = lo.v; row.troughAfterMin = Math.round(lo.off / 60);
  }

  const l0 = nowOnly ? null : await liquidityAt(provider, t.pool, row.entryBlock);
  const l1 = await liquidityAt(provider, t.pool, head.number);
  if (l0 && l1 && !l0.isZero()) row.liqDropPct = Math.round((1 - Number(l1.toString()) / Number(l0.toString())) * 1000) / 10;
  if (row.returns['0'] != null && row.costPct != null && Math.abs(-row.returns['0'] - row.costPct) > 1.5) {
    row.notes.push(`instant round trip ${(-row.returns['0']).toFixed(2)}% vs Gate 4 ${Number(row.costPct).toFixed(2)}%`);
  }
  return row;
}

// ---------------------------------------------------------------- output

function csvOf(rows, points) {
  const labs = points.map(label);
  const head = ['date', 'time', 'symbol', 'token', 'version', 'launchPath', 'verdict', 'gate', 'costPct', 'whaleRecovery',
    'entryBlock', 'entry_source', 'ret_0', ...labs.map((l) => `ret_${l}`), 'ret_now', 'now_hours_after', 'peak_pct', 'peak_after_min',
    'trough_pct', 'trough_after_min', 'liq_drop_pct', 'status', 'notes'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const r of rows) {
    const rt = r.returns || {};
    lines.push([r.date, r.time, r.symbol, r.token, r.version, r.launchPath, r.verdict, r.gate, r.costPct, r.whaleRecovery,
      r.entryBlock, r.entrySource, rt['0'], ...labs.map((l) => rt[l]), rt.now, r.nowHoursAfter, r.peakPct, r.peakAfterMin,
      r.troughPct, r.troughAfterMin, r.liqDropPct, r.status, (r.notes || []).join('; ')].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

const median = (xs) => {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// The headline: per verdict, how many, median return and share in profit.
function summarise(rows, points) {
  const groups = new Map();
  for (const r of rows) {
    if (!/^ok/.test(String(r.status))) continue;
    const g = r.verdict === 'SNIP' ? 'SNIP' : String(r.verdict || '').startsWith('PASSED') ? 'PASSED GATES 0-5' : `${r.verdict} (gate ${r.gate})`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const labs = points.map(label);
  const out = [];
  for (const [g, rs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const line = { group: g, tokens: rs.length };
    for (const l of labs) {
      const vals = rs.map((r) => r.returns[l]).filter((v) => v != null);
      line[`median_${l}`] = median(vals);
      line[`inProfit_${l}`] = vals.length ? `${vals.filter((v) => v > 0).length}/${vals.length}` : null;
    }
    line.medianPeak = median(rs.map((r) => r.peakPct));
    const nows = rs.map((r) => r.returns.now).filter((v) => v != null);
    line.medianNow = median(nows);
    line.inProfitNow = nows.length ? `${nows.filter((v) => v > 0).length}/${nows.length}` : null;
    line.medianHoursAfter = median(rs.map((r) => r.nowHoursAfter));
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- live mode
// For an RPC that keeps no old state: run every 15 minutes (cron). Each run
// quotes, at the NEWEST block only, every token screened in the last
// --horizon, and records each +1h / +6h / +24h checkpoint the first time a run
// lands after it (with how many minutes late). Every run is also a sample for
// the best and worst moment. State: <dir>/state.json; table: <dir>/lookback-live.csv.
//
// Early checkpoints (+2m, +5m, +10m by default, --early-points) are recorded the
// same way but need a run within --early-max-late (3m) of them, which the
// 15-minute job cannot give. So a second cron job runs "--live --early" every
// minute: it quotes only tokens younger than the last early point plus
// --early-max-late, and reads only screen files written in that window, so a
// minute with no new token costs one block read. Both jobs share state.json and
// must share one lock (flock -w, so neither skips while the other runs).
// The minute job keeps quoting each token every minute for --early-window (1h),
// so short trading rules can be tested on a minute-by-minute price path.
//
// Long follow: SNIPs, PASSED GATES 0-5 and Gate 6 holds are followed for
// --long-horizon (7d), hourly (--long-step) after the first --horizon (24h),
// with +3d / +7d checkpoints (--long-points). Other tokens stop at --horizon.
//
// Every quote is also appended to <dir>/samples.csv (one line per token per
// run: time, token, age in minutes, return), the raw path for later analysis.

function liveCsv(state, points, earlyPoints = [], longPoints = []) {
  const labs = [...earlyPoints, ...points, ...longPoints].map(label);
  const head = ['date', 'time', 'symbol', 'token', 'verdict', 'gate', 'costPct', 'whaleRecovery', 'entry_source',
    'first_pct', 'first_after_min', ...labs.flatMap((l) => [`ret_${l}`, `late_min_${l}`]),
    'last_pct', 'last_after_min', 'peak_pct', 'peak_after_min', 'trough_pct', 'trough_after_min', 'samples', 'status'];
  const esc = (v) => { if (v == null) return ''; const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = Object.values(state.tokens).sort((a, b) => a.entryTs - b.entryTs);
  return [head.join(','), ...rows.map((r) => [r.date, r.time, r.symbol, r.token, r.verdict, r.gate, r.costPct, r.whaleRecovery, r.entrySource,
    r.first && r.first.v, r.first && r.first.min,
    ...labs.flatMap((l) => { const c = r.checkpoints[l]; return c ? [c.v, c.lateMin] : ['', '']; }),
    r.last && r.last.v, r.last && r.last.min, r.peak && r.peak.v, r.peak && r.peak.min, r.trough && r.trough.v, r.trough && r.trough.min,
    r.samples, r.status].map(esc).join(','))].join('\n') + '\n';
}

// One live run. now: unix seconds of the newest block (injectable for tests).
async function liveRun(o, provider, { log = console.log } = {}) {
  const dir = o.liveDir;
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  let state = { tokens: {} };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { /* first run */ }

  const head = await rpc(() => provider.getBlock('latest'));
  const now = head.timestamp;
  const amountWei = ethers.utils.parseEther(String(o.amount));
  const maxLate = o.maxLate;
  const horizon = Math.max(o.horizon, ...o.points);
  const earlyPoints = o.earlyPoints || [];
  const earlyMaxLate = o.earlyMaxLate == null ? 180 : o.earlyMaxLate;
  // Every checkpoint with the lateness it allows.
  const longPoints = o.longPoints || [];
  const longStep = o.longStep || 3600;
  const longHorizon = Math.max(o.longHorizon || 0, ...longPoints, horizon);
  const isLong = (x) => x.verdict === 'SNIP' || String(x.verdict || '').startsWith('PASSED') || String(x.gate) === '6';
  const horizonOf = (x) => (isLong(x) ? longHorizon : horizon);
  const checks = [...earlyPoints.map((off) => ({ off, late: earlyMaxLate })), ...o.points.map((off) => ({ off, late: maxLate })),
    ...longPoints.map((off) => ({ off, late: longStep + maxLate, longOnly: true }))];
  // --early: only young tokens (every minute for --early-window, and long enough
  // to reach every early checkpoint).
  const earlyWindow = earlyPoints.length || o.earlyWindow ? Math.max(o.earlyWindow || 0, ...earlyPoints.map((x) => x + earlyMaxLate)) : 0;
  const early = !!o.early;
  if (early && !earlyWindow) { log('live --early: no --early-points, nothing to do'); return { added: 0, quoted: 0, watching: 0, state }; }

  // New tokens: the last two days of screens, screened within the horizon.
  let days = [];
  try { days = fs.readdirSync(o.screens).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().slice(-2); } catch (_) { /* none */ }
  const screens = readScreens(o.screens, { dates: days, modifiedSinceMs: early ? Date.now() - (earlyWindow + 300) * 1000 : 0 });
  let added = 0;
  for (const t of selectTokens(screens, { set: o.set })) {
    const r = t.j.record;
    const key = lc(r.token);
    if (state.tokens[key]) continue;
    const entryTs = Math.floor(Date.parse(r.screenedAt) / 1000);
    if (!Number.isFinite(entryTs) || now - entryTs > (early ? earlyWindow : horizon)) continue;
    if (!t.pool || (t.pool.base && !['ETH', 'WETH'].includes(t.pool.base))) continue;
    let tokens = gate3Tokens(t.j.detail);
    let source = tokens ? 'gate3' : null;
    if (!tokens && now - entryTs <= maxLate) {
      const b = await quote(provider, t.pool, 'buy', amountWei, head.number);
      if (b.out && b.out.gt(0)) { tokens = b.out; source = 'quoter at first run'; }
    }
    if (!tokens) continue; // stopped before Gate 3 and too late to quote a buy
    const d = t.j.detail || {};
    state.tokens[key] = {
      date: t.date, time: t.time, symbol: r.symbol, token: r.token, verdict: r.verdict, gate: r.gate == null ? null : String(r.gate),
      costPct: (d.roundTripJudgement && d.roundTripJudgement.costPct) ?? null, whaleRecovery: (r.rug && r.rug.whaleRecovery) ?? null,
      pool: t.pool, entryTs, tokensBought: tokens.toString(), entrySource: source,
      checkpoints: {}, first: null, last: null, peak: null, trough: null, samples: 0, status: 'watching',
    };
    added += 1;
  }

  // A long-follow token finished by an older version at 24 h is followed again.
  if (!early) for (const s of Object.values(state.tokens)) if (s.status === 'done' && isLong(s) && now - s.entryTs < longHorizon) s.status = 'watching';

  // Quote every token still inside its horizon.
  let quoted = 0;
  const sampleLines = [];
  for (const s of Object.values(state.tokens)) {
    if (s.status !== 'watching') continue;
    const age = now - s.entryTs;
    if (early && age > earlyWindow) continue;
    // Past the first day, a long-follow token is quoted hourly, not every run.
    if (!early && age > horizon && s.lastTs && now - s.lastTs < longStep - 120) continue;
    const lateFor = (off) => Math.round((age - off) / 60);
    const q = await quote(provider, s.pool, 'sell', BN(s.tokensBought), head.number);
    quoted += 1;
    if (o.delay) await sleep(o.delay);
    const v = q.out ? retPct(q.out, amountWei) : q.error === 'revert' ? -100 : null;
    const min = Math.round(age / 60);
    s.lastTs = now;
    sampleLines.push([new Date(now * 1000).toISOString(), s.token, s.symbol, s.verdict, s.gate, (age / 60).toFixed(1), v].map((x) => (x == null ? '' : /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x)).join(','));
    if (v != null) {
      s.samples += 1;
      if (!s.first) s.first = { v, min };
      s.last = { v, min };
      if (!s.peak || v > s.peak.v) s.peak = { v, min };
      if (!s.trough || v < s.trough.v) s.trough = { v, min };
    }
    for (const { off, late, longOnly } of checks) {
      if (longOnly && !isLong(s)) continue;
      const l = label(off);
      if (s.checkpoints[l] || age < off) continue;
      // The first run after the checkpoint records it; if no run came within
      // its allowed lateness (the job was stopped, or the minute job is not
      // installed), it is marked missed rather than filled with a later price.
      // A token first seen after an early checkpoint has passed is left blank
      // for that checkpoint (it was not watched then).
      if (s.samples <= 1 && age - off > late && earlyPoints.includes(off)) continue;
      s.checkpoints[l] = (age - off) <= late ? { v, lateMin: lateFor(off) } : { v: null, lateMin: lateFor(off), missed: true };
    }
    if (age >= horizonOf(s)) s.status = 'done';
  }

  if (early && !added && !quoted) return { added, quoted, watching: null, state }; // quiet minute: no write, no log line
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'lookback-live.csv'), liveCsv(state, o.points, earlyPoints, longPoints));
  if (sampleLines.length) {
    const sf = path.join(dir, 'samples.csv');
    if (!fs.existsSync(sf)) fs.writeFileSync(sf, 'time_utc,token,symbol,verdict,gate,age_min,ret_pct\n');
    fs.appendFileSync(sf, sampleLines.join('\n') + '\n');
  }
  const watching = Object.values(state.tokens).filter((x) => x.status === 'watching').length;
  log(`${new Date(now * 1000).toISOString()} ${early ? 'early' : 'live'}: block ${head.number}, ${added} new token(s), ${quoted} quoted, ${watching} watching, ${Object.keys(state.tokens).length} in total`);
  return { added, quoted, watching, state };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const a = argv.slice(2);
  const val = (flag, dflt) => { const i = a.indexOf(flag); return i >= 0 && a[i + 1] != null ? a[i + 1] : dflt; };
  return {
    probe: a.includes('--probe'),
    live: a.includes('--live'),
    early: a.includes('--early'),
    earlyPoints: val('--early-points', '2m,5m,10m,30m').split(',').map(parseDuration).filter((x) => x > 0),
    earlyWindow: parseDuration(val('--early-window', '1h')),
    longPoints: val('--long-points', '3d,7d').split(',').map(parseDuration).filter((x) => x > 0),
    longStep: parseDuration(val('--long-step', '1h')),
    longHorizon: parseDuration(val('--long-horizon', '7d')),
    earlyMaxLate: parseDuration(val('--early-max-late', '3m')),
    liveDir: val('--live-dir', path.join('extras', 'live')),
    maxLate: parseDuration(val('--max-late', '30m')),
    fresh: a.includes('--fresh'),
    set: val('--set', 'far'),
    sample: Number(val('--sample', 0)),
    seed: Number(val('--seed', 7)),
    dates: val('--dates', '') ? val('--dates', '').split(',').map((s) => s.trim()).filter(Boolean) : null,
    points: val('--points', '1h,6h,24h').split(',').map(parseDuration).filter((x) => x > 0),
    peakStep: parseDuration(val('--peak-step', '30m')),
    horizon: parseDuration(val('--horizon', '24h')),
    amount: val('--amount', '0.05'),
    out: val('--out', path.join('extras', 'lookback')),
    delay: Number(val('--delay', 40)),
    limit: Number(val('--limit', 0)),
    rpc: val('--rpc', process.env.LOOKBACK_RPC || config.RPC_URL),
    screens: val('--screens', path.join(ROOT, 'screens')),
  };
}

// --probe: can this RPC answer for old blocks? Quote the newest SNIP (or any
// token with a pool) at its screen block and at now.
async function probe(o, provider) {
  const clock = new BlockClock(provider);
  const head = await clock.head();
  console.log(`RPC ${o.rpc.replace(/\/\/([^/]{0,6})[^/]*@/, '//$1…@')}: head block ${head.number} at ${new Date(head.timestamp * 1000).toISOString()}`);
  const screens = readScreens(o.screens, { dates: o.dates });
  const pick = selectTokens(screens, { set: 'far' }).filter((t) => t.pool && t.pool.version === 'v4').reverse();
  const oldest = pick[pick.length - 1];
  const t = pick.find((x) => x.j.record.verdict === 'SNIP') || pick[0];
  if (!t) { console.log('no screened token with a v4 pool found under', o.screens); return 1; }
  const amountWei = ethers.utils.parseEther(String(o.amount));
  for (const s of [t, oldest].filter(Boolean)) {
    const ts = Math.floor(Date.parse(s.j.record.screenedAt) / 1000);
    const blk = await clock.at(ts);
    const b = await quote(provider, s.pool, 'buy', amountWei, blk);
    const hoursAgo = ((head.timestamp - ts) / 3600).toFixed(1);
    if (b.out) console.log(`  ${s.j.record.symbol} at block ${blk} (${hoursAgo} h ago): 0.05 ETH buys ${ethers.utils.formatUnits(b.out, 18)} — old state OK`);
    else { console.log(`  ${s.j.record.symbol} at block ${blk} (${hoursAgo} h ago): ${b.error}`); if (b.error === 'no-history') { console.log('\nThis RPC does not keep old state. That is fine: the past-tokens run measures "now" (entry amount from Gate 3),\nand --live (every 15 minutes) records +1h/+6h/+24h as they happen. An archive RPC (LOOKBACK_RPC in .env) would add the past +1h/+6h.'); return 1; } }
  }
  console.log(`\nOK: old blocks answer. ${clock.calls} block lookups used.`);
  return 0;
}

// inject.provider: for the offline end-to-end test only.
async function main(inject = {}) {
  const o = parseArgs(inject.argv || process.argv);
  const provider = inject.provider || new ethers.providers.StaticJsonRpcProvider(o.rpc, config.CHAIN_ID);
  if (o.probe) return probe(o, provider);
  if (o.live) { await liveRun(o, provider); return 0; }

  const jsonl = `${o.out}.jsonl`;
  const csv = `${o.out}.csv`;
  fs.mkdirSync(path.dirname(path.resolve(jsonl)), { recursive: true });
  if (o.fresh && fs.existsSync(jsonl)) fs.unlinkSync(jsonl);
  const done = new Map();
  if (fs.existsSync(jsonl)) {
    for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.set(lc(r.token), r); } catch (_) { /* skip */ }
    }
    // Rows that failed for a passing reason (a network error, an RPC without old
    // state) are tried again on the next run; their newer line replaces them.
    for (const [k, r] of done) {
      if (/^error|no history/.test(String(r.status))) done.delete(k);
    }
  }

  const screens = readScreens(o.screens, { dates: o.dates });
  let list = selectTokens(screens, { set: o.set, sample: o.sample, seed: o.seed });
  const todo = list.filter((t) => !done.has(lc(t.j.record.token)));
  const run = o.limit > 0 ? todo.slice(0, o.limit) : todo;
  console.log(`lookback: ${screens.length} screen files, ${list.length} tokens in set "${o.set}", ${done.size} already done, ${run.length} to score now`);
  console.log(`points ${o.points.map(label).join(', ')}; peak sample every ${o.peakStep ? label(o.peakStep) : '(off)'} over ${label(o.horizon)}; buy ${o.amount} ETH\n`);

  const clock = new BlockClock(provider);
  const amountWei = ethers.utils.parseEther(String(o.amount));
  let n = 0;
  let noHistory = 0;
  for (const t of run) {
    n += 1;
    let row;
    try {
      row = await scoreToken(t, { provider, clock, amountWei, points: o.points, peakStepSec: o.peakStep, horizonSec: o.horizon, delayMs: o.delay });
    } catch (e) {
      row = { date: t.date, time: t.time, symbol: t.j.record.symbol, token: t.j.record.token, verdict: t.j.record.verdict, gate: t.j.record.gate == null ? null : String(t.j.record.gate), returns: {}, status: `error: ${String(e.message || e).slice(0, 160)}`, notes: [] };
    }
    if (/no history/.test(row.status)) noHistory += 1;
    fs.appendFileSync(jsonl, JSON.stringify(row) + '\n');
    done.set(lc(row.token), row);
    const rt = row.returns || {};
    const f = (v) => (v == null ? '   -  ' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`.padStart(7));
    console.log(`[${String(n).padStart(3)}/${run.length}] ${String(row.symbol).slice(0, 12).padEnd(12)} ${String(row.verdict).slice(0, 16).padEnd(16)} ` +
      (/^ok/.test(String(row.status))
        ? row.status !== 'ok'
          ? `now:${f(rt.now)}  (${row.nowHoursAfter} h after the screen; entry from Gate 3)${row.liqDropPct != null && row.liqDropPct > 50 ? `  liquidity -${row.liqDropPct}%` : ''}`
          : `0:${f(rt['0'])} ${o.points.map((p) => `${label(p)}:${f(rt[label(p)])}`).join(' ')} now:${f(rt.now)} peak:${f(row.peakPct)}${row.liqDropPct != null && row.liqDropPct > 50 ? `  liquidity -${row.liqDropPct}%` : ''}`
        : row.status));
    if (noHistory >= 3 && n === noHistory) {
      console.log('\nThe first tokens all failed for lack of old state, and their files have no Gate 3 amount to fall back on. Stopping.');
      break;
    }
  }

  // Rebuild the CSV from every row we have, in screen order.
  const all = [...done.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  fs.writeFileSync(csv, csvOf(all, o.points));
  console.log(`\nwrote ${csv} (${all.length} tokens) and ${jsonl}`);
  console.log(`block lookups: ${clock.calls}`);

  const sum = summarise(all, o.points);
  if (sum.length) {
    console.log('\nScorecard (returns after both hook fees, before gas; "inProfit" = tokens above 0):');
    for (const s of sum) {
      const parts = o.points.map(label).map((l) => `${l} median ${s[`median_${l}`] == null ? '-' : `${s[`median_${l}`].toFixed(1)}%`} (${s[`inProfit_${l}`] || '-'} up)`);
      const nowPart = `now median ${s.medianNow == null ? '-' : `${s.medianNow.toFixed(1)}%`} (${s.inProfitNow || '-'} up, about ${s.medianHoursAfter == null ? '-' : Math.round(s.medianHoursAfter)} h after)`;
      console.log(`  ${s.group.padEnd(28)} ${String(s.tokens).padStart(4)} tokens   ${parts.join('   ')}   ${nowPart}   peak median ${s.medianPeak == null ? '-' : `${s.medianPeak.toFixed(1)}%`}`);
    }
  }
  return 0;
}

module.exports = { main, parseArgs, liveRun, liveCsv, gate3Tokens, parseDuration, BlockClock, readScreens, poolOf, selectTokens, quote, liquidityAt, scoreToken, csvOf, summarise, retPct, isNoHistory, isRevert };

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => { console.error('lookback failed:', e.message || e); process.exit(1); });
}
