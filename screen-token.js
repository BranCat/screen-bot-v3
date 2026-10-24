// screen-token.js — simulation-first screener for ONE token on Robinhood Chain.
//
// The v3/v4 equivalent of the Uniswap V2 swapSimulateCheck() template: a chain
// of gates, each more expensive than the last, ending in an explicit verdict.
// Nothing counts as evidence unless Tenderly actually executed it.
//
//   node screen-token.js 0xTOKEN [--amount 0.05] [--min-liq 1] [--json]
//
// Gates
//   0  source published?           source-gate.js (Sourcify, then the block explorer; proxy-aware)
//                                  2026-10-16, hiddenSource 'probe' (the watcher's mode):
//                                  "not published" no longer ends the screen at once —
//                                    a. bytecode identical to a verified launchpad template
//                                       (template-match.js) -> treated as published;
//                                    b. otherwise Gate 1 + 1b still run (RPC reads only):
//                                       CREATOR_CAN_PULL / DRAINED -> DO NOT SNIP at 1b;
//                                       LOCKED / UNKNOWN -> verdict SOURCE PENDING, and the
//                                       watcher re-checks the source on a schedule.
//                                  No simulation is ever spent on an unpublished source.
//   1  find the pool               every v3/v4 pool, ranked (rankPools): live > launchpad
//                                  hook > fee <= 10% > deepest. ETH/WETH first; USDG if that is all.
//   1b who controls the liquidity  controller-check.js. CREATOR_CAN_PULL or
//                                  DRAINED = DO NOT SNIP; LOCKED = continue;
//                                  UNKNOWN = continue, but flagged on the verdict
//   2  liquidity above minimum     ETH side of the pool (v3; v4 is unmeasured here)
//   3  round trip #1               wallet-round-trip.js from a fresh random wallet:
//                                  buy, then sell 100% (ladder 100/99/95/50%),
//                                  ETH back read from the sell's balance diff
//   4  round trip #2 + judgement   same again from a second fresh wallet, then:
//                                    hidden token tax  <= 0.5%   (the scam signal)
//                                    total cost        <= 7%     (visible hook/pool
//                                                      fees + impact + gas; Frank's limit)
//                                    the two wallets agree within 1.5%
//   5  full exit                   100% must sell (99% allowed, flagged as rounding)
//
// 2026-10-08: Gates 3-5 used to call tenderly-bundle-v4.js directly. For v4
// pools that module needs pool reserves this file never had, so it returned
// "unsupported" per variant — which read as "buy ok, sell ok" with nothing
// simulated (CRTN, the first token to get this far). wallet-round-trip.js sizes
// the sell from the buy's real output and was verified on CRTN the same night.
//   6  rug check                   rug-check.js: position census, liquidity
//                                  removal simulation, whale-dump survival
//
// Two bugs from the V2 script are deliberately not carried over:
//   - the "liquidity is so small" message was attached to the transferFrom
//     branch, so low-liquidity tokens printed nothing and failed-transferFrom
//     tokens printed the wrong reason;
//   - when both simulations were in band but disagreed with each other,
//     nothing was printed at all.
// Here every path ends in exactly one verdict line.

require('dotenv').config();
const ethers = require('ethers');

const config = require('./config');
const { ADDR, RPC_URL, CHAIN_ID } = config;
const { sourceGate } = require('./source-gate');
const { simulateUniV4Txn } = require('./tenderly-bundle-v4');
const { rugCheck } = require('./rug-check');
const { controllerCheck } = require('./controller-check');

// tenderly-bundle-v3.js has not been shared yet. Load it if it is there, and
// report v3 pools as UNKNOWN rather than pretending otherwise if it is not.
let simulateUniV3Txn = null;
try {
  ({ simulateUniV3Txn } = require('./tenderly-bundle-v3'));
} catch (_) { /* handled at Gate 3 */ }

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

// ---------------------------------------------------------------- settings
const BAND_LO = 0.985;          // +/-1.5%, as in the V2 script
const BAND_HI = 1.015;
const AGREE_LO = 0.985;         // sim1 vs sim2
const AGREE_HI = 1.015;
// Gate 4 (Frank, 2026-10-08): hidden token tax is the scam signal and must be ~0;
// visible costs are allowed up to a limit. CRTN (Pons hook ~2.46% per leg) costs 4.93%.
const MAX_HIDDEN_TAX_BPS = 50;          // 0.5% — rounding room only
// 2026-10-19 (Frank): 6% -> 7%. A clean Pons trade is almost all hook fee:
// 1.99%/side = 3.9%, 2.49% = 4.9%, 2.99% = 5.9%, 3.99% = 7.8% round trip. At 6%
// the common 2.99% tier passed by only 0.1%, so any price impact failed it. 7%
// leaves ~1% for impact and gas on the 2.99% tier and still rejects 3.99% (KEPT,
// PALLADIUM, WATER) and anything worse.
const MAX_ROUND_TRIP_COST_PCT = 7;      // total: hook/pool fees + price impact + gas
const MAX_WALLET_DISAGREE_PCT = 1.5;    // sim #1 vs sim #2 ETH back
const MIN_FULL_EXIT_BPS = 9900;         // 99% = rounding; below that is a sell cap
const V3_FEE_TIERS = [100, 500, 3000, 10000];
const V4_LOOKBACK_BLOCKS = 200000;

// ---------------------------------------------------------------- interfaces
const factoryIface = new ethers.utils.Interface([
  'function getPool(address,address,uint24) view returns (address)',
]);
const erc20Iface = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const poolManagerIface = new ethers.utils.Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);

// ---------------------------------------------------------------- helpers
const lc = (s) => String(s).toLowerCase();
const isWethOrEth = (a) => lc(a) === lc(ADDR.WETH) || lc(a) === lc(ADDR.ZERO);
const isUsdg = (a) => !!ADDR.USDG && lc(a) === lc(ADDR.USDG);

function dashboardLink(result) {
  const raw = result?.raw || result;
  const id = raw?.simulation?.id || raw?.id || raw?.transaction?.id;
  const { TENDERLY_ACCOUNT_SLUG: acct, TENDERLY_PROJECT_SLUG: proj } = process.env;
  if (!id || !acct || !proj) return null;
  return `https://dashboard.tenderly.co/${acct}/${proj}/simulator/${id}`;
}

// Collect every dashboard link a bundle result carries, in order.
function collectLinks(simResult) {
  const links = [];
  for (const v of simResult?.variants || []) {
    for (const key of ['buyResult', 'sellResult', 'approveResult', 'results']) {
      const val = v[key];
      if (!val) continue;
      for (const r of Array.isArray(val) ? val : [val]) {
        const l = dashboardLink(r);
        if (l && !links.includes(l)) links.push(l);
      }
    }
  }
  return links;
}

function verdict(kind, reason, extra = {}) {
  return { verdict: kind, reason, ...extra };
}

// ---------------------------------------------------------------- Gate 1
// Collect EVERY pool for the token, then pick one. Taking the first pool found
// was wrong: on 2026-10-08 the Pons token Passkeys was screened against a
// hookless side pool charging an 88% fee (fee 883131) instead of its Pons pool.
// Anyone can create extra pools for a token; a router or bot that lands in the
// wrong one loses most of the trade.
//
// Ranking (rankPools, pure, tested offline):
//   1. a pool with liquidity beats an empty one
//   2. a known launchpad hook (Pons, Bags) beats everything else
//   3. a static fee above 10% loses to any sane one
//   4. v4 by in-range liquidity, v3 by its WETH balance (v4 first, it is where
//      launches happen on this chain)
// Every other pool is reported back on the descriptor (p.otherPools) so the
// screen can flag trap pools.
const MAX_SANE_FEE_PPM = 100000;          // 10%
const DYNAMIC_FEE_FLAG = 0x800000;
const stateViewIface = new ethers.utils.Interface([
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
]);

function staticFeePpm(fee) {
  const f = Number(fee);
  if (!Number.isFinite(f) || (f & DYNAMIC_FEE_FLAG) !== 0) return null; // dynamic: set by the hook per swap
  return f;
}

function rankPools(cands) {
  const { knownHookName } = require('./pool-resolve');
  const score = (c) => {
    const live = c.liquidity != null && Number(c.liquidity) > 0 ? 1 : 0;
    const name = c.version === 'v4' && c.hooks ? knownHookName(c.hooks) : null;
    const launchpad = name && /pons|bags/i.test(name) ? 1 : 0;
    const fee = staticFeePpm(c.fee);
    const sane = fee == null || fee <= MAX_SANE_FEE_PPM ? 1 : 0;
    const v4 = c.version === 'v4' ? 1 : 0;
    return [live, launchpad, sane, v4, Number(c.liquidity || 0)];
  };
  return [...cands].sort((a, b) => {
    const sa = score(a); const sb = score(b);
    for (let k = 0; k < sa.length; k += 1) if (sa[k] !== sb[k]) return sb[k] - sa[k];
    return 0;
  });
}

// allowUsdg: consider USDG pools too (only chosen when no ETH/WETH pool exists).
// Off by default, so the standalone tools (transfer-audit, wallet-round-trip, ...)
// never get one.
// hints: [{ poolId, createdBlock }] — pools already known for this token (from
// launches.jsonl). Added 2026-10-10: the live scan only reaches back 200k blocks
// (~5.5h), so two days after launch CRTN's Pons pool had fallen out of range and
// the scan found only a later 81%-fee trap pool; Passkeys found nothing at all.
// A hint is looked up at its exact creation block (one cheap getLogs) and ranked
// together with whatever the live scan found.
async function discoverPool(tokenAddr, { allowUsdg = false, prov = provider, hints = [] } = {}) {
  const cands = [];
  const factory = new ethers.Contract(ADDR.UNISWAP_V3_FACTORY, factoryIface, prov);
  const weth = new ethers.Contract(ADDR.WETH, erc20Iface, prov);

  for (const fee of V3_FEE_TIERS) {
    let pool;
    try { pool = await factory.getPool(tokenAddr, ADDR.WETH, fee); } catch (e) { continue; }
    if (!pool || pool === ADDR.ZERO) continue;
    let liquidity = null;
    try { liquidity = (await weth.balanceOf(pool)).toString(); } catch (_) { /* unknown */ }
    cands.push({
      version: 'v3', tokenAddr, base: 'WETH', baseAddr: ADDR.WETH, fee, poolAddress: pool, liquidity,
      label: `v3 ${pool} (WETH pair, fee ${fee})`,
    });
  }

  // v4: the pool is identified by its PoolKey, which only exists in the
  // Initialize event — there is no factory to ask.
  const latest = await prov.getBlockNumber();
  const fromBlock = Math.max(0, latest - V4_LOOKBACK_BLOCKS);
  const topic = poolManagerIface.getEventTopic('Initialize');
  const padded = ethers.utils.hexZeroPad(tokenAddr, 32);
  const usdgCands = [];
  async function takeInit(log, from) {
    const a = poolManagerIface.parseLog(log).args;
    if (lc(a.currency0) !== lc(tokenAddr) && lc(a.currency1) !== lc(tokenAddr)) return;
    const other = lc(a.currency0) === lc(tokenAddr) ? a.currency1 : a.currency0;
    const usdg = isUsdg(other);
    if (!isWethOrEth(other) && !usdg) return;
    let liquidity = null;
    try {
      const raw = await prov.call({ to: ADDR.UNIV4_STATE_VIEW, data: stateViewIface.encodeFunctionData('getLiquidity', [a.id]) });
      liquidity = stateViewIface.decodeFunctionResult('getLiquidity', raw)[0].toString();
    } catch (_) { /* unknown */ }
    const base = usdg ? 'USDG' : (lc(other) === lc(ADDR.ZERO) ? 'ETH' : 'WETH');
    const pairName = base === 'ETH' ? 'native ETH' : base;
    const c = {
      version: 'v4', tokenAddr, base, baseAddr: other,
      fee: a.fee, poolId: a.id, hooks: a.hooks, liquidity,
      createdBlock: log.blockNumber ?? null,
      poolKey: { currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks },
      label: `v4 ${a.id.slice(0, 10)}… (${pairName} pair, fee ${a.fee}, hooks ${a.hooks === ADDR.ZERO ? 'none' : a.hooks})${from ? ` [from ${from}]` : ''}`,
    };
    (usdg ? usdgCands : cands).push(c);
  }
  for (const slot of ['currency0', 'currency1']) {
    const topics = slot === 'currency0' ? [topic, null, padded] : [topic, null, null, padded];
    let logs = [];
    try {
      logs = await prov.getLogs({ address: ADDR.UNIV4_POOL_MANAGER, fromBlock, toBlock: latest, topics });
    } catch (e) {
      console.log(`  (v4 log scan failed for ${slot}: ${e.message})`);
      continue;
    }
    for (const log of logs) await takeInit(log, null);
  }

  // Known pools that the live window no longer reaches.
  const seen = new Set([...cands, ...usdgCands].filter((c) => c.poolId).map((c) => lc(c.poolId)));
  for (const h of hints || []) {
    if (!h || !h.poolId || h.createdBlock == null || seen.has(lc(h.poolId))) continue;
    seen.add(lc(h.poolId));
    let logs = [];
    try {
      logs = await prov.getLogs({ address: ADDR.UNIV4_POOL_MANAGER, fromBlock: Number(h.createdBlock), toBlock: Number(h.createdBlock), topics: [topic, h.poolId] });
    } catch (e) {
      console.log(`  (lookup of known pool ${String(h.poolId).slice(0, 10)}… at block ${h.createdBlock} failed: ${e.message})`);
      continue;
    }
    if (!logs.length) console.log(`  (known pool ${String(h.poolId).slice(0, 10)}… not found at block ${h.createdBlock})`);
    for (const log of logs) await takeInit(log, h.source || 'launches.jsonl');
  }

  const pool = cands.length ? cands : (allowUsdg ? usdgCands : []);
  if (!pool.length) return null;
  const [best, ...rest] = rankPools(pool);
  best.otherPools = [...rest, ...(pool === cands ? usdgCands : [])].map((c) => ({
    label: c.label, version: c.version, fee: c.fee, hooks: c.hooks || null, liquidity: c.liquidity,
  }));
  return best;
}

// Flags about the pools a token was NOT screened on (pure, tested offline).
function otherPoolFlags(p) {
  const out = [];
  for (const o of p.otherPools || []) {
    const fee = staticFeePpm(o.fee);
    if (fee != null && fee > MAX_SANE_FEE_PPM) {
      out.push(`another pool for this token charges a ${(fee / 10000).toFixed(1)}% fee (${o.label}) — a trap for routers and bots that pick the wrong pool`);
    }
  }
  if ((p.otherPools || []).length) out.push(`${p.otherPools.length} other pool(s) exist for this token; screened on the ranked best one`);
  return out;
}

// ---------------------------------------------------------------- Gate 2
// v3 holds its own reserves, so balanceOf(pool) is the honest number.
// v4's PoolManager is a shared singleton, so its balance says nothing about
// THIS pool — reported as unmeasured rather than guessed at.
async function measureLiquidity(p) {
  const token = new ethers.Contract(p.tokenAddr, erc20Iface, provider);
  let tokenDecimals = 18;
  try { tokenDecimals = await token.decimals(); } catch (_) {}

  if (p.version === 'v3') {
    const weth = new ethers.Contract(ADDR.WETH, erc20Iface, provider);
    const [baseBal, tokenBal] = await Promise.all([
      weth.balanceOf(p.poolAddress),
      token.balanceOf(p.poolAddress),
    ]);
    // estimateConservativeSellAmount() takes HUMAN numbers, not BigNumbers —
    // it calls .toFixed() on them (see toRawUnits in tenderly-client.js), so a
    // BigNumber here comes back as "reserves unavailable" and every v3 pool
    // dies at Gate 3. token-screener-v3.js passes Number(formatUnits(...));
    // this now matches. The raw values are kept alongside under *Raw for
    // anything that wants exact integers.
    return {
      measured: true,
      baseEth: Number(ethers.utils.formatEther(baseBal)),
      baseLiquidity: Number(ethers.utils.formatUnits(baseBal, 18)),
      tokenLiquidity: Number(ethers.utils.formatUnits(tokenBal, tokenDecimals)),
      baseLiquidityRaw: baseBal,
      tokenLiquidityRaw: tokenBal,
      tokenDecimals, baseDecimals: 18,
    };
  }

  return {
    measured: false,
    baseEth: null,
    baseLiquidity: null, tokenLiquidity: null,
    tokenDecimals, baseDecimals: 18,
    note: 'v4 PoolManager is a shared singleton — per-pool ETH side needs the tick-range estimate (not implemented here)',
  };
}

// ---------------------------------------------------------------- Gates 3-5
async function roundTrip(p, amountEth, liq, tag) {
  const opts = {
    baseAmountWei: ethers.utils.parseEther(String(amountEth)),
    baseLiquidity: liq.baseLiquidity,
    tokenLiquidity: liq.tokenLiquidity,
    tokenDecimals: liq.tokenDecimals,
    baseDecimals: liq.baseDecimals,
    // v3 only: swap-legs.js reads the router bytecode to settle which
    // exactInputSingle struct to encode.
    provider,
  };
  console.log(`  ${tag}: simulating buy -> sell of ${amountEth} ETH …`);

  if (p.version === 'v4') return simulateUniV4Txn(p, ADDR, opts);

  if (!simulateUniV3Txn) {
    return {
      allPassed: false, worstRatio: null, unsupported: true,
      reason: 'tenderly-bundle-v3.js is not in this directory — v3 pools cannot be simulated',
      variants: [],
    };
  }
  return simulateUniV3Txn(p, ADDR, opts);
}

function inBand(x) { return x != null && x >= BAND_LO && x <= BAND_HI; }

// ---------------------------------------------------------------- Gate 6
// The rug check lives in rug-check.js. It is the gate that matters most — the
// 1770-byte template cannot block a sell, yet those tokens are scams, because
// the deployer holds the position and can pull the ETH. Both earlier bots asked
// "is this contract malicious?"; this asks "can the money be taken away from
// me after I buy?".
//
// Three sub-probes, all of which have to come back positive for a SNIP:
//   6a  who custodies each liquidity position, and can any single EOA pull it
//   6b  spoof that owner and actually try, then measure what the victim recovers
//   6c  the top holder dumps its whole balance, then the victim tries to sell
//
// The gate never returns a bare boolean, so this call site has to handle four
// decisions. UNPROVEN is not a pass — it means the probe could not establish
// anything, and the token stays uncleared.
function printRugProbes(rug) {
  const c = rug.probes && rug.probes.census;
  if (c && !c.error) {
    const conc = c.concentrationPct == null ? 'n/a' : `${c.concentrationPct}%`;
    console.log(`        census: ${c.positionCount} position(s), top holds ${conc}, ` +
      `${c.removableByEoaCount} removable by an EOA, ${c.lockedSharePct ?? 0}% burned${c.truncated ? ' (log scan truncated)' : ''}`);
    (c.positions || []).slice(0, 3).forEach((x) => {
      const who = x.beneficialOwner ? `${x.custodian} -> ${x.beneficialOwner} (${x.beneficialOwnerKind})` : `${x.custodian} (${x.custodianKind})`;
      console.log(`                ${x.sharePct}%  ${who}`);
    });
  }
  if (rug.probes && rug.probes.baseline) {
    const b = rug.probes.baseline;
    console.log(`        baseline round trip: ${b.ok
      ? `ratio ${b.ratio.toFixed(4)} (cost ${((1 - b.ratio) * 100).toFixed(2)}%, sold ${(b.sellBps || 10000) / 100}%)`
      : `UNUSABLE — ${b.reason}`}`);
  }
  if (rug.probes && rug.probes.removal) {
    const r = rug.probes.removal;
    const rec = r.recoveryFraction == null ? '' : `, victim recovers ${(r.recoveryFraction * 100).toFixed(1)}%`;
    console.log(`        removal probe:  ${r.verdict}${rec}`);
    if (r.verdict !== 'REMOVABLE' && r.verdict !== 'REMOVABLE_AND_FATAL' && r.reason) console.log(`                        ${r.reason}`);
  }
  if (rug.probes && rug.probes.whaleDump) {
    const w = rug.probes.whaleDump;
    const rec = w.recoveryFraction == null ? '' : `, victim recovers ${(w.recoveryFraction * 100).toFixed(1)}%`;
    const who = w.whale ? ` (top holder ${w.whale}${w.whaleIsContract ? ', a contract' : ''})` : '';
    const pcs = w.dumpPieces > 1 ? `, sold in ${w.dumpPieces} pieces` : '';
    console.log(`        whale dump:     ${w.verdict}${rec}${pcs}${who}`);
    if (w.verdict !== 'WHALE_DUMP_SURVIVED' && w.reason) console.log(`                        ${w.reason}`);
    if (w.sellCapSuspected) console.log('                        one sale of the whole balance reverted but smaller sales went through: possibly a per-transaction sell limit');
    if (w.balanceNote) console.log(`                        ${w.balanceNote}`);
  }
  (rug.notes || []).forEach((n) => console.log(`        note: ${n}`));
}

// ---------------------------------------------------------------- Gates 3-5 judgement
// Pure: two wallet-round-trip.js results in, one decision out. null = passed.
// Returns { verdict, reason, gate } or { pass: true, costPct, taxBps, flags }.
const freshAddress = () => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
const pct2 = (x) => `${Number(x).toFixed(2)}%`;

// Gate 0 template shortcut (template-match.js); built on first use.
let _templateMatcher = null;
function defaultTemplateMatch(src, p) {
  if (!_templateMatcher) {
    _templateMatcher = require('./template-match').createTemplateMatcher({ getCode: (a) => provider.getCode(a) });
  }
  return _templateMatcher(src, p);
}

function judgeRoundTrips(r1, r2) {
  const flags = [];
  for (const [r, n] of [[r1, 1], [r2, 2]]) {
    if (r && r.ok) continue;
    const why = (r && r.reason) || 'no result';
    if (r && r.buyReverted) return { verdict: 'DO NOT SNIP', reason: `sim #${n}: ${why}`, gate: n === 1 ? 3 : 4 };
    if (r && r.sellReverted) {
      return { verdict: 'DO NOT SNIP', reason: n === 1 ? `sim #1: ${why}` : `sim #2 could not sell where #1 could — behaviour depends on the wallet: ${why}`, gate: n === 1 ? 3 : 4 };
    }
    return { verdict: 'UNKNOWN', reason: `sim #${n} could not be measured: ${why}`, gate: n === 1 ? 3 : 4 };
  }

  const taxes = [r1.sellTaxBps, r2.sellTaxBps];
  if (taxes.some((t) => t != null && t > MAX_HIDDEN_TAX_BPS)) {
    const t = Math.max(...taxes.filter((x) => x != null));
    return { verdict: 'DO NOT SNIP', reason: `hidden token tax on the sell: ${pct2(t / 100)} of the tokens never reached the pool (limit ${pct2(MAX_HIDDEN_TAX_BPS / 100)})`, gate: 4 };
  }
  if (taxes.some((t) => t == null)) flags.push('hidden token tax could not be measured on one of the round trips');

  const costs = [-r1.netPct, -r2.netPct];
  if (costs.some((c) => c < -0.5)) {
    return { verdict: 'UNKNOWN', reason: `a round trip came out ahead (${costs.map((c) => pct2(-c)).join(', ')}) — that should not happen, so the measurement is suspect`, gate: 4 };
  }
  const worst = Math.max(...costs);
  if (worst > MAX_ROUND_TRIP_COST_PCT) {
    return { verdict: 'DO NOT SNIP', reason: `the round trip costs ${pct2(worst)} (fees + price impact + gas) — above the ${MAX_ROUND_TRIP_COST_PCT}% limit`, gate: 4 };
  }

  const back1 = Number(r1.scaledProceedsWei || r1.proceedsWei);
  const back2 = Number(r2.scaledProceedsWei || r2.proceedsWei);
  if (back1 > 0 && back2 > 0) {
    const diff = Math.abs(back1 - back2) / Math.max(back1, back2) * 100;
    if (diff > MAX_WALLET_DISAGREE_PCT) {
      return { verdict: 'DO NOT SNIP', reason: `the two wallets got different results (${pct2(diff)} apart) — behaviour depends on the wallet`, gate: 4 };
    }
  }

  const exit = Math.min(r1.soldBps ?? 0, r2.soldBps ?? 0);
  if (exit < MIN_FULL_EXIT_BPS) {
    return { verdict: 'DO NOT SNIP', reason: `only ${exit / 100}% of the position could be sold — a max-sell / max-tx cap`, gate: 5 };
  }
  if (exit < 10000) {
    const pinned = r1.pinnedBlock != null && r2.pinnedBlock != null;
    flags.push(pinned
      ? `selling 100% reverted on a fixed block; ${exit / 100}% went through — a sell cap or rounding in the token`
      : `selling 100% reverted; ${exit / 100}% went through (the simulations were not pinned to one block, so price drift may explain it)`);
  }
  const drift = [r1, r2].map((r) => r.buyDriftBps).filter((x) => x != null && x !== 0);
  if (drift.length) flags.push(`the buy returned a different amount in the measurement than in the probe (${drift.map((x) => `${x / 100}%`).join(', ')}) — the state moved between simulations`);

  return { pass: true, costPct: worst, taxBps: Math.max(...taxes.filter((x) => x != null), 0), flags };
}

// ---------------------------------------------------------------- main
// opts.pool  a pool descriptor already known to the caller (watch-launches.js
//            passes the pool it saw being created); skips the Gate 1 lookup.
// opts.controllerOpts  extra options for controllerCheck (e.g. aroundTime for a
//            pool created more than ~6h ago, which the default window would miss).
// opts.deps  replaces individual steps — used by the offline tests only.
// opts.hiddenSource  'final' (default; the CLI): an unpublished source ends the screen at
//            Gate 0, as before. 'probe' (watch-launches.js): see Gate 0 in the header.
async function screen(tokenAddr, { amountEth = 0.05, minLiqEth = 1, pool = null, poolHints = [], controllerOpts = {}, hiddenSource = 'final', deps = {} } = {}) {
  const d = {
    sourceGate, discoverPool, controllerCheck, measureLiquidity, rugCheck, provider,
    templateMatch: defaultTemplateMatch,
    // lazy: wallet-round-trip.js requires this file, so a top-level require would be circular
    walletRoundTrip: (...a) => require('./wallet-round-trip').walletRoundTrip(...a),
    // lazy for the same reason: transfer-audit.js requires this file
    transferAudit: (...a) => require('./transfer-audit').transferAudit(...a),
    allowanceProbe: (...a) => require('./allowance-probe').allowanceProbe(...a),
    // 2026-10-24: record only, never decides (see change-check.js)
    changeCheck: (...a) => require('./change-check').changeCheck(...a),
    ...deps,
  };
  let controller = null;   // the Gate 1b result, carried on every verdict after it
  const flags = [];        // "continue, but say so" findings, carried on every verdict
  // 2026-10-13: the FULL result of every gate that ran, carried on every verdict
  // as r.detail. The summaries (audit, allowance, rug …) stay as they were;
  // watch-launches.js writes detail to screens/<date>/<token>.json for analysis.
  const detail = {};
  let change = null;       // 2026-10-24: the change check in brief (record only), carried on every verdict after it
  const done = (kind, reason, extra = {}) => verdict(kind, reason, { ...extra, controller, change, flags, detail });

  console.log(`\nToken   ${tokenAddr}`);
  console.log(`Chain   ${CHAIN_ID} (Robinhood)\n`);

  // ---- Gate 0 -------------------------------------------------------------
  const src = await d.sourceGate(tokenAddr, { rpcUrl: RPC_URL, chain: CHAIN_ID });
  detail.source = src;
  console.log(`Gate 0  source: ${src.decision} — ${src.reason}`);
  // Only "not published" can be probed. No bytecode, or a proxy whose code is
  // unknown, still ends here whatever the mode.
  const probeHidden = hiddenSource === 'probe' && src.decision === 'SKIP' && src.sourceVerified === false;
  let sourcePending = false; // set below when the source is hidden and no template matches
  if (src.decision === 'SKIP' && !probeHidden) {
    return done('DO NOT SNIP', `source gate: ${src.reason}`, { gate: 0 });
  }
  if (src.decision === 'ERROR') {
    return done('UNKNOWN', `source gate could not complete: ${src.reason}`, { gate: 0 });
  }

  // ---- Gate 1 -------------------------------------------------------------
  const p = pool || await d.discoverPool(tokenAddr, { allowUsdg: true, hints: poolHints });
  if (!p && probeHidden) {
    return done('DO NOT SNIP', `source gate: ${src.reason}`, { gate: 0, sourceHidden: true });
  }
  if (!p) {
    return done('UNKNOWN', 'no ETH, WETH or USDG pool found on v3 or v4 (the live scan covers only the last ~5.5h; older tokens need their launches.jsonl record)', { gate: 1 });
  }
  detail.pool = p;
  console.log(`Gate 1  pool:   ${p.label}`);
  for (const f of otherPoolFlags(p)) { flags.push(f); console.log(`        note: ${f}`); }
  {
    const fee = staticFeePpm(p.fee);
    if (fee != null && fee > MAX_SANE_FEE_PPM) {
      const f = `the best pool found charges a ${(fee / 10000).toFixed(1)}% fee — probably a trap pool, and the token's real pool may be older than the ~5.5h live scan`;
      flags.push(f); console.log(`        WARNING: ${f}`);
    }
  }

  // ---- Gate 0, hidden source (hiddenSource 'probe') -----------------------
  if (probeHidden) {
    let tm;
    try {
      tm = await d.templateMatch(src, p);
    } catch (e) {
      tm = { matched: false, reason: `template check failed: ${e.message}` };
    }
    detail.templateMatch = tm;
    if (tm && tm.matched) {
      console.log(`Gate 0  template: ${tm.reason} — treated as published`);
      flags.push(`source not published yet when screened; accepted at Gate 0 because the ${tm.reason}`);
    } else {
      sourcePending = true;
      console.log(`Gate 0  template: no match (${tm && tm.reason}) — Gate 1b decides whether to wait for the source`);
    }
  }

  // An old pool (created before the live window): place the Gate 1b window at
  // its creation, and let the Gate 6 census read every position since then.
  let rugLookback = V4_LOOKBACK_BLOCKS;
  if (p.createdBlock != null) {
    try {
      const head = await d.provider.getBlockNumber();
      const age = head - Number(p.createdBlock);
      if (age > V4_LOOKBACK_BLOCKS) {
        rugLookback = age + 1000;
        if (controllerOpts.aroundTime == null) {
          const b = await d.provider.getBlock(Number(p.createdBlock));
          if (b) controllerOpts = { ...controllerOpts, aroundTime: b.timestamp * 1000 };
        }
        console.log(`        pool created at block ${p.createdBlock}, ~${(age / 36000).toFixed(1)}h ago — older checks will scan from there (Gate 6 may take a few minutes)`);
      }
    } catch (_) { /* fresh-launch defaults */ }
  }

  // ---- Gate 1b: who controls the liquidity --------------------------------
  // RPC reads only, no Tenderly. On the 133-token September sample this alone
  // separated the pools that drained from the ones that did not, so it runs
  // before any simulation is spent.
  let ctl;
  try {
    ctl = await d.controllerCheck(p, { provider: d.provider, addr: ADDR, ...controllerOpts });
  } catch (e) {
    ctl = { verdict: 'UNKNOWN', reason: `controller check failed: ${e.message}` };
  }
  detail.controller = ctl;
  controller = {
    verdict: ctl.verdict,
    reason: ctl.reason,
    controller: ctl.controller || null,
    eoaSharePct: ctl.eoaSharePct ?? null,
    lockedSharePct: ctl.lockedSharePct ?? null,
  };
  console.log(`Gate 1b controller: ${ctl.verdict} — ${ctl.reason}`);
  if (ctl.verdict === 'CREATOR_CAN_PULL' || ctl.verdict === 'DRAINED') {
    const also = sourcePending ? ' (the source was not published either)' : '';
    return done('DO NOT SNIP', `liquidity controller ${ctl.verdict}: ${ctl.reason}${also}`, { gate: '1b', ...(sourcePending ? { sourceHidden: true } : {}) });
  }
  if (ctl.verdict !== 'LOCKED') {
    flags.push(`liquidity controller UNKNOWN: ${ctl.reason}`);
  }
  // Hidden source, liquidity not pullable: stop before any simulation and let the
  // watcher re-check the source (watch-launches.js, source re-check list).
  if (sourcePending) {
    console.log('        source not published yet — no simulations; the watcher will re-check the source');
    return done('SOURCE PENDING',
      `source not published yet; liquidity controller ${ctl.verdict} — waiting for the source before any simulation`,
      { gate: 0, sourceHidden: true, pending: true });
  }

  // The simulations below only know ETH/WETH as the base currency.
  if (p.base === 'USDG') {
    return done('UNKNOWN',
      'USDG pool — gates 0-1b ran, but the simulations (gates 2-6) do not cover USDG pools yet',
      { gate: 2 });
  }

  // ---- Change check (2026-10-24, RECORD ONLY) ------------------------------
  // Can the token be changed after release: proxy, owner, roles, switches in
  // the source, v4 hook. Runs for every token that reaches Gate 2, i.e. every
  // token that could become a SNIP. It is written into the screen file and
  // never changes the verdict: an error here is recorded and the screen goes on.
  try {
    const chg = await d.changeCheck(tokenAddr, { provider: d.provider, pool: p, source: src, template: detail.templateMatch || null });
    detail.changeCheck = chg;
    change = { wouldBe: chg.wouldBe, summary: chg.summary };
    console.log(`Change check (record only, does not decide): ${chg.wouldBe} — ${chg.summary}`);
  } catch (e) {
    detail.changeCheck = { checked: false, wouldBe: 'NOT CHECKED', error: String(e.message || e).slice(0, 200) };
    change = { wouldBe: 'NOT CHECKED', summary: detail.changeCheck.error };
    console.log(`Change check (record only): not checked — ${detail.changeCheck.error}`);
  }

  // ---- Gate 2 -------------------------------------------------------------
  const liq = await d.measureLiquidity(p);
  detail.liquidity = liq;
  if (liq.measured) {
    console.log(`Gate 2  liquidity: ${liq.baseEth.toFixed(4)} ETH on the base side`);
    if (liq.baseEth < minLiqEth) {
      // The V2 script printed this in the wrong branch; here it is its own path.
      return done('DO NOT SNIP',
        `liquidity too small: ${liq.baseEth.toFixed(4)} ETH < ${minLiqEth} ETH minimum`,
        { gate: 2 });
    }
  } else {
    console.log(`Gate 2  liquidity: unmeasured — ${liq.note}`);
  }

  // ---- Gates 3, 4 and 5 ---------------------------------------------------
  // Two independent round trips from two fresh random wallets (public addresses
  // with no history; no key exists for them). The exact pool is passed in, so
  // the simulation can never wander off to a different pool for the same token.
  const rt = async (tag) => {
    const wallet = freshAddress();
    console.log(`${tag}: buy ${amountEth} ETH, then sell 100%, from fresh wallet ${wallet} …`);
    try {
      return await d.walletRoundTrip(tokenAddr, { wallet, amountEth, prov: d.provider, discover: async () => p });
    } catch (e) {
      return { ok: false, reason: `simulation error: ${e.message}` };
    }
  };
  const show = (r) => (r.ok
    ? `        ETH back ${(Number(r.proceedsWei) / 1e18).toFixed(6)} — cost ${pct2(-r.netPct)}, hidden tax ${r.sellTaxBps == null ? 'n/a' : pct2(r.sellTaxBps / 100)}, sold ${r.soldBps / 100}%`
    : `        ${r.reason}`);
  const rt1 = await rt('Gate 3  sim #1');
  console.log(show(rt1));
  let rt2 = null;
  if (rt1.ok) {
    rt2 = await rt('Gate 4  sim #2');
    console.log(show(rt2));
  }
  detail.roundTrips = { sim1: rt1, sim2: rt2 };
  const j = judgeRoundTrips(rt1, rt2 || rt1);
  detail.roundTripJudgement = j;
  const sims = { sim1: rt1, sim2: rt2 };
  if (!j.pass) return done(j.verdict, j.reason, { gate: j.gate, sims });
  j.flags.forEach((f) => flags.push(f));
  console.log(`Gate 4  cost ${pct2(j.costPct)} (limit ${MAX_ROUND_TRIP_COST_PCT}%), hidden tax ${pct2(j.taxBps / 100)} — ok`);
  console.log('Gate 5  full exit: ok');
  const links = [];

  // ---- Gate 5b: transfer audit (added 2026-10-10) -------------------------
  // Gates 3-5 measure what a round trip costs and catch a hidden SELL tax.
  // transfer-audit.js measures both ends of every token movement in Tenderly:
  //   buy leg   pool paid out vs wallet received      -> hidden buy tax
  //   sell leg  wallet sent vs pool received; ETH out  -> hidden sell tax / skim
  //   transfer() and transferFrom() of the same amount  -> a token that taxes or
  //             blocks the DEX path (transferFrom) while a wallet transfer looks clean
  //   approve(max) read-back, approve(exact) + transferFrom(exact)
  // Its findings are graded: high = a trap -> DO NOT SNIP; medium = unexplained
  // -> UNKNOWN (unproven is never a pass); info = a visible pool-hook fee (the
  // Pons hook's ~2.5% per leg) -> noted, screen continues.
  console.log('Gate 5b transfer audit (buy/sell legs, transfer, transferFrom, approve) …');
  let audit;
  try {
    // 2026-10-19: run on Gate 3's pinned block, so the audit sees the state the
    // round trips just sold 100% in (CAPA, 18 Oct). null -> the audit pins itself.
    const auditPin = (rt1 && rt1.pinnedBlock != null) ? rt1.pinnedBlock : null;
    audit = await d.transferAudit(tokenAddr, { wallet: freshAddress(), amountEth, prov: d.provider, discover: async () => p, pinnedBlock: auditPin });
  } catch (e) {
    audit = { ok: false, reason: `transfer audit error: ${e.message}` };
  }
  detail.transferAudit = audit;
  const auditSummary = audit ? {
    ok: audit.ok, reason: audit.reason || null,
    buyTaxBps: audit.buyLeg ? audit.buyLeg.taxBps ?? null : null,
    sellTaxBps: audit.sellLeg ? audit.sellLeg.taxBps ?? null : null,
    transferTaxBps: audit.paths && audit.paths.transfer ? audit.paths.transfer.taxBps ?? null : null,
    transferFromTaxBps: audit.paths && audit.paths.transferFrom ? audit.paths.transferFrom.taxBps ?? null : null,
    findings: (audit.findings || []).map((x) => ({ severity: x.severity, title: x.title })),
    pinnedBlock: audit.pinnedBlock ?? null,
    ...(audit.pinFallback ? { pinFallback: audit.pinFallback } : {}),
    ...(audit.sellResized ? { sellResized: audit.sellResized } : {}),
  } : null;
  if (!audit || !audit.ok) {
    console.log(`        could not complete: ${audit && audit.reason}`);
    return done('UNKNOWN', `transfer audit could not complete: ${audit && audit.reason}`, { gate: '5b', sims, audit: auditSummary });
  }
  const findings = audit.findings || [];
  for (const x of findings) console.log(`        [${x.severity}] ${x.title}`);
  const high = findings.filter((x) => x.severity === 'high');
  const medium = findings.filter((x) => x.severity === 'medium');
  if (high.length) {
    return done('DO NOT SNIP', `transfer audit: ${high.map((x) => x.title).join('; ')}`, { gate: '5b', sims, audit: auditSummary });
  }
  // Every part must actually have been measured. A part that came back without
  // a number is skipped by the findings, so without this a half-run audit
  // would print "transfer() and transferFrom() agree" about checks that never ran.
  const missing = [];
  if (!audit.buyLeg || audit.buyLeg.error || audit.buyLeg.taxBps == null) missing.push(`buy leg${audit.buyLeg && audit.buyLeg.error ? ` (${audit.buyLeg.error})` : ''}`);
  if (!audit.sellLeg || audit.sellLeg.error || audit.sellLeg.taxBps == null) missing.push(`sell leg${audit.sellLeg && audit.sellLeg.error ? ` (${audit.sellLeg.error})` : ''}`);
  if (!audit.paths || audit.paths.error) missing.push(`transfer paths${audit.paths && audit.paths.error ? ` (${audit.paths.error})` : ''}`);
  else {
    if (audit.paths.transfer == null || audit.paths.transfer.taxBps == null) missing.push('transfer() amount');
    if (audit.paths.transferFrom == null || audit.paths.transferFrom.taxBps == null) missing.push('transferFrom() amount');
  }
  if (missing.length) {
    console.log(`        not measured: ${missing.join('; ')}`);
    return done('UNKNOWN', `transfer audit incomplete — not measured: ${missing.join('; ')}`, { gate: '5b', sims, audit: auditSummary });
  }
  if (medium.length) {
    return done('UNKNOWN', `transfer audit found something unexplained: ${medium.map((x) => x.title).join('; ')}`, { gate: '5b', sims, audit: auditSummary });
  }
  findings.filter((x) => x.severity === 'info').forEach((x) => flags.push(x.title));
  console.log(`Gate 5b ok — ${findings.length ? 'only a visible pool-hook fee' : 'nothing hidden'}; transfer() and transferFrom() agree`);

  // ---- Gate 5c: allowance backdoor + ghost transfers (added 2026-10-12) ---
  // Everything up to 5b is the wallet acting on its own tokens, or a spender it
  // approved. The Moo Daeng token (Frank's ~2024 loss: 100 bought, 30 kept)
  // let ANYONE send a holder's tokens to 0xdead without approval, let the
  // deployer move them anywhere, and emitted no Transfer event for moves to
  // 0xdead so explorers kept showing the old balance. allowance-probe.js tries
  // a stranger and every privileged address it can find (owner(), creator,
  // addresses hard-coded in the source), compares each balance change with the
  // Transfer events, and scans the source for a conditional allowance check
  // or a conditional Transfer event.
  //   high -> DO NOT SNIP; medium or not fully measured -> UNKNOWN; info -> noted.
  console.log('Gate 5c allowance backdoor (stranger/deployer transferFrom without approval, ghost transfers) …');
  let ap;
  try {
    ap = await d.allowanceProbe(tokenAddr, { p, amountEth, prov: d.provider, sourceSubject: src.verificationSubject || tokenAddr });
  } catch (e) {
    ap = { ok: false, reason: `allowance probe error: ${e.message}` };
  }
  detail.allowanceProbe = ap;
  const allowanceSummary = ap ? {
    ok: Boolean(ap.ok), reason: ap.reason || null,
    privileged: (ap.privileged || []).map((c) => ({ address: c.address, roles: c.roles, isContract: c.isContract ?? null })),
    ghosts: (ap.ghosts || []).length,
    sourceScanned: ap.source ? Boolean(ap.source.scanned) : false,
    findings: (ap.findings || []).map((x) => ({ severity: x.severity, title: x.title })),
  } : null;
  const g5c = { gate: '5c', sims, audit: auditSummary, allowance: allowanceSummary };
  if (!ap || !ap.ok) {
    console.log(`        could not complete: ${ap && ap.reason}`);
    return done('UNKNOWN', `allowance probe could not complete: ${ap && ap.reason}`, g5c);
  }
  try { require('./allowance-probe').printProbe(ap); } catch (_) { /* display only */ }
  const apf = ap.findings || [];
  for (const x of apf) console.log(`        [${x.severity}] ${x.title}`);
  const apHigh = apf.filter((x) => x.severity === 'high');
  if (apHigh.length) {
    return done('DO NOT SNIP', `allowance backdoor: ${apHigh.map((x) => x.title).join('; ')}`, g5c);
  }
  if (ap.missing && ap.missing.length) {
    console.log(`        not measured: ${ap.missing.join('; ')}`);
    return done('UNKNOWN', `allowance probe incomplete — not measured: ${ap.missing.join('; ')}`, g5c);
  }
  const apMedium = apf.filter((x) => x.severity === 'medium');
  if (apMedium.length) {
    return done('UNKNOWN', `allowance probe found something unexplained: ${apMedium.map((x) => x.title).join('; ')}`, g5c);
  }
  apf.filter((x) => x.severity === 'info').forEach((x) => flags.push(x.title));
  console.log('Gate 5c ok — strangers and privileged callers cannot move your tokens; balances match the Transfer events');

  // ---- Gate 6 -------------------------------------------------------------
  // The sell legs inside the rug probes are sized from what the Gate 3 buy
  // actually returned, not from an estimate — a sell that reverts on size would
  // otherwise be indistinguishable from a sell blocked by a drained pool.
  if (!rt1.tokensReceivedWei) {
    return done('UNKNOWN', 'Gate 3 did not report how many tokens the buy returned, so the rug probes cannot size their sell legs', { gate: 6, sims, audit: auditSummary, allowance: allowanceSummary });
  }
  console.log('Gate 6  rug check:');
  const rug = await d.rugCheck(p, ADDR, {
    provider: d.provider,
    // 2026-10-24: the same block Gates 3 to 5b simulated on, so the sell legs
    // (sized from Gate 3's buy) and the whale's balance match the pool state.
    pinnedBlock: (rt1 && rt1.pinnedBlock != null) ? rt1.pinnedBlock : null,
    baseAmountWei: ethers.utils.parseEther(String(amountEth)),
    baselineTokenOutWei: ethers.BigNumber.from(rt1.tokensReceivedWei),
    // Sell as much of the position as Gate 5 managed to (normally 100%).
    startSellBps: rt1.soldBps || 10000,
    // When the position owner is a contract (a locker), the removal probe cannot
    // simulate it honestly and defers to Gate 1b instead.
    controller: { verdict: ctl.verdict, reason: ctl.reason },
    lookbackBlocks: rugLookback,
  });
  detail.rugCheck = rug;
  printRugProbes(rug);

  if (rug.decision === 'SKIP') {
    return done('DO NOT SNIP', rug.reason, { gate: 6, links, sims, audit: auditSummary, allowance: allowanceSummary, rug: rug.probes });
  }
  if (rug.decision === 'ERROR') {
    return done('UNKNOWN', `rug check could not run: ${rug.reason}`, { gate: 6, links, sims, audit: auditSummary, allowance: allowanceSummary, rug: rug.probes });
  }
  if (rug.decision === 'UNPROVEN') {
    // Deliberately not a pass. The only honest statement is that gates 0-5 are
    // clean and the rug vector was not established either way.
    return done('PASSED GATES 0-5',
      `gates 0-5 clean, but the rug check is inconclusive: ${rug.reason}`,
      { gate: 6, links, sims, audit: auditSummary, allowance: allowanceSummary, rug: rug.probes });
  }

  return done('SNIP', `all gates passed — round trip costs ${pct2(j.costPct)}; ${rug.reason}`, { links, sims, audit: auditSummary, allowance: allowanceSummary, rug: rug.probes });
}

// ---------------------------------------------------------------- pool hints
// Every pool the watcher recorded for this token: [{ poolId, createdBlock }].
function poolHintsFromLaunches(token, file = require('path').join(__dirname, 'launches.jsonl')) {
  const fs = require('fs');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = new Map();
  for (const line of raw.split('\n')) {
    if (!line || line.toLowerCase().indexOf(lc(token)) === -1) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (lc(r.token) !== lc(token) || r.version !== 'v4' || !r.poolId || r.createdBlock == null) continue;
    out.set(lc(r.poolId), { poolId: r.poolId, createdBlock: r.createdBlock, source: 'launches.jsonl' });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const token = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const num = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
  };

  if (!token) {
    console.log('usage: node screen-token.js 0xTOKEN [--amount 0.05] [--min-liq 1] [--json]');
    process.exit(1);
  }

  const poolHints = poolHintsFromLaunches(token);
  if (poolHints.length) console.log(`(${poolHints.length} pool(s) for this token recorded in launches.jsonl — included in Gate 1)`);
  screen(token, { amountEth: num('--amount', 0.05), minLiqEth: num('--min-liq', 1), poolHints })
    .then((r) => {
      if (args.includes('--json')) {
        console.log(require('./safe-json').safeStringify({ token, ...r }, 2));
      } else {
        console.log(`\n==> ${r.verdict}`);
        console.log(`    ${r.reason}`);
        (r.flags || []).forEach((f) => console.log(`    FLAG: ${f}`));
        if (r.links && r.links.length) {
          console.log('    Tenderly:');
          r.links.forEach((l) => console.log(`      ${l}`));
        }
      }
      console.log('');
    })
    .catch((e) => {
      // Even an unexpected throw ends in a verdict — never silence.
      console.log('\n==> UNKNOWN');
      console.log(`    screener error: ${e.message}`);
      if (process.env.SCREEN_DEBUG) console.error(e);
      console.log('');
      process.exit(2);
    });
}

module.exports = { screen, discoverPool, poolHintsFromLaunches, measureLiquidity, roundTrip, rankPools, otherPoolFlags, judgeRoundTrips, MAX_ROUND_TRIP_COST_PCT };
