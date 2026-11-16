// extras/coverage-check.js — read only. Did the bot see EVERY launch, not only the ones it screened?
//
//   sudo -u botuser node extras/coverage-check.js                       (the last 24 h)
//   sudo -u botuser node extras/coverage-check.js --from 2026-11-05T00:00:00Z --to 2026-11-13T00:00:00Z
//
// Why: the daily chain check (verify-ready.js) checks only tokens the bot screened, and
// restart-gap-check.js only the pools a restart dropped. Nothing checked that the bot saw
// every launch at all. The bot reads the chain with getLogs; if the RPC ever handed it an
// empty or short answer instead of an error, the bot would move on and the launch would be
// gone without a trace. (One such path exists: for a list of v3 pools the bot reads
// eth_getLogs directly and treats a null reply as "no events", watch-launches.js scanRange.)
//
// What it does:
//   1. Replays the chain from scratch, without the bot's files: every v3 PoolCreated and v4
//      Initialize from 24 h before --from up to --to, then the liquidity of those pools, with
//      the bot's own rules (pickToken / positionAmounts from watch-launches.js; 1 ETH or
//      1000 USDG; a pool forgotten after 24 h; one launch per token).
//   2. Lists every launch between --from and --to.
//   3. Compares them with the bot's 'launched' lines in detections.jsonl:
//        same        the bot logged it, same pool and block
//        other block the bot logged it at another block or through another pool
//        restart     its pool was waiting when the bot restarted (restart-gap-check.js covers it)
//        screened    not in detections.jsonl, but the token is in launches.jsonl
//        MISSED      a launch on the chain the bot never logged
//        bot only    the bot logged a launch this replay does not find (a rule difference to look at)
//
// Nothing here touches the bot. It reads detections.jsonl, launches.jsonl and the first line
// of each logs/watch-*.txt (the bot's start times) and writes only extras/coverage/. RPC reads
// only, from config.RPC_URL; every request is retried, and a reply that is not a list counts
// as an error, never as "no events". No Tenderly, no explorer.
//
// Flags: --from / --to <ISO UTC> (default: the 24 h ending 30 min ago), --hours 24,
//        --min-eth 1, --min-usdg 1000, --replay-sec 900 (the service's --since 15m),
//        --detections, --launches, --logs-dir logs, --concurrency 4, --out-dir coverage

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const lc = (a) => String(a || '').toLowerCase();
const CHUNK = 10000;                       // LOG_CHUNK_BLOCKS in watch-launches.js
const ID_FILTER_MAX = 100;                 // ID_FILTER_MAX in watch-launches.js
const BLOCKS_PER_SEC = 10;
const TTL = 24 * 3600 * BLOCKS_PER_SEC;    // PENDING_TTL_BLOCKS in watch-launches.js
const isoOf = (sec) => (sec == null ? '' : new Date(sec * 1000).toISOString().replace('.000Z', 'Z'));
const byPos = (a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex);
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

function parseArgs(argv, nowSec = Math.floor(Date.now() / 1000)) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const t = (s) => { const v = Math.round(Date.parse(s) / 1000); if (!Number.isFinite(v)) throw new Error(`cannot read the time "${s}" (use e.g. 2026-11-15T06:10:00Z)`); return v; };
  const hours = Number(flag('--hours', 24));
  const toArg = flag('--to', null);
  const fromArg = flag('--from', null);
  const toSec = toArg ? t(toArg) : nowSec - 1800;
  const fromSec = fromArg ? t(fromArg) : toSec - Math.round(hours * 3600);
  if (!(fromSec < toSec)) throw new Error('--from must be before --to');
  return {
    fromSec, toSec,
    minEth: Number(flag('--min-eth', 1)),
    minUsdg: Number(flag('--min-usdg', 1000)),
    replaySec: Number(flag('--replay-sec', 900)),
    detections: path.resolve(ROOT, flag('--detections', 'detections.jsonl')),
    launches: path.resolve(ROOT, flag('--launches', 'launches.jsonl')),
    logsDir: path.resolve(ROOT, flag('--logs-dir', 'logs')),
    concurrency: Math.max(1, Number(flag('--concurrency', 4))),
    outDir: path.resolve(__dirname, flag('--out-dir', 'coverage')),
  };
}

function topics() {
  const { ethers } = require('ethers');
  const v3f = new ethers.utils.Interface([
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  ]);
  const v3 = new ethers.utils.Interface([
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  ]);
  const pm = new ethers.utils.Interface([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  ]);
  return {
    v3f, v3, pm,
    poolCreated: v3f.getEventTopic('PoolCreated'), mint: v3.getEventTopic('Mint'),
    initialize: pm.getEventTopic('Initialize'), modify: pm.getEventTopic('ModifyLiquidity'),
  };
}

const readJsonl = (f) => {
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip a damaged line */ }
  }
  return out;
};

async function runPool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; res[j] = await fn(items[j], j); }
  }));
  return res;
}

// The bot's start times: the first line of each logs/watch-*.txt ends with its local start time,
// e.g. "watch-launches — Robinhood Chain 4663 — 2026-11-13T23:07:22-07:00".
function botStarts(logsDir) {
  if (!fs.existsSync(logsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(logsDir).filter((n) => /^watch-.*\.txt$/.test(n)).sort()) {
    let head = '';
    try {
      const fd = fs.openSync(path.join(logsDir, name), 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.slice(0, n).toString('utf8');
    } catch (_) { continue; }
    const m = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/.exec(head);
    if (m) out.push({ log: name, startSec: Math.round(Date.parse(m[0]) / 1000) });
  }
  return out;
}

// Step 1: the bot's detection, replayed from the chain. Mirrors watch-launches.js scanRange():
// per 10k-block range, creations first, then the liquidity of every pool still waiting.
async function replay({ getLogs, T, W, config, lead, to, seen, minEth, minUsdg, concurrency = 4, onRange }) {
  const { ethers } = require('ethers');
  const A = config.ADDR;
  const PM = A.UNIV4_POOL_MANAGER;
  const dec = (base) => (base === 'USDG' ? 6 : 18);
  const minOf = (e) => (e.base === 'USDG' ? minUsdg : minEth);
  const pend3 = new Map();
  const pend4 = new Map();
  const seenT = new Set([...seen].map(lc));
  const launches = [];
  const stats = { requests: 0, pools: 0, expired: 0, ranges: 0 };
  const get = async (f) => { stats.requests += 1; return getLogs(f); };

  for (let from = lead; from <= to; from += CHUNK) {
    const end = Math.min(to, from + CHUNK - 1);
    const [c3, c4] = await Promise.all([
      get({ address: A.UNISWAP_V3_FACTORY, topics: [T.poolCreated], fromBlock: from, toBlock: end }),
      get({ address: PM, topics: [T.initialize], fromBlock: from, toBlock: end }),
    ]);
    for (const l of [...c3, ...c4].sort(byPos)) {
      if (l.topics[0] === T.poolCreated) {
        const a = T.v3f.parseLog(l).args;
        const pk = W.pickToken(a.token0, a.token1);
        if (!pk || seenT.has(lc(pk.tokenAddr))) continue;
        pend3.set(lc(a.pool), { version: 'v3', token: pk.tokenAddr, base: pk.base, baseIs0: pk.baseIs0, pool: a.pool, createdBlock: l.blockNumber, added: 0 });
      } else {
        const a = T.pm.parseLog(l).args;
        const pk = W.pickToken(a.currency0, a.currency1);
        if (!pk || seenT.has(lc(pk.tokenAddr))) continue;
        pend4.set(lc(a.id), { version: 'v4', token: pk.tokenAddr, base: pk.base, baseIs0: pk.baseIs0, pool: a.id, hooks: a.hooks, sqrtPriceX96: a.sqrtPriceX96, createdBlock: l.blockNumber, added: 0 });
      }
      stats.pools += 1;
    }

    const jobs = [];
    for (const c of chunk([...pend3.values()].map((e) => e.pool), ID_FILTER_MAX)) jobs.push({ address: c, topics: [T.mint], fromBlock: from, toBlock: end });
    for (const c of chunk([...pend4.values()].map((e) => e.pool), ID_FILTER_MAX)) jobs.push({ address: PM, topics: [T.modify, c], fromBlock: from, toBlock: end });
    const liq = (await runPool(jobs, concurrency, get)).flat().sort(byPos);

    for (const l of liq) {
      const isMint = l.topics[0] === T.mint;
      const map = isMint ? pend3 : pend4;
      const key = isMint ? lc(l.address) : lc(l.topics[1]);
      const e = map.get(key);
      if (!e) continue;
      if (l.blockNumber - e.createdBlock > TTL) continue;   // the live bot had forgotten this pool
      let added;
      if (isMint) {
        const a = T.v3.parseLog(l).args;
        added = Number(ethers.utils.formatUnits(e.baseIs0 ? a.amount0 : a.amount1, dec(e.base)));
      } else {
        const a = T.pm.parseLog(l).args;
        if (ethers.BigNumber.from(a.liquidityDelta).lte(0)) continue;
        const amt = W.positionAmounts({ sqrtPriceX96: e.sqrtPriceX96, tickLower: a.tickLower, tickUpper: a.tickUpper, liquidity: a.liquidityDelta });
        added = (e.baseIs0 ? amt.amount0Raw : amt.amount1Raw) / 10 ** dec(e.base);
      }
      e.added += added;
      if (e.added < minOf(e)) continue;
      map.delete(key);
      const t = lc(e.token);
      if (seenT.has(t)) continue;                             // a second pool for the same token
      seenT.add(t);
      launches.push({ ...e, launchBlock: l.blockNumber });
    }

    for (const map of [pend3, pend4]) {
      for (const [k, e] of map) if (end - e.createdBlock > TTL) { map.delete(k); stats.expired += 1; }
    }
    stats.ranges += 1;
    if (onRange) onRange(end, stats);
  }
  return { launches, stats };
}

// Step 2: chain launches vs the bot's 'launched' lines.
function compare({ chain, events, fromBlock, toBlock, starts, screened }) {
  const botFirst = new Map();                                 // token -> first 'launched' line
  for (const e of events) {
    if (e.event !== 'launched') continue;
    const t = lc(e.token);
    const prev = botFirst.get(t);
    if (!prev || Number(e.block) < Number(prev.block)) botFirst.set(t, e);
  }
  const inWin = (b) => b >= fromBlock && b <= toBlock;
  const rows = [];
  const chainTokens = new Set(chain.map((c) => lc(c.token)));
  for (const c of chain.filter((x) => inWin(x.launchBlock))) {
    const b = botFirst.get(lc(c.token));
    const row = { ...c, botBlock: b ? Number(b.block) : null, botPool: b ? b.pool : null };
    if (b) {
      row.cls = (Number(b.block) === c.launchBlock && lc(b.pool) === lc(c.pool)) ? 'same' : 'other block';
    } else if (starts.some((s) => s.replayBlock != null && c.createdBlock < s.replayBlock && c.launchBlock >= s.replayBlock && c.launchBlock - s.replayBlock <= TTL)) {
      row.cls = 'restart';
    } else if (screened.has(lc(c.token))) {
      row.cls = 'screened';
    } else {
      row.cls = 'MISSED';
    }
    rows.push(row);
  }
  for (const [t, b] of botFirst) {
    if (!inWin(Number(b.block)) || chainTokens.has(t)) continue;
    rows.push({ cls: 'bot only', token: b.token, version: b.version, base: b.base, pool: b.pool, createdBlock: b.createdBlock ?? null, launchBlock: null, botBlock: Number(b.block), botPool: b.pool, added: b.baseAdded ?? null });
  }
  const count = (k) => rows.filter((r) => r.cls === k).length;
  const summary = { chain: rows.filter((r) => r.cls !== 'bot only').length };
  for (const k of ['same', 'other block', 'restart', 'screened', 'MISSED', 'bot only']) summary[k] = count(k);
  return { rows, summary };
}

async function main(inject = {}) {
  const o = inject.opts || parseArgs(process.argv.slice(2));
  const log = inject.log || console.log;
  const config = inject.config || require('../config');
  const W = inject.W || require('../watch-launches');
  const T = topics();

  let { getLogs, blockAtTime, blockTime } = inject;
  let head = inject.head;
  if (!getLogs) {
    // config.RPC_URL (Robinhood Chain), never RPC_URL from .env.
    const { ethers } = require('ethers');
    const p = new ethers.providers.StaticJsonRpcProvider(config.RPC_URL);
    const net = await p.getNetwork();
    if (Number(net.chainId) !== Number(config.CHAIN_ID)) throw new Error(`RPC is chain ${net.chainId}, expected ${config.CHAIN_ID}: stopping`);
    getLogs = async (f) => {
      for (let a = 1; ; a += 1) {
        try {
          const raw = await p.send('eth_getLogs', [{ address: f.address, topics: f.topics, fromBlock: ethers.utils.hexValue(f.fromBlock), toBlock: ethers.utils.hexValue(f.toBlock) }]);
          if (!Array.isArray(raw)) throw new Error(`reply is not a list (${JSON.stringify(raw)})`);
          return raw.map((l) => ({ ...l, blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex) }));
        } catch (err) { if (a >= 6) throw err; await new Promise((r) => setTimeout(r, 1500 * a)); }
      }
    };
    const { blockAtTime: bat } = require('../controller-check');
    blockAtTime = (sec) => bat(p, sec);
    const cache = new Map();
    blockTime = async (n) => {
      if (!cache.has(n)) {
        for (let a = 1; ; a += 1) {
          try { cache.set(n, (await p.getBlock(n)).timestamp); break; } catch (err) { if (a >= 4) throw err; await new Promise((r) => setTimeout(r, 1000 * a)); }
        }
      }
      return cache.get(n);
    };
    head = await p.getBlockNumber();
  }

  const fromBlock = await blockAtTime(o.fromSec);
  const toBlock = Math.min(head, await blockAtTime(o.toSec));
  const lead = Math.max(0, fromBlock - TTL);
  const events = readJsonl(o.detections);
  if (!events.length) throw new Error(`nothing in ${o.detections}`);
  const leadSec = o.fromSec - 24 * 3600;
  // Tokens the bot already knew before the lead: launched in detections.jsonl, or screened in
  // launches.jsonl (which goes back further: detections.jsonl starts 13 Oct). The bot never
  // re-screens them, so their later pools are not launches.
  const launchRecs = readJsonl(o.launches);
  const seen = new Set(events.filter((e) => e.event === 'launched' && Number(e.block) < lead).map((e) => lc(e.token)));
  for (const r of launchRecs) {
    const t = Date.parse(r.detectedAt || r.screenedAt || '');
    if (Number.isFinite(t) && t / 1000 < leadSec) seen.add(lc(r.token));
  }
  const screened = new Set(launchRecs.map((r) => lc(r.token)));

  const starts = botStarts(o.logsDir).filter((s) => s.startSec > leadSec && s.startSec <= o.toSec + 3600);
  for (const s of starts) s.replayBlock = await blockAtTime(s.startSec - o.replaySec);

  log(`Window ${isoOf(o.fromSec)} to ${isoOf(o.toSec)}: blocks ${fromBlock}-${toBlock}. Replaying from block ${lead} (24 h earlier), ${Math.ceil((toBlock - lead + 1) / CHUNK)} ranges.`);
  log(`Bot starts in or near the window: ${starts.length ? starts.map((s) => `${isoOf(s.startSec)} (${s.log})`).join(', ') : 'none'}.`);
  let lastNote = 0;
  const { launches, stats } = await replay({
    getLogs, T, W, config, lead, to: toBlock, seen, minEth: o.minEth, minUsdg: o.minUsdg, concurrency: o.concurrency,
    onRange: (end, st) => { if (st.ranges - lastNote >= 25) { lastNote = st.ranges; log(`  block ${end}: ${st.ranges} ranges, ${st.requests} requests`); } },
  });
  log(`Replay done: ${stats.requests} requests, ${stats.pools} new pools, ${launches.length} launches (${launches.filter((x) => x.launchBlock >= fromBlock).length} inside the window).`);

  const { rows, summary } = compare({ chain: launches, events, fromBlock, toBlock, starts, screened });
  await runPool(rows, o.concurrency, async (r) => {
    if (r.launchBlock != null) r.launchTime = isoOf(await blockTime(r.launchBlock));
    if (r.botBlock != null) r.botTime = isoOf(await blockTime(r.botBlock));
  });

  log('');
  log(`Launches on the chain in the window: ${summary.chain}`);
  log(`  bot logged, same pool and block:  ${summary.same}`);
  log(`  bot logged, other block or pool:  ${summary['other block']}`);
  log(`  around a bot restart:             ${summary.restart}`);
  log(`  not logged, but screened:         ${summary.screened}`);
  log(`  MISSED:                           ${summary.MISSED}`);
  log(`Bot launches the replay does not find: ${summary['bot only']}`);
  for (const r of rows.filter((x) => x.cls !== 'same').slice(0, 40)) {
    log(`  ${r.cls.padEnd(11)} ${r.token}  ${r.version || ''} ${r.base || ''}  chain block ${r.launchBlock ?? '-'} ${r.launchTime || ''}  bot block ${r.botBlock ?? '-'} ${r.botTime || ''}`);
  }

  fs.mkdirSync(o.outDir, { recursive: true });
  const stamp = (s) => isoOf(s).replace(/[:]/g, '');
  const out = path.join(o.outDir, `coverage-${stamp(o.fromSec)}-${stamp(o.toSec)}.csv`);
  const cols = ['cls', 'token', 'version', 'base', 'pool', 'createdBlock', 'launchBlock', 'launchTime', 'botBlock', 'botTime', 'botPool', 'added'];
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(6)) : String(v));
  fs.writeFileSync(out, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');
  log(`Details: ${path.relative(ROOT, out)}`);
  if (summary.MISSED) log('A MISSED token can be screened by hand: sudo -u botuser node screen-token.js <token>');
  return { fromBlock, toBlock, lead, launches, rows, summary, stats };
}

module.exports = { main, replay, compare, botStarts, parseArgs, topics };

if (require.main === module) {
  main().catch((e) => { console.error(`coverage-check: ${e.message}`); process.exit(1); });
}
