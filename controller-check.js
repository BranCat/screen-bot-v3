// controller-check.js — who can take this pool's liquidity away?
//
//   node controller-check.js 0xTOKEN                 one token (live pool, or from the cache)
//   node controller-check.js --sweep [--limit N]     every token in v2-screening-data.jsonl,
//                                                    scored against sweep-v2.csv if present
//
// RPC only. No Tenderly, no simulation, no key, no cost beyond public RPC reads.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The September data answered the question the screener exists for, and it was
// not the question the simulations ask. Of 74 pools seeded by an ordinary
// wallet, 73 were drained. Of 46 Pons launchpad pools, whose liquidity sits in
// a permanent locker, none were. No hidden tax or sell trap was found anywhere
// in the sample. A token can pass every simulation — DOGGO: clean, 0.59% round
// trip, sells 100% — and still sit in the group that drained 73 times in 74.
//
// So this asks the cheap, decisive question directly: for the positions that
// hold this pool's liquidity, who holds them NOW, and can that holder pull them?
//
// ---------------------------------------------------------------------------
// HOW
// ---------------------------------------------------------------------------
//   1. Read the pool's ModifyLiquidity events (v4 PoolManager, filtered by
//      poolId) in a window: around the token's first sighting for a cached
//      token, or the last ~6 hours for a fresh launch. A pool is seeded when it
//      is created, so that window holds the seeding positions.
//   2. For each position, read its liquidity NOW from StateView — not from the
//      logs, so a position emptied later reads as empty.
//   3. Resolve the holder. The v4 PositionManager is an ERC721 and its position
//      salt is the tokenId, so ownerOf(tokenId) names who holds the NFT.
//   4. Classify the holder:
//        locker    a known permanent locker (Pons PonsV2LaunchLocker)
//        burn      0x0 / 0x…dEaD — nobody can move it again
//        launchpad a known launchpad contract (not an EOA, not proven locked)
//        eoa       an ordinary wallet — can remove the liquidity at will
//        contract  an unknown contract — cannot say either way
//
// Verdicts, in order of precedence:
//   DRAINED            the positions that seeded the pool are empty now
//   CREATOR_CAN_PULL   an ordinary wallet holds >= 10% of the current liquidity
//   LOCKED             >= 90% is held by a known locker or burned
//   UNKNOWN            anything else — including "found nothing". Never a pass.
//
// v3 pools are not covered yet (2 of 133 tokens); they return UNKNOWN and say so.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');

const config = require('./config');
const { ADDR, RPC_URL } = config;
const { resolvePool, readCache, defaultCacheFiles, knownHookName } = require('./pool-resolve');

const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a || '').toLowerCase();

// ---- addresses --------------------------------------------------------------
const cs = (a) => ethers.utils.getAddress(lc(a));
const POSITION_MANAGER = cs(ADDR.UNIV4_POSITION_MANAGER || '0x58daec3116aae6D93017bAAea7749052E8a04fA7');
const STATE_VIEW = cs(ADDR.UNIV4_STATE_VIEW || '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b');

// Known holders. A name here only decides the CLASS of a holder; every number
// in the verdict still comes from the chain. Sources: docs.bags.fm/robinhood,
// docs.bitquery.io/docs/blockchain/robinhood/pons-api (Sept 2026).
const KNOWN_HOLDERS = {
  [lc(ADDR.PONS_V2_LAUNCH_LOCKER || '0x267444d099b10fb5ed7c3cc7b7c767adca574952')]:
    { kind: 'locker', name: 'PonsV2LaunchLocker (permanent lock)' },
  [lc(ADDR.PONS_V2_LAUNCH_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e')]:
    { kind: 'launchpad', name: 'PonsV2LaunchFactory' },
  '0x0000000000000000000000000000000000000000': { kind: 'burn', name: 'zero address' },
  '0x000000000000000000000000000000000000dead': { kind: 'burn', name: '0x…dEaD' },
};

// Holders recognised by their RUNTIME CODE, not their address. Contracts that
// are deployed once per token (a lock per pool) share one runtime code hash, so
// a single reviewed entry covers every instance. Each entry is added only after
// its verified source has been read and shown to have no path that removes
// liquidity or moves the position NFT out.
//
//   FeeSplitter (src/periphery/FeeSplitter.sol, solc 0.8.26, Sourcify-verified;
//   first seen holding DOGGO 0x59Fb…3b23 via 0xeFF1…ACDf). No owner, no upgrade,
//   no delegatecall, no NFT transfer out; its only DECREASE_LIQUIDITY is hard-coded
//   to 0 (fee collection); it can only ever increase liquidity. Natspec: "Positions
//   sent to this contract are permanently locked and cannot be removed."
//   security-contact security@uniswap.org. Reviewed 2026-09-29.
const KNOWN_CODE_HASHES = {
  // '<keccak256 of runtime code>': { kind: 'locker', name: 'FeeSplitter (permanent lock, verified source)' },
};
// Instances whose source has been reviewed, keyed by address, used to learn the
// code hash on first sight (the hash is then printed so it can be pinned above).
const REVIEWED_LOCK_INSTANCES = {
  '0xeff166aaf189323c58dc27ed1206eb2c37faacdf': { kind: 'locker', name: 'FeeSplitter (permanent lock, verified source)' },
};

// Learn the code hash of each reviewed instance once per provider, so every
// other deployment of the same contract is recognised in the same run.
const _learned = new WeakMap();
async function learnedHashes(provider) {
  if (_learned.has(provider)) return _learned.get(provider);
  const map = { ...KNOWN_CODE_HASHES };
  for (const [a, info] of Object.entries(REVIEWED_LOCK_INSTANCES)) {
    try {
      const code = await provider.getCode(a);
      if (code && code !== '0x') map[ethers.utils.keccak256(code).toLowerCase()] = info;
    } catch (_) { /* unreadable: the instance still matches by address */ }
  }
  _learned.set(provider, map);
  return map;
}

const EOA_PULL_THRESHOLD_PCT = 10;
const LOCKED_THRESHOLD_PCT = 90;

// ~100ms blocks on this chain (see token-screener-v3.js). Used only to size
// windows and to seed the timestamp search; the search itself uses real blocks.
const BLOCKS_PER_SEC = 10;
const WINDOW_BEFORE_SEC = 45 * 60; // first sighting is usually minutes after creation
const WINDOW_AFTER_SEC = 10 * 60;
// If the pool's Initialize is not in the first window, walk back in 6h steps up
// to 48h before the first sighting. Found in the first real sweep: 3 of 133
// pools were created more than 45 min before the old screener first saw them.
const EXTEND_STEP_SEC = 6 * 3600;
const EXTEND_MAX_SEC = 48 * 3600;
const FRESH_LOOKBACK_BLOCKS = 200000; // ~6h, same as screen-token.js
const LOG_CHUNK_BLOCKS = 10000;

const pmIface = new ethers.utils.Interface([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
const stateViewIface = new ethers.utils.Interface([
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);
const erc721Iface = new ethers.utils.Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

// ---- small helpers ----------------------------------------------------------
async function staticCall(provider, to, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    if (!raw || raw === '0x') return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function pct(part, whole) {
  const w = BN(whole);
  if (w.isZero()) return null;
  return Number(BN(part).mul(10000).div(w).toString()) / 100;
}

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const logs = [];
  let truncated = false;
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    try {
      logs.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
    } catch (_) {
      truncated = true;
      break;
    }
  }
  return { logs, truncated };
}

// The block closest to a unix time. Secant search on real block timestamps,
// seeded with the ~100ms block time; typically 3-6 getBlock calls.
async function blockAtTime(provider, tsSec) {
  const head = await provider.getBlock('latest');
  if (tsSec >= head.timestamp) return head.number;
  let aN = head.number;
  let aT = head.timestamp;
  let guess = Math.max(1, Math.round(aN - (aT - tsSec) * BLOCKS_PER_SEC));
  for (let i = 0; i < 20; i += 1) {
    const b = await provider.getBlock(guess);
    if (!b) break;
    const diff = b.timestamp - tsSec;
    if (Math.abs(diff) <= 2) return b.number;
    // secant between the last two probes; fall back to the nominal rate
    const rate = aN !== b.number && aT !== b.timestamp ? (aN - b.number) / (aT - b.timestamp) : BLOCKS_PER_SEC;
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : BLOCKS_PER_SEC;
    aN = b.number; aT = b.timestamp;
    const next = Math.max(1, Math.round(b.number - diff * safeRate));
    if (next === guess) return b.number;
    guess = Math.min(head.number, next);
  }
  return guess;
}

// ---- the check --------------------------------------------------------------

/**
 * @param p        pool descriptor (from resolvePool)
 * @param opts
 *   provider      ethers v5 provider on chain 4663 (required)
 *   aroundTime    a Date / ISO string / ms when the token was first seen; the
 *                 scan window is placed around it. Omit for a fresh launch.
 *   addr          config.ADDR
 */
async function controllerCheck(p, opts = {}) {
  const provider = opts.provider;
  const addr = opts.addr || ADDR;
  const out = { version: p && p.version, poolId: p && p.poolId, hooks: p && p.hooks, notes: [] };
  if (!provider) return { ...out, verdict: 'UNKNOWN', reason: 'no provider' };
  if (!p || p.version !== 'v4') {
    return { ...out, verdict: 'UNKNOWN', reason: `v3 pools are not covered by the controller check yet${p ? '' : ' (no pool)'}` };
  }
  if (p.hooks) {
    const hn = knownHookName(p.hooks);
    if (hn) out.hookName = hn;
  }

  // 1. the window
  let fromBlock;
  let toBlock;
  if (opts.aroundTime != null) {
    const t = Math.floor(new Date(opts.aroundTime).getTime() / 1000);
    if (!Number.isFinite(t)) return { ...out, verdict: 'UNKNOWN', reason: `unreadable aroundTime: ${opts.aroundTime}` };
    const center = await blockAtTime(provider, t);
    fromBlock = Math.max(0, center - WINDOW_BEFORE_SEC * BLOCKS_PER_SEC);
    toBlock = center + WINDOW_AFTER_SEC * BLOCKS_PER_SEC;
    out.window = `around first sighting ${new Date(t * 1000).toISOString()} (blocks ${fromBlock}-${toBlock})`;
  } else {
    const head = await provider.getBlockNumber();
    fromBlock = Math.max(0, head - FRESH_LOOKBACK_BLOCKS);
    toBlock = head;
    out.window = `last ${FRESH_LOOKBACK_BLOCKS} blocks (~6h)`;
  }

  // 2. events
  const mlTopic = pmIface.getEventTopic('ModifyLiquidity');
  const initTopic = pmIface.getEventTopic('Initialize');
  const scan = (from, to) => Promise.all([
    getLogsChunked(provider, { address: addr.UNIV4_POOL_MANAGER, topics: [mlTopic, p.poolId] }, from, to),
    getLogsChunked(provider, { address: addr.UNIV4_POOL_MANAGER, topics: [initTopic, p.poolId] }, from, to),
  ]);
  let [ml, init] = await scan(fromBlock, toBlock);
  if (opts.aroundTime != null && !init.logs.length && !ml.truncated && !init.truncated) {
    let extended = 0;
    while (!init.logs.length && extended < EXTEND_MAX_SEC && fromBlock > 0) {
      const newFrom = Math.max(0, fromBlock - EXTEND_STEP_SEC * BLOCKS_PER_SEC);
      const [ml2, init2] = await scan(newFrom, fromBlock - 1);
      ml = { logs: ml2.logs.concat(ml.logs), truncated: ml.truncated || ml2.truncated };
      init = { logs: init2.logs.concat(init.logs), truncated: init.truncated || init2.truncated };
      fromBlock = newFrom;
      extended += EXTEND_STEP_SEC;
      if (ml2.truncated || init2.truncated) break;
    }
    if (extended) out.window += `; extended back ${extended / 3600}h to block ${fromBlock} to find the pool's creation`;
  }
  if (ml.truncated || init.truncated) out.notes.push('the RPC refused part of the log window, so positions may be missing');
  if (init.logs.length) out.createdBlock = init.logs[0].blockNumber;
  else out.notes.push('the pool\'s Initialize event is not in the window, so seeding positions may be outside it');

  const byKey = new Map();
  for (const log of ml.logs) {
    let ev;
    try { ev = pmIface.parseLog(log); } catch (_) { continue; }
    const { sender, tickLower, tickUpper, liquidityDelta, salt } = ev.args;
    const key = `${lc(sender)}|${tickLower}|${tickUpper}|${salt}`;
    const prev = byKey.get(key) || { sender, tickLower, tickUpper, salt, addedInWindow: BN(0), firstBlock: log.blockNumber };
    if (BN(liquidityDelta).gt(0)) prev.addedInWindow = prev.addedInWindow.add(liquidityDelta);
    byKey.set(key, prev);
  }
  const seeded = [...byKey.values()].filter((x) => x.addedInWindow.gt(0));
  if (!seeded.length) {
    return { ...out, verdict: 'UNKNOWN', reason: 'no liquidity was added to this pool inside the scanned window', positions: [] };
  }

  // 3. each position NOW, and who holds it
  const codeCache = new Map();
  const isContract = async (a) => {
    const k = lc(a);
    if (!codeCache.has(k)) {
      let code = '0x';
      try { code = await provider.getCode(a); } catch (_) { code = null; }
      codeCache.set(k, code);
    }
    const c = codeCache.get(k);
    return c == null ? null : c !== '0x';
  };
  const classify = async (holder) => {
    const known = KNOWN_HOLDERS[lc(holder)];
    if (known) return known;
    const c = await isContract(holder);
    if (c === null) return { kind: 'contract', name: 'code unreadable' };
    if (!c) return { kind: 'eoa', name: 'ordinary wallet' };
    const code = codeCache.get(lc(holder));
    // EIP-7702: an EOA that has delegated to code. Still controlled by a key.
    if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return { kind: 'eoa', name: 'wallet with EIP-7702 delegation', codeHash: null };
    const codeHash = ethers.utils.keccak256(code);
    const byHash = (await learnedHashes(provider))[codeHash.toLowerCase()];
    if (byHash) return { ...byHash, codeHash };
    const reviewed = REVIEWED_LOCK_INSTANCES[lc(holder)];
    if (reviewed) return { ...reviewed, codeHash };
    return { kind: 'contract', name: 'unknown contract', codeHash };
  };

  const positions = [];
  for (const s of seeded) {
    const info = await staticCall(provider, STATE_VIEW, stateViewIface, 'getPositionInfo',
      [p.poolId, s.sender, s.tickLower, s.tickUpper, s.salt]);
    const liqNow = info ? BN(info.liquidity) : null;
    let holder = s.sender;
    let via = null;
    if (lc(s.sender) === lc(POSITION_MANAGER)) {
      via = 'PositionManager NFT';
      const tokenId = BN(s.salt);
      const o = await staticCall(provider, POSITION_MANAGER, erc721Iface, 'ownerOf', [tokenId]);
      holder = o ? o[0] : null; // a burned NFT has no owner
    }
    const cls = holder ? await classify(holder) : { kind: 'burned-nft', name: 'position NFT no longer exists' };
    positions.push({
      holder, holderKind: cls.kind, holderName: cls.name, holderCodeHash: cls.codeHash || null, via,
      sender: s.sender, tokenId: via ? BN(s.salt).toString() : null,
      tickLower: Number(s.tickLower), tickUpper: Number(s.tickUpper),
      addedInWindow: s.addedInWindow.toString(),
      liquidityNow: liqNow == null ? null : liqNow.toString(),
      firstBlock: s.firstBlock,
    });
  }

  const unread = positions.filter((x) => x.liquidityNow == null).length;
  if (unread) out.notes.push(`${unread} position(s) could not be read from StateView`);
  const nowTotal = positions.reduce((a, x) => a.add(x.liquidityNow || 0), BN(0));
  const share = (pred) => pct(positions.filter(pred).reduce((a, x) => a.add(x.liquidityNow || 0), BN(0)), nowTotal);

  out.positions = positions.sort((a, b) => (BN(b.liquidityNow || 0).gt(BN(a.liquidityNow || 0)) ? 1 : -1));
  out.liquidityNow = nowTotal.toString();
  out.eoaSharePct = share((x) => x.holderKind === 'eoa');
  out.lockedSharePct = share((x) => x.holderKind === 'locker' || x.holderKind === 'burn');
  out.launchpadSharePct = share((x) => x.holderKind === 'launchpad');
  out.unknownSharePct = share((x) => x.holderKind === 'contract');
  const liveInRange = await staticCall(provider, STATE_VIEW, stateViewIface, 'getLiquidity', [p.poolId]);
  out.inRangeLiquidityNow = liveInRange ? liveInRange[0].toString() : null;

  // 4. verdict
  if (unread === positions.length) {
    return { ...out, verdict: 'UNKNOWN', reason: 'none of the positions could be read now' };
  }
  if (nowTotal.isZero()) {
    // The seeders left — but that is only a drained POOL if nothing else is in
    // it. Found in the first real sweep: two USDG pools whose 26 and 32 launch
    // positions were all empty still held liquidity added later by others.
    const inRange = out.inRangeLiquidityNow == null ? null : BN(out.inRangeLiquidityNow);
    if (inRange && inRange.gt(0)) {
      return {
        ...out,
        verdict: 'UNKNOWN',
        reason: `all ${positions.length} launch position(s) are empty, but the pool still holds liquidity added later by someone outside the scanned window — who controls it now is not established`,
      };
    }
    return { ...out, verdict: 'DRAINED', reason: `the ${positions.length} position(s) that seeded this pool are empty now, and the pool holds no in-range liquidity` };
  }
  const topEoa = out.positions.find((x) => x.holderKind === 'eoa' && BN(x.liquidityNow || 0).gt(0));
  if (out.eoaSharePct != null && out.eoaSharePct >= EOA_PULL_THRESHOLD_PCT) {
    out.controller = topEoa && topEoa.holder;
    return {
      ...out,
      verdict: 'CREATOR_CAN_PULL',
      reason: `an ordinary wallet (${topEoa.holder}) holds ${out.eoaSharePct}% of the liquidity and can remove it at any time`,
    };
  }
  if (out.lockedSharePct != null && out.lockedSharePct >= LOCKED_THRESHOLD_PCT) {
    const lockHolder = out.positions.find((x) => x.holderKind === 'locker' || x.holderKind === 'burn');
    out.controller = lockHolder && lockHolder.holder;
    return { ...out, verdict: 'LOCKED', reason: `${out.lockedSharePct}% of the liquidity is held by ${lockHolder.holderName}` };
  }
  const why = [];
  if (out.launchpadSharePct) why.push(`${out.launchpadSharePct}% held by a launchpad contract (not proven locked)`);
  if (out.unknownSharePct) why.push(`${out.unknownSharePct}% held by an unknown contract`);
  return { ...out, verdict: 'UNKNOWN', reason: why.join('; ') || 'the holders could not be classified' };
}

// ---- printing -----------------------------------------------------------------
function printCheck(token, r) {
  console.log(`\nToken    ${token}`);
  if (r.poolId) console.log(`Pool     ${String(r.poolId).slice(0, 10)}…${r.hookName ? `  (${r.hookName})` : ''}`);
  if (r.window) console.log(`Window   ${r.window}`);
  if (r.createdBlock) console.log(`Created  block ${r.createdBlock}`);
  if (r.positions && r.positions.length) {
    console.log('\n  holder                                        kind        liquidity now    via');
    console.log('  ' + '-'.repeat(88));
    for (const x of r.positions.slice(0, 8)) {
      console.log(`  ${String(x.holder || '(none)').padEnd(44)}  ${x.holderKind.padEnd(10)}  ${String(x.liquidityNow ?? 'unread').padStart(15)}    ${x.via || 'direct'}`);
    }
  }
  for (const x of (r.positions || []).filter((y) => y.holderCodeHash).slice(0, 3)) {
    console.log(`  ${x.holder} is ${x.holderName}; runtime code hash ${x.holderCodeHash}`);
  }
  console.log(`\n==> ${r.verdict}`);
  console.log(`    ${r.reason}`);
  for (const n of r.notes || []) console.log(`    note: ${n}`);
  console.log('');
}

// ---- batch: every cached token, scored against the drain labels -----------------
// First sighting per token, and per (token, poolId). Some tokens had two or
// three pools; the check examines the pool the resolver picks (the latest), so
// its window must sit around THAT pool's first sighting, not the token's.
// Found in the second sweep: MONEY, HASH and the USDG DOGGO were all searched
// around an earlier, different pool.
function cacheIndex(cacheFile) {
  const first = new Map();
  first.byPool = new Map();
  for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r.tokenAddr) continue;
    const k = lc(r.tokenAddr);
    if (!first.has(k)) first.set(k, r.timestamp || null);
    if (r.poolId) {
      const pk = `${k}|${lc(r.poolId)}`;
      if (!first.byPool.has(pk)) first.byPool.set(pk, r.timestamp || null);
    }
  }
  return first;
}
const firstSeenFor = (idx, token, poolId) =>
  (poolId && idx.byPool.get(`${lc(token)}|${lc(poolId)}`)) || idx.get(lc(token)) || null;

function readCsv(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return rows.map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

async function sweep({ provider, cacheFile, out = 'controller.csv', labels = 'sweep-v2.csv', limit = 0, delayMs = 50 }) {
  const file = cacheFile || defaultCacheFiles()[0];
  if (!file) throw new Error('no v2-screening-data.jsonl found');
  const firstSeen = cacheIndex(file);
  let tokens = [...firstSeen.keys()];
  if (limit) tokens = tokens.slice(0, limit);
  const lab = fs.existsSync(labels) ? Object.fromEntries(readCsv(labels).map((r) => [lc(r.token), r])) : {};

  console.log(`\nController check over ${tokens.length} tokens from ${path.basename(file)} — RPC reads only.\n`);
  const rows = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    let r;
    try {
      const p = await resolvePool(t, { addr: ADDR, cacheFile: file, prefer: 'cache' });
      r = p && !p.error ? await controllerCheck(p, { provider, aroundTime: firstSeenFor(firstSeen, t, p.poolId) }) : { verdict: 'UNKNOWN', reason: 'pool not resolved' };
    } catch (e) {
      r = { verdict: 'UNKNOWN', reason: `error: ${e.message}` };
    }
    const L = lab[t] || {};
    const row = {
      token: ethers.utils.getAddress(t), symbol: L.symbol || '', base: L.base || '',
      drained: L.drained || '', verdict: r.verdict,
      eoaSharePct: r.eoaSharePct ?? '', lockedSharePct: r.lockedSharePct ?? '',
      controller: r.controller || '', positions: r.positions ? r.positions.length : '',
      topHolder: r.positions && r.positions[0] ? r.positions[0].holder || '' : '',
      topHolderKind: r.positions && r.positions[0] ? r.positions[0].holderKind : '',
      topHolderName: r.positions && r.positions[0] ? r.positions[0].holderName : '',
      topHolderCodeHash: r.positions && r.positions[0] ? r.positions[0].holderCodeHash || '' : '',
      createdBlock: r.createdBlock || '', reason: r.reason || '', notes: (r.notes || []).join(' | '),
    };
    rows.push(row);
    process.stdout.write(`  ${String(i + 1).padStart(3)}/${tokens.length}  ${row.verdict.padEnd(16)}  ${String(row.symbol).padEnd(12)} ${row.token}  ${row.drained === 'DRAINED' ? 'DRAINED' : row.drained ? 'alive' : ''}\n`);
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }

  const header = Object.keys(rows[0] || {});
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(out, [header.join(',')].concat(rows.map((r) => header.map((h) => esc(r[h])).join(','))).join('\n') + '\n');
  console.log(`\n  written: ${out}`);
  printScore(rows);
  printHolderTypes(rows);
  return rows;
}

// How well does the verdict line up with what actually happened?
function scoreRows(rows) {
  const verdicts = ['CREATOR_CAN_PULL', 'DRAINED', 'LOCKED', 'UNKNOWN'];
  const table = {};
  for (const v of verdicts) table[v] = { drained: 0, alive: 0, unlabelled: 0 };
  for (const r of rows) {
    const t = table[r.verdict] || (table[r.verdict] = { drained: 0, alive: 0, unlabelled: 0 });
    if (r.drained === 'DRAINED') t.drained += 1;
    else if (r.drained === 'still has liquidity') t.alive += 1;
    else t.unlabelled += 1;
  }
  return table;
}

function printScore(rows) {
  const t = scoreRows(rows);
  console.log('\n  verdict              drained   still alive   unlabelled');
  console.log('  ' + '-'.repeat(58));
  for (const [v, c] of Object.entries(t)) {
    console.log(`  ${v.padEnd(18)}  ${String(c.drained).padStart(8)}  ${String(c.alive).padStart(12)}  ${String(c.unlabelled).padStart(11)}`);
  }
  console.log('');
  console.log('  What "working" looks like:');
  console.log('    DRAINED          -> should be (almost) all drained. It reads the same positions the sweep did.');
  console.log('    LOCKED           -> should be (almost) all alive. A drained LOCKED token is a false lock: investigate.');
  console.log('    CREATOR_CAN_PULL -> alive today, but the group that drained 73/74 in September.');
  console.log('    UNKNOWN          -> the check could not decide. Its size is the coverage gap.');
  console.log('');
}

// Which contract types hold liquidity, grouped by runtime code. Each unknown
// group is one source file to review — and one line in KNOWN_CODE_HASHES if it
// turns out to be a real lock.
function printHolderTypes(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.topHolderCodeHash) continue;
    const g = groups.get(r.topHolderCodeHash) || { name: r.topHolderName, kind: r.topHolderKind, example: r.topHolder, n: 0, drained: 0 };
    g.n += 1; if (r.drained === 'DRAINED') g.drained += 1;
    groups.set(r.topHolderCodeHash, g);
  }
  if (!groups.size) return;
  console.log('  Contract holders by runtime code (review the unknown ones):');
  for (const [h, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${g.kind.padEnd(9)} ${String(g.n).padStart(3)} pools (${g.drained} drained)  ${h}`);
    console.log(`              ${g.name} — e.g. ${g.example}`);
  }
  console.log('');
}

// ---- CLI ----------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

  if (args.includes('--sweep')) {
    sweep({ provider, cacheFile: flag('--cache'), out: flag('--out') || 'controller.csv', limit: Number(flag('--limit') || 0) })
      .catch((e) => { console.log(`\ncontroller sweep error: ${e.message}\n`); process.exit(2); });
  } else {
    const token = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!token) {
      console.log('usage: node controller-check.js 0xTOKEN   |   node controller-check.js --sweep [--limit N]');
      process.exit(1);
    }
    (async () => {
      const { discoverPool } = require('./screen-token');
      const p = await resolvePool(token, { discover: discoverPool, addr: ADDR, prefer: 'cache' });
      if (!p || p.error) { console.log(`\npool lookup: ${p && p.error ? p.error : 'no pool'}\n`); process.exit(1); }
      // A cached token is placed around its first sighting; a live one uses the recent window.
      let aroundTime = null;
      if (p.source === 'cache') {
        const f = p.cacheFile || defaultCacheFiles()[0];
        aroundTime = f ? firstSeenFor(cacheIndex(f), token, p.poolId) : null;
      }
      const r = await controllerCheck(p, { provider, aroundTime });
      if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else printCheck(token, r);
    })().catch((e) => { console.log(`\ncontroller-check error: ${e.message}\n`); process.exit(2); });
  }
}

module.exports = {
  controllerCheck, blockAtTime, cacheIndex, firstSeenFor, scoreRows, printCheck, sweep,
  KNOWN_HOLDERS, KNOWN_CODE_HASHES, REVIEWED_LOCK_INSTANCES, POSITION_MANAGER, STATE_VIEW, EOA_PULL_THRESHOLD_PCT, LOCKED_THRESHOLD_PCT,
};
