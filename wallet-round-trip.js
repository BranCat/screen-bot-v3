// wallet-round-trip.js — "I have 0.05 ETH. I buy this token, I sell all of it.
// How much ETH lands back in my wallet?"
//
//   node wallet-round-trip.js 0xTOKEN --wallet 0xYourAddress [--amount 0.05]
//
// This is a different question from the one screen-token.js asks. The screener
// asks whether a token is safe to touch. This asks what one specific trade,
// from one specific wallet, at one specific size, actually costs — and it
// answers in ETH, not in ratios.
//
// ---------------------------------------------------------------------------
// FOUR THINGS THIS DOES DIFFERENTLY FROM THE SCREENER
// ---------------------------------------------------------------------------
//
// 1. IT USES YOUR REAL ADDRESS, not a freshly generated one.
//    This is the reason to run it even though the screener already round-trips.
//    A token can behave differently per address: deployer whitelists,
//    first-buyer bonuses, per-address cooldowns, blocklists inherited from some
//    other chain's deployment. A throwaway wallet is a stranger to all of that.
//    Yours is not. No private key is involved — Tenderly spoofs the sender, it
//    does not sign anything.
//
// 2. IT SELLS 100% OF WHAT THE BUY RETURNED, not 90%.
//    The bundle modules sell ~90% on purpose, to leave headroom so a
//    fee-on-transfer token doesn't revert on size and get misread as a trap.
//    That headroom is exactly what hides a "you can sell most of it but never
//    all of it" token. Here the full balance is the first attempt, and if it
//    reverts the script walks down 100% -> 99% -> 95% -> 50% and tells you
//    which rung held. A token that needs 95% has a real restriction; one that
//    needs 99% is almost certainly rounding.
//
// 3. IT COUNTS GAS.
//    The simulation itself runs at gas_price 0, deliberately — that is what
//    makes the ETH balance diffs pure swap economics, and it is the assumption
//    nativeBalanceDelta() in tenderly-client.js was verified under. Gas is then
//    added back as arithmetic: measured gas_used from each step, multiplied by
//    the live gas price from the chain. Keeping the two separate means a change
//    in gas price can never quietly move the swap numbers.
//
// 4. IT ANSWERS IN ETH AND SPLITS THE SHORTFALL.
//    "0.9743" is not an answer to "do I get my money back". The output is a
//    statement: ETH in, ETH back, what the gap was, and how much of the gap was
//    the pool fee you can never avoid versus price impact versus a token tax
//    measured from the pool's own balance change.
//
// ---------------------------------------------------------------------------
// ABOUT PUTTING REAL ETH IN THE WALLET
// ---------------------------------------------------------------------------
// You do not need to, for this. Tenderly runs against a fork and the wallet
// balance is set in the fork, so the script reports what your trade would cost
// whether your wallet holds 0 ETH or 5. What the script DOES do is read your
// real balance and tell you whether it would actually cover this trade plus
// gas, so the number is honest about what you'd need if you went ahead.
//
// Executing for real is a separate decision and not something this script does.
// Your own rule from the plan document still stands and this file is written to
// respect it: no private key, no seed phrase, in .env, in a script, or in a
// chat. This script never needs one and never asks for one.

require('dotenv').config();
const ethers = require('ethers');

const config = require('./config');
const { ADDR, RPC_URL, CHAIN_ID } = config;
const { discoverPool } = require('./screen-token');
const { resolvePool, hookPermissions, knownHookName } = require('./pool-resolve');
const { usingLocalSwapEncoder } = require('./rug-check');
const { legsFor } = require('./swap-legs');
const {
  buildStep,
  simulateBundle,
  ethBalanceOverride,
  erc20Iface,
  wethIface,
  MAX_UINT256,
  MAX_UINT160,
  formatStepError,
  anyIndeterminate,
  nativeBalanceDelta,
} = require('./tenderly-client');

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

const permit2Iface = new ethers.utils.Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const metaIface = new ethers.utils.Interface([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 3600;
// Rungs for the full-exit ladder, in basis points of the balance the buy
// returned. 10000 = sell every last unit.
const SELL_LADDER_BPS = [10000, 9900, 9500, 5000];
// v4's dynamic-fee sentinel. Not a fee rate, so the fee-floor arithmetic is
// skipped when the pool carries it.
const DYNAMIC_FEE_SENTINEL = 0x800000;

const BN = (x) => ethers.BigNumber.from(x);

// --------------------------------------------------------------------------
// formatting
// --------------------------------------------------------------------------

function fmtUnits(bn, decimals, places = 4) {
  if (bn == null) return 'n/a';
  const s = ethers.utils.formatUnits(bn, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}
const eth = (bn, places = 6) => fmtUnits(bn, 18, places);
const signed = (bn, places = 6) => (bn && bn.lt(0) ? `-${eth(bn.mul(-1), places)}` : `+${eth(bn, places)}`);

// --------------------------------------------------------------------------
// chain reads
// --------------------------------------------------------------------------

async function tokenMeta(tokenAddr, prov) {
  const read = async (fn, dflt) => {
    try {
      const data = metaIface.encodeFunctionData(fn);
      const raw = await prov.call({ to: tokenAddr, data });
      if (!raw || raw === '0x') return dflt;
      return metaIface.decodeFunctionResult(fn, raw)[0];
    } catch (_) { return dflt; }
  };
  return { decimals: Number(await read('decimals', 18)), symbol: await read('symbol', 'TOKEN') };
}

// gas_used sits on the transaction object of each result. Verified against the
// captured bundle in tenderly-last-response.json (116142 on a real swap step).
function gasUsed(result) {
  try {
    const raw = result && result.raw;
    const txn = raw?.transaction || raw?.simulation || raw;
    const g = txn?.gas_used ?? txn?.transaction_info?.gas_used;
    return g == null ? null : BN(String(g));
  } catch (_) { return null; }
}
function totalGasUsed(results) {
  return results.reduce((acc, r) => {
    const g = gasUsed(r);
    return g ? acc.add(g) : acc;
  }, BN(0));
}

// --------------------------------------------------------------------------
// bundle construction
// --------------------------------------------------------------------------
//
// Built inline rather than reused from rug-check.js because this script needs
// balance reads interleaved between the swap steps — before and after the sell,
// on both the wallet and the pool — and those reads are the measurement.

const balanceOf = (who) => erc20Iface.encodeFunctionData('balanceOf', [who]);

// 2026-10-18: every bundle of one round trip runs on the SAME block.
// Before this, each bundle was simulated on whatever block was newest. The sell
// amount comes from the probe bundle, so when the price moved between the probe
// and the measurement (normal in the first minutes of a launch), the measurement's
// buy returned a different number of tokens: fewer -> the 100% sell asked for
// tokens the wallet did not have and reverted; more -> "sold 100%" still left
// tokens behind. Either way the unsold tokens were counted as lost, which is why
// Pons launches showed 6.5-9.7% instead of their real ~5.9% (NOUS, PRISM, KEPT,
// IRIDIUS, ATLAS on 15 Oct). ROUND_TRIP_PIN=0 turns the pin off.
const pinOn = () => process.env.ROUND_TRIP_PIN !== '0';
const pinSteps = (steps, n) => (n == null ? steps : steps.map((st) => ({ ...st, block_number: n })));

// The measurement bundle. Everything the statement needs comes out of this one
// call, so buy and sell see the same forked state.
//
// Protocol-specific calldata comes from swap-legs.js, so v3 and v4 differ only
// in what `legs` produces — the measurement around it is identical.
function roundTripBundle({ p, legs, wallet, amountInWei, seedWei, sellAmountWei }) {
  const steps = [];
  const ix = {};
  const push = (name, st) => { if (name) ix[name] = steps.length; steps.push(st); };

  legs.buySteps({ from: wallet, amountInWei, seedWei }).forEach((st) => push(null, st));

  ix.tokensAfterBuy = steps.length;
  push(null, buildStep({ from: wallet, to: p.tokenAddr, data: balanceOf(wallet) }));

  const sellSteps = legs.sellSteps({ from: wallet, amountInWei: sellAmountWei });
  // Everything before the swap itself is approvals; they move no balances, so
  // they sit outside the bracketed window.
  sellSteps.slice(0, -1).forEach((st) => push(null, st));

  // Bracketing the swap with the pool's own token balance is how the token tax
  // is measured: the pool should receive exactly what we sent it. Anything
  // missing was taken in transfer. `poolHolder` is the v3 pool contract or the
  // v4 PoolManager, whichever applies.
  ix.poolBefore = steps.length;
  push(null, buildStep({ from: wallet, to: p.tokenAddr, data: balanceOf(legs.poolHolder) }));

  ix.sell = steps.length;
  push(null, sellSteps[sellSteps.length - 1]);

  ix.poolAfter = steps.length;
  push(null, buildStep({ from: wallet, to: p.tokenAddr, data: balanceOf(legs.poolHolder) }));

  ix.tokensAfterSell = steps.length;
  push(null, buildStep({ from: wallet, to: p.tokenAddr, data: balanceOf(wallet) }));

  if (legs.baseIsErc20) {
    ix.wethAfter = steps.length;
    push(null, buildStep({ from: wallet, to: legs.baseAddr, data: balanceOf(wallet) }));
  }
  return { steps, ix, isNative: !legs.baseIsErc20 };
}

const uintAt = (results, i) => {
  const raw = results[i]?.returnData;
  if (!raw || raw === '0x') return null;
  try { return BN(raw); } catch (_) { return null; }
};

// --------------------------------------------------------------------------
// the run
// --------------------------------------------------------------------------

// `prov` and `discover` are injected so the whole run can be exercised offline
// (see test-wallet-round-trip.js); in normal use they default to the real RPC
// provider and the screener's pool discovery.
async function walletRoundTrip(tokenAddr, { wallet, amountEth = 0.05, prov = provider, discover = discoverPool } = {}) {
  const out = { token: tokenAddr, wallet, amountEth };
  const amountInWei = ethers.utils.parseEther(String(amountEth));

  // ---- what the chain says about your wallet right now --------------------
  const [realBalance, gasPrice] = await Promise.all([
    prov.getBalance(wallet),
    prov.getGasPrice(),
  ]);
  out.realBalanceWei = realBalance.toString();
  out.gasPriceWei = gasPrice.toString();

  // The block every bundle below is simulated on. If Tenderly refuses it (it
  // may not have the newest block yet), the run falls back once to "latest"
  // and says so in pinFallback.
  let pin = null;
  if (pinOn() && typeof prov.getBlockNumber === 'function') {
    try { pin = await prov.getBlockNumber(); } catch (_) { pin = null; }
  }
  out.pinnedBlock = pin;
  const sim = async (steps) => {
    if (pin == null) return simulateBundle(steps);
    try {
      return await simulateBundle(pinSteps(steps, pin));
    } catch (e) {
      out.pinFallback = `block ${pin} refused, simulated on latest instead: ${String(e.message).slice(0, 160)}`;
      pin = null;
      out.pinnedBlock = null;
      return simulateBundle(steps);
    }
  };

  // The fork is seeded with whatever the wallet really holds, or with the trade
  // size plus a gas cushion when that is not enough. Either way the simulation
  // is the same; the difference is only whether you could do it today.
  const cushion = amountInWei.div(10);
  const needed = amountInWei.add(cushion);
  const toppedUp = realBalance.lt(needed);
  const seedWei = toppedUp ? needed : realBalance;
  out.toppedUp = toppedUp;

  // ---- the pool -----------------------------------------------------------
  const p = await discover(tokenAddr);
  if (!p) return { ...out, ok: false, reason: 'no WETH or native-ETH pool found on v3 or v4' };
  out.pool = p.label;
  out.version = p.version;

  let legs;
  try {
    legs = await legsFor(p, ADDR, { provider: prov });
  } catch (e) {
    return { ...out, ok: false, reason: `could not build swap legs for this pool: ${e.message}` };
  }
  out.routerShape = legs.routerShape || null;
  if (legs.note) out.legsNote = legs.note;

  const meta = await tokenMeta(tokenAddr, prov);
  out.symbol = meta.symbol;
  out.decimals = meta.decimals;

  // ---- probe: what does the buy actually return? --------------------------
  // The sell amount has to be baked into calldata, so it cannot be read from an
  // earlier step of the same bundle. One cheap bundle to learn the balance,
  // then the real one.
  const buy = legs.buySteps({ from: wallet, amountInWei, seedWei });
  const probeSteps = [
    ...buy,
    buildStep({ from: wallet, to: tokenAddr, data: balanceOf(wallet) }),
  ];
  let probe;
  try { probe = await sim(probeSteps); }
  catch (e) { return { ...out, ok: false, reason: `the buy simulation could not run: ${e.message}` }; }
  if (anyIndeterminate(probe)) {
    return { ...out, ok: false, reason: 'Tenderly returned a step with no readable status on the buy — result unknown, not clean' };
  }
  const buyStep = probe[probeSteps.length - 2];
  if (!buyStep || buyStep.reverted) {
    return { ...out, ok: false, buyReverted: true, reason: `the buy reverted: ${formatStepError(buyStep)}` };
  }
  const tokensReceived = uintAt(probe, probeSteps.length - 1);
  if (tokensReceived == null || tokensReceived.isZero()) {
    return { ...out, ok: false, reason: 'the buy did not revert but the wallet received zero tokens' };
  }
  out.tokensReceivedWei = tokensReceived.toString();

  // ---- the ladder: sell everything, then less, until something holds ------
  const attempts = [];
  let good = null;
  for (const bps of SELL_LADDER_BPS) {
    const sellAmountWei = tokensReceived.mul(bps).div(10000);
    if (sellAmountWei.isZero()) continue;
    const { steps, ix, isNative } = roundTripBundle({ p, legs, wallet, amountInWei, seedWei, sellAmountWei });
    let res;
    try { res = await sim(steps); }
    catch (e) { attempts.push({ bps, error: e.message }); continue; }
    if (anyIndeterminate(res)) { attempts.push({ bps, error: 'indeterminate step' }); continue; }

    const sellRes = res[ix.sell];
    if (!sellRes || sellRes.reverted) {
      attempts.push({ bps, reverted: true, error: formatStepError(sellRes) });
      continue;
    }
    good = { bps, res, ix, isNative, sellAmountWei, steps };
    attempts.push({ bps, reverted: false });
    break;
  }
  out.attempts = attempts;

  if (!good) {
    const first = attempts[0] || {};
    return {
      ...out, ok: false, sellReverted: true,
      reason: `the buy went through but every sell attempt reverted, down to ${SELL_LADDER_BPS[SELL_LADDER_BPS.length - 1] / 100}% of the position. First error: ${first.error || 'none given'}. That is a honeypot signature.`,
    };
  }

  // ---- read the statement out of the good bundle --------------------------
  const { res, ix, isNative, sellAmountWei, bps } = good;
  out.soldBps = bps;

  const tokensLeft = uintAt(res, ix.tokensAfterSell);
  out.tokensLeftWei = tokensLeft ? tokensLeft.toString() : null;
  // A full exit means nothing is left in the wallet, not just that the 100% rung held.
  out.fullExit = bps === 10000 && (tokensLeft == null || tokensLeft.isZero());
  // How far the measurement's buy drifted from the probe's (should be 0 when pinned).
  const boughtInBundle = uintAt(res, ix.tokensAfterBuy);
  out.tokensBoughtInBundleWei = boughtInBundle ? boughtInBundle.toString() : null;
  out.buyDriftBps = boughtInBundle
    ? Number(boughtInBundle.sub(tokensReceived).mul(10000).div(tokensReceived).toString())
    : null;

  // Proceeds. Native comes from the sell step's own balance diff; WETH from the
  // wallet's WETH balance afterwards, which unwraps 1:1.
  let proceeds = null;
  if (isNative) {
    const d = nativeBalanceDelta(res[ix.sell], wallet);
    if (d && d.gt(0)) proceeds = d;
  } else {
    proceeds = uintAt(res, ix.wethAfter);
  }
  if (proceeds == null) {
    return { ...out, ok: false, reason: 'the sell went through but its ETH proceeds could not be read from the response — re-run with TENDERLY_DEBUG=1 and check tenderly-last-response.json' };
  }
  out.proceedsWei = proceeds.toString();

  // If the ladder had to sell less than everything, scale the proceeds up to a
  // like-for-like comparison — and flag it, because a scaled number is an
  // estimate of a trade you cannot actually make.
  const scaledProceeds = bps === 10000 ? proceeds : proceeds.mul(10000).div(bps);
  out.scaledProceedsWei = scaledProceeds.toString();

  // Token tax: what the pool received versus what we sent it.
  const poolBefore = uintAt(res, ix.poolBefore);
  const poolAfter = uintAt(res, ix.poolAfter);
  let taxBps = null;
  if (poolBefore != null && poolAfter != null && sellAmountWei.gt(0)) {
    const receivedByPool = poolAfter.sub(poolBefore);
    const shortfall = sellAmountWei.sub(receivedByPool);
    taxBps = shortfall.gt(0) ? Number(shortfall.mul(10000).div(sellAmountWei).toString()) : 0;
  }
  out.sellTaxBps = taxBps;

  // Gas: measured units from this bundle, priced at the live gas price.
  const gasUnits = totalGasUsed(res);
  const gasCost = gasUnits.mul(gasPrice);
  out.gasUnits = gasUnits.toString();
  out.gasCostWei = gasCost.toString();

  const netWei = proceeds.sub(amountInWei).sub(gasCost);
  out.netWei = netWei.toString();
  out.netPct = Number(netWei.mul(1000000).div(amountInWei).toString()) / 10000;

  // Unavoidable floor: the pool fee is charged on both legs.
  const feePpm = Number(p.fee);
  out.feePpm = feePpm;
  out.feeFloorPct = (Number.isFinite(feePpm) && feePpm > 0 && feePpm < DYNAMIC_FEE_SENTINEL)
    ? Number(((1 - Math.pow(1 - feePpm / 1e6, 2)) * 100).toFixed(4))
    : null;
  // 0x800000 is a FLAG, not a rate. A plain fee of 0 is a real 0% LP fee.
  out.feeIsDynamic = Number.isFinite(feePpm) && (feePpm & DYNAMIC_FEE_SENTINEL) !== 0;
  if (Number.isFinite(feePpm) && feePpm === 0) out.feeFloorPct = 0;
  out.hook = p.version === 'v4' && p.poolKey ? hookPermissions(p.poolKey.hooks) : null;
  if (out.hook) out.hook.name = knownHookName(out.hook.address);

  out.ok = true;
  return out;
}

// --------------------------------------------------------------------------
// the statement
// --------------------------------------------------------------------------

function printStatement(r) {
  const d = r.decimals ?? 18;
  const sym = r.symbol || 'TOKEN';

  console.log(`\nWallet   ${r.wallet}`);
  console.log(`Token    ${sym}  ${r.token}`);
  console.log(`Chain    ${CHAIN_ID} (Robinhood)`);
  if (r.pool) console.log(`Pool     ${r.pool}`);
  if (r.hook) console.log(`Hook     ${r.hook.name || r.hook.address}${r.hook.canTakeSwapFee ? '  (can take a cut of swaps)' : ''}`);
  if (r.routerShape) console.log(`Router   ${r.routerShape}`);
  if (r.legsNote) console.log(`         ${r.legsNote}`);
  console.log('');

  if (r.realBalanceWei != null) {
    console.log(`Your wallet holds        ${eth(BN(r.realBalanceWei))} ETH`);
    console.log(`Simulating a buy of      ${eth(BN(ethers.utils.parseEther(String(r.amountEth))))} ETH`);
    if (r.toppedUp) {
      console.log('                         (topped up inside the fork — no real ETH is needed to run this,');
      console.log(`                          but you would need about ${eth(ethers.utils.parseEther(String(r.amountEth)).mul(11).div(10), 4)} ETH in the wallet to do it for real)`);
    }
    console.log('');
  }

  if (!r.ok) {
    console.log(`==> CANNOT COMPLETE THE ROUND TRIP`);
    console.log(`    ${r.reason}`);
    console.log('');
    return;
  }

  const inWei = ethers.utils.parseEther(String(r.amountEth));
  const received = BN(r.tokensReceivedWei);
  const left = r.tokensLeftWei == null ? null : BN(r.tokensLeftWei);
  const proceeds = BN(r.proceedsWei);
  const gas = BN(r.gasCostWei);
  const net = BN(r.netWei);

  console.log(`BUY    ${eth(inWei)} ETH   ->   ${fmtUnits(received, d, 2)} ${sym}`);
  console.log(`SELL   ${fmtUnits(received.mul(r.soldBps).div(10000), d, 2)} ${sym}  (${r.soldBps / 100}% of the position)   ->   ${eth(proceeds)} ETH`);
  console.log('');

  const row = (label, value) => console.log('  ' + label.padEnd(31) + value);
  row('ETH you put in', ' ' + eth(inWei));
  row('ETH the sell returned', ' ' + eth(proceeds));
  row(`Gas (${BN(r.gasUnits).toString()} units @ ${ethers.utils.formatUnits(r.gasPriceWei, 'gwei')} gwei)`, '-' + eth(gas));
  console.log('  ' + '-'.repeat(46));
  console.log(`  ${'NET BACK IN YOUR WALLET'.padEnd(31)}${signed(net)} ETH   (${r.netPct >= 0 ? '+' : ''}${r.netPct.toFixed(2)}%)`);
  console.log('');

  // The question actually asked: did everything sell?
  if (r.fullExit) {
    const dust = left == null ? null : left;
    if (dust == null) {
      console.log(`  Tokens left in the wallet:     unreadable`);
    } else if (dust.isZero()) {
      console.log(`  Tokens left in the wallet:     0 ${sym}  — the whole position sold.`);
    } else {
      const pctLeft = Number(dust.mul(1000000).div(received).toString()) / 10000;
      console.log(`  Tokens left in the wallet:     ${fmtUnits(dust, d, 2)} ${sym} (${pctLeft.toFixed(4)}% of the buy) — sent 100%, this did not move.`);
    }
  } else {
    console.log(`  !! 100% of the position REVERTED. ${r.soldBps / 100}% is the most that went through.`);
    console.log(`     Scaled to the full position that would be about ${eth(BN(r.scaledProceedsWei))} ETH,`);
    console.log('     but that is an estimate of a trade you cannot actually place.');
    r.attempts.filter((a) => a.reverted).forEach((a) => {
      console.log(`       ${String(a.bps / 100).padStart(5)}%  reverted: ${(a.error || '').slice(0, 110)}`);
    });
  }
  console.log('');

  // Where the money went.
  //
  // The breakdown is computed on the portion that ACTUALLY SOLD, not on the
  // whole stake. When the ladder had to drop to 95%, the missing 5% is still
  // sitting in the wallet as tokens — charging it to "price impact" would be
  // plain wrong, and it is called out on its own line instead. Gas stays out of
  // this breakdown too; it is already its own line in the statement above, and
  // counting it twice would inflate the residual.
  const soldFraction = r.soldBps / 10000;
  const stakeOnSold = inWei.mul(r.soldBps).div(10000);
  const swapLossPct = stakeOnSold.isZero()
    ? null
    : (1 - Number(ethers.utils.formatEther(proceeds)) / Number(ethers.utils.formatEther(stakeOnSold))) * 100;

  if (swapLossPct != null && swapLossPct > 0.005) {
    const on = r.fullExit ? 'the round trip' : `the ${r.soldBps / 100}% that did sell`;
    console.log(`  Where the ${swapLossPct.toFixed(2)}% lost on ${on} went:`);
    if (r.feeFloorPct != null && r.feeFloorPct > 0) {
      console.log(`    Pool LP fee, charged on both legs   ~${r.feeFloorPct.toFixed(2).padStart(6)}%   unavoidable at any size`);
    } else if (r.feeFloorPct === 0) {
      console.log(`    Pool LP fee                         ${'0.00'.padStart(7)}%   this pool charges no LP fee`);
    } else {
      console.log('    Pool LP fee                           (dynamic-fee pool — no fixed rate to quote)');
    }
    let known = r.feeFloorPct || 0;
    if (r.sellTaxBps != null) {
      const taxPct = r.sellTaxBps / 100;
      known += taxPct;
      console.log(`    Token tax taken on the sell          ${taxPct.toFixed(2).padStart(6)}%   ${taxPct > 0.01 ? 'the token itself took this in transfer' : 'none measured'}`);
    }
    // What is left over. A buy and an immediate full sell in the same state
    // hand the price impact of the buy straight back on the sell, so on a
    // round trip the residual is mostly fees the lines above could not quote —
    // a hook's cut, a dynamic fee — plus a small fee-on-impact term. Calling it
    // "price impact" misled the first live run (OPEN: 1.94% that was really
    // two ~0.99% hook fees).
    const residual = swapLossPct - known;
    if (residual > 0.01) {
      if (r.hook && r.hook.canTakeSwapFee) {
        console.log(`    Hook fee (+ a little impact)       ~${residual.toFixed(2).padStart(6)}%   the pool's hook takes a cut of each swap`);
        console.log(`      ~${(residual / 2).toFixed(2)}% per leg. transfer-audit.js shows it per leg and proves where it goes.`);
      } else if (r.feeIsDynamic) {
        console.log(`    Dynamic fee (+ a little impact)    ~${residual.toFixed(2).padStart(6)}%   set per swap by the pool's hook`);
      } else {
        console.log(`    Unexplained by fees                ~${residual.toFixed(2).padStart(6)}%   a same-block round trip recovers its own`);
        console.log('      price impact, so a large number here deserves transfer-audit.js');
      }
    }
    if (!r.fullExit) {
      console.log(`  The other ${((1 - soldFraction) * 100).toFixed(0)}% never sold at all. Those tokens are still in the wallet and are`);
      console.log('  NOT in the breakdown above — they are on top of it.');
    }
    const gasPct = Number(gas.mul(1000000).div(inWei).toString()) / 10000;
    console.log(`  Gas was a further ${gasPct < 0.01 ? 'under 0.01' : gasPct.toFixed(2)}% of the stake.`);
    console.log('');
  }

  // The headline.
  // Judged on the swap itself, against the pool fee that no trade can avoid.
  // Gas is excluded from this comparison on purpose: it is a property of the
  // chain that day, not of the token.
  const nearFeeFloor = swapLossPct != null && swapLossPct <= (r.feeFloorPct ?? 1) + 0.5;
  const verdictLine = !r.fullExit
    ? 'NO — you cannot sell the whole position'
    : swapLossPct != null && swapLossPct < 0
      ? 'YES — and the round trip came out ahead, which should not happen; re-check the pool fee reading'
      : nearFeeFloor
        ? 'YES — you get out, and it costs about the pool fee and nothing more'
        : 'YES — you get out, but it costs more than the pool fee alone';
  console.log(`==> ${verdictLine}`);
  console.log(`    In ${eth(inWei, 4)} ETH, back ${eth(proceeds.sub(gas), 4)} ETH.`);
  console.log('');
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const addrs = args.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const token = addrs[0];
  const wallet = flag('--wallet') || process.env.MY_WALLET_ADDRESS || addrs[1];
  const amountEth = Number(flag('--amount') || 0.05);
  if (!Number.isFinite(amountEth) || amountEth <= 0) {
    console.log(`--amount must be a positive number of ETH, e.g. --amount 0.05. Got: ${flag('--amount')}`);
    process.exit(1);
  }

  if (!token || !wallet) {
    console.log('usage: node wallet-round-trip.js 0xTOKEN --wallet 0xYourAddress [--amount 0.05] [--json]');
    console.log('');
    console.log('  --wallet   the address you would actually trade from. Address only.');
    console.log('             Never a private key or seed phrase — this script cannot use one');
    console.log('             and does not need one. It can also come from MY_WALLET_ADDRESS in .env.');
    console.log('');
    console.log('  Pool lookup: the live Initialize scan only reaches a few hours back on this');
    console.log('  chain, so for an older token use one of:');
    console.log('    --prefer-cache          read v2-screening-data.jsonl first (auto-detected)');
    console.log('    --cache <path>          point at that file explicitly');
    console.log('    --pool-id 0x… --fee N   give the pool directly; the PoolKey is rebuilt and');
    console.log('                            verified by hashing it back to this poolId');
    console.log('    --hooks 0x… --base ETH|WETH   only if they differ from the defaults');
    process.exit(1);
  }
  // Normalise to a checksummed address. Pasting one from an explorer in the
  // wrong case would otherwise blow up deep inside ABI encoding with
  // "bad address checksum", which reads like a bug in the script.
  let walletAddr;
  try {
    walletAddr = ethers.utils.getAddress(wallet.toLowerCase());
  } catch (_) {
    console.log(`--wallet must be a 20-byte address. Got: ${wallet}`);
    process.exit(1);
  }
  if (usingLocalSwapEncoder) {
    console.log('note: using rug-check.js\'s local copy of encodeV4SwapExecute (export the real one from tenderly-bundle-v4.js to remove this)');
  }

  // Pool resolution: the live Initialize scan only reaches a few hours back on
  // this chain, so fall through to the old screener's JSONL cache or an
  // explicit --pool-id. See pool-resolve.js.
  const poolOpts = {
    discover: discoverPool,
    addr: ADDR,
    cacheFile: flag('--cache'),
    poolId: flag('--pool-id'),
    fee: flag('--fee') ? Number(flag('--fee')) : undefined,
    hooks: flag('--hooks'),
    base: flag('--base'),
    prefer: args.includes('--prefer-cache') ? 'cache' : 'live',
  };
  const discover = async (t) => {
    const p = await resolvePool(t, poolOpts);
    if (!p || p.error) {
      console.log(`\npool lookup: ${p && p.error ? p.error : 'no pool found'}\n`);
      return null;
    }
    if (p.source && p.source !== 'live') console.log(`pool resolved from ${p.source}${p.cacheFile ? ` (${p.cacheFile})` : ''}`);
    return p;
  };

  walletRoundTrip(token, { wallet: walletAddr, amountEth, discover })
    .then((r) => {
      if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else printStatement(r);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.log('\n==> UNKNOWN');
      console.log(`    ${e.message}`);
      if (process.env.SCREEN_DEBUG) console.error(e);
      console.log('');
      process.exit(2);
    });
}

module.exports = { walletRoundTrip, printStatement };
