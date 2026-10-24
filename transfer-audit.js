// transfer-audit.js — "the pool paid out 1,000,000 tokens. Did 1,000,000
// actually land in my wallet?"
//
//   node transfer-audit.js 0xTOKEN --wallet 0xYourAddress [--amount 0.05]
//
// wallet-round-trip.js answers what the trade costs. It cannot tell you WHY,
// because it infers the residual: fee and measured sell tax come out, and
// whatever is left over gets called "price impact". That is a guess. A token
// skimming 5% on every transfer and a pool with 5% price impact produce the
// same number there.
//
// This script separates them by measuring both sides of every transfer.
//
// ---------------------------------------------------------------------------
// THE IDEA
// ---------------------------------------------------------------------------
// A Uniswap swap is not one movement, it is a chain of them:
//
//     PoolManager  --(a)-->  UniversalRouter  --(b)-->  your wallet
//
// The AMM decides how much leaves the PoolManager. That figure already has the
// pool fee and the price impact baked into it — it IS the honest "in theory"
// number, and it needs no quoter to obtain, because it is simply the pool's own
// balance before minus after.
//
// Everything that happens AFTER that is the token's business. If the pool paid
// out 1,000,000 and 950,000 reached you, no amount of price impact explains the
// missing 50,000. The token's transfer hook took it.
//
// So every leg is measured at both ends, with the router and the token's own
// address watched as well, which turns "5% went missing" into "5% went missing
// and here is the address holding it".
//
// ---------------------------------------------------------------------------
// WHAT IT CHECKS
// ---------------------------------------------------------------------------
//
//   BUY LEG    pool paid out  vs  wallet received       -> hidden buy tax
//   SELL LEG   wallet sent    vs  pool received         -> hidden sell tax
//   SELL LEG   pool paid ETH  vs  wallet received ETH   -> skim on the way out
//
//   transfer()      wallet -> a fresh address           -> plain transfer tax
//   transferFrom()  a spender moves your tokens         -> the DEX-shaped path
//
// That last pair is the point of the whole script. A common design taxes
// transferFrom() while leaving transfer() clean, because the naive check anyone
// writes first is a wallet-to-wallet transfer. Both paths are run here on the
// same token in the same bundle, and if they disagree the script says so in
// those words — a difference between them is not an accident.
//
//   approve(MAX) then read the allowance back           -> does approve work
//   approve(exact) then transferFrom(exact)             -> exact-allowance trap
//   allowance after a transferFrom                      -> accounting sanity
//
// ---------------------------------------------------------------------------
// WHAT IT CANNOT SEE
// ---------------------------------------------------------------------------
// One block, one wallet, one size. A token that turns hostile on the second
// sell, after a timer, or above a size threshold will pass this. The ladder in
// wallet-round-trip.js covers size; the rest is what Gate 6 and repeat runs are
// for. Nothing here proves a token is safe — it proves that on this trade, at
// this moment, the numbers either reconcile or they do not.
//
// No private key. Tenderly spoofs senders; nothing is ever signed.

require('dotenv').config();
const ethers = require('ethers');

const config = require('./config');
const { ADDR, RPC_URL, CHAIN_ID } = config;
const { discoverPool } = require('./screen-token');
const { resolvePool, hookPermissions, knownHookName, HOOK_FLAGS } = require('./pool-resolve');
const { usingLocalSwapEncoder } = require('./rug-check');
const { legsFor } = require('./swap-legs');
const {
  freshWallet,
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

const tokenIface = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const permit2Iface = new ethers.utils.Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
// Standard Uniswap v4 quoter shape. UNVERIFIED on this chain — the
// UniversalRouter here is a fork with an extra field, so the quoter may be too.
// Used only as a cross-check, and a failure is reported as "unavailable", never
// as a finding about the token.
const v4QuoterIface = new ethers.utils.Interface([
  'function quoteExactInputSingle((( address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);

const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 3600;
// A gap this small is rounding in the AMM's own integer maths, not a tax.
const NOISE_BPS = 2;
const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a || '').toLowerCase();

// 2026-10-19: every bundle of one audit runs on the SAME block (CAPA, 18 Oct).
// The four bundles used to run on whatever block was newest. The sell is sized
// from the probe bundle (90% of what the probe's buy returned), so when the price
// moved between the probe and the sell bundle — normal in the first minutes of a
// launch — the sell bundle's own buy returned fewer tokens and the sell asked for
// more than the wallet held. It reverted, and that read as "the buy works but the
// sell REVERTS": a honeypot finding on a token Gate 4 had just sold 100% of, twice.
// CAPA: probe 2,631,025 -> sell 2,367,923; the bundle's buy delivered ~2,310,659.
// Same fault, same fix as wallet-round-trip.js (2026-10-18). ROUND_TRIP_PIN=0
// turns both off.
const pinOn = () => process.env.ROUND_TRIP_PIN !== '0';
const pinSteps = (steps, n) => (n == null ? steps : steps.map((st) => ({ ...st, block_number: n })));

// --------------------------------------------------------------------------
// bundle builder
// --------------------------------------------------------------------------

function newBundle() {
  const steps = [];
  const ix = {};
  return {
    steps,
    ix,
    add(name, step) {
      if (name) ix[name] = steps.length;
      steps.push(step);
      return steps.length - 1;
    },
  };
}

const uintAt = (results, i) => {
  if (i == null) return null;
  const raw = results[i]?.returnData;
  if (!raw || raw === '0x') return null;
  try { return BN(raw); } catch (_) { return null; }
};

function bps(part, whole) {
  if (part == null || whole == null || BN(whole).isZero()) return null;
  return Number(BN(part).mul(10000).div(whole).toString());
}

// --------------------------------------------------------------------------
// swap legs
// --------------------------------------------------------------------------

function addBuyLegs(b, { legs, wallet, amountInWei, seedWei }) {
  const steps = legs.buySteps({ from: wallet, amountInWei, seedWei });
  steps.forEach((st, i) => b.add(i === steps.length - 1 ? 'buy' : null, st));
}

function addSellLegs(b, { legs, wallet, amountInWei, name = 'sell' }) {
  const steps = legs.sellSteps({ from: wallet, amountInWei });
  steps.forEach((st, i) => b.add(i === steps.length - 1 ? name : null, st));
}

// The addresses watched either side of every swap leg. Between them they
// account for where a missing balance went: still at the pool, kept by the
// router, absorbed by the token contract itself, or delivered to the wallet.
//
// `pool` is whichever address actually custodies the pool's tokens — the v3
// pool contract itself, or the v4 PoolManager singleton. That difference is the
// whole reason this comes from legsFor rather than being hardcoded.
function watchList(legs, p, wallet) {
  const list = [
    ['pool', legs.poolHolder],
    ['router', legs.router],
    ['self', p.tokenAddr],
    ['wallet', wallet],
  ];
  // A v4 hook with swap-delta permissions can take part of the output; watch
  // it so "went missing" can become "went to the hook".
  const hp = p.version === 'v4' && p.poolKey ? hookPermissions(p.poolKey.hooks) : null;
  if (hp) list.push(['hook', hp.address]);
  return list;
}

function addWatchReads(b, legs, p, wallet, tag) {
  for (const [name, who] of watchList(legs, p, wallet)) {
    b.add(`${tag}_${name}`, buildStep({
      from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('balanceOf', [who]),
    }));
  }
  // The base side too, whenever it is an ERC20 we can read: WETH on v3 and on
  // WETH-paired v4. This is what makes "did all the ETH arrive" a direct
  // measurement rather than something inferred from a balance diff.
  if (legs.baseIsErc20) {
    b.add(`${tag}_basePool`, buildStep({ from: wallet, to: legs.baseAddr, data: erc20Iface.encodeFunctionData('balanceOf', [legs.poolHolder]) }));
    b.add(`${tag}_baseWallet`, buildStep({ from: wallet, to: legs.baseAddr, data: erc20Iface.encodeFunctionData('balanceOf', [wallet]) }));
  }
}

function readWatch(results, ix, tag) {
  const out = {};
  for (const name of ['pool', 'router', 'self', 'wallet', 'hook', 'basePool', 'baseWallet']) {
    out[name] = uintAt(results, ix[`${tag}_${name}`]);
  }
  return out;
}

// --------------------------------------------------------------------------
// bundle 1 — how many tokens does the buy actually produce?
// --------------------------------------------------------------------------

async function probeBuy({ p, legs, wallet, amountInWei, seedWei, sim = simulateBundle }) {
  const b = newBundle();
  addBuyLegs(b, { legs, wallet, amountInWei, seedWei });
  b.add('bal', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('balanceOf', [wallet]) }));
  const res = await sim(b.steps);
  if (anyIndeterminate(res)) return { error: 'Tenderly returned a step with no readable status on the buy' };
  const buyRes = res[b.ix.buy];
  if (!buyRes || buyRes.reverted) {
    const why = formatStepError(buyRes);
    // "out of gas" is almost never the token. A concentrated-liquidity swap
    // pays per initialized tick crossed, so a buy that is large relative to
    // current liquidity — especially in a fee-100 / tickSpacing-1 pool — can
    // exhaust any fixed limit. Say that, rather than letting it read as a
    // finding.
    const gassy = /out of gas|gas required exceeds/i.test(why || '');
    return {
      error: gassy
        ? `the buy ran out of gas (limit ${process.env.SWAP_GAS || 15000000}). This is a sizing problem, not a token behaviour: a concentrated-liquidity swap costs gas per tick it crosses, and this pool's tick spacing is fine. Try a smaller --amount (0.01, then 0.005), or raise SWAP_GAS.`
        : `the buy reverted: ${why}`,
      buyReverted: true,
    };
  }
  const bal = uintAt(res, b.ix.bal);
  if (bal == null || bal.isZero()) return { error: 'the buy did not revert but no tokens arrived' };
  return { tokens: bal };
}

// --------------------------------------------------------------------------
// bundle 2 — the buy leg, measured at both ends
// --------------------------------------------------------------------------

async function auditBuy({ p, legs, wallet, amountInWei, seedWei, sim = simulateBundle }) {
  const b = newBundle();
  addWatchReads(b, legs, p, wallet, 'pre');
  addBuyLegs(b, { legs, wallet, amountInWei, seedWei });
  addWatchReads(b, legs, p, wallet, 'post');

  const res = await sim(b.steps);
  if (anyIndeterminate(res)) return { error: 'indeterminate step in the buy audit' };
  const buyRes = res[b.ix.buy];
  if (!buyRes || buyRes.reverted) return { error: `the buy reverted: ${formatStepError(buyRes)}` };

  const pre = readWatch(res, b.ix, 'pre');
  const post = readWatch(res, b.ix, 'post');
  if (pre.pool == null || post.pool == null || pre.wallet == null || post.wallet == null) {
    return { error: 'could not read the pool or wallet token balance around the buy' };
  }

  // What the AMM decided to pay out. Fee and price impact are already inside
  // this number, which is why no quoter is needed to call it "in theory".
  const poolPaidOut = pre.pool.sub(post.pool);
  const walletReceived = post.wallet.sub(pre.wallet);
  const missing = poolPaidOut.sub(walletReceived);

  return {
    poolPaidOut,
    walletReceived,
    missing,
    taxBps: bps(missing, poolPaidOut),
    routerKept: post.router != null && pre.router != null ? post.router.sub(pre.router) : null,
    selfGained: post.self != null && pre.self != null ? post.self.sub(pre.self) : null,
    hookGained: post.hook != null && pre.hook != null ? post.hook.sub(pre.hook) : null,
  };
}

// --------------------------------------------------------------------------
// bundle 3 — the sell leg, measured at both ends, tokens and ETH
// --------------------------------------------------------------------------

async function auditSell({ p, legs, wallet, amountInWei, seedWei, sellAmountWei, sim = simulateBundle }) {
  const b = newBundle();

  addBuyLegs(b, { legs, wallet, amountInWei, seedWei });
  // The sell's own approvals are part of the leg builder (a plain ERC20
  // approve on v3, an approve plus a Permit2 approve on v4), so they are
  // emitted here BEFORE the pre-reads — the approvals move no balances, and
  // keeping them outside the measured window means the reads bracket the swap
  // itself and nothing else.
  const sellSteps = legs.sellSteps({ from: wallet, amountInWei: sellAmountWei });
  const swapStep = sellSteps[sellSteps.length - 1];
  sellSteps.slice(0, -1).forEach((st) => b.add(null, st));

  addWatchReads(b, legs, p, wallet, 'pre');
  b.add('sell', swapStep);
  addWatchReads(b, legs, p, wallet, 'post');

  const res = await sim(b.steps);
  if (anyIndeterminate(res)) return { error: 'indeterminate step in the sell audit' };
  const sellRes = res[b.ix.sell];
  if (!sellRes || sellRes.reverted) {
    // The pre-sell reads ran before the swap, in the same bundle, so they say
    // exactly what the wallet held when the sell was attempted. Asking to sell
    // more than that is our sizing fault, not the token refusing the sale.
    const held = uintAt(res, b.ix.pre_wallet);
    const oversized = held != null && held.lt(sellAmountWei);
    return {
      error: `the sell reverted: ${formatStepError(sellRes)}`,
      sellReverted: true,
      heldBeforeSell: held,
      sellAmountWei,
      oversized,
    };
  }

  const pre = readWatch(res, b.ix, 'pre');
  const post = readWatch(res, b.ix, 'post');
  if (pre.wallet == null || post.wallet == null || pre.pool == null || post.pool == null) {
    return { error: 'could not read the pool or wallet token balance around the sell' };
  }

  const walletSent = pre.wallet.sub(post.wallet);
  const poolReceived = post.pool.sub(pre.pool);
  const missing = walletSent.sub(poolReceived);

  // The base side.
  //
  // When the base is WETH — always on v3, and on WETH-paired v4 — both ends are
  // ordinary ERC20 balances, so the pool's outflow and the wallet's inflow are
  // both measured directly and the gap between them is exact.
  //
  // A native-ETH v4 pool has no balanceOf, so both come out of the step's
  // balance diff instead. Same comparison, weaker source.
  let poolPaidEth = null;
  let walletReceivedEth = null;
  if (legs.baseIsErc20) {
    if (pre.basePool != null && post.basePool != null) poolPaidEth = pre.basePool.sub(post.basePool);
    if (pre.baseWallet != null && post.baseWallet != null) walletReceivedEth = post.baseWallet.sub(pre.baseWallet);
  } else {
    const poolDelta = nativeBalanceDelta(sellRes, legs.poolHolder);
    const walletDelta = nativeBalanceDelta(sellRes, wallet);
    if (poolDelta != null && poolDelta.lt(0)) poolPaidEth = poolDelta.mul(-1);
    if (walletDelta != null && walletDelta.gt(0)) walletReceivedEth = walletDelta;
  }
  let hookGainedEth = null;
  const hp = p.version === 'v4' && p.poolKey ? hookPermissions(p.poolKey.hooks) : null;
  if (hp && !legs.baseIsErc20) {
    const d = nativeBalanceDelta(sellRes, hp.address);
    if (d != null) hookGainedEth = d;
  }

  return {
    walletSent,
    poolReceived,
    missing,
    taxBps: bps(missing, walletSent),
    routerKept: post.router != null && pre.router != null ? post.router.sub(pre.router) : null,
    selfGained: post.self != null && pre.self != null ? post.self.sub(pre.self) : null,
    hookGained: post.hook != null && pre.hook != null ? post.hook.sub(pre.hook) : null,
    hookGainedEth,
    poolPaidEth,
    walletReceivedEth,
      ethGapBps: (poolPaidEth && walletReceivedEth && poolPaidEth.gt(0))
      ? bps(poolPaidEth.sub(walletReceivedEth), poolPaidEth) : null,
  };
}

// --------------------------------------------------------------------------
// bundle 4 — transfer() vs transferFrom(), and the allowance
// --------------------------------------------------------------------------
//
// No DEX in this bundle at all beyond the buy that sources the tokens. Both
// paths move the SAME quantity between fresh addresses that hold nothing else,
// in the same forked state, so the two results are directly comparable and any
// difference between them is the token choosing to behave differently
// depending on who moved the tokens.

async function auditTransferPaths({ p, legs, wallet, amountInWei, seedWei, quantity, sim = simulateBundle }) {
  const recipientA = freshWallet().address; // plain transfer() destination
  const spender = freshWallet().address;    // the approved third party
  const recipientB = freshWallet().address; // transferFrom() destination
  const spender2 = freshWallet().address;   // exact-allowance test
  const recipientC = freshWallet().address;

  const b = newBundle();
  addBuyLegs(b, { legs, wallet, amountInWei, seedWei });

  // --- path 1: transfer() -------------------------------------------------
  b.add('t_send', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('transfer', [recipientA, quantity]) }));
  b.add('t_arrived', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('balanceOf', [recipientA]) }));

  // --- path 2: transferFrom() with an unlimited allowance -----------------
  b.add('tf_approve', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('approve', [spender, MAX_UINT256]) }));
  b.add('tf_allowanceAfterApprove', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('allowance', [wallet, spender]) }));
  b.add('tf_send', buildStep({ from: spender, to: p.tokenAddr, data: tokenIface.encodeFunctionData('transferFrom', [wallet, recipientB, quantity]) }));
  b.add('tf_arrived', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('balanceOf', [recipientB]) }));
  b.add('tf_allowanceAfterSend', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('allowance', [wallet, spender]) }));

  // --- path 3: transferFrom() with an EXACT allowance ---------------------
  // Some tokens accept an unlimited approval and reject an exact one, which
  // breaks every router that approves precisely what it needs.
  b.add('ex_approve', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('approve', [spender2, quantity]) }));
  b.add('ex_allowance', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('allowance', [wallet, spender2]) }));
  b.add('ex_send', buildStep({ from: spender2, to: p.tokenAddr, data: tokenIface.encodeFunctionData('transferFrom', [wallet, recipientC, quantity]) }));
  b.add('ex_arrived', buildStep({ from: wallet, to: p.tokenAddr, data: tokenIface.encodeFunctionData('balanceOf', [recipientC]) }));

  const res = await sim(b.steps);
  if (anyIndeterminate(res)) return { error: 'indeterminate step in the transfer audit' };

  const stepOk = (name) => {
    const r = res[b.ix[name]];
    return { ok: Boolean(r) && !r.reverted, error: r && r.reverted ? formatStepError(r) : null };
  };

  const tSend = stepOk('t_send');
  const tArrived = uintAt(res, b.ix.t_arrived);
  const tfSend = stepOk('tf_send');
  const tfArrived = uintAt(res, b.ix.tf_arrived);
  const exSend = stepOk('ex_send');
  const exArrived = uintAt(res, b.ix.ex_arrived);

  const allowanceMax = uintAt(res, b.ix.tf_allowanceAfterApprove);
  const allowanceAfter = uintAt(res, b.ix.tf_allowanceAfterSend);
  const allowanceExact = uintAt(res, b.ix.ex_allowance);

  const transferTaxBps = tSend.ok && tArrived != null ? bps(quantity.sub(tArrived), quantity) : null;
  const transferFromTaxBps = tfSend.ok && tfArrived != null ? bps(quantity.sub(tfArrived), quantity) : null;

  return {
    quantity,
    transfer: { reverted: !tSend.ok, error: tSend.error, arrived: tArrived, taxBps: transferTaxBps },
    transferFrom: { reverted: !tfSend.ok, error: tfSend.error, arrived: tfArrived, taxBps: transferFromTaxBps },
    exactAllowance: {
      reverted: !exSend.ok,
      error: exSend.error,
      arrived: exArrived,
      taxBps: exSend.ok && exArrived != null ? bps(quantity.sub(exArrived), quantity) : null,
      allowanceSet: allowanceExact,
      allowanceMatches: allowanceExact != null && allowanceExact.eq(quantity),
    },
    allowance: {
      afterMaxApprove: allowanceMax,
      maxApproveHonoured: allowanceMax != null && allowanceMax.gte(quantity),
      afterTransferFrom: allowanceAfter,
    },
    // The headline: the same quantity, moved two ways, with different results.
    asymmetric:
      transferTaxBps != null && transferFromTaxBps != null &&
      Math.abs(transferTaxBps - transferFromTaxBps) > NOISE_BPS,
    pathDisagreesOnRevert: tSend.ok !== tfSend.ok,
  };
}

// --------------------------------------------------------------------------
// optional cross-check: the quoter
// --------------------------------------------------------------------------

async function quoteBuy(p, amountInWei, prov) {
  try {
    const tokenIsCurrency0 = lc(p.poolKey.currency0) === lc(p.tokenAddr);
    const data = v4QuoterIface.encodeFunctionData('quoteExactInputSingle', [{
      poolKey: {
        currency0: p.poolKey.currency0, currency1: p.poolKey.currency1,
        fee: p.poolKey.fee, tickSpacing: p.poolKey.tickSpacing, hooks: p.poolKey.hooks,
      },
      zeroForOne: !tokenIsCurrency0,
      exactAmount: amountInWei,
      hookData: '0x',
    }]);
    const raw = await prov.call({ to: ADDR.V4_QUOTER || ADDR.UNIV4_QUOTER, data });
    if (!raw || raw === '0x') return null;
    return v4QuoterIface.decodeFunctionResult('quoteExactInputSingle', raw)[0];
  } catch (_) {
    // The router on this chain is a fork with an extra field; the quoter may
    // be too. A failure here says nothing about the token.
    return null;
  }
}

// --------------------------------------------------------------------------
// the run
// --------------------------------------------------------------------------

// pinnedBlock: the block to simulate on. screen-token.js passes Gate 3's pinned
// block, so the audit sees the same state the round trips did. Without it the
// audit pins to the current block itself.
// makeLegs: injectable for the offline tests only.
async function transferAudit(tokenAddr, { wallet, amountEth = 0.05, prov = provider, discover = discoverPool, pinnedBlock = null, makeLegs = legsFor } = {}) {
  const out = { token: tokenAddr, wallet, amountEth };
  const amountInWei = ethers.utils.parseEther(String(amountEth));

  // The block every bundle below runs on. Tenderly may not have the newest
  // block yet; if it refuses the pin on the FIRST bundle (the probe), the whole
  // audit falls back to latest once and says so in pinFallback. After the probe
  // has run on the pinned block, the block is known to work, so a later error is
  // a real error and is not papered over by silently mixing blocks.
  let pin = null;
  if (pinOn()) {
    if (pinnedBlock != null) pin = Number(pinnedBlock);
    else if (typeof prov.getBlockNumber === 'function') {
      try { pin = await prov.getBlockNumber(); } catch (_) { pin = null; }
    }
  }
  out.pinnedBlock = pin;
  let pinConfirmed = false;
  const sim = async (steps) => {
    if (pin == null) return simulateBundle(steps);
    if (pinConfirmed) return simulateBundle(pinSteps(steps, pin));
    try {
      const r = await simulateBundle(pinSteps(steps, pin));
      pinConfirmed = true;
      return r;
    } catch (e) {
      out.pinFallback = `block ${pin} refused, simulated on latest instead: ${String(e.message).slice(0, 160)}`;
      pin = null;
      out.pinnedBlock = null;
      return simulateBundle(steps);
    }
  };

  const realBalance = await prov.getBalance(wallet);
  out.realBalanceWei = realBalance.toString();
  const needed = amountInWei.add(amountInWei.div(10));
  out.toppedUp = realBalance.lt(needed);
  const seedWei = out.toppedUp ? needed : realBalance;

  const p = await discover(tokenAddr);
  if (!p) return { ...out, ok: false, reason: 'no WETH or native-ETH pool found on v3 or v4' };
  out.pool = p.label;
  out.version = p.version;
  out.hook = p.version === 'v4' && p.poolKey ? hookPermissions(p.poolKey.hooks) : null;
  if (out.hook) out.hook.name = knownHookName(out.hook.address);

  // Both protocols, one interface. For v3 this also resolves which
  // exactInputSingle struct the router wants, from its bytecode.
  let legs;
  try {
    legs = await makeLegs(p, ADDR, { provider: prov });
  } catch (e) {
    return { ...out, ok: false, reason: `could not build swap legs for this pool: ${e.message}` };
  }
  out.routerShape = legs.routerShape || null;
  if (legs.note) out.legsNote = legs.note;

  // decimals / symbol, best effort
  for (const [fn, key, dflt] of [['decimals', 'decimals', 18], ['symbol', 'symbol', 'TOKEN']]) {
    try {
      const raw = await prov.call({ to: tokenAddr, data: tokenIface.encodeFunctionData(fn) });
      out[key] = raw && raw !== '0x' ? tokenIface.decodeFunctionResult(fn, raw)[0] : dflt;
    } catch (_) { out[key] = dflt; }
  }
  out.decimals = Number(out.decimals);

  const probe = await probeBuy({ p, legs, wallet, amountInWei, seedWei, sim });
  if (probe.error) return { ...out, ok: false, reason: probe.error, buyReverted: probe.buyReverted };
  out.tokensReceivedWei = probe.tokens.toString();

  // Sell 90% and move 5% through each transfer path, so all four probes fit
  // inside one buy without competing for the same tokens.
  const sellAmountWei = probe.tokens.mul(9000).div(10000);
  const quantity = probe.tokens.mul(500).div(10000);
  if (quantity.isZero()) {
    return { ...out, ok: false, reason: 'the buy returned too few token units to run the transfer probes' };
  }

  const [buyLeg, firstSell, paths, quoted] = await Promise.all([
    auditBuy({ p, legs, wallet, amountInWei, seedWei, sim }),
    auditSell({ p, legs, wallet, amountInWei, seedWei, sellAmountWei, sim }),
    auditTransferPaths({ p, legs, wallet, amountInWei, seedWei, quantity, sim }),
    p.version === 'v4' ? quoteBuy(p, amountInWei, prov) : Promise.resolve(null),
  ]);

  // The sell reverted while asking for more tokens than the wallet held: the
  // state moved between the probe and the sell bundle (only possible when the
  // pin was refused or switched off). Re-size from what the sell bundle's own
  // buy actually delivered and try once more. If that is still oversized the
  // sell is reported as unmeasured, never as a honeypot.
  let sellLeg = firstSell;
  if (firstSell && firstSell.sellReverted && firstSell.oversized && firstSell.heldBeforeSell && firstSell.heldBeforeSell.gt(0)) {
    const resized = firstSell.heldBeforeSell.mul(9000).div(10000);
    const retry = await auditSell({ p, legs, wallet, amountInWei, seedWei, sellAmountWei: resized, sim });
    out.sellResized = {
      firstAskedWei: firstSell.sellAmountWei.toString(),
      heldWei: firstSell.heldBeforeSell.toString(),
      retryAskedWei: resized.toString(),
      retryOk: !(retry && retry.error),
    };
    sellLeg = retry;
  }

  // How far the measured buy moved from the probe. 0 when pinned.
  if (buyLeg && !buyLeg.error && buyLeg.walletReceived) {
    out.buyDriftBps = bps(probe.tokens.sub(buyLeg.walletReceived), probe.tokens);
  }

  out.buyLeg = buyLeg;
  out.sellLeg = sellLeg;
  out.paths = paths;
  out.quotedBuyWei = quoted ? quoted.toString() : null;
  // Agreement between the quoter and the pool's own balance change is a
  // cross-check on the measurement, not on the token.
  out.quoteAgreesWithPool = (quoted && buyLeg && buyLeg.poolPaidOut)
    ? Math.abs(bps(quoted.sub(buyLeg.poolPaidOut).abs(), buyLeg.poolPaidOut)) <= 100
    : null;
  // The sharper question: which number does the quote match? The v4 quoter
  // runs the whole swap INCLUDING the hook's delta, but never performs the
  // final token transfer to the wallet. So:
  //   quote == wallet received  -> the shortfall is applied by the pool/hook,
  //                                and every quote already shows it
  //   quote == pool paid out    -> the shortfall happens in the token's own
  //                                transfer: a real hidden tax
  if (quoted && buyLeg && buyLeg.walletReceived && buyLeg.poolPaidOut) {
    const vsWallet = Math.abs(bps(quoted.sub(buyLeg.walletReceived).abs(), buyLeg.walletReceived));
    const vsPool = Math.abs(bps(quoted.sub(buyLeg.poolPaidOut).abs(), buyLeg.poolPaidOut));
    out.quoteMatches = vsWallet <= NOISE_BPS ? 'wallet' : vsPool <= NOISE_BPS ? 'pool' : 'neither';
  }

  out.ok = true;
  out.findings = collectFindings(out);
  return out;
}

// --------------------------------------------------------------------------
// findings
// --------------------------------------------------------------------------

// Is a leg's shortfall the pool's hook taking its fee, rather than the token?
//
// Two independent pieces of evidence, either of which is enough:
//   - the hook's own balance rose by (about) the missing amount, or
//   - on the buy, the quoter's answer equals what the wallet received — the
//     quoter includes the hook's delta but not the token's transfer, so a
//     match there locates the cut in the pool, not the token.
// Both require the hook to HAVE a swap-delta permission. Without it, a hook
// cannot legally change the amounts, and a gap stays a token finding.
function hookExplains(r, missing, hookGained, isBuy) {
  if (!r.hook || !r.hook.canTakeSwapFee || !missing || missing.lte(0)) return null;
  const close = (a, b) => a && b && b.gt(0) && Math.abs(bps(a.sub(b).abs(), b)) <= 50; // within 0.5% of the gap
  if (hookGained && close(hookGained, missing)) return 'the hook\'s own balance rose by the missing amount';
  if (isBuy && r.quoteMatches === 'wallet') return 'the quoter, which includes the hook\'s delta but not the token\'s transfer, predicted exactly what the wallet received';
  return 'unlocated';
}

function collectFindings(r) {
  const f = [];
  const pctOf = (b) => (b / 100).toFixed(2);
  const hookName = r.hook ? (r.hook.name || r.hook.address) : null;

  if (r.buyLeg && !r.buyLeg.error && r.buyLeg.taxBps != null && r.buyLeg.taxBps > NOISE_BPS) {
    const why = hookExplains(r, r.buyLeg.missing, r.buyLeg.hookGained, true);
    if (why && why !== 'unlocated') {
      f.push({
        severity: 'info',
        kind: 'hookFee',
        title: `the pool's hook takes ${pctOf(r.buyLeg.taxBps)}% of each buy`,
        detail: `${hookName}. Evidence: ${why}. This is a pool-level swap fee that every quote already shows — not a hidden token tax.`,
      });
    } else if (why === 'unlocated') {
      f.push({
        severity: 'medium',
        title: `${pctOf(r.buyLeg.taxBps)}% of the buy did not arrive, and the hook is allowed to take it`,
        detail: `${hookName} has a swap-delta permission, so it can legally keep part of a swap — but neither its balance nor the quote confirms that it did. Treat as unexplained until traced.`,
      });
    } else {
      f.push({
        severity: 'high',
        title: `hidden buy tax of ${pctOf(r.buyLeg.taxBps)}%`,
        detail: 'the pool paid out more tokens than reached the wallet. Price impact cannot explain this — it is already inside what the pool paid.',
      });
    }
  }
  if (r.sellLeg && !r.sellLeg.error && r.sellLeg.taxBps != null && r.sellLeg.taxBps > NOISE_BPS) {
    f.push({
      severity: 'high',
      title: `hidden sell tax of ${pctOf(r.sellLeg.taxBps)}%`,
      detail: 'the wallet sent more tokens than the pool received, so the shortfall was taken in transfer.',
    });
  }
  if (r.sellLeg && !r.sellLeg.error && r.sellLeg.ethGapBps != null && r.sellLeg.ethGapBps > NOISE_BPS) {
    const gap = r.sellLeg.poolPaidEth.sub(r.sellLeg.walletReceivedEth);
    const why = hookExplains(r, gap, r.sellLeg.hookGainedEth, false);
    // The sell has no quoter cross-check, so when the hook's balance can't be
    // read, a buy-side hook fee of the SAME size is taken as corroboration.
    const buyFee = f.find((x) => x.kind === 'hookFee');
    const sameAsBuy = buyFee && r.buyLeg && Math.abs(r.buyLeg.taxBps - r.sellLeg.ethGapBps) <= 5;
    if (why && why !== 'unlocated') {
      f.push({
        severity: 'info', kind: 'hookFee',
        title: `the pool's hook takes ${pctOf(r.sellLeg.ethGapBps)}% of each sell`,
        detail: `${hookName}. Evidence: ${why}. A pool-level swap fee, not the token.`,
      });
    } else if (why === 'unlocated' && sameAsBuy) {
      f.push({
        severity: 'info', kind: 'hookFee',
        title: `the pool's hook takes ${pctOf(r.sellLeg.ethGapBps)}% of each sell`,
        detail: `${hookName} has a swap-delta permission, and the cut matches the ${pctOf(r.buyLeg.taxBps)}% it provably takes on the buy. The token's own transfers were clean on the sell.`,
      });
    } else if (why === 'unlocated') {
      f.push({
        severity: 'medium',
        title: `${pctOf(r.sellLeg.ethGapBps)}% of the sell's ETH did not arrive, and the hook is allowed to take it`,
        detail: `${hookName} has a swap-delta permission; its share could not be confirmed.`,
      });
    } else {
      f.push({
        severity: 'high',
        title: `${pctOf(r.sellLeg.ethGapBps)}% of the ETH never reached the wallet`,
        detail: 'the PoolManager paid out more ETH than arrived. Something between the pool and the wallet kept the difference.',
      });
    }
  }
  // A sell that reverts after the buy went through is the most important thing
  // this audit can find: it is the honeypot. It used to be printed in the table
  // and then silently left out of the verdict, so a token that could be bought
  // but not sold could end in "NOTHING HIDDEN FOUND". Found by the planted-trap
  // test before it ever mattered on a real token.
  if (r.buyLeg && !r.buyLeg.error && r.sellLeg && r.sellLeg.error && r.sellLeg.oversized) {
    // 2026-10-19: the sell asked for more tokens than the wallet held, even after
    // re-sizing. That is the measurement, not the token (CAPA, 18 Oct). Medium:
    // the screen ends UNKNOWN, not DO NOT SNIP, because nothing was proven either way.
    const held = r.sellLeg.heldBeforeSell;
    f.push({
      severity: 'medium',
      kind: 'sellUnmeasured',
      title: 'the sell could not be measured: it asked for more tokens than the wallet held',
      detail: `asked ${r.sellLeg.sellAmountWei ? r.sellLeg.sellAmountWei.toString() : '?'}, held ${held ? held.toString() : '?'} — the price moved between simulations${r.pinnedBlock == null ? ' (they were not pinned to one block)' : ''}. Not evidence of a honeypot; wallet-round-trip.js's full exit is the better test.`,
    });
  } else if (r.buyLeg && !r.buyLeg.error && r.sellLeg && r.sellLeg.error) {
    f.push({
      severity: 'high',
      kind: 'sellReverted',
      title: 'the buy works but the sell REVERTS',
      detail: `${r.sellLeg.error}. You could get in and not get out. Confirm with wallet-round-trip.js, which walks 100% -> 99% -> 95% -> 50% to find what (if anything) can be sold.`,
    });
  }

  const paths = r.paths;
  if (paths && !paths.error) {
    if (paths.transfer.reverted) {
      f.push({ severity: 'high', title: 'transfer() reverted', detail: paths.transfer.error || 'no reason given' });
    }
    if (paths.transferFrom.reverted) {
      f.push({
        severity: 'high',
        title: 'transferFrom() reverted with a valid unlimited allowance',
        detail: `${paths.transferFrom.error || 'no reason given'} — this is the path every DEX sell uses.`,
      });
    }
    if (paths.asymmetric) {
      f.push({
        severity: 'high',
        title: `transfer() and transferFrom() are taxed differently (${pctOf(paths.transfer.taxBps ?? 0)}% vs ${pctOf(paths.transferFrom.taxBps ?? 0)}%)`,
        detail: 'the same quantity, moved two ways, between fresh addresses, in the same block. A token has to be written deliberately to do this, and the usual reason is that a simple wallet-to-wallet check looks clean while the DEX path is taxed.',
      });
    }
    if (paths.pathDisagreesOnRevert) {
      f.push({
        severity: 'high',
        title: 'one transfer path works and the other does not',
        detail: 'transfer() and transferFrom() disagree on whether the move is allowed at all.',
      });
    }
    if (!paths.allowance.maxApproveHonoured) {
      f.push({
        severity: 'high',
        title: 'approve() did not set the allowance it was given',
        detail: `after approving the maximum, the allowance reads back as ${paths.allowance.afterMaxApprove == null ? 'unreadable' : paths.allowance.afterMaxApprove.toString()}.`,
      });
    }
    if (paths.exactAllowance.reverted && !paths.transferFrom.reverted) {
      f.push({
        severity: 'medium',
        title: 'an exact allowance is rejected where an unlimited one is accepted',
        detail: `${paths.exactAllowance.error || 'no reason given'} — routers that approve precisely what they need will fail on this token.`,
      });
    }
  }
  return f;
}

// --------------------------------------------------------------------------
// the report
// --------------------------------------------------------------------------

function fmt(bn, decimals, places = 2) {
  if (bn == null) return 'n/a';
  const n = Number(ethers.utils.formatUnits(bn, decimals));
  if (!Number.isFinite(n)) return String(bn);
  return n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}
const pctStr = (b) => (b == null ? 'n/a' : `${(b / 100).toFixed(2)}%`);

function printAudit(r) {
  const d = r.decimals ?? 18;
  const sym = r.symbol || 'TOKEN';

  console.log(`\nWallet   ${r.wallet}`);
  console.log(`Token    ${sym}  ${r.token}`);
  console.log(`Chain    ${CHAIN_ID} (Robinhood)`);
  if (r.pool) console.log(`Pool     ${r.pool}`);
  if (r.hook) {
    const perms = Object.keys(HOOK_FLAGS).filter((k) => r.hook[k]).join(', ') || 'none';
    console.log(`Hook     ${r.hook.name || r.hook.address}`);
    console.log(`         permissions: ${perms}${r.hook.canTakeSwapFee ? '  (can take a cut of swaps)' : ''}`);
  }
  if (r.routerShape) console.log(`Router   ${r.routerShape}`);
  if (r.legsNote) console.log(`         ${r.legsNote}`);
  console.log('');

  if (!r.ok) {
    console.log('==> COULD NOT AUDIT');
    console.log(`    ${r.reason}`);
    console.log('');
    return;
  }

  const col = (a, b, c, e) =>
    console.log('  ' + String(a).padEnd(26) + String(b).padStart(20) + String(c).padStart(20) + '   ' + (e || ''));

  console.log('THE SWAP LEGS — what the pool paid out, against what arrived');
  console.log('');
  col('', 'pool paid out', 'wallet received', '');
  console.log('  ' + '-'.repeat(88));

  const bl = r.buyLeg;
  if (bl && !bl.error) {
    const flag = bl.taxBps != null && bl.taxBps > NOISE_BPS ? `<- ${pctStr(bl.taxBps)} MISSING` : 'clean';
    col(`BUY   ${r.amountEth} ETH ->`, `${fmt(bl.poolPaidOut, d)} ${sym}`, `${fmt(bl.walletReceived, d)} ${sym}`, flag);
    if (bl.taxBps != null && bl.taxBps > NOISE_BPS) {
      const where = [];
      if (bl.routerKept && bl.routerKept.gt(0)) where.push(`${fmt(bl.routerKept, d)} kept by the router`);
      if (bl.selfGained && bl.selfGained.gt(0)) where.push(`${fmt(bl.selfGained, d)} taken by the token contract itself`);
      if (bl.hookGained && bl.hookGained.gt(0)) where.push(`${fmt(bl.hookGained, d)} to the pool's hook`);
      if (!where.length && r.quoteMatches === 'wallet' && r.hook && r.hook.canTakeSwapFee) where.push('taken inside the swap by the pool\'s hook (the quote already excludes it)');
      console.log('    ' + (where.length ? `where it went: ${where.join('; ')}` : 'the missing tokens went to neither the router nor the token contract — burned or redirected elsewhere'));
    }
  } else {
    col('BUY', '-', '-', bl ? bl.error : 'not run');
  }

  const sl = r.sellLeg;
  if (sl && !sl.error) {
    console.log('');
    col('', 'wallet sent', 'pool received', '');
    const flag = sl.taxBps != null && sl.taxBps > NOISE_BPS ? `<- ${pctStr(sl.taxBps)} MISSING` : 'clean';
    col(`SELL  tokens ->`, `${fmt(sl.walletSent, d)} ${sym}`, `${fmt(sl.poolReceived, d)} ${sym}`, flag);
    if (sl.taxBps != null && sl.taxBps > NOISE_BPS) {
      const where = [];
      if (sl.routerKept && sl.routerKept.gt(0)) where.push(`${fmt(sl.routerKept, d)} kept by the router`);
      if (sl.selfGained && sl.selfGained.gt(0)) where.push(`${fmt(sl.selfGained, d)} taken by the token contract itself`);
      console.log('    ' + (where.length ? `where it went: ${where.join('; ')}` : 'the missing tokens went to neither the router nor the token contract'));
    }
    if (sl.poolPaidEth || sl.walletReceivedEth) {
      console.log('');
      col('', 'pool paid out', 'wallet received', '');
      const eflag = sl.ethGapBps != null && sl.ethGapBps > NOISE_BPS ? `<- ${pctStr(sl.ethGapBps)} MISSING` : (sl.ethGapBps == null ? 'pool side not measurable' : 'clean');
      col('      ETH proceeds ->', `${fmt(sl.poolPaidEth, 18, 6)} ETH`, `${fmt(sl.walletReceivedEth, 18, 6)} ETH`, eflag);
    }
  } else if (sl) {
    console.log('');
    col('SELL', '-', '-', sl.error);
  }

  // The quoter, if it answered.
  console.log('');
  if (r.version === 'v3') {
    console.log('  Cross-check: not run — the quoter wired here is the v4 one. On v3 the pool holds');
    console.log('  its own tokens, so "what the pool paid out" is read straight off the pool contract,');
    console.log('  which is the number a quoter would only be predicting.');
  } else if (r.quotedBuyWei) {
    const noGap = bl && bl.poolPaidOut && bl.walletReceived && bl.poolPaidOut.eq(bl.walletReceived);
    const m = noGap && r.quoteMatches !== 'neither'
      ? 'it matches both the pool and the wallet, which agree with each other — nothing was taken in between'
      : r.quoteMatches === 'wallet'
      ? 'it matches what the WALLET received, so the cut is applied inside the swap (pool/hook), not by the token'
      : r.quoteMatches === 'pool'
        ? 'it matches what the POOL paid out, so any cut happened in the token\'s own transfer'
        : (r.quoteAgreesWithPool ? 'close to the pool figure' : 'it matches neither, so treat the numbers above with care');
    console.log(`  Cross-check: the quoter says ${fmt(BN(r.quotedBuyWei), d)} ${sym} — ${m}`);
  } else {
    console.log('  Cross-check: the quoter did not answer (its ABI on this fork is unverified).');
    console.log('  Not a problem — the pool\'s own balance change is the better number anyway,');
    console.log('  because it is what the pool actually did rather than what it predicted.');
  }

  // Transfer paths.
  const paths = r.paths;
  console.log('');
  console.log('THE TOKEN ITSELF — the same quantity moved two ways, no DEX involved');
  console.log('');
  if (!paths || paths.error) {
    console.log(`  not run: ${paths ? paths.error : 'no result'}`);
  } else {
    const q = paths.quantity;
    col('', 'sent', 'arrived', '');
    console.log('  ' + '-'.repeat(88));
    // "clean" is only printed when a tax was actually measured and came back
    // at zero. An unmeasured leg says so — it must never read as a pass.
    const line = (label, leg) => {
      const flag = leg.reverted
        ? 'REVERTED'
        : leg.taxBps == null
          ? 'not measured'
          : leg.taxBps > NOISE_BPS
            ? `<- ${pctStr(leg.taxBps)} TAXED`
            : 'clean';
      col(label, `${fmt(q, d)} ${sym}`, leg.reverted ? '-' : `${fmt(leg.arrived, d)} ${sym}`, flag);
      if (leg.reverted && leg.error) console.log(`    ${leg.error.slice(0, 100)}`);
    };
    line('transfer()', paths.transfer);
    line('transferFrom()', paths.transferFrom);
    line('transferFrom() exact allow', paths.exactAllowance);
    console.log('');
    if (paths.asymmetric) {
      console.log('  !! The two paths disagree. A DEX sell always goes through transferFrom(),');
      console.log('     and a simple wallet-to-wallet check only ever tests transfer(). A token');
      console.log('     that taxes one and not the other was written to be checked carelessly.');
    } else if (!paths.transfer.reverted && !paths.transferFrom.reverted) {
      console.log('  Both paths behave identically, which is what an ordinary ERC20 does.');
    }
    console.log(`  approve(max) honoured: ${paths.allowance.maxApproveHonoured ? 'yes' : 'NO'}` +
      `   |   exact allowance accepted: ${paths.exactAllowance.reverted ? 'NO' : 'yes'}`);
  }

  // Verdict.
  console.log('');
  const findings = r.findings || [];
  if (!findings.length) {
    console.log('==> NOTHING HIDDEN FOUND');
    console.log('    Every token that left the pool arrived in the wallet, every token the wallet');
    console.log('    sent arrived at the pool, and both transfer paths behave the same way.');
    console.log('    That is this trade, at this size, in this block — not a guarantee about the next one.');
  } else {
    const high = findings.filter((x) => x.severity === 'high');
    const onlyInfo = findings.every((x) => x.severity === 'info');
    console.log(`==> ${high.length ? 'HIDDEN BEHAVIOUR FOUND' : onlyInfo ? 'NOTHING HIDDEN IN THE TOKEN — the pool charges a visible hook fee' : 'SOMETHING WORTH A LOOK'}`);
    findings.forEach((x) => {
      console.log(`    [${x.severity}] ${x.title}`);
      console.log(`            ${x.detail}`);
    });
  }
  console.log('');
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const addrs = args.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const token = addrs[0];
  const walletRaw = flag('--wallet') || process.env.MY_WALLET_ADDRESS || addrs[1];
  const amountEth = Number(flag('--amount') || 0.05);
  if (!Number.isFinite(amountEth) || amountEth <= 0) {
    console.log(`--amount must be a positive number of ETH, e.g. --amount 0.05. Got: ${flag('--amount')}`);
    process.exit(1);
  }

  if (!token || !walletRaw) {
    console.log('usage: node transfer-audit.js 0xTOKEN --wallet 0xYourAddress [--amount 0.05] [--json]');
    console.log('');
    console.log('  --wallet   the address you would trade from. Address only — never a private');
    console.log('             key or seed phrase. This script cannot use one and never asks.');
    console.log('');
    console.log('  Pool lookup: the live Initialize scan only reaches a few hours back on this');
    console.log('  chain, so for an older token use one of:');
    console.log('    --prefer-cache          read v2-screening-data.jsonl first (auto-detected)');
    console.log('    --cache <path>          point at that file explicitly');
    console.log('    --pool-id 0x… --fee N   give the pool directly; the PoolKey is rebuilt and');
    console.log('                            verified by hashing it back to this poolId');
    console.log('    --hooks 0x… --base ETH|WETH   only if they differ from the defaults');
    console.log('    --block N               simulate on block N (default: the current block)');
    process.exit(1);
  }
  let wallet;
  try { wallet = ethers.utils.getAddress(walletRaw.toLowerCase()); }
  catch (_) { console.log(`--wallet must be a 20-byte address. Got: ${walletRaw}`); process.exit(1); }

  if (usingLocalSwapEncoder) {
    console.log('note: using rug-check.js\'s local copy of encodeV4SwapExecute');
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

  // --block N: run every bundle on block N (a past launch, e.g. to replay CAPA's
  // audit on the block Gate 3 used). Default: pinned to the current block.
  const blockArg = flag('--block');
  const pinnedBlock = blockArg != null && /^\d+$/.test(blockArg) ? Number(blockArg) : null;

  transferAudit(token, { wallet, amountEth, discover, pinnedBlock })
    .then((r) => {
      if (args.includes('--json')) console.log(JSON.stringify(r, (_, v) => (v && v._isBigNumber ? v.toString() : v), 2));
      else {
        printAudit(r);
        console.log(r.pinnedBlock != null ? `(simulated on block ${r.pinnedBlock})` : `(simulated on the latest block${r.pinFallback ? ` — ${r.pinFallback}` : ''})`);
        if (r.sellResized) console.log(`(the first sell asked for more than the wallet held and was re-sized: ${JSON.stringify(r.sellResized)})`);
      }
      process.exit(r.ok && (r.findings || []).length === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.log('\n==> UNKNOWN');
      console.log(`    ${e.message}`);
      if (process.env.SCREEN_DEBUG) console.error(e);
      process.exit(2);
    });
}

module.exports = { transferAudit, printAudit, auditBuy, auditSell, auditTransferPaths, collectFindings };
