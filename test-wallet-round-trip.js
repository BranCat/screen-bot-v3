// Offline tests for wallet-round-trip.js. No RPC, no Tenderly.
//
//   node test-wallet-round-trip.js
//
// The arithmetic in the statement is the deliverable, so it is what gets
// tested: a hand-computable scenario goes in, and every line of the statement
// is checked against a number worked out by hand at the top of each case.

const { ethers } = require('ethers');

// Stub Tenderly before the module under test destructures it.
const client = require('./tenderly-client');
let SCRIPT = null;
let BUNDLES = [];
client.simulateBundle = async (steps) => { BUNDLES.push(steps); return SCRIPT(steps); };

const wrt = require('./wallet-round-trip');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
}
const section = (t) => console.log(`\n${t}`);

const E = (x) => ethers.utils.parseEther(String(x));
const TOKEN = '0x1111111111111111111111111111111111111111';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const { ADDR } = require('./config');

const v4NativePool = {
  version: 'v4', tokenAddr: TOKEN, base: 'ETH', fee: 10000,
  poolId: '0x' + 'ab'.repeat(32), hooks: ADDR.ZERO, label: 'Uniswap v4, 1.00% fee, native ETH',
  poolKey: { currency0: ADDR.ZERO, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: ADDR.ZERO },
};

// 1 gwei, so gas is a visible but small number.
const GAS_PRICE = ethers.utils.parseUnits('1', 'gwei');

function makeProvider({ balance = E(0), decimals = 18, symbol = 'SCAM' } = {}) {
  const iface = new ethers.utils.Interface([
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);
  return {
    async getBalance() { return balance; },
    async getGasPrice() { return GAS_PRICE; },
    async call({ data }) {
      if (data.startsWith(iface.getSighash('decimals'))) {
        return iface.encodeFunctionResult('decimals', [decimals]);
      }
      if (data.startsWith(iface.getSighash('symbol'))) {
        return iface.encodeFunctionResult('symbol', [symbol]);
      }
      throw new Error('unexpected call');
    },
  };
}

const GAS_PER_STEP = 100000;
const okStep = (extra = {}) => ({
  reverted: false, indeterminate: false, returnData: '0x', errorMessage: null,
  raw: { transaction: { gas_used: GAS_PER_STEP, ...extra } },
});
const badStep = (msg) => ({
  reverted: true, indeterminate: false, returnData: '0x', errorMessage: msg,
  raw: { transaction: { gas_used: 21000 } },
});
const uintStep = (v) => ({
  reverted: false, indeterminate: false,
  returnData: ethers.utils.hexZeroPad(ethers.BigNumber.from(v).toHexString(), 32),
  errorMessage: null, raw: { transaction: { gas_used: GAS_PER_STEP } },
});
// A sell step whose native proceeds show up in the wallet's balance diff.
const sellStep = (ethOut) => ({
  reverted: false, indeterminate: false, returnData: '0x', errorMessage: null,
  raw: { transaction: {
    gas_used: GAS_PER_STEP,
    transaction_info: { balance_diff: [{ address: WALLET, original: '0', dirty: E(ethOut).toString() }] },
  } },
});

// Native v4 bundle shapes:
//   probe  = [buy, balanceOf]                                      -> 2 steps
//   full   = [buy, tokensAfterBuy, approve, permit2, poolBefore,
//             sell, poolAfter, tokensAfterSell]                    -> 8 steps
const PROBE_LEN = 2, FULL_LEN = 8;
const IX = { buy: 0, tokensAfterBuy: 1, poolBefore: 4, sell: 5, poolAfter: 6, tokensAfterSell: 7 };

// The scenario every case below builds on:
//   buy 0.05 ETH -> 1,000,000 tokens
//   sell all 1,000,000 -> 0.048 ETH
//   8 steps x 100,000 gas x 1 gwei = 0.0008 ETH of gas
//   net = 0.048 - 0.05 - 0.0008 = -0.0028 ETH = -5.60%
const TOKENS = ethers.utils.parseUnits('1000000', 18);
const PROCEEDS = 0.048;
const EXPECTED_GAS = ethers.BigNumber.from(GAS_PER_STEP).mul(FULL_LEN).mul(GAS_PRICE); // 0.0008 ETH

function fullBundleResults({ sellOut = PROCEEDS, tokensLeft = 0, poolReceived = TOKENS } = {}) {
  const r = new Array(FULL_LEN).fill(null).map(() => okStep());
  r[IX.tokensAfterBuy] = uintStep(TOKENS);
  r[IX.poolBefore] = uintStep(0);
  r[IX.sell] = sellStep(sellOut);
  r[IX.poolAfter] = uintStep(poolReceived);
  r[IX.tokensAfterSell] = uintStep(tokensLeft);
  return r;
}

async function main() {

// ==========================================================================
section('1. the clean case: everything sells, the statement adds up');
// ==========================================================================
{
  BUNDLES = [];
  SCRIPT = (steps) => {
    if (steps.length === PROBE_LEN) return [okStep(), uintStep(TOKENS)];
    return fullBundleResults();
  };
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(0.2) }),
    discover: async () => v4NativePool,
  });

  check('the run succeeded', r.ok === true, r.reason);
  check('the sender is the real wallet, not a throwaway', BUNDLES[0][0].from === WALLET);
  check('the fork is seeded with the real balance when it covers the trade',
    !r.toppedUp && r.realBalanceWei === E(0.2).toString());
  check('tokens received recorded', r.tokensReceivedWei === TOKENS.toString());
  check('sold 100% on the first rung', r.soldBps === 10000 && r.fullExit === true);
  check('only two bundles were needed (probe + measurement)', BUNDLES.length === 2, String(BUNDLES.length));
  check('nothing left in the wallet', r.tokensLeftWei === '0');
  check('proceeds read from the balance diff', r.proceedsWei === E(PROCEEDS).toString());
  check('gas priced from measured units x live gas price',
    r.gasCostWei === EXPECTED_GAS.toString(), `${r.gasCostWei} vs ${EXPECTED_GAS.toString()}`);
  // 0.048 - 0.05 - 0.0008 = -0.0028
  check('net = proceeds - stake - gas', r.netWei === E(-0.0028).toString(), r.netWei);
  check('net percentage is -5.60%', Math.abs(r.netPct - -5.6) < 0.001, String(r.netPct));
  check('no token tax measured when the pool received the full amount', r.sellTaxBps === 0);
  // 1 - 0.99^2 = 1.99%
  check('fee floor for a 1% pool is 1.99%', Math.abs(r.feeFloorPct - 1.99) < 0.001, String(r.feeFloorPct));
}

// ==========================================================================
section('2. the wallet is empty: topped up in the fork, and it says so');
// ==========================================================================
{
  SCRIPT = (steps) => (steps.length === PROBE_LEN ? [okStep(), uintStep(TOKENS)] : fullBundleResults());
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(0) }),
    discover: async () => v4NativePool,
  });
  check('flagged as topped up', r.toppedUp === true);
  check('the result is still produced — no real ETH required', r.ok === true);
  check('the real balance is reported as it is', r.realBalanceWei === '0');
}

// ==========================================================================
section('3. a token tax on the sell is measured from the pool balance');
// ==========================================================================
{
  // The pool receives only 95% of what was sent: a 5% transfer tax.
  const received = TOKENS.mul(95).div(100);
  SCRIPT = (steps) => (steps.length === PROBE_LEN
    ? [okStep(), uintStep(TOKENS)]
    : fullBundleResults({ poolReceived: received }));
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(1) }), discover: async () => v4NativePool,
  });
  check('tax measured at 500 bps', r.sellTaxBps === 500, String(r.sellTaxBps));
}

// ==========================================================================
section('4. the full position will not sell — the ladder finds the ceiling');
// ==========================================================================
{
  // 100% and 99% revert; 95% goes through. That is a real restriction, not
  // rounding, and the script must not quietly report the 95% number as if it
  // were a full exit.
  BUNDLES = [];
  // Rather than parse the sell amount back out of the calldata, count the
  // measurement bundles and fail the first two rungs.
  let measurementCalls = 0;
  SCRIPT = (steps) => {
    if (steps.length === PROBE_LEN) return [okStep(), uintStep(TOKENS)];
    measurementCalls += 1;
    if (measurementCalls <= 2) {
      const r = fullBundleResults();
      r[IX.sell] = badStep('execution reverted: transfer amount exceeds max sell');
      return r;
    }
    return fullBundleResults({ sellOut: 0.0456, tokensLeft: TOKENS.mul(5).div(100) });
  };
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(1) }), discover: async () => v4NativePool,
  });
  check('the run still produces a result', r.ok === true, r.reason);
  check('fullExit is false', r.fullExit === false);
  check('the ladder stopped at 95%', r.soldBps === 9500, String(r.soldBps));
  check('the two failed rungs are recorded with their errors',
    r.attempts.filter((a) => a.reverted).length === 2 &&
    /max sell/.test(r.attempts[0].error || ''), JSON.stringify(r.attempts));
  check('the leftover tokens are reported', r.tokensLeftWei === TOKENS.mul(5).div(100).toString());
  // 0.0456 scaled by 10000/9500 = 0.048
  check('proceeds are scaled to the full position for comparison, and kept separate',
    r.scaledProceedsWei === E(0.048).toString() && r.proceedsWei === E(0.0456).toString(),
    `${r.scaledProceedsWei} / ${r.proceedsWei}`);
  check('net is computed from the REAL proceeds, not the scaled estimate',
    r.netWei === E(0.0456).sub(E(0.05)).sub(EXPECTED_GAS).toString(), r.netWei);
}

// ==========================================================================
section('5. honeypot: nothing sells at any size');
// ==========================================================================
{
  SCRIPT = (steps) => {
    if (steps.length === PROBE_LEN) return [okStep(), uintStep(TOKENS)];
    const r = fullBundleResults();
    r[IX.sell] = badStep('execution reverted: TRANSFER_FAILED');
    return r;
  };
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(1) }), discover: async () => v4NativePool,
  });
  check('reported as a failure, not a small loss', r.ok === false && r.sellReverted === true);
  check('the reason names the honeypot signature', /honeypot/i.test(r.reason), r.reason);
  check('all four rungs were tried', r.attempts.length === 4, String(r.attempts.length));
}

// ==========================================================================
section('6. the buy itself reverts');
// ==========================================================================
{
  SCRIPT = () => [badStep('execution reverted: not open yet'), uintStep(0)];
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(1) }), discover: async () => v4NativePool,
  });
  check('reported as a buy failure', r.ok === false && r.buyReverted === true);
  check('the revert reason is passed through', /not open yet/.test(r.reason), r.reason);
}

// ==========================================================================
section('7. the buy succeeds but returns nothing');
// ==========================================================================
{
  SCRIPT = () => [okStep(), uintStep(0)];
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05,
    prov: makeProvider({ balance: E(1) }), discover: async () => v4NativePool,
  });
  check('zero tokens received is a failure, not a pass', r.ok === false);
  check('and it is described accurately', /zero tokens/.test(r.reason), r.reason);
}

// ==========================================================================
section('8. a v3 pool runs the same way, with v3 calldata');
// ==========================================================================
{
  const v3Pool = {
    version: 'v3', tokenAddr: TOKEN, base: 'WETH', baseAddr: ADDR.WETH, fee: 3000,
    poolAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', label: 'v3 (WETH pair, fee 3000)',
  };
  // v3 probe   = [deposit, approve, swap, balanceOf]                    4
  // v3 measure = buy(3) + balOf + approve + poolBefore + swap
  //              + poolAfter + balOf + wethOf                          10
  const V3_PROBE_LEN = 4, V3_FULL_LEN = 10;
  const V3 = { tokensAfterBuy: 3, poolBefore: 5, sell: 6, poolAfter: 7, tokensAfterSell: 8, weth: 9 };
  SCRIPT = (steps) => {
    if (steps.length === V3_PROBE_LEN) {
      const r = steps.map(() => okStep());
      r[V3.tokensAfterBuy] = uintStep(TOKENS);
      return r;
    }
    const r = steps.map(() => okStep());
    r[V3.tokensAfterBuy] = uintStep(TOKENS);
    r[V3.poolBefore] = uintStep(0);
    r[V3.poolAfter] = uintStep(TOKENS);
    r[V3.tokensAfterSell] = uintStep(0);
    r[V3.weth] = uintStep(ethers.utils.parseEther('0.048')); // WETH proceeds
    return r;
  };
  const prov = { ...makeProvider({ balance: E(1) }), async getCode() { return '0x6004e45aaf60'; } };
  const r = await wrt.walletRoundTrip(TOKEN, {
    wallet: WALLET, amountEth: 0.05, prov, discover: async () => v3Pool,
  });
  check('a v3 pool completes instead of being refused', r.ok === true, r.reason);
  check('the router shape was resolved from bytecode', r.routerShape === 'SwapRouter02', r.routerShape);
  check('the bundle used v3 calldata, not the UniversalRouter',
    BUNDLES[BUNDLES.length - 1].some((st) => st.to === ADDR.SWAP_ROUTER_02) &&
    !BUNDLES[BUNDLES.length - 1].some((st) => st.to === ADDR.UNIVERSAL_ROUTER));
  check('no Permit2 step on the v3 path',
    !BUNDLES[BUNDLES.length - 1].some((st) => st.to === ADDR.PERMIT2));
  check('proceeds read from the WETH balance, not a native balance diff',
    r.proceedsWei === E(0.048).toString(), r.proceedsWei);
  check('sold the whole position', r.fullExit === true && r.tokensLeftWei === '0');
  // 0.048 - 0.05 - (10 steps x 100k x 1gwei = 0.001) = -0.003
  check('net accounts for the v3 bundle being longer',
    r.netWei === E(0.048).sub(E(0.05)).sub(ethers.BigNumber.from(GAS_PER_STEP).mul(V3_FULL_LEN).mul(GAS_PRICE)).toString(),
    r.netWei);
}

// ==========================================================================
section('9. the statement prints without throwing, for every shape');
// ==========================================================================
{
  const shapes = [];
  SCRIPT = (steps) => (steps.length === PROBE_LEN ? [okStep(), uintStep(TOKENS)] : fullBundleResults());
  shapes.push(await wrt.walletRoundTrip(TOKEN, { wallet: WALLET, prov: makeProvider({ balance: E(1) }), discover: async () => v4NativePool }));
  SCRIPT = () => [badStep('nope'), uintStep(0)];
  shapes.push(await wrt.walletRoundTrip(TOKEN, { wallet: WALLET, prov: makeProvider({ balance: E(0) }), discover: async () => v4NativePool }));

  const realLog = console.log;
  let printed = '';
  console.log = (...a) => { printed += a.join(' ') + '\n'; };
  let threw = null;
  try { shapes.forEach((s) => wrt.printStatement(s)); } catch (e) { threw = e; }
  console.log = realLog;
  check('printStatement never throws', threw === null, threw && threw.message);
  check('the clean statement states the answer in ETH', /NET BACK IN YOUR WALLET/.test(printed));
  check('the clean statement answers the yes/no question', /^==> (YES|NO)/m.test(printed));
  check('the failing statement says it cannot complete', /CANNOT COMPLETE THE ROUND TRIP/.test(printed));
}

// ==========================================================================
section('10. 2026-10-18: every bundle runs on one pinned block');
// ==========================================================================
{
  // A launch in motion: on "latest", each bundle sees a new block and the buy
  // returns 2% fewer tokens than the probe did, so selling the probe amount
  // reverts. Pinned to one block, the buy returns the same amount every time.
  const PIN = 89379934;
  const pinnedProv = () => ({ ...makeProvider({ balance: E(1) }), async getBlockNumber() { return PIN; } });
  const FEWER = TOKENS.mul(98).div(100);
  const driftScript = (steps) => {
    const pinned = steps.every((st) => st.block_number === PIN);
    if (steps.length === PROBE_LEN) return [okStep(), uintStep(TOKENS)];
    if (pinned) return fullBundleResults();
    const r = fullBundleResults();
    r[IX.tokensAfterBuy] = uintStep(FEWER);
    r[IX.sell] = badStep('ERC20: transfer amount exceeds balance');
    return r;
  };
  BUNDLES = [];
  SCRIPT = driftScript;
  const r = await wrt.walletRoundTrip(TOKEN, { wallet: WALLET, prov: pinnedProv(), discover: async () => v4NativePool });
  check('pinned: every step of every bundle carries the same block_number',
    BUNDLES.every((b) => b.every((st) => st.block_number === PIN)), JSON.stringify(BUNDLES.map((b) => b[0].block_number)));
  check('pinned: the 100% sell holds on the first rung', r.ok && r.soldBps === 10000 && r.fullExit === true, r.reason);
  check('pinned: the run records its block', r.pinnedBlock === PIN);
  check('pinned: no buy drift between probe and measurement', r.buyDriftBps === 0, String(r.buyDriftBps));

  // The old behaviour, for contrast (ROUND_TRIP_PIN=0): 100% reverts, a lower rung is used.
  process.env.ROUND_TRIP_PIN = '0';
  BUNDLES = [];
  SCRIPT = (steps) => {
    if (steps.length === PROBE_LEN) return [okStep(), uintStep(TOKENS)];
    const sellAmt = BUNDLES.length; // 2 = 100% rung, 3 = 99% rung
    const res = fullBundleResults({ tokensLeft: sellAmt === 2 ? 0 : TOKENS.mul(1).div(100).sub(TOKENS.div(50)).abs() });
    res[IX.tokensAfterBuy] = uintStep(FEWER);
    if (sellAmt === 2) res[IX.sell] = badStep('ERC20: transfer amount exceeds balance');
    return res;
  };
  const old = await wrt.walletRoundTrip(TOKEN, { wallet: WALLET, prov: pinnedProv(), discover: async () => v4NativePool });
  delete process.env.ROUND_TRIP_PIN;
  check('unpinned (ROUND_TRIP_PIN=0): no block_number is sent', BUNDLES.every((b) => b.every((st) => st.block_number === undefined)));
  check('unpinned: the 100% rung reverts and 99% is used', old.ok && old.soldBps === 9900 && old.attempts[0].reverted === true);
  check('unpinned: the drift is reported (-2%)', old.buyDriftBps === -200, String(old.buyDriftBps));

  // "sold 100%" but tokens left: no longer a full exit.
  SCRIPT = (steps) => (steps.length === PROBE_LEN ? [okStep(), uintStep(TOKENS)] : fullBundleResults({ tokensLeft: TOKENS.div(100) }));
  const left = await wrt.walletRoundTrip(TOKEN, { wallet: WALLET, prov: pinnedProv(), discover: async () => v4NativePool });
  check('100% rung held but 1% still in the wallet -> fullExit false', left.ok && left.soldBps === 10000 && left.fullExit === false);

  // Tenderly refuses the block: one fallback to latest, recorded.
  BUNDLES = [];
  let refused = 0;
  SCRIPT = (steps) => {
    if (steps[0].block_number === PIN) { refused += 1; throw new Error('unknown block'); }
    return steps.length === PROBE_LEN ? [okStep(), uintStep(TOKENS)] : fullBundleResults();
  };
  const fb = await wrt.walletRoundTrip(TOKEN, { wallet: WALLET, prov: pinnedProv(), discover: async () => v4NativePool });
  check('refused block: falls back to latest once and still measures', fb.ok && refused === 1 && fb.pinnedBlock === null, fb.reason);
  check('refused block: the fallback is recorded', /block 89379934 refused/.test(fb.pinFallback || ''), fb.pinFallback);
  check('refused block: later bundles are not pinned', BUNDLES.slice(2).every((b) => b[0].block_number === undefined));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
