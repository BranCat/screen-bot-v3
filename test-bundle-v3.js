// Offline tests for tenderly-bundle-v3.js — the v3 round trip screen-token.js
// consumes at Gates 3, 4 and 5.
//
//   node test-bundle-v3.js
//
// The contract being tested is the one screen-token.js relies on: the variant
// field names, and above all that a sizing mistake of ours never surfaces as a
// finding about the token.

const { ethers } = require('ethers');

const client = require('./tenderly-client');
let SCRIPT = null;
let BUNDLES = [];
client.simulateBundle = async (steps) => { BUNDLES.push(steps); return SCRIPT(steps); };

const { simulateUniV3Txn } = require('./tenderly-bundle-v3');
const { _shapeCache } = require('./swap-legs');
const { ADDR } = require('./config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);

const E = (x) => ethers.utils.parseEther(String(x));
const T = (x) => ethers.utils.parseUnits(String(x), 18);
const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const pool = { version: 'v3', tokenAddr: TOKEN, base: 'WETH', baseAddr: ADDR.WETH, fee: 3000, poolAddress: POOL };
const provider = { async getCode() { return '0x608004e45aaf60'; } };

// Bundle shape: buy[deposit,approve,swap](3) + tokensAfterBuy(1) + poolBefore(1)
//             + sell[approve,swap](2) + poolAfter(1) + wethAfter(1) = 9 steps
const IX = { buy: 2, tokensAfterBuy: 3, poolBefore: 4, sell: 6, poolAfter: 7, wethAfter: 8 };
const LEN = 9;

const ok = () => ({ reverted: false, indeterminate: false, returnData: '0x', errorMessage: null, raw: {} });
const bad = (m) => ({ reverted: true, indeterminate: false, returnData: '0x', errorMessage: m, raw: {} });
const u = (v) => ({
  reverted: false, indeterminate: false,
  returnData: ethers.utils.hexZeroPad(ethers.BigNumber.from(v).toHexString(), 32),
  errorMessage: null, raw: {},
});

const TOKENS = T(1000000);
// Human numbers, not BigNumbers — this is the contract
// estimateConservativeSellAmount() actually has (see toRawUnits).
const RESERVES = { baseLiquidity: 50, tokenLiquidity: 1000000000, tokenDecimals: 18, baseDecimals: 18 };
const OPTS = { baseAmountWei: E(0.05), ...RESERVES, provider };

// Reads the sell amount straight out of the SwapRouter02 calldata, so the model
// can price the sell honestly instead of assuming what was asked for.
function sellAmountOf(steps) {
  const data = steps[IX.sell].input;
  // struct is all-static: tokenIn, tokenOut, fee, recipient, amountIn, ...
  return ethers.BigNumber.from('0x' + data.slice(10 + 4 * 64, 10 + 5 * 64));
}

function bundle({ sellReverts = false, poolReceives = null, wethOut = null, buyReverts = false, tokens = TOKENS } = {}) {
  return (steps) => {
    const r = new Array(LEN).fill(null).map(ok);
    if (buyReverts) { r[IX.buy] = bad('execution reverted: not open'); return r; }
    r[IX.tokensAfterBuy] = u(tokens);
    r[IX.poolBefore] = u(0);
    if (sellReverts) { r[IX.sell] = bad('execution reverted: max tx'); return r; }
    const sold = sellAmountOf(steps);
    r[IX.poolAfter] = u(poolReceives == null ? sold : sold.mul(poolReceives).div(10000));
    // Proceeds proportional to what was sold, at the requested round-trip rate.
    const rate = wethOut == null ? 0.994 : wethOut;
    r[IX.wethAfter] = u(E(0.05).mul(Math.round(rate * 10000)).div(10000).mul(sold).div(tokens));
    return r;
  };
}

async function main() {

// ==========================================================================
section('1. a clean v3 round trip');
// ==========================================================================
{
  _shapeCache.clear(); BUNDLES = [];
  SCRIPT = bundle({});
  const r = await simulateUniV3Txn(pool, ADDR, OPTS);
  check('not unsupported', r.unsupported === false, r.reason);
  check('allPassed', r.allPassed === true);
  check('the router shape is reported', r.routerShape === 'SwapRouter02', r.routerShape);
  check('two passes ran: probe then measurement', BUNDLES.length === 2, String(BUNDLES.length));
  const v = r.variants[0];
  check('the measurement pass sold 90% of the real balance',
    v.sellAmountWei.eq(TOKENS.mul(9000).div(10000)), v.sellAmountWei.toString());
  check('sellResizedFromActual is set on the measurement pass', v.sellResizedFromActual === true);
  check('ratio is measurable on v3 — there is no native-ETH case',
    v.ratio != null && v.nativeProceedsUnmeasured === false, String(v.ratio));
  check('ratio reads about 0.994', Math.abs(v.ratio - 0.994) < 0.002, String(v.ratio));
  check('no sell tax measured', v.sellTokenTaxBps === 0, String(v.sellTokenTaxBps));
  check('no cap suspected', !v.sellCapSuspected);
  // 1 - 0.997^2 = 0.599%, so the ceiling is 0.994009
  check('the round-trip ceiling is computed from the fee tier',
    Math.abs(v.ratioCeiling - 0.994009) < 1e-6, String(v.ratioCeiling));
  check('and this ratio does not exceed it', v.ratioExceedsCeiling === false);
}

// ==========================================================================
section('2. a measured sell-side tax');
// ==========================================================================
{
  _shapeCache.clear();
  SCRIPT = bundle({ poolReceives: 9000 }); // pool gets 90% of what was sent
  const r = await simulateUniV3Txn(pool, ADDR, OPTS);
  check('tax measured at 1000 bps', r.variants[0].sellTokenTaxBps === 1000, String(r.variants[0].sellTokenTaxBps));
}

// ==========================================================================
section('3. a sell cap: the probe clears, 90% does not');
// ==========================================================================
{
  _shapeCache.clear(); BUNDLES = [];
  let pass = 0;
  SCRIPT = (steps) => {
    pass += 1;
    return pass === 1 ? bundle({})(steps) : bundle({ sellReverts: true })(steps);
  };
  const r = await simulateUniV3Txn(pool, ADDR, OPTS);
  const v = r.variants[0];
  check('sellCapSuspected is set', v.sellCapSuspected === true);
  check('allPassed is false', r.allPassed === false);
  check('the revert reason is carried', /max tx/.test(v.sellError || ''), v.sellError);
  check('the claim rests on the probe having actually succeeded',
    v.probeTokenReceived != null && v.probeSizingError === undefined);
}

// ==========================================================================
section('4. OUR sizing error must never read as a token restriction');
// ==========================================================================
{
  _shapeCache.clear();
  // The buy returns far less than the reserve-based estimate assumed.
  SCRIPT = bundle({ tokens: T(1) });
  const r = await simulateUniV3Txn(pool, ADDR, OPTS);
  const v = r.variants[0];
  // The resize pass recovers from our over-estimate, so the FINAL variant is
  // clean — which is right. What must not happen is the over-estimate being
  // reported as a restriction on the token.
  check('the resize recovers and the round trip completes', r.allPassed === true, JSON.stringify(v.sellError));
  check('NOT reported as a sell cap', v.sellCapSuspected !== true);
  check('the probe\'s sizing miss is surfaced, not swallowed', v.probeSizingError === true);
  check('and it is labelled as ours', /sizing error, not a token restriction/.test(v.probeSellError || ''), v.probeSellError);
}

// ==========================================================================
section('5. failures are distinguishable from each other');
// ==========================================================================
{
  _shapeCache.clear();
  SCRIPT = bundle({ buyReverts: true });
  const buy = await simulateUniV3Txn(pool, ADDR, OPTS);
  check('a reverting buy stops before the measurement pass',
    buy.variants[0].buyReverted === true && buy.allPassed === false);
  check('and carries its reason', /not open/.test(buy.variants[0].buyError || ''));

  _shapeCache.clear();
  SCRIPT = () => new Array(LEN).fill(null).map(() => ({ reverted: false, indeterminate: true, returnData: '0x', errorMessage: 'unparsed', raw: {} }));
  const ind = await simulateUniV3Txn(pool, ADDR, OPTS);
  check('an unparsed response is unsupported, not a clean pass',
    ind.unsupported === true && /could not be parsed/.test(ind.reason), ind.reason);

  _shapeCache.clear();
  SCRIPT = () => { throw new Error('tenderly 500'); };
  const err = await simulateUniV3Txn(pool, ADDR, OPTS);
  check('a transport failure is an internalError, not a finding',
    err.variants[0].internalError === true && /tenderly 500/.test(err.variants[0].buyError));

  _shapeCache.clear();
  const noRes = await simulateUniV3Txn(pool, ADDR, { baseAmountWei: E(0.05), provider });
  check('missing reserves -> unsupported with a reason, no guessed sell size',
    noRes.unsupported === true && /reserves unavailable/.test(noRes.reason), noRes.reason);

  const noProv = await simulateUniV3Txn(pool, ADDR, { baseAmountWei: E(0.05), ...RESERVES });
  check('no provider -> unsupported rather than guessing the router struct',
    noProv.unsupported === true && /opts.provider/.test(noProv.reason), noProv.reason);

  const wrongVersion = await simulateUniV3Txn({ version: 'v4' }, ADDR, OPTS);
  check('a v4 pool handed to the v3 module is refused', wrongVersion.unsupported === true);
}

// ==========================================================================
section('6. the calldata really is v3');
// ==========================================================================
{
  _shapeCache.clear(); BUNDLES = [];
  SCRIPT = bundle({});
  await simulateUniV3Txn(pool, ADDR, OPTS);
  const steps = BUNDLES[BUNDLES.length - 1];
  check('every swap goes to SwapRouter02',
    steps.filter((s) => s.to === ADDR.SWAP_ROUTER_02).length === 2);
  check('the UniversalRouter is never touched', !steps.some((s) => s.to === ADDR.UNIVERSAL_ROUTER));
  check('Permit2 is never touched', !steps.some((s) => s.to === ADDR.PERMIT2));
  check('the pool contract is what gets balance-read, not the v4 PoolManager',
    !steps.some((s) => (s.input || '').includes(ADDR.UNIV4_POOL_MANAGER.slice(2).toLowerCase())));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
