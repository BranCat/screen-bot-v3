// extras/verify-ready.js — INDEPENDENT CHECK of ready-times.js. READ-ONLY. Added 2026-11-09.
//
// The question: is the tradable time that ready-times.js recorded for a token really
// the moment it could first be traded? This script does not trust the bot. For each
// token it reads, straight from the chain and the explorer:
//   - pool created   v4 Initialize / v3 pool Initialize event
//   - first money    first liquidity added (v4 ModifyLiquidity > 0 / v3 Mint)
//   - pool live      the bot's launch block (liquidity reached the bot's minimum), re-read
//   - code published the explorer's verified_at, asked again
//   - first trades   the first Swap in the pool, and the first Swap after the code was published
// and compares them with the recorded tradable_utc.
//
// Verdicts (one per token):
//   AGREES        recorded time = max(pool live, code published) within --tol seconds,
//                 and no trade happened before the pool was live
//   CHECK         a difference worth looking at (printed with the reason): e.g. trades
//                 before the bot's launch block (the pool was tradable with less money
//                 than the bot's minimum), or a recorded time that differs from the chain
//   INCOMPLETE    something could not be read (no pool in the screen file, RPC error...)
// Trades BEFORE the code was published are normal for "trades first" tokens (other
// people trade without the code) and are reported, not flagged.
//
// 2026-11-10:
//   - Code time: the explorer's verified_at can be earlier than the moment the source
//     could really be read. Like ready-times.js, the explorer time (asked again here) is
//     checked against the bot's own "not published" / "found" checks in the screen
//     file (ready-times.js codeBounds/codeTime). When the explorer time is early, that
//     is NOT a fault of the record: the result stays AGREES and the reason says
//     "explorer time N s early (corrected from the bot's checks)". So for trades-first
//     tokens the code time is a consistency check, not an independent one; the pool,
//     liquidity and trade times are read from the chain.
//   - Sourcify: a code time earlier than the explorer's (the bot saw it on Sourcify, or
//     a twin match) is accepted, as in the bot.
//   - A trade before the launch block is flagged only if the code was already published
//     then (LIT). Liquidity added before the launch block is reported, not flagged.
//   - Dates in the table; --days N; every run is merged into <out>-all.csv / .jsonl
//     (one row per token, newest check kept), which keeps first liquidity and first
//     trade for every checked token.
//
//   node extras/verify-ready.js --sample 20            20 random recorded tokens (fixed seed)
//   node extras/verify-ready.js --since 2026-11-09     every token recorded from that date
//   node extras/verify-ready.js --tokens 0xA,0xB       these tokens
//   node extras/verify-ready.js --days 2               tokens recorded in the last 2 days (daily cron)
//   [--verdicts SNIP,6] [--back 6h] [--tol 2] [--seed 7] [--out extras/ready/verify]
//
// Cost: about 25-40 RPC getLogs calls and one explorer request per token.
// Output: a line per token on screen, and <out>.csv.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) { /* optional */ }
const RT = require('./ready-times');

const lc = (a) => String(a || '').toLowerCase();
const tsOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.round(t / 1000) : null; };
const isoOf = (sec) => (sec == null ? '' : new Date(sec * 1000).toISOString().replace('.000Z', 'Z'));
const CHUNK = 10000; // the public RPC accepts 10k-block getLogs ranges (as in watch-launches.js)
const BLOCKS_PER_SEC = 10;

// Event topics (same signatures as watch-launches.js / controller-check.js).
function topics() {
  const { ethers } = require('ethers');
  const v4 = new ethers.utils.Interface([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ]);
  const v3 = new ethers.utils.Interface([
    'event Initialize(uint160 sqrtPriceX96, int24 tick)',
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ]);
  return {
    v4: { init: v4.getEventTopic('Initialize'), liq: v4.getEventTopic('ModifyLiquidity'), swap: v4.getEventTopic('Swap'), iface: v4 },
    v3: { init: v3.getEventTopic('Initialize'), liq: v3.getEventTopic('Mint'), swap: v3.getEventTopic('Swap'), iface: v3 },
  };
}

function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) throw new Error(`bad duration "${s}"`);
  return Math.round(Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's').toLowerCase()]);
}

// The pool of a screen file, in the shape needed here (from lookback.js's poolOf).
function poolOf(j, ADDR) {
  const r = j.record || {};
  const p = (j.detail && j.detail.pool) || null;
  if (!p) return null;
  if (p.version === 'v4' && (p.poolId || r.poolId)) return { version: 'v4', address: ADDR.UNIV4_POOL_MANAGER, id: p.poolId || r.poolId };
  if (p.version === 'v3' && (p.poolAddress || r.poolAddress)) return { version: 'v3', address: p.poolAddress || r.poolAddress, id: null };
  return null;
}

// All pool events of interest in [from, to], oldest first. One OR-filter per chunk.
async function poolEvents(getLogs, pool, T, from, to, { stopAtSwapAfterBlock = null } = {}) {
  const t = T[pool.version];
  const filter = { address: pool.address, topics: pool.version === 'v4' ? [[t.init, t.liq, t.swap], pool.id] : [[t.init, t.liq, t.swap]] };
  const out = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(to, a + CHUNK - 1);
    const logs = await getLogs({ ...filter, fromBlock: a, toBlock: b });
    for (const l of logs) {
      const kind = l.topics[0] === t.init ? 'init' : l.topics[0] === t.swap ? 'swap' : 'liq';
      let add = true;
      if (kind === 'liq' && pool.version === 'v4') {
        try { add = t.iface.parseLog(l).args.liquidityDelta.gt(0); } catch (_) { add = true; }
      }
      if (add) out.push({ kind, block: Number(l.blockNumber), logIndex: Number(l.logIndex || 0) });
    }
    if (stopAtSwapAfterBlock != null && out.some((e) => e.kind === 'swap' && e.block >= stopAtSwapAfterBlock)) break;
  }
  return out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
}

// The check for one token. rec = the ready-times row; screen = its screen file (parsed).
async function verifyOne(rec, screen, { getLogs, blockTime, head, get, ADDR, T, backSec, tol }) {
  const res = {
    date: rec.date, time: rec.time, symbol: rec.symbol, token: rec.token, verdict: rec.verdict, case: rec.case,
    recorded_tradable_utc: rec.tradable_utc, pool_created_utc: '', first_liquidity_utc: '', pool_live_utc: '',
    code_published_utc: '', code_explorer_utc: '', explorer_early_s: null, chain_tradable_utc: '', first_swap_utc: '', first_swap_after_code_utc: '',
    diff_s: null, result: 'INCOMPLETE', reason: '',
  };
  const pool = screen ? poolOf(screen, ADDR) : null;
  if (!pool) { res.reason = 'no pool in the screen file'; return res; }
  const L = Number(rec.launch_block);
  if (!Number.isFinite(L)) { res.reason = 'no launch block'; return res; }

  try {
    const live = await blockTime(L);
    res.pool_live_utc = isoOf(live);

    // Code published: ask the explorer again (independent of the stored value), then
    // hold it against the bot's own checks from the screen file (not from the record).
    const subject = (screen.detail && screen.detail.source && screen.detail.source.verificationSubject) || rec.token;
    const sr = screen.record || {};
    const rc = sr.sourceRecheck || null;
    const detected = tsOf(sr.detectedAt);
    const hidden = !!(sr.sourceHidden || (rc && rc.hiddenAtLaunch));
    const bounds = !hidden ? { lb: null, ub: detected } : RT.codeBounds(rc, detected);
    let exAt = null;
    if (get) {
      const v = await RT.verifiedAt(subject, get);
      if (v.at != null) exAt = v.at; else res.reason = v.note;
    }
    res.code_explorer_utc = isoOf(exAt);
    let code = null;
    if (exAt != null || bounds.ub != null) {
      const ct = RT.codeTime({ ex: exAt, lb: bounds.lb, ub: bounds.ub });
      code = ct.code;
      if (ct.early != null) { res.explorer_early_s = ct.early; res.reason = (res.reason ? res.reason + '; ' : '') + `explorer time ${ct.early} s early (corrected from the bot's checks)`; }
      if (exAt != null && ct.from.startsWith('bot (earlier')) res.reason = (res.reason ? res.reason + '; ' : '') + `code seen by the bot ${exAt - code} s before the explorer's stamp (Sourcify or twin)`;
    }
    if (code == null && rec.code_published_utc) { code = tsOf(rec.code_published_utc); res.reason = (res.reason ? res.reason + '; ' : '') + 'code time from the record'; }
    res.code_published_utc = isoOf(code);

    // Events: from --back before the launch block to the first swap after both the launch
    // and the code (capped at 24 h after launch).
    const back = Math.max(1, L - backSec * BLOCKS_PER_SEC);
    const codeBlockGuess = code != null && code > live ? L + (code - live) * BLOCKS_PER_SEC : L;
    const to = Math.min(head, Math.max(L, codeBlockGuess) + 3600 * BLOCKS_PER_SEC, L + 86400 * BLOCKS_PER_SEC);
    const ev = await poolEvents(getLogs, pool, T, back, to, { stopAtSwapAfterBlock: Math.max(L, codeBlockGuess) });

    const first = (k, pred = () => true) => ev.find((e) => e.kind === k && pred(e));
    const init = first('init'); const liq = first('liq'); const swap = first('swap');
    if (init) res.pool_created_utc = isoOf(await blockTime(init.block));
    else res.reason = (res.reason ? res.reason + '; ' : '') + `pool creation not within ${Math.round(backSec / 3600)} h before launch`;
    if (liq) res.first_liquidity_utc = isoOf(await blockTime(liq.block));
    if (swap) res.first_swap_utc = isoOf(await blockTime(swap.block));
    let swapAfterCode = null;
    for (const e of ev) {
      if (e.kind !== 'swap') continue;
      const t = await blockTime(e.block);
      if (code == null || t >= code) { swapAfterCode = t; break; }
    }
    res.first_swap_after_code_utc = isoOf(swapAfterCode);

    // What the chain says: tradable = later of pool live (bot's launch block) and code published.
    const chain = code != null ? Math.max(live, code) : live;
    res.chain_tradable_utc = isoOf(chain);
    const recorded = tsOf(rec.tradable_utc);
    if (recorded == null) { res.reason = (res.reason ? res.reason + '; ' : '') + 'nothing recorded'; return res; }
    res.diff_s = recorded - chain;

    const issues = []; const notes = [];
    if (Math.abs(res.diff_s) > tol) issues.push(`recorded ${res.diff_s > 0 ? 'later' : 'earlier'} than the chain by ${Math.abs(res.diff_s)} s`);
    if (swap && swap.block < L) {
      const st = await blockTime(swap.block);
      const ahead = live - st;
      // Only a real case if the code was already published at that trade (LIT): before
      // the code, the token was not tradable by our definition anyway (BPCATE).
      if (code != null && code <= st) issues.push(`a trade ${ahead} s before the bot's launch block, with the code already published (pool tradable with less than the bot's minimum liquidity)`);
      else notes.push(`a trade ${ahead} s before the launch block, before the code was published (not tradable then)`);
    }
    if (liq && liq.block < L) {
      const ahead = live - (await blockTime(liq.block));
      if (ahead > tol) notes.push(`first liquidity ${ahead} s before the launch block`);
    }
    res.result = issues.length ? 'CHECK' : 'AGREES';
    res.reason = [...issues, ...notes, res.reason].filter(Boolean).join('; ');
  } catch (e) {
    res.reason = `read error: ${String(e && e.message || e).slice(0, 120)}`;
  }
  return res;
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const o = { sample: 0, since: null, days: null, history: null, tokens: null, verdicts: ['SNIP', 'PASSED GATES 0-5', 'DO NOT SNIP'], backSec: 6 * 3600, tol: 2, seed: 7, out: path.join(ROOT, 'extras', 'ready', 'verify'), ready: path.join(ROOT, 'extras', 'ready', 'ready-times.jsonl') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { i += 1; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i]; };
    if (a === '--sample') o.sample = Number(val());
    else if (a === '--since') o.since = val();
    else if (a === '--days') o.days = Number(val());
    else if (a === '--history') o.history = path.resolve(val());
    else if (a === '--tokens') o.tokens = val().split(',').map((s) => lc(s.trim())).filter(Boolean);
    else if (a === '--verdicts') o.verdicts = val().split(',').map((s) => s.trim());
    else if (a === '--back') o.backSec = parseDuration(val());
    else if (a === '--tol') o.tol = Number(val());
    else if (a === '--seed') o.seed = Number(val());
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--ready') o.ready = path.resolve(val());
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.sample && !o.since && !o.tokens && !o.days) throw new Error('choose --sample N, --since DATE, --days N or --tokens 0x..,0x..');
  return o;
}

function seededShuffle(arr, seed) {
  const a = [...arr]; let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function pick(rows, o) {
  let x = rows.filter((r) => r.tradable_utc && o.verdicts.includes(r.verdict));
  if (o.tokens) return x.filter((r) => o.tokens.includes(lc(r.token)));
  if (o.since) x = x.filter((r) => r.date >= o.since);
  if (o.days) { const from = new Date((o.nowMs || Date.now()) - o.days * 86400000).toISOString().slice(0, 10); x = x.filter((r) => r.date >= from); }
  if (o.sample) {
    // half code first, half trades first where possible, so both cases are checked
    const a = seededShuffle(x.filter((r) => r.case === 'code first'), o.seed);
    const b = seededShuffle(x.filter((r) => r.case === 'trades first'), o.seed);
    const nb = Math.min(b.length, Math.ceil(o.sample / 2));
    x = [...b.slice(0, nb), ...a.slice(0, o.sample - nb)];
  }
  return x;
}

const COLS = ['date', 'time', 'symbol', 'token', 'verdict', 'case', 'result', 'diff_s', 'recorded_tradable_utc', 'chain_tradable_utc', 'pool_created_utc',
  'first_liquidity_utc', 'pool_live_utc', 'code_published_utc', 'code_explorer_utc', 'explorer_early_s', 'first_swap_utc', 'first_swap_after_code_utc', 'reason', 'checked_utc'];
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const hm = (iso) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 19)}` : '-'.padEnd(14));

async function main(inject = {}) {
  const o = inject.opts || parseArgs(process.argv.slice(2));
  const log = inject.log || console.log;
  const screensDir = inject.screensDir || path.join(ROOT, 'screens');
  const config = inject.config || require('../config');
  const T = inject.T || topics();

  let { getLogs, blockTime, head } = inject;
  if (!getLogs) {
    // config.RPC_URL (Robinhood Chain), never RPC_URL from .env (see ready-times.js).
    const { ethers } = require('ethers');
    const p = new ethers.providers.StaticJsonRpcProvider(config.RPC_URL);
    const net = await p.getNetwork();
    if (Number(net.chainId) !== Number(config.CHAIN_ID)) throw new Error(`RPC is chain ${net.chainId}, expected ${config.CHAIN_ID}: stopping`);
    const cache = new Map();
    getLogs = (f) => p.getLogs(f);
    blockTime = async (n) => { if (!cache.has(n)) { const b = await p.getBlock(n); if (!b) throw new Error(`no block ${n}`); cache.set(n, b.timestamp); } return cache.get(n); };
    head = await p.getBlockNumber();
  }
  let get = inject.get;
  if (get === undefined) {
    const sg = require('../source-gate');
    const H = sg.explorerHttp();
    get = (addr) => H(sg.explorerUrl(`/smart-contracts/${addr}`), { userAgent: sg.explorerUA(), attempts: 2 });
  }

  const rows = (() => { try { return fs.readFileSync(o.ready, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } })();
  if (!rows.length) throw new Error(`nothing recorded yet in ${o.ready}`);
  const todo = pick(rows, o);
  const screens = new Map(RT.readScreens(screensDir).map((s) => [lc(s.j.record.token) + '|' + s.date + s.time, s.j]));

  log(`checking ${todo.length} token(s) against the chain`);
  log('symbol       case          result   diff  recorded        chain           created         1st liq         code            1st swap        reason');
  const out = [];
  for (const rec of todo) {
    const screen = screens.get(lc(rec.token) + '|' + rec.date + rec.time) || null;
    const r = await verifyOne(rec, screen, { getLogs, blockTime, head, get, ADDR: config.ADDR, T, backSec: o.backSec, tol: o.tol });
    r.checked_utc = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    out.push(r);
    log(`${String(r.symbol).slice(0, 12).padEnd(12)} ${r.case.padEnd(13)} ${r.result.padEnd(8)} ${String(r.diff_s ?? '-').padStart(4)}  ${hm(r.recorded_tradable_utc)}  ${hm(r.chain_tradable_utc)}  ${hm(r.pool_created_utc)}  ${hm(r.first_liquidity_utc)}  ${hm(r.code_published_utc)}  ${hm(r.first_swap_utc)}  ${r.reason}`);
  }
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(`${o.out}.csv`, [COLS.join(','), ...out.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
  // History: one row per token (newest check wins), so first liquidity / first trade
  // are kept for every token ever checked.
  const hist = o.history || `${o.out}-all`;
  const key = (r) => lc(r.token) + '|' + r.date + r.time;
  const all = new Map();
  try { for (const l of fs.readFileSync(`${hist}.jsonl`, 'utf8').split('\n')) { if (l.trim()) { try { const r = JSON.parse(l); all.set(key(r), r); } catch (_) { /* skip */ } } } } catch (_) { /* none yet */ }
  for (const r of out) all.set(key(r), r);
  const allRows = [...all.values()].sort((a, b) => (String(a.date) + a.time).localeCompare(String(b.date) + b.time));
  fs.writeFileSync(`${hist}.jsonl`, allRows.map((r) => JSON.stringify(r) + '\n').join(''));
  fs.writeFileSync(`${hist}.csv`, [COLS.join(','), ...allRows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
  const n = (k) => out.filter((r) => r.result === k).length;
  const corr = out.filter((r) => r.explorer_early_s != null).length;
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  log(`verify-ready: ${n('AGREES')} agree, ${n('CHECK')} to check, ${n('INCOMPLETE')} incomplete; explorer time corrected for ${corr} (times in UTC; details in ${path.relative(ROOT, o.out)}.csv; ${allRows.length} in ${path.relative(ROOT, hist)}.csv) ${stamp}`);
  return out;
}

module.exports = { main, verifyOne, poolEvents, poolOf, pick, parseArgs, topics };

if (require.main === module) {
  main().catch((e) => { console.error(`verify-ready: ${e && e.message || e}`); process.exit(1); });
}
