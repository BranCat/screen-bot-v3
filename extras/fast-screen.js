// extras/fast-screen.js — FAST-SCREEN SHADOW, READ-ONLY. Added 2026-11-11.
//
// Question: can the same screening reach the same verdict in ~10-15 s instead of ~1 min?
//
// This script runs BESIDE the bot. It never edits a bot file, never restarts the bot and
// never changes a verdict the bot writes. It reads the bot's detections.jsonl, and for
// each new token it runs the bot's own screen() from screen-token.js — the same gates,
// the same order, the same thresholds — with two changes that only affect WHEN the work
// is done:
//
//   1. Log scans start at the pool's creation block. Gate 1b (and the Gate 6 census)
//      read the pool's events over the last 200,000 blocks in 10,000-block chunks
//      (~17 s). The watcher already knows the block where the pool was created, and a
//      pool cannot have events before it exists (v4: ModifyLiquidity needs Initialize;
//      v3: the pool contract does not exist yet). So a request for those events that
//      ends before the creation block is answered "none" without asking the RPC, and
//      one that starts before it is started at it. Same events, far fewer requests.
//
//   2. After sim #1, the next four checks are started together. Sim #2, the Gate 5b
//      transfer audit, the Gate 5c allowance probe and the Gate 6 rug check need only
//      sim #1's result (its pinned block, tokens received, share sold) and the
//      Gate 1b result. They are started as soon as sim #1 returns. screen() still asks
//      for them one at a time, in the original order, and gets the result that was
//      started early — but only if it asks with the same inputs (checked field by
//      field). Otherwise it runs the check normally ("prefetch miss"). The first gate
//      that fails still decides the verdict, exactly as in the bot.
//
// Known difference, recorded rather than hidden: sim #2 and Gate 5c choose their own
// block when they start. Started early, they can see a block a few seconds earlier than
// the bot's would. Each record keeps those blocks so a verdict difference can be traced.
//
// Cost: every token is screened a second time, so Tenderly simulations roughly double
// (agreed 11 Nov). A token that fails at sim #2 or later also spends the early-started
// checks (counted as "wasted" in each record). One token is screened at a time, and the
// next waits until every started check has finished, so the shadow adds at most 4
// Tenderly calls at once. Explorer: about 1-2 extra requests per screened token.
//
// Run on the server, as the bot's user, in the background:
//   cd /home/botuser/bot-v3
//   sudo -u botuser nohup node extras/fast-screen.js > extras/fast/run.out 2>&1 &
// Stop:  pkill -f extras/fast-screen.js
// Options:  --hours 120 (stops by itself; default 120)   --detections detections.jsonl
//
// Compare with the bot (any time, read-only):
//   sudo -u botuser node extras/fast-screen.js --compare            (all shadow records)
//   sudo -u botuser node extras/fast-screen.js --compare --since 2026-11-11
//
// Output (folder extras/fast/, created if missing):
//   fast-screen.jsonl   one line per shadow screen: token, trigger, verdict, gate, seconds,
//                       per-check timings, prefetch hits/misses/wasted, pinned blocks
//   screens/<date>/<hhmmss>_<token>.txt   the full gate-by-gate output of that screen
//   fast-screen.log     one line per event (start, finish, errors)
//   compare.csv         written by --compare

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'fast');

const lc = (s) => String(s || '').toLowerCase();
const BLOCKS_PER_SEC = 10;                                     // as controller-check.js / watch-launches.js
const CONTROLLER_FRESH_WINDOW_BLOCKS = 5 * 3600 * BLOCKS_PER_SEC; // as watch-launches.js
const V4_LOOKBACK_BLOCKS = 200000;                             // as screen-token.js

// ---------------------------------------------------------------- 1. creation-block clamp
// Wraps an ethers v5 provider. Only getLogs is changed, and only for this pool's own
// events: address = the v3 pool, or address = the v4 PoolManager with topic[1] = poolId.
// Everything else (calls, blocks, other contracts' logs) passes through untouched.
function asBlockNumber(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x)) return parseInt(x, 16);
  if (typeof x === 'string' && /^\d+$/.test(x)) return Number(x);
  return null; // 'latest', undefined, … — not clamped
}

function isPoolFilter(f, pool, pmAddr) {
  if (!f || !pool) return false;
  if (pool.version === 'v3' && pool.poolAddress) return lc(f.address) === lc(pool.poolAddress);
  if (pool.version === 'v4' && pool.poolId) {
    return lc(f.address) === lc(pmAddr) && Array.isArray(f.topics) && lc(f.topics[1]) === lc(pool.poolId);
  }
  return false;
}

function clampProvider(base, { pool, createdBlock, pmAddr }) {
  const stats = { skipped: 0, clamped: 0, passed: 0 };
  const cb = asBlockNumber(createdBlock);
  const getLogs = async (f) => {
    if (cb != null && isPoolFilter(f, pool, pmAddr)) {
      const from = asBlockNumber(f.fromBlock);
      const to = asBlockNumber(f.toBlock);
      if (to != null && to < cb) { stats.skipped += 1; return []; }
      if (from != null && from < cb) { stats.clamped += 1; return base.getLogs({ ...f, fromBlock: cb }); }
    }
    stats.passed += 1;
    return base.getLogs(f);
  };
  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop === 'getLogs') return getLogs;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { provider: proxy, stats };
}

// ---------------------------------------------------------------- 2. early start after sim #1
// keys: what must be identical for an early-started result to stand in for the real call.
const str = (x) => (x == null ? null : String(x));
const auditKey = (o) => JSON.stringify({ amountEth: str(o.amountEth), pinnedBlock: str(o.pinnedBlock) });
const allowKey = (o) => JSON.stringify({ amountEth: str(o.amountEth), sourceSubject: lc(o.sourceSubject), pool: lc((o.p && (o.p.poolId || o.p.poolAddress)) || '') });
const rugKey = (o) => JSON.stringify({
  pinnedBlock: str(o.pinnedBlock),
  baseAmountWei: str(o.baseAmountWei),
  baselineTokenOutWei: str(o.baselineTokenOutWei),
  startSellBps: str(o.startSellBps),
  controller: o.controller ? { verdict: o.controller.verdict, reason: o.controller.reason } : null,
  lookbackBlocks: str(o.lookbackBlocks),
});
const rtKey = (o) => JSON.stringify({ amountEth: str(o.amountEth) });

// base: the real checks { walletRoundTrip, transferAudit, allowanceProbe, rugCheck,
//        sourceGate, controllerCheck, … }
// ctx:  { token, pool, amountEth, provider, addr, createdBlock, freshAddress, parseEther,
//         BigNumber, getHead }
function fastDeps(base, ctx) {
  const t0 = Date.now();
  const timings = [];
  const pre = {};            // name -> { key, promise, used }
  const counts = { hits: 0, misses: 0, wasted: 0 };
  const pins = {};
  let src = null;
  let ctl = null;
  let rtCalls = 0;

  const timed = (name, fn) => async (...a) => {
    const e = { check: name, startMs: Date.now() - t0, endMs: null };
    timings.push(e);
    try { return await fn(...a); } finally { e.endMs = Date.now() - t0; }
  };
  const settle = (p) => { p.catch(() => {}); return p; };   // never an unhandled rejection

  function startEarly(rt1) {
    const discover = async () => ctx.pool;
    const prov = ctx.provider;
    const amountEth = ctx.amountEth;
    pre.rt2 = { key: rtKey({ amountEth }), used: false,
      promise: settle(timed('sim #2 (early)', base.walletRoundTrip)(ctx.token, { wallet: ctx.freshAddress(), amountEth, prov, discover })) };
    const auditOpts = { wallet: ctx.freshAddress(), amountEth, prov, discover, pinnedBlock: (rt1.pinnedBlock != null) ? rt1.pinnedBlock : null };
    pre.audit = { key: auditKey(auditOpts), used: false,
      promise: settle(timed('5b audit (early)', base.transferAudit)(ctx.token, auditOpts)) };
    const allowOpts = { p: ctx.pool, amountEth, prov, sourceSubject: (src && src.verificationSubject) || ctx.token };
    pre.allow = { key: allowKey(allowOpts), used: false,
      promise: settle(timed('5c allowance (early)', base.allowanceProbe)(ctx.token, allowOpts)) };
    if (rt1.tokensReceivedWei && ctl) {
      const rugOpts = {
        provider: prov,
        pinnedBlock: (rt1.pinnedBlock != null) ? rt1.pinnedBlock : null,
        baseAmountWei: ctx.parseEther(String(amountEth)),
        baselineTokenOutWei: ctx.BigNumber.from(rt1.tokensReceivedWei),
        startSellBps: rt1.soldBps || 10000,
        controller: { verdict: ctl.verdict, reason: ctl.reason },
        lookbackBlocks: ctx.rugLookback,
      };
      pre.rug = { key: rugKey(rugOpts), used: false,
        promise: settle(timed('6 rug (early)', base.rugCheck)(ctx.pool, ctx.addr, rugOpts)) };
    }
  }

  function take(name, key, run) {
    const e = pre[name];
    if (e && !e.used && e.key === key) { e.used = true; counts.hits += 1; return e.promise; }
    counts.misses += 1;
    return run();
  }

  const deps = {
    provider: ctx.provider,
    sourceGate: timed('0 source', async (...a) => { src = await base.sourceGate(...a); return src; }),
    controllerCheck: timed('1b controller', async (...a) => { ctl = await base.controllerCheck(...a); return ctl; }),
    measureLiquidity: timed('2 liquidity', base.measureLiquidity),
    changeCheck: timed('change check', base.changeCheck),
    walletRoundTrip: async (token, o = {}) => {
      rtCalls += 1;
      if (rtCalls === 1) {
        const r = await timed('3 sim #1', base.walletRoundTrip)(token, o);
        pins.sim1 = r && r.pinnedBlock != null ? r.pinnedBlock : null;
        if (r && r.ok) startEarly(r);
        return r;
      }
      const r = await take('rt2', rtKey(o), () => timed('4 sim #2', base.walletRoundTrip)(token, o));
      pins.sim2 = r && r.pinnedBlock != null ? r.pinnedBlock : null;
      return r;
    },
    transferAudit: (token, o = {}) => take('audit', auditKey(o), () => timed('5b audit', base.transferAudit)(token, o)),
    allowanceProbe: async (token, o = {}) => {
      const r = await take('allow', allowKey(o), () => timed('5c allowance', base.allowanceProbe)(token, o));
      pins.allowance = r && r.pinnedBlock != null ? r.pinnedBlock : (r && r.block != null ? r.block : null);
      return r;
    },
    rugCheck: (p, addr, o = {}) => take('rug', rugKey(o), () => timed('6 rug', base.rugCheck)(p, addr, o)),
  };
  if (base.templateMatch) deps.templateMatch = timed('0 template', base.templateMatch);

  // After screen() returns: wait for every early-started check, count the unused ones.
  async function drain() {
    const all = Object.values(pre);
    await Promise.allSettled(all.map((e) => e.promise));
    counts.wasted = all.filter((e) => !e.used).length;
  }

  return { deps, timings, counts, pins, drain, started: () => Object.keys(pre) };
}

// ---------------------------------------------------------------- pool from a detection
// Rebuilds the pool descriptor exactly as watch-launches.js registerV3 / registerV4 does.
function baseOf(addr, ADDR) {
  const a = lc(addr);
  if (a === lc(ADDR.ZERO)) return 'ETH';
  if (a === lc(ADDR.WETH)) return 'WETH';
  if (ADDR.USDG && a === lc(ADDR.USDG)) return 'USDG';
  return null;
}
function pickToken(a0, a1, ethers, ADDR) {
  const b0 = baseOf(a0, ADDR);
  const b1 = baseOf(a1, ADDR);
  if (b0 && !b1) return { tokenAddr: ethers.utils.getAddress(a1), base: b0, baseAddr: a0, baseIs0: true };
  if (b1 && !b0) return { tokenAddr: ethers.utils.getAddress(a0), base: b1, baseAddr: a1, baseIs0: false };
  return null;
}

async function poolFromDetection(ev, { provider, ethers, ADDR }) {
  if (ev.version === 'v4') {
    const pm = new ethers.utils.Interface([
      'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    ]);
    const logs = await provider.getLogs({
      address: ADDR.UNIV4_POOL_MANAGER, topics: [pm.getEventTopic('Initialize'), ev.pool],
      fromBlock: Number(ev.createdBlock), toBlock: Number(ev.createdBlock),
    });
    if (!logs.length) throw new Error(`no Initialize for ${ev.pool} at block ${ev.createdBlock}`);
    const a = pm.parseLog(logs[0]).args;
    const picked = pickToken(a.currency0, a.currency1, ethers, ADDR);
    if (!picked) throw new Error(`pool ${ev.pool} has no ETH/WETH/USDG side`);
    const pairName = picked.base === 'ETH' ? 'native ETH' : picked.base;
    return {
      version: 'v4', tokenAddr: picked.tokenAddr, base: picked.base, baseAddr: picked.baseAddr,
      fee: a.fee, poolId: a.id, hooks: a.hooks,
      poolKey: { currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks },
      label: `v4 ${a.id.slice(0, 10)}… (${pairName} pair, fee ${a.fee}, hooks ${lc(a.hooks) === lc(ADDR.ZERO) ? 'none' : a.hooks})`,
    };
  }
  if (ev.version === 'v3') {
    const baseAddr = ev.base === 'WETH' ? ADDR.WETH : ev.base === 'USDG' ? ADDR.USDG : null;
    if (!baseAddr) throw new Error(`v3 pool with base ${ev.base}`);
    return {
      version: 'v3', tokenAddr: ethers.utils.getAddress(ev.token), base: ev.base, baseAddr,
      fee: Number(ev.fee), poolAddress: ev.pool, label: `v3 ${ev.pool} (${ev.base} pair, fee ${ev.fee})`,
    };
  }
  throw new Error(`unknown pool version ${ev.version}`);
}

// ---------------------------------------------------------------- one shadow screen
async function screenOne(item, env) {
  const { ethers, ADDR, provider, screen, base, log } = env;
  const ev = item.launched;
  const startedAt = new Date();
  const out = {
    token: ethers.utils.getAddress(ev.token), trigger: item.trigger,
    launchBlock: ev.block, createdBlock: ev.createdBlock, detectionAt: item.at || null,
    seenAt: item.seenAt, startedAt: startedAt.toISOString(), finishedAt: null,
    seconds: null, verdict: null, gate: null, reason: null,
    timings: [], prefetch: null, getLogs: null, pins: null, error: null,
  };
  const lines = [];
  const origLog = console.log;
  try {
    const pool = await poolFromDetection(ev, { provider, ethers, ADDR });
    const head = await provider.getBlockNumber();
    const age = head - Number(ev.createdBlock);
    const controllerOpts = {};
    if (age > CONTROLLER_FRESH_WINDOW_BLOCKS) {
      const b = await provider.getBlock(Number(ev.createdBlock));
      if (b) controllerOpts.aroundTime = b.timestamp * 1000;
    }
    const clamp = clampProvider(provider, { pool, createdBlock: ev.createdBlock, pmAddr: ADDR.UNIV4_POOL_MANAGER });
    const fast = fastDeps(base, {
      token: pool.tokenAddr, pool, amountEth: env.amountEth, provider: clamp.provider, addr: ADDR,
      freshAddress: () => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20))),
      parseEther: ethers.utils.parseEther, BigNumber: ethers.BigNumber,
      rugLookback: age > V4_LOOKBACK_BLOCKS ? age + 1000 : V4_LOOKBACK_BLOCKS,
    });
    const hiddenSource = item.trigger === 'launched' ? 'probe' : 'final';
    const t0 = Date.now();
    console.log = (...a) => { lines.push(a.map(String).join(' ')); };
    let r;
    try {
      r = await screen(pool.tokenAddr, { pool, amountEth: env.amountEth, minLiqEth: env.minLiqEth, controllerOpts, hiddenSource, deps: fast.deps });
    } catch (e) {
      r = { verdict: 'UNKNOWN', reason: `screener error: ${e.message}`, flags: [] };
    } finally {
      console.log = origLog;
    }
    const ms = Date.now() - t0;
    await fast.drain();
    Object.assign(out, {
      finishedAt: new Date(t0 + ms).toISOString(), seconds: Math.round(ms / 100) / 10,
      verdict: r.verdict, gate: r.gate ?? null, reason: r.reason,
      timings: fast.timings, prefetch: { started: fast.started(), ...fast.counts },
      getLogs: clamp.stats, pins: fast.pins,
    });
  } catch (e) {
    console.log = origLog;
    out.error = String(e && e.message || e).slice(0, 300);
    out.finishedAt = new Date().toISOString();
  }
  const day = out.startedAt.slice(0, 10);
  const dir = path.join(env.outDir, 'screens', day);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const hms = out.startedAt.slice(11, 19).replace(/:/g, '');
    fs.writeFileSync(path.join(dir, `${hms}_${out.token}.txt`), lines.join('\n') + '\n');
  } catch (_) { /* the jsonl line below is what matters */ }
  fs.appendFileSync(path.join(env.outDir, 'fast-screen.jsonl'), JSON.stringify(out) + '\n');
  log(`${out.trigger} ${out.token} -> ${out.verdict || 'ERROR'} gate ${out.gate ?? '-'} in ${out.seconds ?? '-'} s` +
    (out.prefetch ? ` (early: ${out.prefetch.hits} used, ${out.prefetch.misses} miss, ${out.prefetch.wasted} wasted; logs skipped ${out.getLogs.skipped})` : '') +
    (out.error ? ` ERROR ${out.error}` : ''));
  return out;
}

// ---------------------------------------------------------------- detections.jsonl reader
// Pure: given new text and the carried-over partial line, returns parsed events.
function splitLines(carry, chunk) {
  const text = carry + chunk;
  const parts = text.split('\n');
  const rest = parts.pop();
  const events = [];
  for (const line of parts) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch (_) { /* damaged line */ }
  }
  return { events, rest };
}

// Turns detection events into shadow work items. launchedByToken is updated in place.
function itemsFrom(events, launchedByToken, seenAt) {
  const items = [];
  for (const e of events) {
    if (e.event === 'launched' && e.token) {
      launchedByToken.set(lc(e.token), e);
      items.push({ trigger: 'launched', launched: e, at: e.at || null, seenAt });
    } else if (e.event === 'source_found' && e.token) {
      const l = launchedByToken.get(lc(e.token));
      if (l) items.push({ trigger: 'source_found', launched: l, at: e.at || null, seenAt });
    }
  }
  return items;
}

// ---------------------------------------------------------------- --compare
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// bot: launches.jsonl records; shadow: fast-screen.jsonl records.
// A bot record with sourceRecheck is the screen after the source appeared (shadow trigger
// source_found); without it, the screen at launch (shadow trigger launched).
function compare(botRecords, shadowRecords) {
  const bot = new Map();
  for (const b of botRecords) {
    if (!b || !b.token) continue;
    const trig = b.sourceRecheck && b.sourceRecheck.foundOnCheck != null ? 'source_found' : 'launched';
    bot.set(`${lc(b.token)}|${trig}`, b);
  }
  const rows = [];
  for (const s of shadowRecords) {
    if (!s || !s.token) continue;
    const b = bot.get(`${lc(s.token)}|${s.trigger}`);
    const row = {
      token: s.token, symbol: b ? b.symbol : null, trigger: s.trigger,
      botVerdict: b ? b.verdict : null, botGate: b ? b.gate ?? null : null, botSec: b ? b.screenSeconds ?? null : null,
      fastVerdict: s.verdict, fastGate: s.gate ?? null, fastSec: s.seconds,
      match: null, note: '',
    };
    if (s.error) { row.match = 'error'; row.note = s.error; }
    else if (s.verdict === 'SOURCE PENDING') { row.match = 'pending'; row.note = 'source not yet published at launch (the bot waits too; compare its later screen)'; }
    else if (!b) { row.match = 'no bot record'; row.note = 'bot record not written yet, or held'; }
    else if (b.verdict === s.verdict && String(b.gate ?? '') === String(s.gate ?? '')) row.match = 'same';
    else row.match = 'DIFFERENT';
    if (row.match === 'DIFFERENT' && s.pins) row.note = `fast blocks sim1 ${s.pins.sim1} sim2 ${s.pins.sim2}`;
    rows.push(row);
  }
  const done = rows.filter((r) => r.match === 'same' || r.match === 'DIFFERENT');
  const summary = {
    compared: done.length,
    same: rows.filter((r) => r.match === 'same').length,
    different: rows.filter((r) => r.match === 'DIFFERENT').length,
    pending: rows.filter((r) => r.match === 'pending').length,
    noBotRecord: rows.filter((r) => r.match === 'no bot record').length,
    errors: rows.filter((r) => r.match === 'error').length,
    medianBotSec: median(done.map((r) => Number(r.botSec))),
    medianFastSec: median(done.map((r) => Number(r.fastSec))),
    snip: (() => {
      const sn = done.filter((r) => r.botVerdict === 'SNIP');
      return { count: sn.length, medianBotSec: median(sn.map((r) => Number(r.botSec))), medianFastSec: median(sn.map((r) => Number(r.fastSec))) };
    })(),
  };
  return { rows, summary };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip */ }
  }
  return out;
}

function runCompare(args) {
  const i = args.indexOf('--since');
  const since = i >= 0 ? args[i + 1] : null;
  let shadow = readJsonl(path.join(OUT_DIR, 'fast-screen.jsonl'));
  if (since) shadow = shadow.filter((s) => String(s.startedAt) >= since);
  const bot = readJsonl(path.join(ROOT, 'launches.jsonl'));
  const { rows, summary } = compare(bot, shadow);
  const cols = ['token', 'symbol', 'trigger', 'botVerdict', 'botGate', 'botSec', 'fastVerdict', 'fastGate', 'fastSec', 'match', 'note'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'compare.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n');
  for (const r of rows) {
    console.log(`${String(r.symbol || r.token.slice(0, 10)).padEnd(12)} ${r.trigger.padEnd(13)} bot ${String(r.botVerdict ?? '-').padEnd(17)} g${String(r.botGate ?? '-').padEnd(3)} ${String(r.botSec ?? '-').padStart(4)} s | fast ${String(r.fastVerdict ?? '-').padEnd(17)} g${String(r.fastGate ?? '-').padEnd(3)} ${String(r.fastSec ?? '-').padStart(5)} s | ${r.match}${r.note ? ' — ' + r.note : ''}`);
  }
  const s = summary;
  console.log(`\ncompare: ${s.compared} compared, ${s.same} same, ${s.different} DIFFERENT; ${s.pending} pending, ${s.noBotRecord} without bot record, ${s.errors} errors`);
  console.log(`median screen time: bot ${s.medianBotSec ?? '-'} s, fast ${s.medianFastSec ?? '-'} s; SNIPs (${s.snip.count}): bot ${s.snip.medianBotSec ?? '-'} s, fast ${s.snip.medianFastSec ?? '-'} s`);
  console.log(`details: ${path.join(OUT_DIR, 'compare.csv')}`);
}

// ---------------------------------------------------------------- main loop
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--compare')) return runCompare(args);
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
  const hours = Number(flag('--hours', 120));
  const detectFile = path.resolve(ROOT, flag('--detections', 'detections.jsonl'));

  process.chdir(ROOT); // the bot's modules read .env and launches.jsonl relative to its folder
  require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
  const ethers = require(path.join(ROOT, 'node_modules', 'ethers'));
  const config = require(path.join(ROOT, 'config'));
  const { screen } = require(path.join(ROOT, 'screen-token'));
  const base = {
    sourceGate: require(path.join(ROOT, 'source-gate')).sourceGate,
    controllerCheck: require(path.join(ROOT, 'controller-check')).controllerCheck,
    measureLiquidity: require(path.join(ROOT, 'screen-token')).measureLiquidity,
    rugCheck: require(path.join(ROOT, 'rug-check')).rugCheck,
    walletRoundTrip: (...a) => require(path.join(ROOT, 'wallet-round-trip')).walletRoundTrip(...a),
    transferAudit: (...a) => require(path.join(ROOT, 'transfer-audit')).transferAudit(...a),
    allowanceProbe: (...a) => require(path.join(ROOT, 'allowance-probe')).allowanceProbe(...a),
    changeCheck: (...a) => require(path.join(ROOT, 'change-check')).changeCheck(...a),
  };
  const provider = new ethers.providers.JsonRpcProvider(config.RPC_URL);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(config.CHAIN_ID)) throw new Error(`RPC is chain ${net.chainId}, expected ${config.CHAIN_ID}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logFile = path.join(OUT_DIR, 'fast-screen.log');
  const origLog = console.log;
  const log = (m) => { const l = `${new Date().toISOString()} ${m}`; origLog(l); try { fs.appendFileSync(logFile, l + '\n'); } catch (_) {} };
  const env = { ethers, ADDR: config.ADDR, provider, screen, base, log, outDir: OUT_DIR, amountEth: 0.05, minLiqEth: 1 };

  // Index every launch already in the file (for source_found later), then follow new lines only.
  const launchedByToken = new Map();
  let offset = 0;
  let carry = '';
  if (fs.existsSync(detectFile)) {
    const text = fs.readFileSync(detectFile, 'utf8');
    itemsFrom(splitLines('', text).events, launchedByToken, null);
    offset = Buffer.byteLength(text);
  }
  log(`fast-screen started: following ${detectFile} from byte ${offset}; ${launchedByToken.size} launches indexed; stops after ${hours} h`);

  const queue = [];
  let busy = false;
  const stopAt = Date.now() + hours * 3600 * 1000;
  async function work() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try { await screenOne(item, env); } catch (e) { log(`ERROR ${item.launched.token}: ${e.message}`); }
      }
    } finally { busy = false; }
  }
  function poll() {
    try {
      const size = fs.statSync(detectFile).size;
      if (size < offset) { offset = 0; carry = ''; log('detections file shrank — reading it from the start'); }
      if (size > offset) {
        const fd = fs.openSync(detectFile, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;
        const { events, rest } = splitLines(carry, buf.toString('utf8'));
        carry = rest;
        const items = itemsFrom(events, launchedByToken, new Date().toISOString());
        for (const it of items) { log(`queued ${it.trigger} ${it.launched.token}`); queue.push(it); }
        if (items.length) work();
      }
    } catch (e) { log(`poll error: ${e.message}`); }
    if (Date.now() > stopAt) {
      log(`stopping after ${hours} h`);
      const wait = setInterval(() => { if (!busy && !queue.length) { clearInterval(wait); process.exit(0); } }, 2000);
      return;
    }
    setTimeout(poll, 1000);
  }
  poll();
}

module.exports = { clampProvider, isPoolFilter, fastDeps, poolFromDetection, splitLines, itemsFrom, compare, median, auditKey, allowKey, rugKey };

if (require.main === module) {
  main().catch((e) => { console.error(`fast-screen: ${e.message}`); process.exit(1); });
}
