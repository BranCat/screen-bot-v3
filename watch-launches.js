// watch-launches.js — find newly launched tokens on Robinhood Chain (4663) and
// run every one through screen-token.js.
//
//   node watch-launches.js                       watch live, from now on
//   node watch-launches.js --since 3h            replay the last 3 hours first, then keep watching
//   node watch-launches.js --since 3h --once     replay the last 3 hours, screen them, then exit
//
// Options
//   --amount 0.05      ETH per simulated buy (default 0.05)
//   --min-eth 1        an ETH/WETH pool counts as launched once this much ETH is added (default 1)
//   --min-usdg 1000    same for USDG pools (default 1000)
//   --poll 10          seconds between chain polls (default 10)
//   --out launches.jsonl   where one record per screened token is appended
//   --detections detections.jsonl   every pool event seen (created / liquidity /
//                      launched / expired), screened or not  (2026-10-13)
//   --screens screens  one full JSON file per screened token, every gate's
//                      complete result: screens/<date>/<time>_<SYMBOL>_<token>.json
//   --log FILE         where a full copy of everything printed goes
//                      (default logs/watch-YYYY-MM-DD_HHMM.txt, one file per run)
//   --source-recheck 30,60,120,300   seconds after launch at which a token whose
//                      source was not published yet is looked up again (default)
//   --no-source-recheck   old behaviour: an unpublished source is final at Gate 0
//   --wait-file source-wait.json   the re-check list, kept on disk so a restart
//                      does not forget it
//   --hold-retry 600   explorer quota outage (HTTP 402): seconds between probe
//                      lookups while tokens are held (2026-10-18)
//   --hold-max 3600    a token held longer than this is recorded UNKNOWN without
//                      screening (a verdict that late is no use for a trade)
//   VERBOSE=1          also print pools still waiting for liquidity
//
// Nothing here trades, signs or needs a key. Public RPC reads + Tenderly simulations only.
//
// ---------------------------------------------------------------------------
// HOW IT IS BUILT
// ---------------------------------------------------------------------------
// Detection is v1's (token-screener-v3.js), screening is screen-token.js.
//
//   1. Creation    v3 PoolCreated / v4 Initialize on a token paired with ETH,
//                  WETH or USDG -> the pool waits for liquidity.
//   2. Launch      liquidity added (v3 Mint / v4 ModifyLiquidity > 0) reaches
//                  the minimum -> "*** NEW TOKEN" prints at once and the token
//                  joins the screening queue. That line never waits on a screen.
//   3. Screening   one token at a time through screen(): Gate 0 source, pool,
//                  Gate 1b liquidity controller, Tenderly gates 2-6.
//   4. Record      one JSON line per token in launches.jsonl, whatever the verdict.
//
// Changes from v1, and why:
//   - Polling (getLogs every few seconds) instead of a WebSocket. v1 already
//     needed a 2-minute getLogs backfill and a heartbeat because the socket
//     dropped events silently; polling is that backfill made the only path.
//   - The intent-proxy checks (owner renounced, danger selectors, holder %,
//     "N concerns") are gone. They scored scams as "0 concerns". The verdict
//     now comes only from screen-token.js.
//   - No deployer blocklist written on soft concerns. Instead, a wallet that
//     controlled the liquidity of an earlier launch is flagged when it shows up
//     again ("repeat controller"), counted from launches.jsonl.
//   - Hidden source (Gate 0) is marked and skipped: recorded, never re-screened.
//     2026-10-16: changed. On 15 Oct, 750 of 903 tokens skipped at Gate 0 had their
//     source published later (8 of them Pons launchpad tokens, the HRX template).
//     Now a hidden source runs Gate 1b first (RPC only). Pullable liquidity -> DO NOT
//     SNIP at once. Otherwise the token goes on the source re-check list and is
//     looked up again 30s / 1m / 2m / 5m after launch; published -> full screen,
//     still hidden after the last look -> DO NOT SNIP (gate 0) as before.
//   - Pons and Bags launches are named from their hook (pool-resolve.js).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');

const { ADDR, RPC_URL } = require('./config');
const { knownHookName } = require('./pool-resolve');

const lc = (a) => String(a || '').toLowerCase();
const BLOCKS_PER_SEC = 10;                 // ~100ms blocks (same figure as controller-check.js)
const LOG_CHUNK_BLOCKS = 10000;            // the public RPC accepts 10k-block getLogs ranges
const PENDING_TTL_BLOCKS = 24 * 3600 * BLOCKS_PER_SEC;   // forget pools with no liquidity after ~24h
const CONTROLLER_FRESH_WINDOW_BLOCKS = 5 * 3600 * BLOCKS_PER_SEC; // older than this -> pass aroundTime
const ID_FILTER_MAX = 100;                 // poolIds / addresses per getLogs OR-filter

// ---------------------------------------------------------------- events
const v3FactoryIface = new ethers.utils.Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);
const v3PoolIface = new ethers.utils.Interface([
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
]);
const pmIface = new ethers.utils.Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
]);
const T = {
  poolCreated: v3FactoryIface.getEventTopic('PoolCreated'),
  mint: v3PoolIface.getEventTopic('Mint'),
  initialize: pmIface.getEventTopic('Initialize'),
  modify: pmIface.getEventTopic('ModifyLiquidity'),
};
const erc20Iface = new ethers.utils.Interface(['function symbol() view returns (string)']);

// ---------------------------------------------------------------- pure helpers
function albertaISOString(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    // hourCycle only, NOT hour12:false. Node 20 (the droplet) lets hour12
    // override hourCycle and then prints midnight as "24:30"; caught by the
    // offline test on the droplet at 00:20 on 13 Oct 2026. The '24' guard
    // below is a second line of defence for any other ICU build.
    hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  if (parts.hour === '24') parts.hour = '00';
  const offset = (parts.timeZoneName || 'GMT+00:00').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// Which side is the base currency. Returns { tokenAddr, base, baseAddr, baseIs0 }
// or null (no base side, or both sides are base currencies).
function baseOf(addr) {
  const a = lc(addr);
  if (a === lc(ADDR.ZERO)) return 'ETH';
  if (a === lc(ADDR.WETH)) return 'WETH';
  if (ADDR.USDG && a === lc(ADDR.USDG)) return 'USDG';
  return null;
}
function pickToken(a0, a1) {
  const b0 = baseOf(a0);
  const b1 = baseOf(a1);
  if (b0 && !b1) return { tokenAddr: ethers.utils.getAddress(a1), base: b0, baseAddr: a0, baseIs0: true };
  if (b1 && !b0) return { tokenAddr: ethers.utils.getAddress(a0), base: b1, baseAddr: a1, baseIs0: false };
  return null;
}
const baseDecimals = (base) => (base === 'USDG' ? 6 : 18);

// Uniswap v3/v4 concentrated-liquidity amounts for ONE position at a given
// price. Floating point: for a "how much was added" threshold, not for trading.
function positionAmounts({ sqrtPriceX96, tickLower, tickUpper, liquidity }) {
  const sqrtP = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const sqrtPL = 1.0001 ** (Number(tickLower) / 2);
  const sqrtPU = 1.0001 ** (Number(tickUpper) / 2);
  const L = Number(liquidity.toString());
  if (sqrtP <= sqrtPL) return { amount0Raw: L * (1 / sqrtPL - 1 / sqrtPU), amount1Raw: 0 };
  if (sqrtP >= sqrtPU) return { amount0Raw: 0, amount1Raw: L * (sqrtPU - sqrtPL) };
  return { amount0Raw: L * (1 / sqrtP - 1 / sqrtPU), amount1Raw: L * (sqrtP - sqrtPL) };
}

function launchPathOf(p) {
  if (p.version === 'v3') return 'direct v3 pool';
  if (!p.hooks || lc(p.hooks) === lc(ADDR.ZERO)) return 'direct v4 pool (no hook)';
  const name = knownHookName(p.hooks);
  if (name && /pons/i.test(name)) return 'Pons launchpad';
  if (name && /bags/i.test(name)) return 'Bags launchpad';
  return `custom hook ${p.hooks}`;
}

function parseSince(s) {
  if (s == null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`--since: cannot read "${s}" (use e.g. 90m, 3h, 1d)`);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, '': 3600 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const byPosition = (a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- watcher
/**
 * @param opts
 *   provider     ethers v5 provider (required)
 *   screenFn     async (token, screenOpts) => verdict; defaults to screen-token.js
 *   amountEth, minEth, minUsdg, outFile
 *   log          console.log replacement (tests)
 *   verbose
 */
function createWatcher(opts) {
  const provider = opts.provider;
  const screenFn = opts.screenFn || require('./screen-token').screen;
  const amountEth = opts.amountEth ?? 0.05;
  const minEth = opts.minEth ?? 1;
  const minUsdg = opts.minUsdg ?? 1000;
  const outFile = opts.outFile ?? null;
  // 2026-10-13, for analysis:
  //   detectFile  every pool/launch event seen, screened or not (JSONL)
  //   detailDir   one complete JSON file per screened token, every gate's full result
  const detectFile = opts.detectFile ?? null;
  const detailDir = opts.detailDir ?? null;
  // 2026-10-16: source re-check list (see the header). [] or null turns it off.
  const recheckDelays = (opts.sourceRecheckSec === undefined ? [30, 60, 120, 300] : (opts.sourceRecheckSec || []))
    .map(Number).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const recheckOn = recheckDelays.length > 0;
  const waitFile = opts.waitFile ?? null;
  const now = opts.now || (() => Date.now());
  const sourceGateFn = opts.sourceGateFn || ((token) => require('./source-gate').sourceGate(token, { rpcUrl: RPC_URL, chain: 4663 }));
  const log = opts.log || console.log;
  const vlog = opts.verbose ? log : () => {};

  // 2026-10-18: explorer quota guard. On 17 Oct the Blockscout key ran out of credits
  // (HTTP 402) from 05:00 to 18:00 and 423 tokens ended UNKNOWN at Gate 0, while
  // service-error.log stayed empty. Now the first 402 raises an alarm on stderr (which
  // systemd appends to service-error.log), tokens are HELD instead of written off,
  // one held token is looked up every holdRetrySec as a probe, and when the explorer
  // answers again every held token is screened. A token held longer than holdMaxSec
  // is recorded UNKNOWN without screening.
  const alarm = opts.alarm || console.error;
  const holdRetrySec = opts.holdRetrySec ?? 600;
  const holdMaxSec = opts.holdMaxSec ?? 3600;
  const explorerStats = opts.explorerStats !== undefined ? opts.explorerStats
    : (() => { try { return require('./source-gate').explorerStats; } catch (_) { return null; } })();
  const isQuota = (text) => /HTTP 402/.test(String(text || ''));
  const viaExplorer = (src) => /block explorer/.test(String((src && src.reason) || ''));
  const hrs = (ms) => `${(ms / 3600e3).toFixed(1)} h`;
  const outage = { since: null, failures: 0, lastAlarm: 0 };

  const pendingV3 = new Map();      // pool address -> entry
  const pendingV4 = new Map();      // poolId -> entry
  const seenTokens = new Set();
  const controllerCount = new Map(); // controller wallet -> launches it controlled
  const queue = [];
  const results = [];
  let working = false;
  let idleResolvers = [];
  const stats = { detected: 0, screened: 0, byVerdict: {}, sourceWaiting: 0, sourceFound: 0, sourceGaveUp: 0, quotaHeld: 0, quotaReleased: 0, quotaExpired: 0 };
  const sourceWait = new Map();      // token (lc) -> waiting entry, see waitForSource()

  // Earlier records: never re-screen a token, and remember who controlled what.
  if (outFile && fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.token) seenTokens.add(lc(r.token));
        const c = r.controller && r.controller.controller;
        if (c && r.controller.verdict === 'CREATOR_CAN_PULL') controllerCount.set(lc(c), (controllerCount.get(lc(c)) || 0) + 1);
      } catch (_) { /* a damaged line is skipped, not fatal */ }
    }
  }

  // The source re-check list survives a restart: its tokens count as seen (never
  // re-queued by the --since replay) and their schedule carries on.
  if (recheckOn && waitFile && fs.existsSync(waitFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(waitFile, 'utf8'));
      for (const e of Array.isArray(arr) ? arr : []) {
        if (!e || !e.item || !e.item.p || !e.item.p.tokenAddr) continue;
        const k = lc(e.item.p.tokenAddr);
        if (seenTokens.has(k)) continue; // already has a final record
        seenTokens.add(k);
        sourceWait.set(k, e);
      }
    } catch (_) { /* a damaged file is ignored, not fatal */ }
  }
  function saveWait() {
    if (!waitFile) return;
    try {
      const tmp = `${waitFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...sourceWait.values()], null, 1));
      fs.renameSync(tmp, waitFile);
    } catch (e) { log(`[source-wait] could not write ${waitFile}: ${e.message}`); }
  }

  // ---- detection log (detections.jsonl) ----------------------------------
  // One line per event. A restart replays the last few minutes, so events
  // already in the file are recognised by key and not written twice.
  const noted = new Set();
  const evKey = (e) => `${e.event}|${lc(e.pool)}|${e.block ?? ''}|${e.logIndex ?? ''}`;
  if (detectFile && fs.existsSync(detectFile)) {
    for (const line of fs.readFileSync(detectFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { noted.add(evKey(JSON.parse(line))); } catch (_) { /* skip a damaged line */ }
    }
  }
  function note(e) {
    if (!detectFile) return;
    const rec = { event: e.event, at: albertaISOString(), ...e };
    const k = evKey(rec);
    if (noted.has(k)) return;
    noted.add(k);
    try { fs.appendFileSync(detectFile, JSON.stringify(rec) + '\n'); } catch (err) { log(`[detections] could not write ${detectFile}: ${err.message}`); }
  }
  const poolKeyOf = (p) => p.poolId || p.poolAddress;
  const poolFields = (p) => ({
    token: p.tokenAddr, version: p.version, base: p.base, fee: Number(p.fee),
    pool: poolKeyOf(p), hooks: p.hooks || null, launchPath: launchPathOf(p),
  });

  // ---- stage 1: creation -> pending
  function registerV3(log_) {
    const { token0, token1, fee, pool } = v3FactoryIface.parseLog(log_).args;
    const picked = pickToken(token0, token1);
    if (!picked) return;
    if (seenTokens.has(lc(picked.tokenAddr))) {
      // a further pool for a token already launched: often a trap pool
      note({ event: 'pool_created', knownToken: true, block: log_.blockNumber, logIndex: log_.logIndex,
        ...poolFields({ version: 'v3', tokenAddr: picked.tokenAddr, base: picked.base, fee, poolAddress: pool }) });
      return;
    }
    const p = {
      version: 'v3', tokenAddr: picked.tokenAddr, base: picked.base, baseAddr: picked.baseAddr,
      fee, poolAddress: pool, label: `v3 ${pool} (${picked.base} pair, fee ${fee})`,
    };
    pendingV3.set(lc(pool), { p, baseIs0: picked.baseIs0, added: 0, createdBlock: log_.blockNumber });
    note({ event: 'pool_created', knownToken: false, block: log_.blockNumber, logIndex: log_.logIndex, ...poolFields(p) });
    vlog(`[pending] ${p.label} — token ${p.tokenAddr}`);
  }
  function registerV4(log_) {
    const a = pmIface.parseLog(log_).args;
    const picked = pickToken(a.currency0, a.currency1);
    if (!picked) return;
    if (seenTokens.has(lc(picked.tokenAddr))) {
      note({ event: 'pool_created', knownToken: true, block: log_.blockNumber, logIndex: log_.logIndex,
        ...poolFields({ version: 'v4', tokenAddr: picked.tokenAddr, base: picked.base, fee: a.fee, poolId: a.id, hooks: a.hooks }) });
      return;
    }
    const pairName = picked.base === 'ETH' ? 'native ETH' : picked.base;
    const p = {
      version: 'v4', tokenAddr: picked.tokenAddr, base: picked.base, baseAddr: picked.baseAddr,
      fee: a.fee, poolId: a.id, hooks: a.hooks,
      poolKey: { currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks },
      label: `v4 ${a.id.slice(0, 10)}… (${pairName} pair, fee ${a.fee}, hooks ${lc(a.hooks) === lc(ADDR.ZERO) ? 'none' : a.hooks})`,
    };
    pendingV4.set(lc(a.id), { p, baseIs0: picked.baseIs0, sqrtPriceX96: a.sqrtPriceX96, added: 0, createdBlock: log_.blockNumber });
    note({ event: 'pool_created', knownToken: false, block: log_.blockNumber, logIndex: log_.logIndex, ...poolFields(p) });
    vlog(`[pending] ${p.label} — token ${p.tokenAddr}`);
  }

  // ---- stage 2: liquidity -> launched?
  function onLiquidity(entry, key, map, addedHuman, log_) {
    entry.added += addedHuman;
    const min = entry.p.base === 'USDG' ? minUsdg : minEth;
    note({ event: 'liquidity', block: log_.blockNumber, logIndex: log_.logIndex, token: entry.p.tokenAddr, pool: poolKeyOf(entry.p),
      base: entry.p.base, added: Number(addedHuman.toFixed(6)), total: Number(entry.added.toFixed(6)), minimum: min });
    if (entry.added < min) {
      vlog(`[pending] ${entry.p.label}: ${entry.added.toFixed(4)} ${entry.p.base} added, below ${min}`);
      return;
    }
    map.delete(key);
    const tok = lc(entry.p.tokenAddr);
    if (seenTokens.has(tok)) return; // a second pool for the same token
    seenTokens.add(tok);
    stats.detected += 1;
    const item = {
      p: entry.p, launchPath: launchPathOf(entry.p), baseAdded: entry.added,
      createdBlock: entry.createdBlock, launchBlock: log_.blockNumber, detectedAt: albertaISOString(),
      detectedMs: now(),
    };
    log(`\n*** NEW TOKEN ${entry.p.tokenAddr}  ${item.detectedAt}`);
    log(`    ${entry.p.label}`);
    log(`    ${item.launchPath} — ~${entry.added.toFixed(entry.p.base === 'USDG' ? 0 : 3)} ${entry.p.base} added — block ${log_.blockNumber}`);
    queue.push(item);
    log(`    queued for screening (${queue.length + (working ? 1 : 0)} in line)`);
    note({ event: 'launched', block: log_.blockNumber, logIndex: log_.logIndex, createdBlock: entry.createdBlock,
      baseAdded: Number(entry.added.toFixed(6)), ...poolFields(entry.p) });
    kick();
  }
  function handleMint(log_) {
    const key = lc(log_.address);
    const entry = pendingV3.get(key);
    if (!entry) return;
    const { amount0, amount1 } = v3PoolIface.parseLog(log_).args;
    const raw = entry.baseIs0 ? amount0 : amount1;
    onLiquidity(entry, key, pendingV3, Number(ethers.utils.formatUnits(raw, baseDecimals(entry.p.base))), log_);
  }
  function handleModify(log_) {
    const a = pmIface.parseLog(log_).args;
    const key = lc(a.id);
    const entry = pendingV4.get(key);
    if (!entry || ethers.BigNumber.from(a.liquidityDelta).lte(0)) return;
    const amt = positionAmounts({ sqrtPriceX96: entry.sqrtPriceX96, tickLower: a.tickLower, tickUpper: a.tickUpper, liquidity: a.liquidityDelta });
    const raw = entry.baseIs0 ? amt.amount0Raw : amt.amount1Raw;
    onLiquidity(entry, key, pendingV4, raw / 10 ** baseDecimals(entry.p.base), log_);
  }

  // ---- one block range
  // ethers v5's provider.getLogs() rejects a LIST of addresses (it tries to
  // resolve the array as an ENS name), although eth_getLogs itself accepts one.
  // A list goes out as a raw eth_getLogs call; a single address uses getLogs().
  async function getLogs(filter, from, to) {
    if (!Array.isArray(filter.address)) {
      return provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
    }
    const raw = await provider.send('eth_getLogs', [{
      address: filter.address,
      topics: filter.topics,
      fromBlock: ethers.utils.hexValue(from),
      toBlock: ethers.utils.hexValue(to),
    }]);
    return (raw || []).map((l) => ({
      ...l,
      blockNumber: ethers.BigNumber.from(l.blockNumber).toNumber(),
      logIndex: ethers.BigNumber.from(l.logIndex).toNumber(),
    }));
  }
  async function scanRange(from, to) {
    // creations first, so a pool created and seeded inside one range is caught
    const [created, inits] = await Promise.all([
      getLogs({ address: ADDR.UNISWAP_V3_FACTORY, topics: [T.poolCreated] }, from, to),
      getLogs({ address: ADDR.UNIV4_POOL_MANAGER, topics: [T.initialize] }, from, to),
    ]);
    [...created, ...inits].sort(byPosition).forEach((l) => (l.topics[0] === T.poolCreated ? registerV3(l) : registerV4(l)));

    const liq = [];
    for (const addrs of chunk([...pendingV3.values()].map((e) => e.p.poolAddress), ID_FILTER_MAX)) {
      liq.push(...await getLogs({ address: addrs, topics: [T.mint] }, from, to));
    }
    for (const ids of chunk([...pendingV4.values()].map((e) => e.p.poolId), ID_FILTER_MAX)) {
      liq.push(...await getLogs({ address: ADDR.UNIV4_POOL_MANAGER, topics: [T.modify, ids] }, from, to));
    }
    liq.sort(byPosition).forEach((l) => (l.topics[0] === T.mint ? handleMint(l) : handleModify(l)));

    for (const map of [pendingV3, pendingV4]) {
      for (const [k, e] of map) {
        if (to - e.createdBlock <= PENDING_TTL_BLOCKS) continue;
        // never reached the launch minimum within ~24h
        note({ event: 'expired', block: e.createdBlock, logIndex: 'ttl', createdBlock: e.createdBlock, atBlock: to,
          baseAdded: Number(e.added.toFixed(6)), ...poolFields(e.p) });
        map.delete(k);
      }
    }
  }

  let nextBlock = null;
  async function start({ sinceSec = null } = {}) {
    const head = await provider.getBlockNumber();
    nextBlock = sinceSec ? Math.max(0, head - Math.round(sinceSec * BLOCKS_PER_SEC)) : head + 1;
    if (sinceSec) {
      // pin the start to a real timestamp rather than the nominal block rate
      try {
        const { blockAtTime } = require('./controller-check');
        const latest = await provider.getBlock('latest');
        nextBlock = await blockAtTime(provider, latest.timestamp - sinceSec);
      } catch (_) { /* nominal estimate is fine */ }
    }
    return { head, fromBlock: nextBlock };
  }
  // Scan from nextBlock to the chain head, then run any source re-checks that
  // are due. Returns the head reached.
  async function pollOnce() {
    const head = await provider.getBlockNumber();
    while (nextBlock <= head) {
      const to = Math.min(head, nextBlock + LOG_CHUNK_BLOCKS - 1);
      await scanRange(nextBlock, to);
      nextBlock = to + 1;
    }
    // Not awaited: an explorer that is slow or down must never hold up launch
    // detection. checkSourceWait() guards itself against running twice at once.
    checkSourceWait().catch((e) => log(`[source-wait] re-check error: ${e.message}`));
    reportExplorer();
    return head;
  }

  // ---- source re-check list (2026-10-16) ----------------------------------
  // A token lands here when screen() answers SOURCE PENDING: source not published
  // yet, liquidity not pullable (Gate 1b LOCKED or UNKNOWN), nothing simulated.
  function waitForSource(item, symbol, r) {
    const k = lc(item.p.tokenAddr);
    const entry = {
      item, symbol,
      controllerAtLaunch: r.controller || null,
      flagsAtLaunch: r.flags || [],
      reasonAtLaunch: r.reason,
      slotsDone: 0, lookups: 0, lastCheck: null,
    };
    sourceWait.set(k, entry);
    stats.sourceWaiting += 1;
    saveWait();
    note({ event: 'source_wait', block: item.launchBlock, logIndex: 'source_wait', token: item.p.tokenAddr, pool: poolKeyOf(item.p),
      launchPath: item.launchPath, controller: r.controller ? r.controller.verdict : null, schedule: recheckDelays });
    log(`==> SOURCE PENDING  ${symbol || ''} ${item.p.tokenAddr}`);
    log(`    ${r.reason}`);
    log(`    re-checking the source ${recheckDelays.map((x) => `+${x}s`).join(', ')} after launch (${sourceWait.size} waiting)`);
  }

  // ---- explorer quota guard (2026-10-18) -----------------------------------
  const heldCount = () => { let n = 0; for (const e of sourceWait.values()) if (e.hold) n += 1; return n; };
  function quotaHit(where) {
    outage.failures += 1;
    const t = now();
    if (!outage.since) {
      outage.since = t;
      outage.lastAlarm = t;
      alarm(`[${albertaISOString()}] EXPLORER QUOTA EXHAUSTED (HTTP 402 at ${where}): source lookups are failing. `
        + `New tokens are held; one is re-tried every ${Math.round(holdRetrySec / 60)} min. Blockscout credits reset at 00:00 UTC.`);
    } else if (t - outage.lastAlarm >= 3600e3) {
      outage.lastAlarm = t;
      alarm(`[${albertaISOString()}] explorer quota still exhausted after ${hrs(t - outage.since)}: ${outage.failures} failed lookups, ${heldCount()} tokens held`);
    }
  }
  function quotaOk() {
    if (!outage.since) return;
    alarm(`[${albertaISOString()}] explorer answering again after ${hrs(now() - outage.since)} (${outage.failures} failed lookups); ${heldCount()} held tokens released`);
    outage.since = null;
    outage.failures = 0;
  }
  function hold(item, symbol, why) {
    const k = lc(item.p.tokenAddr);
    const prev = sourceWait.get(k) || {};
    const since = item.quotaHold && item.quotaHold.since != null ? item.quotaHold.since : now();
    const { quotaHold, ...plain } = item;
    sourceWait.set(k, {
      item: plain, symbol,
      controllerAtLaunch: prev.controllerAtLaunch || null,
      hold: { since, lastTry: now(), tries: (item.quotaHold && item.quotaHold.tries) || 0, why: String(why || '').slice(0, 200) },
    });
    if (!item.quotaHold) stats.quotaHeld += 1;
    saveWait();
    log(`==> HELD (explorer quota)  ${symbol || ''} ${item.p.tokenAddr} (${heldCount()} held)`);
  }
  function releaseHeld(k, e, t) {
    sourceWait.delete(k);
    stats.quotaReleased += 1;
    const quotaHold = { since: e.hold.since, heldSec: Math.round((t - e.hold.since) / 1000), tries: e.hold.tries, released: true };
    queue.push({ ...e.item, symbol: e.symbol, quotaHold });
  }
  // Held tokens: write off the stale ones, then one probe lookup if one is due.
  async function checkHeld() {
    const t = now();
    for (const [k, e] of [...sourceWait]) {
      if (!e.hold || (t - e.hold.since) / 1000 < holdMaxSec) continue;
      sourceWait.delete(k);
      stats.quotaExpired += 1;
      const heldSec = Math.round((t - e.hold.since) / 1000);
      log(`\n--- held token written off after ${Math.round(heldSec / 60)} min (explorer quota): ${e.symbol || ''} ${e.item.p.tokenAddr} ---`);
      finish({ ...e.item, quotaHold: { since: e.hold.since, heldSec, tries: e.hold.tries, released: false } }, e.symbol, {
        verdict: 'UNKNOWN',
        reason: `explorer quota exhausted (HTTP 402): source never checked; held ${Math.round(heldSec / 60)} min, then written off`,
        gate: 0, flags: ['explorer quota outage'], controller: e.controllerAtLaunch || null,
      }, t);
    }
    const due = [...sourceWait].filter(([, e]) => e.hold && (t - e.hold.lastTry) / 1000 >= holdRetrySec);
    if (!due.length) return;
    const [k0, e0] = due[0]; // oldest first: a Map keeps insertion order
    e0.hold.lastTry = t;
    e0.hold.tries += 1;
    let src;
    try { src = await sourceGateFn(e0.item.p.tokenAddr); } catch (err) { src = { decision: 'ERROR', reason: err.message }; }
    if (src.decision === 'ERROR') {
      if (isQuota(src.reason)) quotaHit('probe');
      log(`[quota] probe ${e0.symbol || ''} ${e0.item.p.tokenAddr}: ${isQuota(src.reason) ? 'still HTTP 402' : src.reason} (${heldCount()} held)`);
      return;
    }
    if (viaExplorer(src)) {
      quotaOk();
      for (const [k, e] of [...sourceWait]) if (e.hold) releaseHeld(k, e, t);
    } else {
      releaseHeld(k0, e0, t); // Sourcify answered; the explorer itself is still untested
    }
    kick();
  }

  // Explorer requests per hour, from source-gate.js's counter.
  let lastReport = null;
  let lastCalls = null;
  const callSnap = () => ({ calls: explorerStats.calls, byStatus: { ...explorerStats.byStatus } });
  function reportExplorer() {
    if (!explorerStats) return;
    const t = now();
    if (lastReport == null) { lastReport = t; lastCalls = callSnap(); return; }
    if (t - lastReport < 3600e3) return;
    const cur = callSnap();
    const parts = Object.entries(cur.byStatus).map(([st, n]) => [st, n - (lastCalls.byStatus[st] || 0)]).filter(([, n]) => n > 0)
      .map(([st, n]) => `HTTP ${st}: ${n}`);
    log(`[explorer] last ${hrs(t - lastReport)}: ${cur.calls - lastCalls.calls} requests (${parts.join(', ') || 'none'}); ${heldCount()} held${outage.since ? '; QUOTA OUTAGE' : ''}`);
    lastReport = t;
    lastCalls = cur;
  }

  let checkingWait = false;
  async function checkSourceWait() {
    if (!recheckOn || !sourceWait.size || checkingWait) return;
    checkingWait = true;
    try {
      await checkHeld();
      for (const [k, e] of [...sourceWait]) {
        if (e.hold) continue;
        const base = e.item.detectedMs != null ? e.item.detectedMs : now();
        const elapsedSec = (now() - base) / 1000;
        let reached = 0;
        while (reached < recheckDelays.length && elapsedSec >= recheckDelays[reached]) reached += 1;
        if (reached <= e.slotsDone) continue;
        // Slots missed while the bot was down are skipped, not replayed: one lookup now.
        e.slotsDone = reached;
        e.lookups += 1;
        let src;
        try { src = await sourceGateFn(e.item.p.tokenAddr); } catch (err) { src = { decision: 'ERROR', reason: err.message }; }
        if (src.decision === 'ERROR' && isQuota(src.reason)) {
          quotaHit('source re-check');
          hold(e.item, e.symbol, src.reason);
          continue;
        }
        if (viaExplorer(src)) quotaOk();
        e.lastCheck = { at: albertaISOString(), afterSec: Math.round(elapsedSec), decision: src.decision, reason: src.reason };
        const info = {
          hiddenAtLaunch: true,
          controllerAtLaunch: e.controllerAtLaunch ? e.controllerAtLaunch.verdict : null,
          schedule: recheckDelays, checks: e.lookups,
        };
        const tok = e.item.p.tokenAddr;
        if (src.decision === 'PASS') {
          sourceWait.delete(k);
          stats.sourceFound += 1;
          const found = { ...info, foundOnCheck: e.lookups, foundAfterSec: Math.round(elapsedSec), verifiedBy: src.verifiedBy || null, explorerName: src.explorer_name || null };
          log(`\n*** SOURCE NOW PUBLISHED ${e.symbol || ''} ${tok} — ${found.foundAfterSec}s after launch (check ${e.lookups}) — screening`);
          note({ event: 'source_found', block: e.item.launchBlock, logIndex: 'source_found', token: tok, pool: poolKeyOf(e.item.p),
            afterSec: found.foundAfterSec, check: e.lookups, verifiedBy: found.verifiedBy, explorerName: found.explorerName });
          queue.push({ ...e.item, symbol: e.symbol, recheck: found });
          kick();
        } else if (e.slotsDone >= recheckDelays.length) {
          sourceWait.delete(k);
          stats.sourceGaveUp += 1;
          const gave = { ...info, foundOnCheck: null, gaveUpAfterSec: Math.round(elapsedSec), lastDecision: src.decision };
          const unknown = src.decision === 'ERROR';
          const r = {
            verdict: unknown ? 'UNKNOWN' : 'DO NOT SNIP',
            reason: unknown
              ? `source re-check could not complete: ${src.reason}`
              : `source gate: still not published ${Math.round(elapsedSec)}s after launch (${e.lookups} re-checks) — ${src.reason}`,
            gate: 0, sourceHidden: true,
            controller: e.controllerAtLaunch, flags: e.flagsAtLaunch,
          };
          note({ event: 'source_gave_up', block: e.item.launchBlock, logIndex: 'source_gave_up', token: tok, pool: poolKeyOf(e.item.p), afterSec: gave.gaveUpAfterSec, checks: e.lookups });
          log(`\n--- source re-check gave up: ${e.symbol || ''} ${tok} ---`);
          finish({ ...e.item, recheck: gave }, e.symbol, r, now());
        } else {
          vlog(`[source-wait] ${e.symbol || ''} ${tok}: still ${src.decision} at +${Math.round(elapsedSec)}s`);
        }
      }
    } finally {
      checkingWait = false;
      saveWait();
    }
  }

  // ---- stage 3: screening, one at a time
  function kick() {
    if (working) return;
    working = true;
    (async () => {
      while (queue.length) await screenOne(queue.shift());
      working = false;
      idleResolvers.forEach((r) => r());
      idleResolvers = [];
    })();
  }
  function idle() {
    if (!working && !queue.length) return Promise.resolve();
    return new Promise((r) => idleResolvers.push(r));
  }

  async function screenOne(item) {
    const { p } = item;
    const t0 = Date.now();
    let symbol = item.symbol ?? null;
    if (symbol == null) {
      try {
        const raw = await provider.call({ to: p.tokenAddr, data: erc20Iface.encodeFunctionData('symbol') });
        symbol = erc20Iface.decodeFunctionResult('symbol', raw)[0];
      } catch (_) { /* nameless tokens exist */ }
    }

    const controllerOpts = {};
    try {
      const head = await provider.getBlockNumber();
      if (head - item.createdBlock > CONTROLLER_FRESH_WINDOW_BLOCKS) {
        const b = await provider.getBlock(item.createdBlock);
        if (b) controllerOpts.aroundTime = b.timestamp * 1000;
      }
    } catch (_) { /* the default recent window is used */ }

    // Explorer quota outage with tokens already held: hold this one too, without a
    // lookup that would only fail. The probe in checkHeld() decides when it ends.
    if (outage.since && heldCount() > 0 && !item.quotaHold) {
      hold(item, symbol, 'explorer quota exhausted (HTTP 402)');
      return;
    }
    log(`\n--- screening ${symbol || ''} ${p.tokenAddr} (${item.launchPath})${item.recheck ? ' — source published after launch' : ''} ---`);
    // 'probe': a hidden source runs Gate 1b and may come back SOURCE PENDING.
    // A token coming off the re-check list is screened normally ('final').
    const hiddenSource = recheckOn && !item.recheck ? 'probe' : 'final';
    let r;
    try {
      r = await screenFn(p.tokenAddr, { pool: p, amountEth, minLiqEth: minEth, controllerOpts, hiddenSource });
    } catch (e) {
      r = { verdict: 'UNKNOWN', reason: `screener error: ${e.message}`, flags: [] };
    }
    if (r.verdict === 'UNKNOWN' && r.gate === 0 && isQuota(r.reason)) {
      quotaHit('Gate 0');
      hold(item, symbol, r.reason);
      return;
    }
    // A finished screen clears the outage only when nobody is held; held tokens wait for a probe
    // that reached the explorer itself (Gate 0 may have passed on Sourcify alone).
    if (outage.since && r.verdict !== 'UNKNOWN' && heldCount() === 0) quotaOk();
    if (r.verdict === 'SOURCE PENDING' && hiddenSource === 'probe') {
      waitForSource(item, symbol, r);
      return;
    }
    finish(item, symbol, r, t0);
  }

  // Everything after the screen: flags, log lines, the launches.jsonl record and
  // the screens/ file. Shared by screenOne and the re-check list's final verdict.
  function finish(item, symbol, r, t0) {
    const { p } = item;
    const flags = [...(r.flags || [])];
    const sourceHidden = r.sourceHidden === true || (r.gate === 0 && r.verdict === 'DO NOT SNIP');
    const ctlWallet = r.controller && r.controller.verdict === 'CREATOR_CAN_PULL' ? lc(r.controller.controller) : null;
    if (ctlWallet) {
      const before = controllerCount.get(ctlWallet) || 0;
      if (before) flags.push(`repeat controller: ${r.controller.controller} controlled ${before} earlier launch(es)`);
      controllerCount.set(ctlWallet, before + 1);
    }

    log(`==> ${r.verdict}  ${symbol || ''} ${p.tokenAddr}`);
    log(`    ${r.reason}`);
    if (sourceHidden) log('    SOURCE HIDDEN — marked and skipped');
    flags.forEach((f) => log(`    FLAG: ${f}`));
    (r.links || []).forEach((l) => log(`    ${l}`));

    const record = {
      detectedAt: item.detectedAt,
      screenedAt: albertaISOString(),
      screenSeconds: Math.round((Date.now() - t0) / 1000),
      token: p.tokenAddr,
      symbol,
      version: p.version,
      base: p.base,
      poolId: p.poolId || null,
      poolAddress: p.poolAddress || null,
      hooks: p.hooks || null,
      launchPath: item.launchPath,
      baseAddedEst: Number(item.baseAdded.toFixed(6)),
      createdBlock: item.createdBlock,
      launchBlock: item.launchBlock,
      verdict: r.verdict,
      reason: r.reason,
      gate: r.gate ?? null,
      sourceHidden,
      // 2026-10-16: the source re-check list. null = source was public at launch.
      // { hiddenAtLaunch, controllerAtLaunch, schedule, checks, foundOnCheck,
      //   foundAfterSec | gaveUpAfterSec, verifiedBy, explorerName }
      sourceRecheck: item.recheck || null,
      // 2026-10-18: held during an explorer quota outage (HTTP 402). null = never held.
      // { since, heldSec, tries, released }  released:false = written off unscreened
      quotaHold: item.quotaHold || null,
      // Gate 0 accepted an unpublished source by its template (template-match.js).
      sourceTemplate: r.detail && r.detail.templateMatch && r.detail.templateMatch.matched ? r.detail.templateMatch.name : null,
      controller: r.controller || null,
      // Gate 5b and Gate 6 in brief (2026-10-10), for the later scorecard.
      audit: r.audit || null,
      // Gate 5c in brief (2026-10-12): who was probed, ghost count, findings.
      allowance: r.allowance || null,
      rug: r.rug ? {
        removal: r.rug.removal ? r.rug.removal.verdict : null,
        whaleDump: r.rug.whaleDump ? r.rug.whaleDump.verdict : null,
        whaleRecovery: r.rug.whaleDump ? r.rug.whaleDump.recoveryFraction ?? null : null,
        baselineRatio: r.rug.baseline ? r.rug.baseline.ratio ?? null : null,
      } : null,
      flags,
      links: r.links || [],
    };
    results.push(record);
    stats.screened += 1;
    stats.byVerdict[r.verdict] = (stats.byVerdict[r.verdict] || 0) + 1;
    if (outFile) {
      try { fs.appendFileSync(outFile, JSON.stringify(record) + '\n'); } catch (e) { log(`[record] could not write ${outFile}: ${e.message}`); }
    }
    writeDetail(record, r);
  }

  // screens/<YYYY-MM-DD>/<HHMMSS>_<SYMBOL>_<token>.json — the record plus every
  // gate's full result (r.detail), as plain JSON. Never stops the watcher.
  function writeDetail(record, r) {
    if (!detailDir) return null;
    try {
      const stamp = String(record.screenedAt || albertaISOString());
      const day = stamp.slice(0, 10);
      const hms = stamp.slice(11, 19).replace(/:/g, '');
      const sym = String(record.symbol || 'NOSYMBOL').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'NOSYMBOL';
      const dir = path.join(detailDir, day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${hms}_${sym}_${record.token}.json`);
      const { safeStringify } = require('./safe-json');
      const { detail, ...rest } = r || {};
      fs.writeFileSync(file, safeStringify({ record, result: rest, detail: detail || null }, 2));
      return file;
    } catch (e) {
      log(`[detail] could not write the full screen file: ${e.message}`);
      return null;
    }
  }

  return {
    start, pollOnce, idle, scanRange, checkSourceWait, reportExplorer, results, stats,
    _state: { pendingV3, pendingV4, seenTokens, queue, controllerCount, sourceWait, outage },
  };
}

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
  let sinceSec;
  try { sinceSec = parseSince(flag('--since', null)); } catch (e) { console.log(e.message); process.exit(1); }
  const once = args.includes('--once');
  const pollSec = Number(flag('--poll', 10));
  const outFile = path.resolve(__dirname, flag('--out', 'launches.jsonl'));
  const detectFile = path.resolve(__dirname, flag('--detections', 'detections.jsonl'));
  const detailDir = path.resolve(__dirname, flag('--screens', 'screens'));
  const waitFile = path.resolve(__dirname, flag('--wait-file', 'source-wait.json'));
  const sourceRecheckSec = args.includes('--no-source-recheck')
    ? [] : String(flag('--source-recheck', '30,60,120,300')).split(',').map(Number).filter((x) => Number.isFinite(x) && x >= 0);

  // Everything printed to the terminal — including every gate line from
  // screen-token.js — is also written to a text file, so long runs survive
  // the terminal's scrollback limit.
  const stamp = albertaISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const logFile = path.resolve(__dirname, flag('--log', path.join('logs', `watch-${stamp}.txt`)));
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (_) { /* reported below */ }
  const util = require('util');
  const tee = (orig) => (...a) => {
    orig(...a);
    try { fs.appendFileSync(logFile, util.format(...a) + '\n'); } catch (_) { /* never stop the watcher over the log */ }
  };
  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));
  console.warn = tee(console.warn.bind(console));
  console.log(`Log file: ${logFile}`);

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const w = createWatcher({
    provider,
    amountEth: Number(flag('--amount', 0.05)),
    minEth: Number(flag('--min-eth', 1)),
    minUsdg: Number(flag('--min-usdg', 1000)),
    outFile,
    detectFile,
    detailDir,
    waitFile,
    sourceRecheckSec,
    holdRetrySec: Number(flag('--hold-retry', 600)),
    holdMaxSec: Number(flag('--hold-max', 3600)),
    verbose: process.env.VERBOSE === '1',
  });

  const summary = () => {
    const v = Object.entries(w.stats.byVerdict).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    console.log(`\nDetected ${w.stats.detected}, screened ${w.stats.screened} (${v}). Records: ${outFile}`);
    console.log(`Source re-check: ${w.stats.sourceWaiting} put on the list, ${w.stats.sourceFound} published later, ${w.stats.sourceGaveUp} never published, ${w._state.sourceWait.size} still waiting (${waitFile})`);
    console.log(`Explorer quota guard: ${w.stats.quotaHeld} held, ${w.stats.quotaReleased} released and screened, ${w.stats.quotaExpired} written off`);
    console.log(`Full log: ${logFile}`);
  };
  process.on('SIGINT', () => { summary(); process.exit(0); });

  (async () => {
    const { head, fromBlock } = await w.start({ sinceSec });
    console.log(`watch-launches — Robinhood Chain 4663 — ${albertaISOString()}`);
    console.log(sinceSec
      ? `Replaying from block ${fromBlock} (~${(sinceSec / 3600).toFixed(1)}h back), head ${head}`
      : `Watching from block ${fromBlock}`);
    console.log(`Polling every ${pollSec}s. Launch = >= ${flag('--min-eth', 1)} ETH or ${flag('--min-usdg', 1000)} USDG added. Ctrl+C to stop.`);
    console.log(sourceRecheckSec.length
      ? `Hidden source: Gate 1b first, then re-check at ${sourceRecheckSec.map((x) => `+${x}s`).join(', ')} (${w._state.sourceWait.size} on the list from before)`
      : 'Hidden source: final at Gate 0 (--no-source-recheck)');

    let failures = 0;
    for (;;) {
      try {
        await w.pollOnce();
        failures = 0;
      } catch (e) {
        failures += 1;
        console.log(`[poll] RPC error (${failures} in a row, retrying): ${e.message}`);
        await sleep(Math.min(60, pollSec * failures) * 1000);
        continue;
      }
      if (once) {
        await w.idle();
        summary();
        process.exit(0);
      }
      await sleep(pollSec * 1000);
    }
  })().catch((e) => { console.log(`watch-launches error: ${e.message}`); process.exit(2); });
}

module.exports = { createWatcher, pickToken, positionAmounts, launchPathOf, parseSince, albertaISOString };
