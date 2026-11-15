// extras/restart-gap-check.js — read only. Did a bot restart make it miss a launch?
//
//   sudo -u botuser node extras/restart-gap-check.js --restart 2026-11-14T06:07:05Z
//
// Why: pools that exist but do not yet hold the launch minimum (1 ETH / 1000 USDG)
// are kept only in the bot's memory (pendingV3 / pendingV4). After a restart the bot
// replays just 15 minutes, so a pool created earlier that reaches the minimum later
// is never marked as a launch, and nothing else would notice.
//
// What it does:
//   1. Reads detections.jsonl and finds the pools the restart dropped: created
//      (knownToken false) before the replay start, less than ~24 h before it, and
//      not yet launched or expired.
//   2. Reads the chain's liquidity events (v3 Mint, v4 ModifyLiquidity) for those
//      pools from the replay start until each pool's 24 h limit, adds them to what
//      the bot had already counted before the replay start, using the bot's own
//      rules (pickToken / positionAmounts from watch-launches.js), and reports any
//      pool that reached the minimum: a launch the bot would have screened.
//   3. Says whether the token was screened anyway through another pool.
//
// Nothing here touches the bot: it reads detections.jsonl and launches.jsonl and
// writes only extras/restart-gap/gap-<restart>.csv. RPC reads only, no Tenderly,
// no explorer.
//
// Flags: --restart <ISO UTC> (required), --replay-sec 900 (the service's --since 15m),
//        --min-eth 1, --min-usdg 1000, --detections, --launches, --concurrency 4

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) { /* optional */ }

const lc = (a) => String(a || '').toLowerCase();
const CHUNK = 10000;                 // 10k-block getLogs ranges, as in watch-launches.js
const ID_FILTER_MAX = 100;           // addresses / ids per OR-filter, as in watch-launches.js
const BLOCKS_PER_SEC = 10;
const TTL = 24 * 3600 * BLOCKS_PER_SEC;   // PENDING_TTL_BLOCKS in watch-launches.js
const isoOf = (sec) => (sec == null ? '' : new Date(sec * 1000).toISOString().replace('.000Z', 'Z'));

function parseArgs(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const restart = flag('--restart', null);
  const restartSec = restart ? Math.round(Date.parse(restart) / 1000) : NaN;
  if (!Number.isFinite(restartSec)) throw new Error('give --restart <time in UTC>, e.g. --restart 2026-11-14T06:07:05Z');
  return {
    restartSec,
    replaySec: Number(flag('--replay-sec', 900)),
    minEth: Number(flag('--min-eth', 1)),
    minUsdg: Number(flag('--min-usdg', 1000)),
    detections: path.resolve(ROOT, flag('--detections', 'detections.jsonl')),
    launches: path.resolve(ROOT, flag('--launches', 'launches.jsonl')),
    concurrency: Math.max(1, Number(flag('--concurrency', 4))),
    outDir: path.resolve(__dirname, flag('--out-dir', 'restart-gap')),
  };
}

function topics() {
  const { ethers } = require('ethers');
  const v3 = new ethers.utils.Interface([
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  ]);
  const pm = new ethers.utils.Interface([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  ]);
  return { v3, pm, mint: v3.getEventTopic('Mint'), initialize: pm.getEventTopic('Initialize'), modify: pm.getEventTopic('ModifyLiquidity') };
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

// Step 1: the pools the restart dropped, from detections.jsonl alone.
function droppedPools(events, replayBlock) {
  const created = new Map();            // pool key -> creation record
  const before = new Map();             // pool key -> base added before the replay start
  const closed = new Set();             // pool keys launched or expired
  const launchedTokens = new Map();     // token -> first launch block
  for (const e of events) {
    const k = lc(e.pool);
    if (e.event === 'pool_created' && e.knownToken === false && !created.has(k)) created.set(k, e);
    else if (e.event === 'liquidity' && Number(e.block) < replayBlock) before.set(k, (before.get(k) || 0) + Number(e.added || 0));
    else if (e.event === 'launched') {
      closed.add(k);
      const t = lc(e.token);
      if (!launchedTokens.has(t) || Number(e.block) < launchedTokens.get(t)) launchedTokens.set(t, Number(e.block));
    } else if (e.event === 'expired') closed.add(k);
  }
  const out = [];
  for (const [k, e] of created) {
    const b = Number(e.block);
    if (!(b < replayBlock) || replayBlock - b > TTL) continue;   // replayed, or already past its 24 h
    if (closed.has(k)) continue;
    const t = lc(e.token);
    if (launchedTokens.has(t) && launchedTokens.get(t) < replayBlock) continue; // token already launched elsewhere
    out.push({ key: k, version: e.version, token: e.token, base: e.base, pool: e.pool, createdBlock: b, before: before.get(k) || 0 });
  }
  return { pools: out, launchedTokens };
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; res[j] = await fn(items[j], j); }
  }));
  return res;
}

async function main(inject = {}) {
  const o = inject.opts || parseArgs(process.argv.slice(2));
  const log = inject.log || console.log;
  const config = inject.config || require('../config');
  const W = inject.W || require('../watch-launches');
  const T = topics();

  let { getLogs, blockAtTime, blockTime, head } = inject;
  if (!getLogs) {
    // config.RPC_URL (Robinhood Chain), never RPC_URL from .env (as in verify-ready.js).
    const { ethers } = require('ethers');
    const p = new ethers.providers.StaticJsonRpcProvider(config.RPC_URL);
    const net = await p.getNetwork();
    if (Number(net.chainId) !== Number(config.CHAIN_ID)) throw new Error(`RPC is chain ${net.chainId}, expected ${config.CHAIN_ID}: stopping`);
    getLogs = async (f) => {
      for (let a = 1; ; a += 1) {
        try {
          if (!Array.isArray(f.address)) return await p.getLogs(f);
          const raw = await p.send('eth_getLogs', [{ address: f.address, topics: f.topics, fromBlock: ethers.utils.hexValue(f.fromBlock), toBlock: ethers.utils.hexValue(f.toBlock) }]);
          return (raw || []).map((l) => ({ ...l, blockNumber: Number(l.blockNumber), logIndex: Number(l.logIndex) }));
        } catch (err) { if (a >= 4) throw err; await new Promise((r) => setTimeout(r, 1000 * a)); }
      }
    };
    const { blockAtTime: bat } = require('../controller-check');
    blockAtTime = (sec) => bat(p, sec);
    const cache = new Map();
    blockTime = async (n) => { if (!cache.has(n)) cache.set(n, (await p.getBlock(n)).timestamp); return cache.get(n); };
    head = await p.getBlockNumber();
  }

  // The bot's replay start: blockAtTime(start time - 15 min), as in watch-launches.js start().
  const replayBlock = await blockAtTime(o.restartSec - o.replaySec);
  const events = readJsonl(o.detections);
  if (!events.length) throw new Error(`nothing in ${o.detections}`);
  const { pools, launchedTokens } = droppedPools(events, replayBlock);
  log(`Restart ${isoOf(o.restartSec)}; bot replayed from block ${replayBlock} (${isoOf(o.restartSec - o.replaySec)}).`);
  log(`Pools waiting for liquidity that the restart dropped: ${pools.length} (v3 ${pools.filter((x) => x.version === 'v3').length}, v4 ${pools.filter((x) => x.version === 'v4').length}).`);
  if (!pools.length) return { replayBlock, pools, reached: [] };

  const endBlock = Math.min(head, Math.max(...pools.map((x) => x.createdBlock + TTL)));
  if (endBlock < Math.max(...pools.map((x) => x.createdBlock + TTL))) log(`Note: the 24 h window is not over for every pool yet (chain head ${head}); run again later for the final answer.`);

  // Step 2: liquidity events from the replay start to the 24 h limit.
  const PM = config.ADDR.UNIV4_POOL_MANAGER;
  const v3 = pools.filter((x) => x.version === 'v3');
  const v4 = pools.filter((x) => x.version === 'v4');
  const jobs = [];
  for (let from = replayBlock; from <= endBlock; from += CHUNK) {
    const to = Math.min(endBlock, from + CHUNK - 1);
    for (let i = 0; i < v3.length; i += ID_FILTER_MAX) jobs.push({ address: v3.slice(i, i + ID_FILTER_MAX).map((x) => x.pool), topics: [T.mint], fromBlock: from, toBlock: to });
    for (let i = 0; i < v4.length; i += ID_FILTER_MAX) jobs.push({ address: PM, topics: [T.modify, v4.slice(i, i + ID_FILTER_MAX).map((x) => x.pool)], fromBlock: from, toBlock: to });
  }
  log(`Reading liquidity events: ${jobs.length} requests over ${endBlock - replayBlock + 1} blocks...`);
  let done = 0;
  const all = (await pool(jobs, o.concurrency, async (f) => {
    const r = await getLogs(f);
    done += 1;
    if (done % 200 === 0) log(`  ${done}/${jobs.length}`);
    return r;
  })).flat();
  all.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const byKey = new Map(pools.map((x) => [lc(x.pool), x]));
  const sqrtCache = new Map();
  const sqrtOf = async (x) => {
    if (!sqrtCache.has(x.key)) {
      const logs = await getLogs({ address: PM, topics: [T.initialize, x.pool], fromBlock: x.createdBlock, toBlock: x.createdBlock });
      sqrtCache.set(x.key, logs.length ? T.pm.parseLog(logs[0]).args.sqrtPriceX96 : null);
    }
    return sqrtCache.get(x.key);
  };
  const baseDec = (base) => (base === 'USDG' ? 6 : 18);
  const total = new Map(pools.map((x) => [x.key, x.before]));
  const reached = [];
  const hit = new Set();
  for (const l of all) {
    const isMint = l.topics[0] === T.mint;
    const x = byKey.get(isMint ? lc(l.address) : lc(l.topics[1]));
    if (!x || hit.has(x.key) || l.blockNumber > x.createdBlock + TTL) continue;
    // which side is the base token: same rule as the bot (pickToken on the pool's tokens)
    let added = 0;
    if (isMint) {
      const a = T.v3.parseLog(l).args;
      const tokenIs0 = lc(x.token) < lc(baseAddrOf(x, config)); // token0 = lower address (v3 and v4)
      const raw = tokenIs0 ? a.amount1 : a.amount0;
      added = Number(raw.toString()) / 10 ** baseDec(x.base);
    } else {
      const a = T.pm.parseLog(l).args;
      if (a.liquidityDelta.lte(0)) continue;
      const sq = await sqrtOf(x);
      if (!sq) continue;
      const amt = W.positionAmounts({ sqrtPriceX96: sq, tickLower: a.tickLower, tickUpper: a.tickUpper, liquidity: a.liquidityDelta });
      const tokenIs0 = lc(x.token) < lc(baseAddrOf(x, config)); // token0 = lower address (v3 and v4)
      added = (tokenIs0 ? amt.amount1Raw : amt.amount0Raw) / 10 ** baseDec(x.base);
    }
    const t = total.get(x.key) + added;
    total.set(x.key, t);
    const min = x.base === 'USDG' ? o.minUsdg : o.minEth;
    if (t >= min) {
      hit.add(x.key);
      const other = launchedTokens.get(lc(x.token));
      reached.push({ ...x, total: t, minimum: min, reachedBlock: l.blockNumber, screenedElsewhere: other != null });
    }
  }
  for (const r of reached) {
    r.reachedTime = isoOf(await blockTime(r.reachedBlock));
    r.createdTime = isoOf(await blockTime(r.createdBlock));
  }

  // Step 3: report.
  const screened = new Set(readJsonl(o.launches).map((r) => lc(r.token)));
  for (const r of reached) r.screened = screened.has(lc(r.token)) || r.screenedElsewhere;
  const missed = reached.filter((r) => !r.screened);
  log('');
  log(`Reached the launch minimum after the restart: ${reached.length}; screened anyway through another pool: ${reached.length - missed.length}; MISSED: ${missed.length}.`);
  for (const r of reached) {
    log(`  ${r.screened ? 'screened ' : 'MISSED   '} ${r.token}  ${r.version} ${r.base}  created ${r.createdTime}  reached ${r.total.toFixed(3)} ${r.base} at ${r.reachedTime} (block ${r.reachedBlock})`);
  }
  fs.mkdirSync(o.outDir, { recursive: true });
  const out = path.join(o.outDir, `gap-${isoOf(o.restartSec).replace(/[:]/g, '')}.csv`);
  const cols = ['token', 'version', 'base', 'pool', 'createdBlock', 'createdTime', 'before', 'total', 'minimum', 'reachedBlock', 'reachedTime', 'screened'];
  fs.writeFileSync(out, [cols.join(','), ...reached.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n');
  log(`Details: ${path.relative(ROOT, out)}`);
  if (missed.length) log('A MISSED token can be screened by hand: sudo -u botuser node screen-token.js <token>');
  return { replayBlock, pools, reached, missed };
}

// The base token's address for a pool (WETH / native ETH / USDG), from config.
function baseAddrOf(x, config) {
  const A = config.ADDR;
  if (x.base === 'USDG') return A.USDG;
  if (x.base === 'ETH') return A.ZERO;     // native ETH (v4)
  return A.WETH;
}

module.exports = { main, droppedPools, parseArgs, topics, baseAddrOf };

if (require.main === module) {
  main().catch((e) => { console.error(`restart-gap-check: ${e.message}`); process.exit(1); });
}
