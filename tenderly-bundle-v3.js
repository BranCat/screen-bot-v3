// tenderly-bundle-v3.js — the Uniswap v3 counterpart to tenderly-bundle-v4.js.
//
// screen-token.js has always tried to require this file and fallen back to
// "v3 pools cannot be simulated yet" when it was missing. This is that file.
// Same export contract, same variant shape, so Gates 3, 4 and 5 light up for a
// v3 pool with no changes on the calling side.
//
//   const { simulateUniV3Txn } = require('./tenderly-bundle-v3');
//   const result = await simulateUniV3Txn(pool, ADDR, opts);
//
// ---------------------------------------------------------------------------
// WHY THIS IS SHORTER THAN THE V4 MODULE
// ---------------------------------------------------------------------------
// The v4 module carries two burdens this one does not.
//
// First, the UniversalRouter on this chain is a Robinhood fork whose swap
// struct has an extra field, so its calldata has to be hand-encoded. v3 here is
// the stock Uniswap deployment (see config.js), so SwapRouter02's ABI applies
// as published — and swap-legs.js confirms WHICH SwapRouter struct the
// deployed router wants by reading its bytecode, rather than assuming.
//
// Second, a v4 pool can be paired against native ETH, which has no balanceOf,
// so proceeds have to be recovered from a balance diff. There is no native-ETH
// v3 pool — v3 pairs are always ERC20/ERC20 — so the proceeds here are a plain
// WETH balance read. The ratio is therefore always measurable on v3, and
// `nativeProceedsUnmeasured` is always false.
//
// ---------------------------------------------------------------------------
// THE TWO PASSES, AND WHY
// ---------------------------------------------------------------------------
// The sell amount has to be inside the calldata, so it cannot be read from an
// earlier step of the same bundle. Hence:
//
//   PASS 1 (probe)        sell a conservative estimate derived from the pool
//                         reserves. Sized to succeed — the job is to discover
//                         the real post-buy balance, and a probe that reverts
//                         on size teaches nothing about the token.
//
//   PASS 2 (measurement)  re-sell 90% of what the buy ACTUALLY returned. Every
//                         number the caller uses comes from this pass.
//
// If pass 1's sell succeeds and pass 2's reverts, a small sell cleared where a
// large one did not: that is `sellCapSuspected`, and it is the signal a
// one-size check would miss entirely.

const ethers = require('ethers');
const {
  freshWallet,
  buildStep,
  simulateBundle,
  erc20Iface,
  estimateConservativeSellAmount,
  formatStepError,
  anyIndeterminate,
} = require('./tenderly-client');

// Same constants and meanings as the v4 module, so the two report comparably.
const SELL_SAFETY_FRACTION = 0.5;
const SELL_RETRY_BPS = 9000;
const RATIO_CEILING_TOLERANCE = 0.001;
const SEED_ETH = ethers.utils.parseEther('1');

const BN = (x) => ethers.BigNumber.from(x);

function uintOf(result) {
  const raw = result?.returnData;
  if (!raw || raw === '0x') return null;
  try { return BN(raw); } catch (_) { return null; }
}

// A buy-then-sell round trip cannot return more than (1 - fee)^2: the fee is
// charged on both legs and the buy's price impact is exactly reversed by the
// sell. Anything above that is our own arithmetic, not a profitable token — so
// it is recorded on the variant rather than thrown, same as the v4 module.
function annotateRatioCeiling(variant, feePpm) {
  if (variant == null || variant.ratio == null) return variant;
  if (!Number.isFinite(feePpm) || feePpm < 0 || feePpm >= 1_000_000) return variant;
  const ceiling = Math.pow(1 - feePpm / 1e6, 2);
  variant.ratioCeiling = Number(ceiling.toFixed(6));
  variant.ratioExceedsCeiling = variant.ratio > ceiling + RATIO_CEILING_TOLERANCE;
  return variant;
}

// One buy-and-sell, in a single bundle so both legs see consistent state.
async function runOneRoundTrip(p, addr, legs, amountInWei, reserves, sellAmountOverride) {
  const sellAmountWei = sellAmountOverride ?? estimateConservativeSellAmount({
    baseLiquidity: reserves.baseLiquidity,
    tokenLiquidity: reserves.tokenLiquidity,
    tokenDecimals: reserves.tokenDecimals,
    baseDecimals: reserves.baseDecimals,
    amountInWei,
    feePpm: p.fee,
    safetyFraction: SELL_SAFETY_FRACTION,
  });
  if (sellAmountWei == null) {
    return {
      unsupported: true,
      reason: 'pool reserves unavailable — cannot safely size the sell leg without them (see estimateConservativeSellAmount in tenderly-client.js)',
    };
  }

  const from = freshWallet().address;
  const steps = [];
  const ix = {};

  const buy = legs.buySteps({ from, amountInWei, seedWei: SEED_ETH });
  buy.forEach((s) => steps.push(s));
  ix.buy = steps.length - 1;

  // The wallet's real post-buy balance. Pass 2 is sized from this.
  ix.tokensAfterBuy = steps.length;
  steps.push(buildStep({ from, to: p.tokenAddr, data: erc20Iface.encodeFunctionData('balanceOf', [from]) }));

  // Bracketing the swap with the pool's own token balance gives the sell-side
  // tax directly: the pool should receive exactly what was sent.
  ix.poolBefore = steps.length;
  steps.push(buildStep({ from, to: p.tokenAddr, data: erc20Iface.encodeFunctionData('balanceOf', [legs.poolHolder]) }));

  const sell = legs.sellSteps({ from, amountInWei: sellAmountWei });
  sell.forEach((s) => steps.push(s));
  ix.sell = steps.length - 1;

  ix.poolAfter = steps.length;
  steps.push(buildStep({ from, to: p.tokenAddr, data: erc20Iface.encodeFunctionData('balanceOf', [legs.poolHolder]) }));

  // v3's base is always WETH, so the proceeds are an ordinary ERC20 read.
  ix.wethAfter = steps.length;
  steps.push(buildStep({ from, to: legs.baseAddr, data: erc20Iface.encodeFunctionData('balanceOf', [from]) }));

  let results;
  try {
    results = await simulateBundle(steps);
  } catch (e) {
    return { internalError: true, buyReverted: false, sellReverted: false, buyError: e.message, sellError: null };
  }
  if (anyIndeterminate(results)) {
    return {
      unsupported: true,
      reason: 'Tenderly returned at least one step whose status could not be parsed — round-trip result is unknown, not clean (run with TENDERLY_DEBUG=1 and check tenderly-last-response.json)',
    };
  }

  const buyRes = results[ix.buy];
  if (!buyRes || buyRes.reverted) {
    return {
      buyReverted: true, sellReverted: false,
      buyError: formatStepError(buyRes), sellError: null,
      ratio: null, sellAmountWei, actualTokenReceived: null,
      nativeProceedsUnmeasured: false,
      results,
    };
  }

  const actualTokenReceived = uintOf(results[ix.tokensAfterBuy]);

  // A sell estimate larger than the balance would revert on size, which reads
  // exactly like a restriction. Report it as our sizing error instead — the
  // caller retries from actualTokenReceived.
  if (actualTokenReceived != null && actualTokenReceived.lt(sellAmountWei)) {
    return {
      buyReverted: false, sellReverted: true, sizingError: true,
      buyError: null,
      sellError: `sizing error, not a token restriction: estimated sell amount exceeded actual buy output (estimated ${sellAmountWei.toString()}, received ${actualTokenReceived.toString()})`,
      ratio: null, sellAmountWei, actualTokenReceived,
      nativeProceedsUnmeasured: false,
      results,
    };
  }

  const sellRes = results[ix.sell];
  if (!sellRes || sellRes.reverted) {
    return {
      buyReverted: false, sellReverted: true,
      buyError: null, sellError: formatStepError(sellRes),
      ratio: null, sellAmountWei, actualTokenReceived,
      nativeProceedsUnmeasured: false,
      results,
    };
  }

  // Sell-side tax, measured rather than inferred.
  let sellTokenTaxBps = null;
  const poolBefore = uintOf(results[ix.poolBefore]);
  const poolAfter = uintOf(results[ix.poolAfter]);
  if (poolBefore != null && poolAfter != null && sellAmountWei.gt(0)) {
    const received = poolAfter.sub(poolBefore);
    const shortfall = sellAmountWei.sub(received);
    sellTokenTaxBps = shortfall.gt(0) ? Number(shortfall.mul(10000).div(sellAmountWei).toString()) : 0;
  }

  const wethOut = uintOf(results[ix.wethAfter]);
  if (wethOut == null) {
    return {
      buyReverted: false, sellReverted: false,
      buyError: null, sellError: null,
      wethIn: amountInWei, wethOut: null, ratio: null,
      sellTokenTaxBps, sellAmountWei, actualTokenReceived,
      nativeProceedsUnmeasured: false,
      proceedsUnreadable: true,
      results,
    };
  }

  // We sold `sellAmountWei` out of a real balance of `actualTokenReceived`, so
  // scale the proceeds by the fraction actually sold — not by the safety
  // constant, which is a fraction of an estimate.
  const scaledOut = (actualTokenReceived != null && sellAmountWei.gt(0))
    ? wethOut.mul(actualTokenReceived).div(sellAmountWei)
    : wethOut;
  const ratio = Number(scaledOut.mul(10000).div(amountInWei).toString()) / 10000;

  return {
    buyReverted: false, sellReverted: false,
    buyError: null, sellError: null,
    wethIn: amountInWei, wethOut, ratio,
    sellTokenTaxBps, sellAmountWei, actualTokenReceived,
    sellResizedFromActual: sellAmountOverride != null,
    nativeProceedsUnmeasured: false,
    results,
  };
}

/**
 * @param p    v3 pool descriptor from discoverPool(): { version:'v3', tokenAddr,
 *             base:'WETH', fee, poolAddress, ... }
 * @param addr config.ADDR
 * @param opts { baseAmountWei, baseLiquidity, tokenLiquidity, tokenDecimals,
 *               baseDecimals, provider }
 *
 * `provider` is required — swap-legs.js needs it to read the router's bytecode
 * and settle which exactInputSingle struct to encode. Without it this returns
 * unsupported rather than guessing, because a wrong guess reverts in a way that
 * looks exactly like a hostile token.
 */
async function simulateUniV3Txn(p, addr, opts = {}) {
  if (p.version !== 'v3') {
    return { allPassed: false, worstRatio: null, unsupported: true, reason: `simulateUniV3Txn got a ${p.version} pool`, variants: [] };
  }
  const provider = opts.provider;
  if (!provider) {
    return {
      allPassed: false, worstRatio: null, unsupported: true,
      reason: 'simulateUniV3Txn needs opts.provider to resolve the SwapRouter struct from bytecode',
      variants: [],
    };
  }

  let legs;
  try {
    const { legsFor } = require('./swap-legs');
    legs = await legsFor(p, addr, { provider });
  } catch (e) {
    return { allPassed: false, worstRatio: null, unsupported: true, reason: `could not build v3 swap legs: ${e.message}`, variants: [] };
  }

  const amountInWei = BN(opts.baseAmountWei);
  const reserves = {
    baseLiquidity: opts.baseLiquidity,
    tokenLiquidity: opts.tokenLiquidity,
    tokenDecimals: opts.tokenDecimals,
    baseDecimals: opts.baseDecimals ?? 18,
  };

  // ---- pass 1: the probe --------------------------------------------------
  const probe = await runOneRoundTrip(p, addr, legs, amountInWei, reserves, null);
  if (probe.unsupported) {
    return { allPassed: false, worstRatio: null, unsupported: true, reason: probe.reason, variants: [], routerShape: legs.routerShape };
  }
  if (probe.internalError) {
    return { allPassed: false, worstRatio: null, variants: [probe], routerShape: legs.routerShape };
  }
  if (probe.buyReverted) {
    return { allPassed: false, worstRatio: null, variants: [probe], routerShape: legs.routerShape, note: legs.note };
  }

  // ---- pass 2: the measurement -------------------------------------------
  let variant = probe;
  if (probe.actualTokenReceived && probe.actualTokenReceived.gt(0)) {
    const resized = probe.actualTokenReceived.mul(SELL_RETRY_BPS).div(10000);
    if (resized.gt(0)) {
      const measured = await runOneRoundTrip(p, addr, legs, amountInWei, reserves, resized);
      if (!measured.unsupported && !measured.internalError) {
        // A small sell cleared and ~90% of the position did not: a cap between
        // the two sizes.
        //
        // `!probe.sellReverted` is load-bearing. The claim is "a SMALLER sell
        // succeeded", so it needs the probe to have actually succeeded. If the
        // probe failed — including when it failed on our own over-estimate —
        // there is no smaller success to point at, and flagging a cap would be
        // asserting something we never observed. Not flagging is the
        // conservative direction: a missed cap is caught by the full-exit
        // ladder in wallet-round-trip.js, whereas a fabricated one is a false
        // accusation against the token.
        measured.sellCapSuspected =
          Boolean(measured.sellReverted) && !measured.sizingError && !probe.sellReverted;
        measured.probeTokenReceived = probe.actualTokenReceived;
        // The probe's own sizing miss would otherwise vanish once the resize
        // recovered. Kept so the caller can tell "clean on the second try"
        // from "clean first time".
        if (probe.sizingError) {
          measured.probeSizingError = true;
          measured.probeSellError = probe.sellError;
        }
        variant = measured;
      }
    }
  }

  annotateRatioCeiling(variant, Number(p.fee));

  const allPassed = !variant.buyReverted && !variant.sellReverted;
  return {
    allPassed,
    worstRatio: variant.ratio ?? null,
    unsupported: false,
    routerShape: legs.routerShape,
    note: legs.note,
    variants: [variant],
  };
}

module.exports = { simulateUniV3Txn, runOneV3RoundTrip: runOneRoundTrip };
