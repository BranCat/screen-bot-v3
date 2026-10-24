// ============================================================================
// V4 round-trip buy/sell simulation for the honeypot trade-gate — Robinhood
// Chain specific.
//
// This chain's UniversalRouter is a MODIFIED FORK (confirmed against
// docs.bags.fm/robinhood/trade-tokens, 2026-08): its v4 swap struct carries
// an extra `minHopPriceX36` field (must be set to 0), so stock Uniswap SDK
// calldata reverts here. The encoding below — command 0x10 (V4_SWAP), actions
// [0x06 SWAP_EXACT_IN_SINGLE, 0x0c SETTLE_ALL, 0x0f TAKE_ALL] — is copied from
// that doc's "Execute the swap" section, not from the generic V4 SDK.
//
// IMPORTANT — buy and sell run in ONE Tenderly bundle call, not two:
// an earlier version split this into two separate simulateBundle() calls
// (buy first, read the resulting token balance, then build+submit the sell
// using that exact number). That doesn't work — Tenderly's /simulate-bundle
// does not carry state between independent HTTP calls, so by the second call
// the wallet has zero real token balance, and the sell reverted with
// "insufficient balance" on every run, regardless of the token's actual
// behavior (confirmed live against a token whose source has no transfer
// restrictions at all). Fix: compute a CONSERVATIVE estimate of the buy's
// output up front (see estimateConservativeSellAmount in tenderly-client.js)
// from current pool reserves, and submit buy+sell as one bundle so Tenderly
// runs them sequentially against consistent forked state.
//
// Scope: WETH-paired AND native-ETH-paired pools (base === 'WETH' or 'ETH').
// USDG-paired v4 pools are still NOT handled — there's no analog to
// WETH.deposit() to mint test USDG from nothing, so simulating a fresh
// wallet into it isn't straightforward yet. simulateUniV4Txn() returns an
// explicit "unsupported base" result rather than guessing.
//
// Native ETH handling (currency = address(0) in the pool's PoolKey) is a
// core Uniswap V4 feature, not something Robinhood/Bags-specific — the
// PoolManager accepts native ETH directly via msg.value on SETTLE, no WETH
// wrapping needed, and pays it out directly on TAKE. Confirmed against
// Uniswap's own v4-core docs (Currency type, CurrencySettler), independent
// of the Robinhood router's minHopPriceX36 modification, which is orthogonal
// to currency type. Practical effect on the buy leg: no deposit()/approve()/
// Permit2 dance at all — just send `value: amountIn` straight on execute().
//
// IMPORTANT LIMITATION for native-ETH pools specifically: the sell leg still
// pulls the TOKEN from the wallet via the normal ERC20-approve + Permit2
// path (unchanged — this is the step that actually detects a transferFrom
// trap, so buyOk/sellOk revert detection is fully reliable for native-ETH
// pools too). But the *proceeds* of that sell come back as native ETH, not
// an ERC20 — and unlike WETH.balanceOf(), there's no simple contract call to
// read a wallet's native balance after the fact within this bundle. Rather
// than guess at Tenderly's asset-change response schema (unverified), this
// module reports ratio: null / nativeProceedsUnmeasured: true for native-ETH
// sells instead of computing a possibly-wrong number. The core honeypot
// signal (does the sell revert at all) is unaffected by this — only the
// finer-grained "silent tax" ratio detection is unavailable for this case.
//
// Router spends any ERC20 input via Permit2 (two-leg approval: ERC20 ->
// Permit2, then Permit2 -> router) — per the docs. Every leg is simulated as
// a real transaction in the bundle so the buy and sell exercise the exact
// code path a live trade would take.
//
// Flow per variant (WETH-paired case), ONE Tenderly bundle:
//   1. seed wallet with native ETH (state override)
//   2. WETH.deposit()
//   3. WETH.approve(Permit2, max)
//   4. Permit2.approve(WETH, UniversalRouter, max, expiration)
//   5. UniversalRouter.execute(V4_SWAP, [buy calldata], deadline)
//   6. token.balanceOf(wallet) — informational only, NOT used to size the sell
//   7. token.approve(Permit2, max)
//   8. Permit2.approve(token, UniversalRouter, max, expiration)
//   9. UniversalRouter.execute(V4_SWAP, [sell calldata], deadline) — sells a
//      pre-computed conservative amount, not "whatever step 6 read"
//   10. WETH.balanceOf(wallet)
//
// Native-ETH-paired case skips steps 2-4 (no wrap/approve needed for native
// ETH) and step 10 (can't read native proceeds this way — see above).
//
// SELL SIZING (revised 2026-09-11) — read this before changing either knob:
// the sell leg is sized from the buy's REAL post-buy balance (SELL_RETRY_BPS,
// 90%), which costs a second bundle per variant because Tenderly cannot tell
// us that balance until the first bundle has run. The first bundle is a probe
// sized from the pre-trade xy=k estimate; the second is the measurement. This
// replaced a single-bundle design that sold SELL_SAFETY_FRACTION (50%) of that
// estimate and scaled the proceeds back up linearly, which was wrong twice
// over: proceeds are concave in size, so the scale-up overstated a full exit,
// and selling half never proved the other half was sellable — a token with a
// max-sell cap anywhere between ~50% and 100% of the position passed cleanly.
//
// The second bundle is paid for by dropping the old large-size (10x) variant,
// so the Tenderly cost per token is unchanged at two bundles. That variant
// existed to catch honeypots that only block bigger sells, but it measured the
// wrong thing: on the 2026-09-11 local run its ratio erred by up to +0.76%
// against the (1-fee)^2 ceiling and 2 of 4 samples scored above the
// mathematical maximum, always in the flattering direction. Sell-size traps
// are now probed by selling MORE of the actual position, not by buying more.
// ============================================================================

const { ethers } = require('ethers');
const {
  freshWallet, ethBalanceOverride, buildStep, simulateBundle,
  erc20Iface, wethIface, MAX_UINT256, MAX_UINT160, estimateConservativeSellAmount, formatStepError, anyIndeterminate, nativeBalanceDelta,
} = require('./tenderly-client');

const universalRouterIface = new ethers.utils.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
const permit2Iface = new ethers.utils.Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const V4_SWAP_COMMAND = '0x10';
const V4_ACTIONS = ethers.utils.solidityPack(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

const SWAP_PARAMS_TYPE =
  'tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)';

const SEED_ETH = ethers.utils.parseEther('1');
const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 3600;
const ROUTER_DEADLINE_SECONDS = 600;
// Sizes the PROBE bundle only — see estimateConservativeSellAmount() header in
// tenderly-client.js. Deliberately conservative: the probe exists to discover
// the real post-buy balance, and a probe that reverts on size teaches us
// nothing about the token.
const SELL_SAFETY_FRACTION = 0.5;
// Sizes the MEASUREMENT bundle, from the wallet's real post-buy balance. 90%
// leaves headroom for fee-on-transfer tokens. Everything downstream — ratio,
// sellTokenTaxBps, sellCapSuspected — comes from this pass.
const SELL_RETRY_BPS = 9000;
// A buy-then-sell round trip in one pool cannot return more than (1 - fee)^2:
// the fee is charged on both legs and the buy's price impact is exactly
// reversed by the sell. Concentrated liquidity can only make it worse by
// crossing ticks, never better. Anything above that ceiling is our own
// arithmetic, not a profitable token. 0.001 absorbs rounding in the 4-dp ratio
// without absorbing a real defect: on the 2026-09-11 run the (sound)
// normal-size samples sat +0.0004 over the ceiling and the (unsound) 10x
// samples +0.0024 to +0.0076.
const RATIO_CEILING_TOLERANCE = 0.001;

// Builds the manually-encoded router calldata for one exact-in leg. `side`
// only affects which currency is "in" vs "out" for the settle/take steps —
// direction (zeroForOne) is derived from poolKey + which address is the
// token, so this works whether the token happens to sort above or below the
// base currency. `baseAddr` is whichever address represents "the other side"
// of the pool from the token — the WETH contract address for WETH-paired
// pools, or the zero address for native-ETH-paired pools (Currency's native
// sentinel, same convention Uniswap V4 core uses throughout).
function encodeV4SwapExecute({ poolKey, tokenAddr, baseAddr, side, amountIn, amountOutMinimum }) {
  const tokenIsCurrency0 = poolKey.currency0.toLowerCase() === tokenAddr.toLowerCase();
  const zeroForOne = side === 'buy' ? !tokenIsCurrency0 : tokenIsCurrency0; // buy = base->token, sell = token->base
  const inputCurrency = side === 'buy' ? baseAddr : tokenAddr;
  const outputCurrency = side === 'buy' ? tokenAddr : baseAddr;

  const swapParams = ethers.utils.defaultAbiCoder.encode([SWAP_PARAMS_TYPE], [{
    poolKey: {
      currency0: poolKey.currency0, currency1: poolKey.currency1,
      fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks,
    },
    zeroForOne,
    amountIn,
    amountOutMinimum,
    minHopPriceX36: 0, // Robinhood-only field vs vanilla Uniswap V4 — always disabled
    hookData: '0x',
  }]);
  const settleAll = ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [inputCurrency, amountIn]);
  const takeAll = ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [outputCurrency, amountOutMinimum]);
  const routerInput = ethers.utils.defaultAbiCoder.encode(['bytes', 'bytes[]'], [V4_ACTIONS, [swapParams, settleAll, takeAll]]);

  const deadline = Math.floor(Date.now() / 1000) + ROUTER_DEADLINE_SECONDS;
  return universalRouterIface.encodeFunctionData('execute', [V4_SWAP_COMMAND, [routerInput], deadline]);
}

// Data-quality guard, not a token check: records whether a measured ratio
// exceeds what a round trip can physically return (see RATIO_CEILING_TOLERANCE).
// A hit means OUR arithmetic drifted — historically the linear scale-up of a
// partial sell — so it is recorded on the variant rather than thrown, to flag
// the record without losing the token. Mutates and returns `result`.
//
// Skipped when feePpm is not a static rate: v4 dynamic-fee pools carry the
// sentinel 0x800000 (8,388,608) in this field, not a fee, and the ceiling is
// undefined for them. The >= 1e6 guard catches that sentinel on its own.
function annotateRatioCeiling(result, feePpm) {
  if (result == null || result.ratio == null) return result;
  if (!Number.isFinite(feePpm) || feePpm < 0 || feePpm >= 1_000_000) return result;
  const ceiling = Math.pow(1 - feePpm / 1e6, 2);
  result.ratioCeiling = Number(ceiling.toFixed(6));
  result.ratioExceedsCeiling = result.ratio > ceiling + RATIO_CEILING_TOLERANCE;
  return result;
}

/**
 * @param p     pending-pool object from token-screener-v3.js: needs
 *              { tokenAddr, base, poolKey } — poolKey is the exact
 *              { currency0, currency1, fee, tickSpacing, hooks } from the
 *              Initialize event, used as-is (not reconstructed) so this
 *              works for Bags graduates AND any other v4 pool on the chain.
 * @param addr  { WETH, UNIVERSAL_ROUTER, PERMIT2, ZERO, UNIV4_POOL_MANAGER }
 *              UNIV4_POOL_MANAGER is optional — without it, sellTokenTaxBps
 *              (see runOneRoundTrip below) comes back null instead of a
 *              measured value, but everything else still works.
 * @param opts.baseAmountWei — same as the v3 module. opts.largeSizeMultiplier
 *              is accepted and ignored since 2026-09-11 (see the sell-sizing
 *              note in the file header); callers need not stop passing it.
 * @param opts.baseLiquidity, opts.tokenLiquidity, opts.tokenDecimals
 *              current pool reserves — required to size the sell leg safely.
 *              Without these, returns { unsupported: true, reason } for
 *              every variant.
 * @param opts.baseDecimals  decimals of the base asset — defaults to 18
 *              (WETH/native ETH); pass 6 explicitly for a USDG-based pool.
 */
async function simulateUniV4Txn(p, addr, opts = {}) {
  if (p.base !== 'WETH' && p.base !== 'ETH') {
    return {
      allPassed: false, worstRatio: null, unsupported: true,
      reason: `base asset '${p.base}' not yet supported by tenderly-bundle-v4.js (WETH- or native-ETH-paired pools only — see file header)`,
      variants: [],
    };
  }

  const baseAmountWei = ethers.BigNumber.from(opts.baseAmountWei || ethers.utils.parseEther('0.005'));
  const reserves = {
    baseLiquidity: opts.baseLiquidity ?? null,
    tokenLiquidity: opts.tokenLiquidity ?? null,
    tokenDecimals: opts.tokenDecimals ?? null,
    baseDecimals: opts.baseDecimals ?? 18,
  };
  const variants = [
    { label: 'normal-size', amountInWei: baseAmountWei },
  ];

  const results = [];
  for (const variant of variants) {
    // 2026-09-07: this handler catches ANY throw, including bugs in our own
    // code. It used to report them as `buyReverted: true`, which the screener
    // classified as a severe concern and wrote to the permanent flagged-
    // template store. A missing export ("anyIndeterminate is not a function")
    // therefore looked exactly like a token blocking the buy, on 10 tokens.
    // `internalError` lets the screener tell "our fault" from "the token's".
    const onError = (e) => ({
      buyReverted: true, sellReverted: true, internalError: true,
      buyError: e.message, sellError: e.message,
      wethIn: variant.amountInWei, wethOut: null, ratio: null, sellTokenTaxBps: null,
    });
    // PROBE pass. Sized from the pre-trade estimate; its job is to reach a
    // successful buy so the wallet's real token balance can be read.
    const probe = await runOneRoundTrip(p, addr, variant.amountInWei, reserves).catch(onError);
    let result = probe;

    // MEASUREMENT pass. Unconditional since 2026-09-11 — it used to run only
    // as recovery from a sizing error, which left the common case measuring a
    // ~50% sell and scaling it up linearly. See the file header.
    if (probe.actualTokenReceived && probe.actualTokenReceived.gt(0)) {
      const resized = probe.actualTokenReceived.mul(SELL_RETRY_BPS).div(10000);
      // Skip when the probe already sold at least this much: re-running would
      // spend a bundle to learn nothing.
      const worthRerunning = probe.sizingError || resized.gt(probe.sellAmountWei ?? 0);
      if (resized.gt(0) && worthRerunning) {
        const retry = await runOneRoundTrip(p, addr, variant.amountInWei, reserves, resized).catch(onError);
        if (retry.sizingError) {
          result = { ...retry, sellError: `${retry.sellError} (after resize retry)` };
        } else if (retry.sellReverted && !probe.sellReverted && !probe.buyReverted) {
          // The probe sold its slice fine and 90% of the position reverts. That
          // asymmetry IS the finding — a max-sell / max-tx cap sitting between
          // the two sizes, which is exactly the trap the old half-sell design
          // could not see. Keep the reverting result (it is the honest one) and
          // record the size that did clear, so the cap can be bracketed later.
          result = {
            ...retry,
            sellCapSuspected: true,
            probeSellAmountWei: probe.sellAmountWei ?? null,
            probeTokenReceived: probe.actualTokenReceived,
          };
        } else {
          result = retry;
        }
      }
    }
    annotateRatioCeiling(result, Number(p.fee));
    results.push({ label: variant.label, amountInWei: variant.amountInWei, ...result });
  }

  // 2026-10-08: a variant that could not be simulated at all (no reserves to
  // size the sell) used to sit in `results` with no revert flags, and callers
  // read it as "buy ok, sell ok". Say it plainly at the top level instead.
  const unsupportedVariant = results.find((r) => r.unsupported);
  if (unsupportedVariant) {
    return { allPassed: false, worstRatio: null, unsupported: true, reason: unsupportedVariant.reason, variants: results };
  }

  // For native-ETH pools, ratio is intentionally null on every variant (see
  // file header) — allPassed only requires no reverts in that case, since
  // there's nothing to band-check. worstRatio stays null rather than
  // collapsing to a misleading number.
  const isNative = p.base === 'ETH';
  const allPassed = results.every((r) => !r.buyReverted && !r.sellReverted && (isNative || r.ratio != null));
  const worstRatio = isNative
    ? null
    : (() => {
        const w = results.reduce((min, r) => (r.ratio != null && r.ratio < min ? r.ratio : min), Infinity);
        return w === Infinity ? null : w;
      })();

  return { allPassed, worstRatio, unsupported: false, variants: results };
}

// sellAmountOverride: set on the RETRY pass (see simulateUniV4Txn) to size the
// sell leg from the buy's ACTUAL output rather than the pre-bundle xy=k
// estimate, which on concentrated-liquidity pools has been observed
// overshooting real output badly enough to revert the sell.
async function runOneRoundTrip(p, addr, amountInWei, reserves = {}, sellAmountOverride = null) {
  const isNative = p.base === 'ETH';
  const baseAddr = isNative ? addr.ZERO : addr.WETH;

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

  const wallet = freshWallet();
  const from = wallet.address;

  // ---- BUY: base -> token ----
  const buyExecuteData = encodeV4SwapExecute({
    poolKey: p.poolKey, tokenAddr: p.tokenAddr, baseAddr,
    side: 'buy', amountIn: amountInWei, amountOutMinimum: 0,
  });

  let buySteps;
  if (isNative) {
    // No wrap, no approve, no Permit2 — native ETH is sent directly as the
    // execute() call's value. Just seed the wallet and swap.
    buySteps = [
      buildStep({
        from, to: addr.UNIVERSAL_ROUTER, data: buyExecuteData, value: amountInWei, gas: 5_000_000,
        stateObjects: ethBalanceOverride(from, SEED_ETH),
      }),
    ];
  } else {
    const nowSec = Math.floor(Date.now() / 1000);
    const depositData = wethIface.encodeFunctionData('deposit');
    const approveWethToPermit2Data = erc20Iface.encodeFunctionData('approve', [addr.PERMIT2, MAX_UINT256]);
    const permit2ApproveWethData = permit2Iface.encodeFunctionData('approve', [addr.WETH, addr.UNIVERSAL_ROUTER, MAX_UINT160, nowSec + PERMIT2_EXPIRY_SECONDS]);
    buySteps = [
      buildStep({ from, to: addr.WETH, data: depositData, value: amountInWei, stateObjects: ethBalanceOverride(from, SEED_ETH) }),
      buildStep({ from, to: addr.WETH, data: approveWethToPermit2Data }),
      buildStep({ from, to: addr.PERMIT2, data: permit2ApproveWethData }),
      buildStep({ from, to: addr.UNIVERSAL_ROUTER, data: buyExecuteData, gas: 5_000_000 }),
    ];
  }
  const buyStepCount = buySteps.length;
  const balanceOfStepIndex = buyStepCount; // informational read, right after the buy leg

  // ---- SELL: token -> base ----
  // This leg is identical in structure regardless of base asset — the token
  // side always needs a real ERC20 approve + Permit2 approve, and THIS pull
  // (Permit2 calling token.transferFrom on the router's behalf) is the step
  // that actually reveals a transferFrom trap. Only what happens to the
  // *proceeds* differs by base asset. amountIn is the pre-computed
  // conservative estimate, NOT a value read from the buy step above — see
  // file header for why.
  const approveTokenToPermit2Data = erc20Iface.encodeFunctionData('approve', [addr.PERMIT2, MAX_UINT256]);
  const nowSec2 = Math.floor(Date.now() / 1000);
  const permit2ApproveTokenData = permit2Iface.encodeFunctionData('approve', [p.tokenAddr, addr.UNIVERSAL_ROUTER, MAX_UINT160, nowSec2 + PERMIT2_EXPIRY_SECONDS]);
  const sellExecuteData = encodeV4SwapExecute({
    poolKey: p.poolKey, tokenAddr: p.tokenAddr, baseAddr,
    side: 'sell', amountIn: sellAmountWei, amountOutMinimum: 0,
  });
  // Brackets the sell's execute() call so the PoolManager singleton's raw
  // token balance can be diffed across it — see sellTokenTaxBps below for
  // why this is a more precise tax signal than the WETH ratio. Notably this
  // works for native-ETH pools too (unlike the ratio, which is always null
  // there per the file header) — it only reads the TOKEN side of the sell,
  // never the native-ETH proceeds, so the "can't read native balance"
  // limitation doesn't apply to it.
  const poolManagerAddr = addr.UNIV4_POOL_MANAGER || null;
  const poolTokenBalanceData = poolManagerAddr ? erc20Iface.encodeFunctionData('balanceOf', [poolManagerAddr]) : null;

  const sellLegStartIndex = balanceOfStepIndex + 1;
  const sellSteps = [
    buildStep({ from, to: p.tokenAddr, data: approveTokenToPermit2Data }),
    buildStep({ from, to: addr.PERMIT2, data: permit2ApproveTokenData }),
  ];
  let poolBalBeforeIndex = null;
  if (poolTokenBalanceData) {
    poolBalBeforeIndex = sellLegStartIndex + sellSteps.length;
    sellSteps.push(buildStep({ from, to: p.tokenAddr, data: poolTokenBalanceData }));
  }
  const sellExecuteIndex = sellLegStartIndex + sellSteps.length;
  sellSteps.push(buildStep({ from, to: addr.UNIVERSAL_ROUTER, data: sellExecuteData, gas: 5_000_000 }));
  let poolBalAfterIndex = null;
  if (poolTokenBalanceData) {
    poolBalAfterIndex = sellLegStartIndex + sellSteps.length;
    sellSteps.push(buildStep({ from, to: p.tokenAddr, data: poolTokenBalanceData }));
  }
  let wethAfterIndex = null;
  // WETH-paired case: one more step to read the resulting WETH balance —
  // there's no equivalent read for native ETH proceeds (see file header),
  // so that step (and the ratio it enables) is simply omitted for native.
  if (!isNative) {
    wethAfterIndex = sellLegStartIndex + sellSteps.length;
    sellSteps.push(buildStep({ from, to: addr.WETH, data: erc20Iface.encodeFunctionData('balanceOf', [from]) }));
  }

  // All steps in ONE bundle call — see file header for why this matters.
  const allSteps = [
    ...buySteps,
    buildStep({ from, to: p.tokenAddr, data: erc20Iface.encodeFunctionData('balanceOf', [from]) }), // informational
    ...sellSteps,
  ];

  const results = await simulateBundle(allSteps);
  // 2026-09: if any step's status could not be parsed out of the response, we
  // do not know what happened — say so rather than letting normalizeResult's
  // "not succeeded" reading surface as a token-level revert signal.
  if (anyIndeterminate(results)) {
    return {
      unsupported: true,
      reason: 'Tenderly returned at least one step whose status could not be parsed — round-trip result is unknown, not clean (run with TENDERLY_DEBUG=1 and check tenderly-last-response.json)',
    };
  }
  // Per Tenderly's docs, a failing step returns an early cutoff — results can
  // be shorter than allSteps if something reverted partway through.
  const buyResultSlice = results.slice(0, buyStepCount);
  const buyReverted = buyResultSlice.length < buyStepCount || buyResultSlice.some((r) => r.reverted);
  if (buyReverted) {
    const firstError = formatStepError(buyResultSlice.find((r) => r.reverted));
    return {
      buyReverted: true, sellReverted: true, buyError: firstError || 'buy leg did not complete',
      sellError: null, wethIn: amountInWei, wethOut: null, ratio: null, sellTokenTaxBps: null,
    };
  }

  const balAfterBuyRes = results[balanceOfStepIndex];
  let actualTokenReceived = null;
  try { actualTokenReceived = ethers.BigNumber.from(balAfterBuyRes?.returnData || '0x0'); } catch (_) { /* informational only */ }
  if (actualTokenReceived != null && actualTokenReceived.lt(sellAmountWei)) {
    // Our conservative estimate somehow still exceeded what the buy actually
    // produced — sell will genuinely revert on balance, but that's our
    // sizing being wrong, not a transferFrom trap. Flag it distinctly rather
    // than letting it masquerade as sellOk: false.
    return {
      buyReverted: false, sellReverted: true,
      buyError: null,
      sellError: `sizing error, not a token restriction: estimated sell amount exceeded actual buy output (estimated ${sellAmountWei.toString()}, received ${actualTokenReceived.toString()})`,
      // NOT a token restriction — simulateUniV4Txn re-runs this variant sized
      // from actualTokenReceived before anything reaches the caller.
      sizingError: true,
      actualTokenReceived,
      wethIn: amountInWei, wethOut: null, ratio: null, sellTokenTaxBps: null,
    };
  }

  const approveTokenRes = results[sellLegStartIndex];
  const permit2ApproveTokenRes = results[sellLegStartIndex + 1];
  const poolBalBeforeRes = poolBalBeforeIndex != null ? results[poolBalBeforeIndex] : null;
  const sellRes = results[sellExecuteIndex];
  const poolBalAfterRes = poolBalAfterIndex != null ? results[poolBalAfterIndex] : null;
  if (!approveTokenRes || !permit2ApproveTokenRes || !sellRes || approveTokenRes.reverted || permit2ApproveTokenRes.reverted || sellRes.reverted) {
    return {
      buyReverted: false, sellReverted: true,
      buyError: null,
      sellError: formatStepError(sellRes) || formatStepError(permit2ApproveTokenRes) || formatStepError(approveTokenRes) || 'sell leg did not complete',
      wethIn: amountInWei, wethOut: null, ratio: null, sellTokenTaxBps: null,
    };
  }

  // Exact transfer-tax measurement — see file header addendum above
  // poolTokenBalanceData. Works regardless of native vs WETH-paired, since
  // it only looks at the token side of the sell.
  let sellTokenTaxBps = null;
  if (poolBalBeforeRes && poolBalAfterRes) {
    try {
      const poolBefore = ethers.BigNumber.from(poolBalBeforeRes.returnData || '0x0');
      const poolAfter = ethers.BigNumber.from(poolBalAfterRes.returnData || '0x0');
      const actualPoolReceived = poolAfter.sub(poolBefore);
      const shortfall = sellAmountWei.sub(actualPoolReceived);
      sellTokenTaxBps = shortfall.gt(0) ? Number(shortfall.mul(10000).div(sellAmountWei).toString()) : 0;
    } catch (_) { /* leave sellTokenTaxBps null — informational, not worth failing the check over */ }
  }

  if (isNative) {
    // 2026-09-07: native proceeds ARE measurable after all — see
    // nativeBalanceDelta() in tenderly-client.js for the verification. Until
    // now this returned ratio: null, which meant a native-ETH pool could
    // return a fraction of your money and still be reported as a clean round
    // trip: the sell not reverting was the only thing being checked.
    const nativeOut = nativeBalanceDelta(sellRes, from);
    if (nativeOut == null || nativeOut.lte(0)) {
      return {
        buyReverted: false, sellReverted: false, buyError: null, sellError: null,
        wethIn: amountInWei, wethOut: null, ratio: null, sellTokenTaxBps,
        nativeProceedsUnmeasured: true,
        sellAmountWei, actualTokenReceived,
        sellResizedFromActual: sellAmountOverride != null,
      };
    }
    // Same scaling correction as the WETH path: we sold `sellAmountWei` out of
    // a real post-buy balance of `actualTokenReceived`, so scale the proceeds
    // by the fraction actually sold rather than by the SELL_SAFETY_FRACTION
    // constant, which is a fraction of an ESTIMATE.
    const scaledNativeOut = (actualTokenReceived != null && sellAmountWei.gt(0))
      ? nativeOut.mul(actualTokenReceived).div(sellAmountWei)
      : nativeOut.mul(Math.round(1000 / SELL_SAFETY_FRACTION)).div(1000);
    const nativeRatio = Number(scaledNativeOut.mul(10000).div(amountInWei).toString()) / 10000;
    return {
      buyReverted: false, sellReverted: false, buyError: null, sellError: null,
      wethIn: amountInWei, wethOut: nativeOut, ratio: nativeRatio, sellTokenTaxBps,
      nativeProceedsUnmeasured: false,
      sellAmountWei, actualTokenReceived,
      sellResizedFromActual: sellAmountOverride != null,
    };
  }

  const wethAfterRes = results[wethAfterIndex];
  let wethOut;
  try { wethOut = ethers.BigNumber.from(wethAfterRes?.returnData || '0x0'); }
  catch (_) { wethOut = ethers.BigNumber.from(0); }

  // We only sold ~SELL_SAFETY_FRACTION of the buy's estimated output, not all
  // of it — scale proceeds back up by that same fraction so `ratio` stays
  // comparable to "proceeds if the full round trip had been sold," which is
  // what highTaxSuspicious downstream expects.
  // FIX: sellAmountWei is SELL_SAFETY_FRACTION of an ESTIMATE, not of the real
  // buy output — so whenever the estimate was off, the ratio was off by the
  // same factor and then failed the inBand check. Scale by the fraction
  // actually sold when the post-buy balance is known.
  const scaledWethOut = (actualTokenReceived != null && sellAmountWei.gt(0))
    ? wethOut.mul(actualTokenReceived).div(sellAmountWei)
    : wethOut.mul(Math.round(1000 / SELL_SAFETY_FRACTION)).div(1000);
  const ratio = Number(scaledWethOut.mul(10000).div(amountInWei).toString()) / 10000;
  return {
    buyReverted: false, sellReverted: false, buyError: null, sellError: null,
    wethIn: amountInWei, wethOut, ratio, sellTokenTaxBps,
    sellAmountWei, actualTokenReceived,
    sellResizedFromActual: sellAmountOverride != null,
  };
}

// Exported alongside simulateUniV4Txn so tenderly-transfrom-fail.js can run a
// single fast round trip (its whole point is being a cheap pre-filter) without
// duplicating this bundle-building logic or paying for the full multi-variant sweep.
module.exports = { simulateUniV4Txn, runOneV4RoundTrip: runOneRoundTrip, encodeV4SwapExecute };

