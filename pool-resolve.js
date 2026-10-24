// pool-resolve.js — find a token's pool even when the Initialize event is long
// out of log range.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// discoverPool() in screen-token.js finds a v4 pool by scanning the PoolManager
// for its Initialize event. That works beautifully for the job it was written
// for — a token that launched minutes ago — and not at all for anything older,
// because this chain produces blocks roughly every 100ms. The 200,000-block
// window is about five hours. A two-week-old token's Initialize event is some
// twelve million blocks back, and scanning that in 10k-block chunks is 1,200
// requests.
//
// So the first live run against a real token from the ground-truth spreadsheet
// failed with "no WETH or native-ETH pool found" — not a finding about the
// token, just a lookback that was never meant for archaeology.
//
// Three routes to the same answer, tried in order:
//
//   1. discoverPool()      the live scan. Right for a fresh launch.
//   2. the JSONL cache     v2-screening-data.jsonl already records version,
//                          poolId, fee, hooks and base for every token the old
//                          screener ever looked at. Free, instant, offline.
//   3. --pool-id / --fee   explicit, for anything neither of those has.
//
// ---------------------------------------------------------------------------
// THE PART THAT MAKES ROUTES 2 AND 3 TRUSTWORTHY
// ---------------------------------------------------------------------------
// A v4 swap needs the whole PoolKey — currency0, currency1, fee, tickSpacing,
// hooks — but the cache only stores poolId, fee and hooks. tickSpacing and the
// currency ordering are missing.
//
// They do not have to be guessed, because the poolId IS the hash of the
// PoolKey:
//
//     poolId = keccak256(abi.encode(poolKey))
//
// So candidate keys can be built and hashed until one reproduces the recorded
// poolId. A match is proof, not inference: no other PoolKey hashes to it. If
// nothing matches, this returns null and says so rather than handing back a key
// that would revert and look like a hostile token.
//
// Verified against two real pools from the spreadsheet:
//   0x617270…  fee 100    -> tickSpacing 1
//   0x9Ce1b7…  fee 10000  -> tickSpacing 200
//
// ---------------------------------------------------------------------------
// THE USDG GAP (fixed 2026-09-28)
// ---------------------------------------------------------------------------
// The first sweep left 27 of 133 tokens as "pool could not be resolved". Two
// separate causes, both now fixed:
//
//   25 tokens  base currency is USDG, not ETH/WETH. The cache even said so
//              (rec.base === 'USDG'), but descriptorFromCache mapped anything
//              that wasn't 'ETH' to WETH, so the hash never matched.
//    2 tokens  native-ETH pools with tickSpacing 98 and 1400, which were not
//              in the candidate list. (Three USDG pools use 600.)
//
// tickSpacing is now searched exhaustively (1..32767, the v4 maximum) once the
// likely candidates miss. That is ~33k keccaks per ordering and takes well
// under a second because only the tickSpacing word changes between hashes.
// Exhaustive search does not weaken the proof: a hit still means the key
// hashes to the recorded poolId, and nothing else can.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const config = require('./config');

const POOL_KEY_TYPE =
  'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

// Uniswap's canonical fee -> tickSpacing pairs first, then everything else seen
// in the wild. Order only affects speed; correctness comes from the hash.
const TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const TICK_SPACING_CANDIDATES = [
  1, 10, 60, 200, 2, 4, 5, 8, 20, 25, 50, 100, 500, 1000, 2000, 16384,
];

const MAX_TICK_SPACING = 32767; // v4 TickMath.MAX_TICK_SPACING

const lc = (a) => String(a || '').toLowerCase();

// Base currencies this project knows how to name. `decimals` matters: a USDG
// pool's baseLiquidity is dollars (6 decimals), and must never be read as ETH.
function baseInfo(base, addr) {
  const a = addr || config.ADDR;
  switch (String(base || 'ETH').toUpperCase()) {
    case 'ETH': return { base: 'ETH', baseAddr: a.ZERO, baseDecimals: 18, label: 'native ETH' };
    case 'WETH': return { base: 'WETH', baseAddr: a.WETH, baseDecimals: 18, label: 'WETH' };
    case 'USDG':
      if (!a.USDG) return null;
      return { base: 'USDG', baseAddr: a.USDG, baseDecimals: 6, label: 'USDG' };
    default: return null;
  }
}

// A v4 hook's permissions are not configuration — they are the low 14 bits of
// its address, fixed when it was deployed. So they can be read with no RPC.
// The two that matter for fee accounting are the *_RETURNS_DELTA flags: they
// let the hook take a slice of a swap, which shows up as "the pool paid out X
// but the wallet got less" even though the token itself taxes nothing.
const HOOK_FLAGS = {
  beforeInitialize: 1 << 13, afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11, afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9, afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7, afterSwap: 1 << 6,
  beforeDonate: 1 << 5, afterDonate: 1 << 4,
  beforeSwapReturnsDelta: 1 << 3, afterSwapReturnsDelta: 1 << 2,
  afterAddLiquidityReturnsDelta: 1 << 1, afterRemoveLiquidityReturnsDelta: 1 << 0,
};

function hookPermissions(hooks) {
  const h = lc(hooks);
  if (!/^0x[0-9a-f]{40}$/.test(h) || /^0x0{40}$/.test(h)) return null;
  const bits = parseInt(h.slice(-4), 16) & 0x3fff;
  const out = { address: ethers.utils.getAddress(h), bits };
  for (const [k, v] of Object.entries(HOOK_FLAGS)) out[k] = (bits & v) !== 0;
  // Can the hook change what a swapper receives?
  out.canTakeSwapFee = out.beforeSwapReturnsDelta || out.afterSwapReturnsDelta;
  // Can the hook interfere with liquidity being removed (e.g. block or skim it)?
  out.gatesLiquidityRemoval = out.beforeRemoveLiquidity || out.afterRemoveLiquidityReturnsDelta;
  return out;
}

// Known hooks on chain 4663. A name is a label for humans, never a pass: the
// permission bits above are what the analysis uses.
const KNOWN_HOOKS = {
  '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044': 'Pons V2 meme hook (graduated launches; LP locked in PonsV2LaunchLocker)',
  '0x2380abf72c17aabab76480244759ac7e2932eecc': 'Bags V4 hook',
};
const knownHookName = (hooks) => KNOWN_HOOKS[lc(hooks)] || null;

function poolIdOf(poolKey) {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode([POOL_KEY_TYPE], [poolKey]));
}

/**
 * Rebuilds a full v4 PoolKey from what the cache actually stores, and proves it
 * by hashing back to the recorded poolId.
 *
 * Both currency orderings are tried because v4 sorts currency0 < currency1 by
 * address, and whether the token or the base sorts first depends entirely on
 * the token's address. Native ETH (the zero sentinel) always sorts first, but
 * letting the hash decide costs one extra keccak and removes the assumption.
 *
 * @returns { poolKey, tickSpacing, verified: true } or null
 */
function reconstructV4PoolKey({ tokenAddr, baseAddr, fee, hooks, poolId }) {
  if (!poolId || fee == null) return null;
  if (!tokenAddr || !baseAddr) return null;
  const hooksAddr = hooks || config.ADDR.ZERO;
  const preferred = TICK_SPACING_BY_FEE[Number(fee)];
  const likely = preferred == null
    ? TICK_SPACING_CANDIDATES
    : [preferred, ...TICK_SPACING_CANDIDATES.filter((t) => t !== preferred)];

  const orderings = [
    { currency0: baseAddr, currency1: tokenAddr },
    { currency0: tokenAddr, currency1: baseAddr },
  ];
  const want = lc(poolId);

  // abi.encode of an all-static tuple is five 32-byte words, so the encoding
  // is built once per ordering and only the tickSpacing word is rewritten.
  const word = (hex) => ethers.utils.zeroPad(ethers.utils.arrayify(hex), 32);
  const build = (order) => {
    const buf = new Uint8Array(160);
    buf.set(word(ethers.utils.getAddress(order.currency0)), 0);
    buf.set(word(ethers.utils.getAddress(order.currency1)), 32);
    buf.set(word(ethers.BigNumber.from(Number(fee)).toHexString()), 64);
    buf.set(word(ethers.utils.getAddress(hooksAddr)), 128);
    return buf;
  };
  const setSpacing = (buf, ts) => {
    for (let i = 96; i < 128; i += 1) buf[i] = 0;
    buf[124] = (ts >>> 24) & 0xff; buf[125] = (ts >>> 16) & 0xff;
    buf[126] = (ts >>> 8) & 0xff; buf[127] = ts & 0xff;
  };
  const hit = (order, tickSpacing) => ({
    poolKey: {
      currency0: ethers.utils.getAddress(order.currency0),
      currency1: ethers.utils.getAddress(order.currency1),
      fee: Number(fee),
      tickSpacing,
      hooks: ethers.utils.getAddress(hooksAddr),
    },
    tickSpacing,
    verified: true,
  });

  const bufs = orderings.map(build);
  // Pass 1: the likely spacings, both orderings. Pass 2: everything else.
  const tried = new Set(likely);
  const passes = [likely, null];
  for (const pass of passes) {
    for (let o = 0; o < orderings.length; o += 1) {
      const buf = bufs[o];
      const test = (ts) => { setSpacing(buf, ts); return lc(ethers.utils.keccak256(buf)) === want; };
      if (pass) {
        for (const ts of pass) if (test(ts)) return hit(orderings[o], ts);
      } else {
        for (let ts = 1; ts <= MAX_TICK_SPACING; ts += 1) {
          if (!tried.has(ts) && test(ts)) return hit(orderings[o], ts);
        }
      }
    }
  }
  return null;
}

// Most recent record for a token in the old screener's JSONL log. The file is
// append-only, so later lines win.
function readCache(tokenAddr, cacheFile) {
  if (!cacheFile || !fs.existsSync(cacheFile)) return null;
  const want = lc(tokenAddr);
  let best = null;
  let raw;
  try { raw = fs.readFileSync(cacheFile, 'utf8'); } catch (_) { return null; }
  for (const line of raw.split('\n')) {
    if (!line || lc(line).indexOf(want) === -1) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (lc(rec.tokenAddr) !== want) continue;
    best = rec; // later lines overwrite earlier ones
  }
  return best;
}

// Turns one cache record into the pool descriptor the rest of the project uses.
function descriptorFromCache(rec, addr) {
  if (!rec || !rec.version) return null;

  if (rec.version === 'v3') {
    if (!rec.poolAddress) return null;
    return {
      version: 'v3',
      tokenAddr: ethers.utils.getAddress(rec.tokenAddr),
      base: 'WETH',
      baseAddr: addr.WETH,
      baseDecimals: 18,
      fee: Number(rec.fee),
      poolAddress: ethers.utils.getAddress(rec.poolAddress),
      label: `v3 ${rec.poolAddress} (WETH pair, fee ${rec.fee}) [from cache]`,
      source: 'cache',
    };
  }

  if (rec.version === 'v4') {
    // The recorded base is tried first; the others only as a fallback, so an
    // old record with a wrong or missing `base` can still be proved. The hash
    // decides, never the label.
    const recorded = String(rec.base || 'ETH').toUpperCase();
    const order = [recorded, ...['ETH', 'WETH', 'USDG'].filter((b) => b !== recorded)];
    let rebuilt = null;
    let bi = null;
    for (const b of order) {
      bi = baseInfo(b, addr);
      if (!bi) continue;
      rebuilt = reconstructV4PoolKey({
        tokenAddr: rec.tokenAddr, baseAddr: bi.baseAddr, fee: rec.fee, hooks: rec.hooks, poolId: rec.poolId,
      });
      if (rebuilt) break;
    }
    if (!rebuilt) return null; // could not prove a key — say nothing rather than guess
    return {
      version: 'v4',
      tokenAddr: ethers.utils.getAddress(rec.tokenAddr),
      base: bi.base,
      baseAddr: bi.baseAddr,
      baseDecimals: bi.baseDecimals,
      fee: Number(rec.fee),
      poolId: rec.poolId,
      hooks: rebuilt.poolKey.hooks,
      poolKey: rebuilt.poolKey,
      label: `v4 ${String(rec.poolId).slice(0, 10)}… (${bi.label} pair, fee ${rec.fee}, tickSpacing ${rebuilt.tickSpacing}, hooks ${rebuilt.poolKey.hooks === addr.ZERO ? 'none' : rebuilt.poolKey.hooks}) [from cache, key verified against poolId]`,
      source: 'cache',
      // The reserves the old screener measured. Not current, but enough to size
      // a sell leg, and far better than refusing to run.
      cachedBaseLiquidity: rec.baseLiquidity ?? null,
      cachedTokenLiquidity: rec.tokenLiquidity ?? null,
    };
  }
  return null;
}

/**
 * @param tokenAddr the token
 * @param opts
 *   discover      the live discoverPool(); omit to skip route 1
 *   cacheFile     path to v2-screening-data.jsonl; defaults to a few likely spots
 *   poolId, fee, hooks, base   explicit override (route 3)
 *   addr          config.ADDR
 *   prefer        'live' (default) or 'cache'
 *
 * @returns a pool descriptor with `.source` set to 'live' | 'cache' | 'explicit',
 *          or null. Never returns a partially-built v4 key.
 */
async function resolvePool(tokenAddr, opts = {}) {
  const addr = opts.addr || config.ADDR;
  const notes = [];

  // ---- route 3 first when given explicitly: the caller knows best ---------
  if (opts.poolId && opts.fee != null) {
    const bi = baseInfo(opts.base || 'ETH', addr);
    if (!bi) return { error: `--base ${opts.base} is not a known base currency (ETH, WETH or USDG).` };
    const rebuilt = reconstructV4PoolKey({
      tokenAddr,
      baseAddr: bi.baseAddr,
      fee: opts.fee,
      hooks: opts.hooks || addr.ZERO,
      poolId: opts.poolId,
    });
    if (!rebuilt) {
      return {
        error: `--pool-id ${opts.poolId} does not hash back from any candidate PoolKey for this token at fee ${opts.fee}. Either the fee, the hooks address or the base currency is wrong — a key that does not hash to the recorded id would revert and look like a hostile token, so it is refused here.`,
      };
    }
    return {
      version: 'v4',
      tokenAddr: ethers.utils.getAddress(tokenAddr),
      base: bi.base,
      baseAddr: bi.baseAddr,
      baseDecimals: bi.baseDecimals,
      fee: Number(opts.fee),
      poolId: opts.poolId,
      hooks: rebuilt.poolKey.hooks,
      poolKey: rebuilt.poolKey,
      label: `v4 ${String(opts.poolId).slice(0, 10)}… (${bi.label} pair, fee ${opts.fee}, tickSpacing ${rebuilt.tickSpacing}) [explicit, key verified against poolId]`,
      source: 'explicit',
    };
  }

  const order = opts.prefer === 'cache' ? ['cache', 'live'] : ['live', 'cache'];

  for (const route of order) {
    if (route === 'live' && typeof opts.discover === 'function') {
      try {
        const p = await opts.discover(tokenAddr);
        if (p) return { ...p, source: 'live' };
        notes.push('the live Initialize scan found nothing in range');
      } catch (e) {
        notes.push(`the live scan errored: ${e.message}`);
      }
    }
    if (route === 'cache') {
      const files = opts.cacheFile ? [opts.cacheFile] : defaultCacheFiles();
      for (const f of files) {
        const rec = readCache(tokenAddr, f);
        if (!rec) continue;
        const d = descriptorFromCache(rec, addr);
        if (d) return { ...d, cacheFile: f, notes };
        notes.push(`found a cache record in ${path.basename(f)} but could not rebuild a PoolKey that hashes to its poolId`);
      }
      if (!opts.cacheFile) notes.push('no cache record found in the usual locations');
    }
  }

  return { error: `could not resolve a pool for ${tokenAddr}. ${notes.join('; ')}.`, notes };
}

function defaultCacheFiles() {
  const here = __dirname;
  return [
    path.join(here, 'v2-screening-data.jsonl'),
    path.join(here, '..', 'v2-screening-data.jsonl'),
    path.join(here, '..', 'rh-new-token-screen-proj', 'v2-screening-data.jsonl'),
  ].filter((f) => {
    try { return fs.existsSync(f); } catch (_) { return false; }
  });
}

module.exports = {
  resolvePool,
  reconstructV4PoolKey,
  baseInfo,
  hookPermissions,
  knownHookName,
  HOOK_FLAGS,
  poolIdOf,
  readCache,
  descriptorFromCache,
  defaultCacheFiles,
  POOL_KEY_TYPE,
};
