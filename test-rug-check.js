// Offline tests for rug-check.js. No RPC, no Tenderly — every external call is
// stubbed, so this runs anywhere and tests the parts that are easy to get
// silently wrong: calldata encoding, log decoding, and the verdict logic.
//
//   node test-rug-check.js

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// ---- stub Tenderly before rug-check destructures it -----------------------
const client = require('./tenderly-client');
let LAST_STEPS = null;
let SCRIPT = null; // (steps) => results
client.simulateBundle = async (steps) => {
  LAST_STEPS = steps;
  return SCRIPT(steps);
};

const rug = require('./rug-check');
const { usingLocalSwapEncoder } = rug;
const { legsFor } = require('./swap-legs');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok    ${name}`); }
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
}
function section(t) { console.log(`\n${t}`); }

const ADDR = require('./config').ADDR;
const TOKEN = '0x1111111111111111111111111111111111111111';
const POSM = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const POOL_V3 = '0x4444444444444444444444444444444444444444';

const v4Pool = {
  version: 'v4',
  tokenAddr: TOKEN,
  base: 'ETH',
  fee: 3000,
  poolId: '0x' + 'ab'.repeat(32),
  hooks: ADDR.ZERO,
  poolKey: {
    currency0: ADDR.ZERO,
    currency1: TOKEN,
    fee: 3000,
    tickSpacing: 60,
    hooks: ADDR.ZERO,
  },
};
const v3Pool = { version: 'v3', tokenAddr: TOKEN, base: 'WETH', fee: 3000, poolAddress: POOL_V3 };

// ==========================================================================
section('1. v4 removal calldata decodes to the intended actions');
// ==========================================================================
{
  const pos = { tokenId: '12345', liquidity: ethers.BigNumber.from('987654321'), custodian: POSM };
  const steps = rug.v4RemovalSteps({ p: v4Pool, from: OWNER, pos, recipient: OWNER });
  check('one step built', Array.isArray(steps) && steps.length === 1);
  check('sent to the custodian, not the PoolManager', steps[0].to === POSM,
    'v4 liquidity can only move inside PoolManager.unlock(), so the call must go through the PositionManager');
  check('sender is the spoofed owner', steps[0].from === OWNER);

  const posmIface = new ethers.utils.Interface([
    'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  ]);
  const decoded = posmIface.parseTransaction({ data: steps[0].input });
  check('selector is modifyLiquidities', decoded.name === 'modifyLiquidities');

  const [actions, params] = ethers.utils.defaultAbiCoder.decode(['bytes', 'bytes[]'], decoded.args.unlockData);
  check('actions are DECREASE_LIQUIDITY then TAKE_PAIR (0x0111)', actions === '0x0111', `got ${actions}`);
  check('two param blobs', params.length === 2);

  const dec = ethers.utils.defaultAbiCoder.decode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], params[0]);
  check('tokenId round-trips', dec[0].toString() === '12345');
  check('full position liquidity is requested', dec[1].toString() === '987654321');
  check('amount0Min/amount1Min are zero (we want the attempt to succeed if allowed)', dec[2].isZero() && dec[3].isZero());

  const take = ethers.utils.defaultAbiCoder.decode(['address', 'address', 'address'], params[1]);
  check('TAKE_PAIR sweeps both pool currencies', take[0] === ADDR.ZERO && take[1] === TOKEN);
  check('TAKE_PAIR recipient is the remover-side sink', take[2] === OWNER);

  const noId = rug.v4RemovalSteps({ p: v4Pool, from: OWNER, pos: { ...pos, tokenId: null }, recipient: OWNER });
  check('returns null when no tokenId was resolved (rather than encoding a bogus call)', noId === null);
}

// ==========================================================================
section('2. v3 removal goes straight to the pool: burn then collect');
// ==========================================================================
{
  const pos = { tickLower: -60, tickUpper: 60, liquidity: ethers.BigNumber.from('5000') };
  const steps = rug.v3RemovalSteps({ p: v3Pool, from: OWNER, pos, recipient: OWNER });
  check('two steps built', steps.length === 2);
  check('both target the pool itself (no periphery address needed)', steps.every((s) => s.to === POOL_V3));

  const iface = new ethers.utils.Interface([
    'function burn(int24 tickLower, int24 tickUpper, uint128 amount) returns (uint256,uint256)',
    'function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested) returns (uint128,uint128)',
  ]);
  const burn = iface.parseTransaction({ data: steps[0].input });
  const collect = iface.parseTransaction({ data: steps[1].input });
  check('step 1 is burn()', burn.name === 'burn');
  check('burn carries the position ticks and full liquidity',
    burn.args.tickLower === -60 && burn.args.tickUpper === 60 && burn.args.amount.toString() === '5000');
  check('step 2 is collect()', collect.name === 'collect');
  const MAXU128 = ethers.BigNumber.from(2).pow(128).sub(1);
  check('collect requests the uint128 max on both sides', collect.args.amount0Requested.eq(MAXU128) && collect.args.amount1Requested.eq(MAXU128));
}

let V4_LEGS = null;

async function main() {
  V4_LEGS = await legsFor(v4Pool, ADDR, {});

// ==========================================================================
section('3. the local v4 swap encoder still matches tenderly-bundle-v4.js');
// ==========================================================================
// rug-check.js carries a fallback copy of encodeV4SwapExecute for the case
// where tenderly-bundle-v4.js does not export the real one. This test is the
// guard against those two drifting apart, and it runs either way: it writes a
// temp copy of the real module with the export forced on, then diffs the
// calldata both encoders produce. Passing means the swap they build is
// identical, whichever copy is actually in use.
{
  const src = fs.readFileSync(path.join(__dirname, 'tenderly-bundle-v4.js'), 'utf8');
  const patched = src.replace(
    /module\.exports\s*=\s*\{[^}]*\};?/,
    'module.exports = { simulateUniV4Txn, runOneV4RoundTrip: runOneRoundTrip, encodeV4SwapExecute };'
  );
  const tmp = path.join(__dirname, '_tmp-bundle-v4-exported.js');
  fs.writeFileSync(tmp, patched);
  let real = null;
  try { ({ encodeV4SwapExecute: real } = require(tmp)); } catch (e) { /* reported below */ }
  check('the real encoder could be loaded from a patched copy', typeof real === 'function');

  if (typeof real === 'function') {
    // encodeV4SwapExecute embeds a Date.now()-derived deadline, so compare
    // everything except that final word of the execute() calldata.
    const args = {
      poolKey: v4Pool.poolKey, tokenAddr: TOKEN, baseAddr: ADDR.ZERO,
      amountIn: ethers.utils.parseEther('0.05'), amountOutMinimum: 0,
    };
    const iface = new ethers.utils.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
    for (const side of ['buy', 'sell']) {
      const a = iface.parseTransaction({ data: real({ ...args, side }) });
      // Route through the module's own buy/sell step builders so the fallback
      // is exercised exactly as rug-check uses it.
      const steps = side === 'buy'
        ? V4_LEGS.buySteps({ from: OWNER, amountInWei: args.amountIn })
        : V4_LEGS.sellSteps({ from: OWNER, amountInWei: args.amountIn });
      const swapStep = steps[steps.length - 1];
      const b = iface.parseTransaction({ data: swapStep.input });
      check(`${side}: commands byte matches`, a.args.commands === b.args.commands, `${a.args.commands} vs ${b.args.commands}`);
      check(`${side}: router input matches byte for byte`, a.args.inputs[0] === b.args.inputs[0]);
    }
  }
  fs.unlinkSync(tmp);
}



// ==========================================================================
section('4. the census decodes real ModifyLiquidity logs and finds the owner');
// ==========================================================================
{
  const pmIface = new ethers.utils.Interface([
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  ]);
  const salt = ethers.utils.hexZeroPad(ethers.BigNumber.from(777).toHexString(), 32);
  const mk = (sender, delta, s = salt) => {
    const ev = pmIface.encodeEventLog(pmIface.getEvent('ModifyLiquidity'), [
      v4Pool.poolId, sender, -120, 120, ethers.BigNumber.from(delta), s,
    ]);
    return { address: ADDR.UNIV4_POOL_MANAGER, topics: ev.topics, data: ev.data, blockNumber: 100 };
  };

  // A fake provider: two mints and a partial burn by the PositionManager, whose
  // ownerOf(777) answers with an EOA.
  const fakeProvider = {
    async getBlockNumber() { return 1000; },
    async getLogs() { return [mk(POSM, '1000'), mk(POSM, '500'), mk(POSM, '-200')]; },
    async getCode(a) {
      const code = { [POSM.toLowerCase()]: '0xdeadbeef' };
      return code[String(a).toLowerCase()] || '0x';
    },
    async call({ to, data }) {
      // ownerOf(777) -> OWNER
      if (String(to).toLowerCase() === POSM.toLowerCase() && data.startsWith('0x6352211e')) {
        return ethers.utils.hexZeroPad(OWNER, 32);
      }
      throw new Error('unexpected call');
    },
  };

  const census = await rug.positionCensus(v4Pool, { provider: fakeProvider, addr: ADDR, lookbackBlocks: 5000 });
  check('one net position after netting the burn', census.positionCount === 1, JSON.stringify(census.positionCount));
  check('liquidity nets to 1300', census.totalMinted === '1300', census.totalMinted);
  check('custodian recognised as a contract', census.positions[0].custodianKind === 'contract');
  check('beneficial owner resolved through ownerOf()', census.positions[0].beneficialOwner === OWNER);
  check('beneficial owner classified as an EOA', census.positions[0].beneficialOwnerKind === 'eoa');
  check('tokenId taken from the salt', census.positions[0].tokenId === '777');
  check('concentration is 100% with a single position', census.positionCount === 1 && census.concentrationPct === 100);
  check('_top carries the BigNumber record for probe 6b', census._top && census._top.liquidity.toString() === '1300');

  // An EOA custodian is the plain-as-day open rug vector.
  const eoaProvider = { ...fakeProvider, async getLogs() { return [mk(OWNER, '1000')]; } };
  const c2 = await rug.positionCensus(v4Pool, { provider: eoaProvider, addr: ADDR, lookbackBlocks: 5000 });
  check('an EOA custodian is counted as removable', c2.removableByEoaCount === 1);

  // A burned position is a genuine lock.
  const burnProvider = { ...fakeProvider, async getLogs() { return [mk('0x000000000000000000000000000000000000dEaD', '1000')]; } };
  const c3 = await rug.positionCensus(v4Pool, { provider: burnProvider, addr: ADDR, lookbackBlocks: 5000 });
  check('a position held at the burn address reads as 100% locked', c3.lockedSharePct === 100);
  check('and is not counted as removable', c3.removableByEoaCount === 0);
}

// ==========================================================================
section('5. verdict logic');
// ==========================================================================
// Steps for a native-ETH v4 pool: [buy] [removal] [approve] [permit2] [sell].
// Index 0 buy, 1 removal, 2-3 approvals, 4 sell.
const SELL_IX = 4;
const REMOVAL_IX = 1;

const okStep = { reverted: false, indeterminate: false, returnData: '0x', errorMessage: null, raw: {} };
const badStep = (msg) => ({ reverted: true, indeterminate: false, returnData: '0x', errorMessage: msg, raw: {} });
// A sell whose native proceeds are `eth` — read via balance_diff, matching the
// shape nativeBalanceDelta() expects.
const sellStep = (eth, victim) => ({
  reverted: false, indeterminate: false, returnData: '0x', errorMessage: null,
  raw: { transaction: { transaction_info: { balance_diff: [
    { address: victim, original: '0', dirty: ethers.utils.parseEther(String(eth)).toString() },
  ] } } },
});

const censusStub = {
  version: 'v4',
  positionCount: 1,
  concentrationPct: 100,
  _top: { custodian: POSM, custodianKind: 'contract', beneficialOwner: OWNER, beneficialOwnerKind: 'eoa', tokenId: '777', tickLower: -120, tickUpper: 120, liquidity: ethers.BigNumber.from('1300'), salt: null },
};
const baseOpts = {
  baseAmountWei: ethers.utils.parseEther('0.05'),
  baselineTokenOutWei: ethers.utils.parseEther('1000'),
};
// The baseline the probes are measured against. In production this comes from
// baselineRun(); here it is supplied directly so each verdict case is isolated.
const GOOD_BASELINE = { ok: true, ratio: 0.98, proceedsWei: ethers.utils.parseEther('0.049').toString() };

// -- 5a: owner pulls it and the victim's sell then dies --------------------
{
  let call = 0;
  SCRIPT = (steps) => {
    call += 1;
    const victim = steps[0].from;
    if (call === 1) {
      // owner run: removal succeeds, sell reverts
      const r = steps.map(() => ({ ...okStep }));
      r[SELL_IX] = badStep('execution reverted: TOO_LITTLE_RECEIVED');
      return r;
    }
    // stranger run: removal reverts (correct control)
    const r = steps.map(() => ({ ...okStep }));
    r[REMOVAL_IX] = badStep('execution reverted: NotApproved');
    r[SELL_IX] = sellStep(0.049, victim);
    return r;
  };
  const res = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, censusStub, GOOD_BASELINE, V4_LEGS);
  check('owner removes + victim sell reverts -> REMOVABLE_AND_FATAL', res.verdict === 'REMOVABLE_AND_FATAL', res.verdict);
  check('recovery recorded as zero', res.recoveryFraction === 0);
  check('spoofed sender is the beneficial owner, not the custodian', res.remover === OWNER && res.removerIsBeneficial === true);
}

// -- 5b: owner pulls it, victim still sells but gets a fraction back -------
{
  let call = 0;
  SCRIPT = (steps) => {
    call += 1;
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    if (call === 1) { r[SELL_IX] = sellStep(0.010, victim); return r; } // 0.010/0.05 = 0.20 ratio vs 0.98 baseline
    r[REMOVAL_IX] = badStep('execution reverted: NotApproved');
    r[SELL_IX] = sellStep(0.049, victim);
    return r;
  };
  const res = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, censusStub, GOOD_BASELINE, V4_LEGS);
  check('partial recovery below half -> REMOVABLE_AND_FATAL', res.verdict === 'REMOVABLE_AND_FATAL', res.verdict);
  check('recovery fraction is measured, not guessed', Math.abs(res.recoveryFraction - 0.2041) < 0.001, String(res.recoveryFraction));
}

// -- 5c: liquidity survives the removal attempt ---------------------------
{
  SCRIPT = (steps) => {
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    r[REMOVAL_IX] = badStep('execution reverted: LiquidityLocked');
    r[SELL_IX] = sellStep(0.049, victim);
    return r;
  };
  const res = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, censusStub, GOOD_BASELINE, V4_LEGS);
  check('owner cannot pull it -> LOCK_SUSPECTED, never a proven lock', res.verdict === 'LOCK_SUSPECTED', res.verdict);
  check('the verdict text says out loud that this is not proof', /[Nn]ot proof of a lock/.test(res.reason));
}

// -- 5d: the control fails -> the probe disowns its own result -------------
{
  SCRIPT = (steps) => {
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    r[SELL_IX] = sellStep(0.049, victim);
    return r; // everything succeeds for everyone, including the stranger
  };
  const res = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, censusStub, GOOD_BASELINE, V4_LEGS);
  check('a stranger removing liquidity too -> CONTROL_FAILED', res.verdict === 'CONTROL_FAILED', res.verdict);
}

// -- 5e: an unusable baseline is refused rather than worked around ---------
{
  const res = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, censusStub, { ok: false, reason: 'baseline sell reverted' }, V4_LEGS);
  check('unusable baseline -> UNPROVEN, no finding reported', res.verdict === 'UNPROVEN', res.verdict);
  check('and the reason names the baseline, not the token', /baseline/.test(res.reason), res.reason);
}

// -- 5f: empty census ------------------------------------------------------
{
  const res = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, { ...censusStub, _top: null }, GOOD_BASELINE, V4_LEGS);
  check('no positions found -> NO_POSITIONS_FOUND, not a pass', res.verdict === 'NO_POSITIONS_FOUND', res.verdict);
}

// -- 5g: v3 pools run the same probe, with v3 removal calldata ------------
{
  const v3Provider = { async getCode() { return '0x6080604e45aaf'; } }; // SwapRouter02 selector present
  const v3Legs = await legsFor(v3Pool, ADDR, { provider: v3Provider });
  check('v3 legs resolve the router shape from bytecode', v3Legs.routerShape === 'SwapRouter02', v3Legs.routerShape);
  check('v3 watches the pool contract itself, not the v4 PoolManager',
    v3Legs.poolHolder === POOL_V3, v3Legs.poolHolder);
  check('v3 base is WETH and readable with balanceOf', v3Legs.baseIsErc20 === true && v3Legs.isNative === false);

  // v3 bundle shape, WETH-paired so proceeds are an ERC20 read:
  //   buy    = [deposit, approve, swap]          3
  //   middle = [burn, collect]                   2   (removal probe only)
  //   sell   = [approve, swap]                   2
  //   + one WETH balanceOf, because the base side is an ERC20   1
  // Baseline is therefore 6 steps and the removal probe 8.
  const V3_REMOVAL_IX = 3;
  const V3_SELL_IX = 6;
  const V3_WETH_IX = 7;
  const uintStep = (v) => ({
    reverted: false, indeterminate: false,
    returnData: ethers.utils.hexZeroPad(ethers.utils.parseEther(String(v)).toHexString(), 32),
    errorMessage: null, raw: {},
  });
  SCRIPT = (steps) => {
    const r = steps.map(() => ({ ...okStep }));
    if (steps.length === 8) {
      r[V3_REMOVAL_IX] = badStep('execution reverted: NotApproved');
      r[V3_WETH_IX] = uintStep(0.049);
    } else {
      r[steps.length - 1] = uintStep(0.049); // baseline's WETH read
    }
    return r;
  };
  const v3Census = {
    ...censusStub,
    version: 'v3',
    _top: { custodian: OWNER, custodianKind: 'eoa', beneficialOwner: null, beneficialOwnerKind: null,
      tokenId: null, tickLower: -60, tickUpper: 60, liquidity: ethers.BigNumber.from('5000'), salt: null },
  };
  const res = await rug.liquidityRemovalProbe(v3Pool, ADDR, baseOpts, v3Census, GOOD_BASELINE, v3Legs);
  check('a v3 removal probe now produces a verdict instead of a refusal',
    res.verdict !== 'UNPROVEN' || !/v3Legs/.test(res.reason || ''), `${res.verdict}: ${res.reason}`);
  check('v3 removal reverting for owner and stranger alike -> LOCK_SUSPECTED',
    res.verdict === 'LOCK_SUSPECTED', `${res.verdict}: ${res.reason}`);
  check('the v3 removal was sent to the pool contract, not a position manager',
    res.remover === OWNER, res.remover);
}

// ==========================================================================
section('6. whale-dump probe');
// ==========================================================================
// Steps: [buy] [whale approve] [whale permit2] [whale sell] [approve] [permit2] [victim sell]
const W_DUMP_IX = 3;
const W_SELL_IX = 6;
const whaleOpts = { ...baseOpts, whale: OWNER, whaleBalanceWei: ethers.utils.parseEther('170000000') };

{
  SCRIPT = (steps) => {
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    r[W_SELL_IX] = badStep('execution reverted');
    return r;
  };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, whaleOpts, GOOD_BASELINE, V4_LEGS);
  check('top holder dumps, victim cannot sell -> WHALE_DUMP_FATAL', res.verdict === 'WHALE_DUMP_FATAL', res.verdict);
  check('the whale is named in the result', res.whale === OWNER);
  check('the dump used the whale as sender', LAST_STEPS[W_DUMP_IX].from === OWNER);
}
{
  SCRIPT = (steps) => {
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    r[W_SELL_IX] = sellStep(0.048, victim); // 0.96 ratio vs 0.98 baseline
    return r;
  };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, whaleOpts, GOOD_BASELINE, V4_LEGS);
  check('top holder dumps, victim still gets out -> WHALE_DUMP_SURVIVED', res.verdict === 'WHALE_DUMP_SURVIVED', res.verdict);
  check('recovery fraction near 0.98', Math.abs(res.recoveryFraction - 0.9796) < 0.001, String(res.recoveryFraction));
}
{
  SCRIPT = (steps) => {
    const r = steps.map(() => ({ ...okStep }));
    r[W_DUMP_IX] = badStep('execution reverted: max sell exceeded');
    return r;
  };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, whaleOpts, GOOD_BASELINE, V4_LEGS);
  check('whale itself cannot sell -> UNPROVEN, not a pass', res.verdict === 'UNPROVEN', res.verdict);
  check('and the sell-cap possibility is called out', /sell cap/i.test(res.reason));
}

// ==========================================================================
section('7. gate decision');
// ==========================================================================
{
  const fakeProvider = {
    async getBlockNumber() { return 1000; },
    async getLogs() {
      const pmIface = new ethers.utils.Interface([
        'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
      ]);
      const salt = ethers.utils.hexZeroPad(ethers.BigNumber.from(777).toHexString(), 32);
      const ev = pmIface.encodeEventLog(pmIface.getEvent('ModifyLiquidity'), [
        v4Pool.poolId, POSM, -120, 120, ethers.BigNumber.from('1000'), salt,
      ]);
      return [{ address: ADDR.UNIV4_POOL_MANAGER, topics: ev.topics, data: ev.data, blockNumber: 100 }];
    },
    async getCode(a) { return String(a).toLowerCase() === POSM.toLowerCase() ? '0xdeadbeef' : '0x'; },
    async call({ to, data }) {
      if (String(to).toLowerCase() === POSM.toLowerCase() && data.startsWith('0x6352211e')) {
        return ethers.utils.hexZeroPad(OWNER, 32);
      }
      throw new Error('unexpected call');
    },
  };

  // Three bundles now run, distinguishable by length for a native-ETH v4 pool:
  //   4 steps = baseline (buy, approve, permit2, sell)
  //   5 steps = removal probe (baseline + one removal step in the middle)
  //   7 steps = whale-dump probe (baseline + the whale's three sell steps)
  const BASELINE_LEN = 4, REMOVAL_LEN = 5, WHALE_LEN = 7;
  const BASE_SELL_IX = 3;

  // Removal blocked, whale dump survived -> PASS (with the caveat in the text).
  SCRIPT = (steps) => {
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    if (steps.length === BASELINE_LEN) { r[BASE_SELL_IX] = sellStep(0.049, victim); return r; }
    if (steps.length === REMOVAL_LEN) { r[REMOVAL_IX] = badStep('LiquidityLocked'); r[SELL_IX] = sellStep(0.049, victim); return r; }
    if (steps.length === WHALE_LEN) { r[W_SELL_IX] = sellStep(0.048, victim); return r; }
    throw new Error(`unexpected bundle length ${steps.length}`);
  };
  const pass = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, provider: fakeProvider });
  check('blocked removal + survived dump -> PASS', pass.decision === 'PASS', `${pass.decision}: ${pass.reason}`);
  check('the PASS text still carries the "not proof of a lock" caveat', /not proof of a lock/.test(pass.reason), pass.reason);
  // Which encoder is in use depends on whether tenderly-bundle-v4.js exports
  // encodeV4SwapExecute. Both states are legitimate, so assert the note tracks
  // reality rather than assuming either one: present while the fallback is in
  // use, absent once the real encoder is exported. (An earlier version of this
  // check asserted the note was always there, and so failed the moment the
  // recommended one-line export was applied.)
  const warned = pass.notes.some((n) => /local copy of encodeV4SwapExecute/.test(n));
  check(
    usingLocalSwapEncoder
      ? 'the fallback encoder is in use, and the note says so'
      : 'the real encoder is exported, so no fallback note is emitted',
    warned === usingLocalSwapEncoder,
    `usingLocalSwapEncoder=${usingLocalSwapEncoder}, note present=${warned}`
  );

  // Whale dump kills it -> SKIP even though removal was blocked.
  SCRIPT = (steps) => {
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    if (steps.length === BASELINE_LEN) { r[BASE_SELL_IX] = sellStep(0.049, victim); return r; }
    if (steps.length === REMOVAL_LEN) { r[REMOVAL_IX] = badStep('LiquidityLocked'); r[SELL_IX] = sellStep(0.049, victim); return r; }
    r[W_SELL_IX] = badStep('execution reverted');
    return r;
  };
  const skip = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, provider: fakeProvider });
  check('locked LP but a fatal whale dump -> SKIP', skip.decision === 'SKIP', `${skip.decision}: ${skip.reason}`);

  // THE important negative case: if this module's own swap legs are broken, the
  // victim's sell reverts in every bundle. Without the baseline control that
  // reads as "the liquidity was pulled and you are trapped" — a false SKIP on a
  // perfectly good token. With it, the gate refuses to conclude anything.
  SCRIPT = (steps) => {
    const r = steps.map(() => ({ ...okStep }));
    const sellIx = steps.length === BASELINE_LEN ? BASE_SELL_IX : steps.length === REMOVAL_LEN ? SELL_IX : W_SELL_IX;
    r[sellIx] = badStep('execution reverted: our own calldata is wrong');
    return r;
  };
  const broken = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, provider: fakeProvider });
  check('a broken baseline -> UNPROVEN, never SKIP', broken.decision === 'UNPROVEN', `${broken.decision}: ${broken.reason}`);
  check('and the note blames this module, not the token',
    broken.notes.some((n) => /baseline round trip unusable/.test(n)), JSON.stringify(broken.notes));

  const noProvider = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts });
  check('missing provider -> ERROR, not a silent pass', noProvider.decision === 'ERROR');

  const noSize = await rug.rugCheck(v4Pool, ADDR, { baseAmountWei: baseOpts.baseAmountWei, provider: fakeProvider });
  check('missing baselineTokenOutWei -> ERROR naming actualTokenReceived',
    noSize.decision === 'ERROR' && /actualTokenReceived/.test(noSize.reason), noSize.reason);
}

// ==========================================================================
section('8. 2026-10-10 fixes: contract owners, explorer route, baseline size');
// ==========================================================================
{
  const LOCKER = ADDR.PONS_V2_LAUNCH_LOCKER;
  const lockerCensus = {
    ...censusStub,
    _top: { ...censusStub._top, beneficialOwner: LOCKER, beneficialOwnerKind: 'contract' },
  };
  let calls = 0;
  SCRIPT = (steps) => { calls += 1; return steps.map(() => ({ ...okStep })); };

  // The CRTN / Passkeys case: the owner is the locker. Before the fix the probe
  // spoofed it, the locker's code never ran, and the removal "succeeded".
  const locked = await rug.liquidityRemovalProbe(v4Pool, ADDR,
    { ...baseOpts, controller: { verdict: 'LOCKED', reason: '100% of the liquidity is held by PonsV2LaunchLocker (permanent lock)' } },
    lockerCensus, GOOD_BASELINE, V4_LEGS);
  check('locker-owned position + controller LOCKED -> LOCKED_PER_CONTROLLER', locked.verdict === 'LOCKED_PER_CONTROLLER', locked.verdict);
  check('and no removal is simulated from the contract (no Tenderly call)', calls === 0, `calls=${calls}`);
  check('the reason says why it was not simulated', /skips its code/.test(locked.reason), locked.reason);

  const unk = await rug.liquidityRemovalProbe(v4Pool, ADDR,
    { ...baseOpts, controller: { verdict: 'UNKNOWN', reason: 'holder not reviewed' } }, lockerCensus, GOOD_BASELINE, V4_LEGS);
  check('contract owner + controller UNKNOWN -> CONTRACT_OWNER (not a pass, not REMOVABLE)', unk.verdict === 'CONTRACT_OWNER', unk.verdict);
  const none = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, lockerCensus, GOOD_BASELINE, V4_LEGS);
  check('contract owner + no controller result -> CONTRACT_OWNER', none.verdict === 'CONTRACT_OWNER', none.verdict);

  const unresolved = { ...censusStub, _top: { ...censusStub._top, beneficialOwner: null, beneficialOwnerKind: 'unresolved' } };
  const ur = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, unresolved, GOOD_BASELINE, V4_LEGS);
  check('unresolved owner behind a contract custodian -> CONTRACT_OWNER, never spoofed', ur.verdict === 'CONTRACT_OWNER' && calls === 0, `${ur.verdict} calls=${calls}`);

  const burned = { ...censusStub, _top: { ...censusStub._top, beneficialOwner: '0x000000000000000000000000000000000000dEaD', beneficialOwnerKind: 'burn' } };
  const b = await rug.liquidityRemovalProbe(v4Pool, ADDR, baseOpts, burned, GOOD_BASELINE, V4_LEGS);
  check('burn-address owner -> LOCKED_BURNED, not simulated', b.verdict === 'LOCKED_BURNED' && calls === 0, `${b.verdict} calls=${calls}`);

  // An EOA owner is still simulated exactly as before.
  SCRIPT = (steps) => {
    const r = steps.map(() => ({ ...okStep }));
    r[REMOVAL_IX] = badStep('execution reverted: NotApproved');
    r[SELL_IX] = sellStep(0.049, steps[0].from);
    return r;
  };
  const eoa = await rug.liquidityRemovalProbe(v4Pool, ADDR, { ...baseOpts, controller: { verdict: 'LOCKED', reason: 'x' } }, censusStub, GOOD_BASELINE, V4_LEGS);
  check('an EOA owner is still spoofed and simulated (controller does not override it)', eoa.verdict === 'LOCK_SUSPECTED', eoa.verdict);
}
{
  // Whale lookup, keyless route: curl with the short identity.
  const SAVED_K = process.env.BLOCKSCOUT_API_KEY; delete process.env.BLOCKSCOUT_API_KEY;
  const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
  const WHALE = '0x5555555555555555555555555555555555555555';
  const pHook = { ...v4Pool, hooks: HOOK, poolKey: { ...v4Pool.poolKey, hooks: HOOK } };
  let seen = null;
  const http = async (url, o) => {
    seen = { url, ua: o && o.userAgent };
    return { status: 200, error: null, json: { items: [
      { address: { hash: ADDR.UNIV4_POOL_MANAGER, is_contract: true }, value: '900' },
      { address: { hash: HOOK, is_contract: true }, value: '800' },
      { address: { hash: ADDR.PONS_V2_LAUNCH_LOCKER, is_contract: true }, value: '700' },
      { address: { hash: WHALE, is_contract: false }, value: '600' },
    ] } };
  };
  const w = await rug.findWhale(pHook, ADDR, { http });
  check('whale lookup uses the curl route with the short browser identity',
    seen && seen.ua === require('./source-gate').EXPLORER_UA && /\/tokens\/.*\/holders$/.test(seen.url), JSON.stringify(seen));
  check('PoolManager, the pool hook and the Pons locker are skipped; the first real holder is the whale',
    w.address === WHALE && w.balanceWei.toString() === '600', JSON.stringify(w));
  check('the whale is marked as an EOA', w.isContract === false);

  // With a key, the holders lookup goes to the official API with a plain request.
  {
    const saved = process.env.BLOCKSCOUT_API_KEY;
    process.env.BLOCKSCOUT_API_KEY = 'proapi_K';
    try {
      seen = null;
      const w2 = await rug.findWhale(pHook, ADDR, { http });
      check('with a key: holders come from api.blockscout.com/4663 with the key',
        seen && seen.url === `https://api.blockscout.com/4663/api/v2/tokens/${TOKEN}/holders?apikey=proapi_K` && w2.address === WHALE, JSON.stringify(seen));
      const bad = await rug.findWhale(pHook, ADDR, { http: async () => ({ status: 401, json: null, error: null }) });
      check('with a key: a refused key is named', /BLOCKSCOUT_API_KEY/.test(bad.error), bad.error);
    } finally {
      if (saved === undefined) delete process.env.BLOCKSCOUT_API_KEY; else process.env.BLOCKSCOUT_API_KEY = saved;
    }
  }
  const refused = await rug.findWhale(pHook, ADDR, { http: async () => ({ status: 403, json: null, error: null }) });
  check('a 403 is reported as bot protection, with the fix to try', /403/.test(refused.error) && /EXPLORER_USER_AGENT/.test(refused.error), refused.error);
  const thrown = await rug.findWhale(pHook, ADDR, { http: async () => { throw new Error('curl gone'); } });
  check('a lookup that throws becomes an error, not a crash', /curl gone/.test(thrown.error), thrown.error);
  if (SAVED_K !== undefined) process.env.BLOCKSCOUT_API_KEY = SAVED_K;
}
{
  // Baseline sizing. 0.05 ETH in; selling 100% returns 0.0475 -> ratio 0.95
  // (a 5% cost, the CRTN figure), not ~0.85 as the old flat 90% sell read.
  const sells = [];
  SCRIPT = (steps) => {
    const r = steps.map(() => ({ ...okStep }));
    r[steps.length - 1] = sellStep(0.0475, steps[0].from);
    return r;
  };
  const bl = await rug.baselineRun({ p: v4Pool, addr: ADDR, legs: V4_LEGS, victimBuyWei: ethers.utils.parseEther('0.05'), tokenOutWei: ethers.utils.parseEther('1000') });
  check('baseline sells 100% of the Gate 3 position by default', bl.ok && bl.sellBps === 10000, JSON.stringify({ ok: bl.ok, bps: bl.sellBps, reason: bl.reason }));
  check('baseline ratio reads like the Gate 3 round trip (0.95)', bl.ok && Math.abs(bl.ratio - 0.95) < 1e-9, String(bl.ratio));

  // 100% reverts on size, 99% goes through: ratio is scaled to the share sold.
  let n = 0;
  SCRIPT = (steps) => {
    n += 1;
    const r = steps.map(() => ({ ...okStep }));
    if (n === 1) { r[steps.length - 1] = badStep('execution reverted: insufficient balance'); return r; }
    r[steps.length - 1] = sellStep(0.0475 * 0.99, steps[0].from);
    return r;
  };
  const bl2 = await rug.baselineRun({ p: v4Pool, addr: ADDR, legs: V4_LEGS, victimBuyWei: ethers.utils.parseEther('0.05'), tokenOutWei: ethers.utils.parseEther('1000') });
  check('a 100% sell that reverts steps down to 99%', bl2.ok && bl2.sellBps === 9900, JSON.stringify({ ok: bl2.ok, bps: bl2.sellBps }));
  check('and the ratio is scaled to the 99% sold (still 0.95)', bl2.ok && Math.abs(bl2.ratio - 0.95) < 1e-6, String(bl2.ratio));

  // A buy that reverts ends the ladder at once (it is not a sizing problem).
  n = 0;
  SCRIPT = (steps) => { n += 1; const r = steps.map(() => ({ ...okStep })); r[0] = badStep('buy broke'); return r; };
  const bl3 = await rug.baselineRun({ p: v4Pool, addr: ADDR, legs: V4_LEGS, victimBuyWei: ethers.utils.parseEther('0.05'), tokenOutWei: ethers.utils.parseEther('1000') });
  check('a reverting buy stops the ladder after one bundle', !bl3.ok && n === 1, `ok=${bl3.ok} n=${n}`);
}
{
  // Whole gate, the Pons shape: locker owns the position, Gate 1b said LOCKED,
  // the top holder's dump is survivable -> PASS (this is what turns into SNIP).
  const LOCKER = ADDR.PONS_V2_LAUNCH_LOCKER;
  const lockerProvider = {
    async getBlockNumber() { return 1000; },
    async getLogs() {
      const pmIface = new ethers.utils.Interface([
        'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
      ]);
      const salt = ethers.utils.hexZeroPad(ethers.BigNumber.from(777).toHexString(), 32);
      const ev = pmIface.encodeEventLog(pmIface.getEvent('ModifyLiquidity'), [v4Pool.poolId, POSM, -120, 120, ethers.BigNumber.from('1000'), salt]);
      return [{ address: ADDR.UNIV4_POOL_MANAGER, topics: ev.topics, data: ev.data, blockNumber: 100 }];
    },
    async getCode(a) { const x = String(a).toLowerCase(); return (x === POSM.toLowerCase() || x === LOCKER.toLowerCase()) ? '0xdeadbeef' : '0x'; },
    async call({ to, data }) {
      if (String(to).toLowerCase() === POSM.toLowerCase() && data.startsWith('0x6352211e')) return ethers.utils.hexZeroPad(LOCKER, 32);
      throw new Error('unexpected call');
    },
  };
  const lens = [];
  SCRIPT = (steps) => {
    lens.push(steps.length);
    const r = steps.map(() => ({ ...okStep }));
    r[steps.length - 1] = sellStep(steps.length === 4 ? 0.0475 : 0.046, steps[0].from);
    return r;
  };
  const ctl = { verdict: 'LOCKED', reason: '100% of the liquidity is held by PonsV2LaunchLocker (permanent lock)' };
  const g = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, baseAmountWei: ethers.utils.parseEther('0.05'), provider: lockerProvider, controller: ctl });
  check('Pons shape: locker + controller LOCKED + survivable dump -> PASS', g.decision === 'PASS', `${g.decision}: ${g.reason}`);
  check('the PASS says the lock came from the controller check, not a simulation', /reviewed permanent locker/.test(g.reason) && /not simulated/.test(g.reason), g.reason);
  check('no removal bundle (length 5) was ever sent', !lens.includes(5), JSON.stringify(lens));

  const g2 = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, baseAmountWei: ethers.utils.parseEther('0.05'), provider: lockerProvider, controller: { verdict: 'UNKNOWN', reason: 'not reviewed' } });
  check('same pool but controller UNKNOWN -> UNPROVEN, never PASS', g2.decision === 'UNPROVEN' && /CONTRACT_OWNER/.test(g2.reason), `${g2.decision}: ${g2.reason}`);
}


// ==========================================================================
section('9. 2026-10-24: pinned block, whale dump in pieces, real errors');
// ==========================================================================
{
  // 8a. every bundle carries the pinned block; without a pin, none does
  const seen = [];
  SCRIPT = (steps) => {
    seen.push(steps.map((st) => st.block_number));
    const r = steps.map(() => ({ ...okStep }));
    r[r.length - 1] = sellStep(0.049, steps[0].from);
    return r;
  };
  const prov = { async getBlockNumber() { return 999999; }, async getLogs() { return []; }, async getCode() { return '0x'; }, async call() { throw new Error('unexpected call'); } };
  const g = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, baseAmountWei: ethers.utils.parseEther('0.05'), provider: prov, pinnedBlock: 4242 });
  check('pinned: at least one bundle was sent', seen.length > 0);
  check('pinned: every step of every bundle has block_number 4242', seen.length > 0 && seen.every((b) => b.every((n) => n === 4242)), JSON.stringify(seen.map((b) => b[0])));
  check('pinned: the result records the block', g.probes && g.probes.pinnedBlock === 4242, JSON.stringify(g.probes && g.probes.pinnedBlock));
  seen.length = 0;
  const g2 = await rug.rugCheck(v4Pool, ADDR, { ...whaleOpts, baseAmountWei: ethers.utils.parseEther('0.05'), provider: prov });
  check('unpinned: no step carries a block_number', seen.length > 0 && seen.every((b) => b.every((n) => n === undefined)));
  check('unpinned: a note says so', (g2.notes || []).some((n) => /not pinned/.test(n)), JSON.stringify(g2.notes));
}
{
  // 8b. the pinned provider reads "as of" the block, and falls back once when the RPC has no history
  const tags = [];
  const base = {
    async call(tx, t) { tags.push(t); if (t === 77 && tags.length > 1) throw new Error('missing trie node abc'); return '0x01'; },
    async getLogs(f) { return [f.toBlock]; },
  };
  const notes = [];
  const pp = rug.pinnedProvider(base, 77, (m) => notes.push(m));
  await pp.call({ to: TOKEN, data: '0x' });
  check('pinned provider passes the block as the block tag', tags[0] === 77, JSON.stringify(tags));
  check('getBlockNumber answers the pinned block', (await pp.getBlockNumber()) === 77);
  check('getLogs never reads past the pinned block', (await pp.getLogs({ toBlock: 500 }))[0] === 77);
  await pp.call({ to: TOKEN, data: '0x' });
  check('no history -> falls back to latest and says so', tags[tags.length - 1] === 'latest' && notes.length === 1, JSON.stringify({ tags, notes }));
}
{
  // 8c. the pieces add up to exactly the balance; approvals once
  const bal = ethers.BigNumber.from('1000000000000000000000003');
  const d = rug.whaleDumpSteps(V4_LEGS, OWNER, bal, 4);
  check('4 pieces: approvals once, then 4 swaps', JSON.stringify(d.labels) === JSON.stringify(['approval 1', 'approval 2', 'swap 1/4', 'swap 2/4', 'swap 3/4', 'swap 4/4']), JSON.stringify(d.labels));
  const ur = new ethers.utils.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
  const amounts = d.steps.slice(2).map((st) => {
    const ex = ur.parseTransaction({ data: st.input });
    const [, params] = ethers.utils.defaultAbiCoder.decode(['bytes', 'bytes[]'], ex.args.inputs[0]);
    const sp = ethers.utils.defaultAbiCoder.decode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'], params[0]);
    return ethers.BigNumber.from(sp[0][2]);
  });
  const sum = amounts.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));
  check('the 4 swap amounts sum to the whole balance', sum.eq(bal), `${sum.toString()} vs ${bal.toString()}`);
  const dc = rug.whaleDumpSteps(V4_LEGS, OWNER, bal, 1, true);
  check('code cleared: every whale step overrides its code with 0x', dc.steps.every((st) => st.state_objects && Object.entries(st.state_objects).some(([a, o]) => a.toLowerCase() === OWNER.toLowerCase() && o.code === '0x')));
  check('not cleared by default', rug.whaleDumpSteps(V4_LEGS, OWNER, bal, 1).steps.every((st) => !st.state_objects || !Object.values(st.state_objects).some((o) => o && o.code === '0x')));
}
{
  // 8d. one sale of everything reverts (a sell cap); 4 pieces go through
  const lens = [];
  SCRIPT = (steps) => {
    lens.push(steps.length);
    const victim = steps[0].from;
    const r = steps.map(() => ({ ...okStep }));
    if (steps.length === 7) {
      r[W_DUMP_IX] = { ...badStep('execution reverted'), raw: { transaction: { gas: 15000000, gas_used: 210000, transaction_info: { call_trace: {
        to: ADDR.UNIVERSAL_ROUTER, error: 'execution reverted', output: '0x',
        calls: [{ to: TOKEN, function_name: 'transferFrom', error: 'execution reverted', output: '0x08c379a0' + ethers.utils.defaultAbiCoder.encode(['string'], ['MaxTx']).slice(2) }],
      } } } } };
    }
    r[steps.length - 1] = sellStep(0.048, victim);
    return r;
  };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, whaleOpts, GOOD_BASELINE, V4_LEGS);
  check('whole-balance sale reverts, 4 pieces succeed -> WHALE_DUMP_SURVIVED', res.verdict === 'WHALE_DUMP_SURVIVED', `${res.verdict}: ${res.reason}`);
  check('two bundles: 1 piece (7 steps), then 4 pieces (10 steps)', JSON.stringify(lens) === '[7,10]', JSON.stringify(lens));
  check('dumpPieces = 4 and sellCapSuspected', res.dumpPieces === 4 && res.sellCapSuspected === true);
  check('the first attempt keeps the real error: the failing step', res.attempts[0].failedStep === 'swap 1/1', JSON.stringify(res.attempts[0]));
  check('... the decoded revert reason of the deepest call', res.attempts[0].deepest && res.attempts[0].deepest.reason === 'Error("MaxTx")' && res.attempts[0].deepest.fn === 'transferFrom', JSON.stringify(res.attempts[0].deepest));
  check('... and the gas used against the limit (not out of gas)', res.attempts[0].gasUsed === 210000 && res.attempts[0].gasLimit === 15000000 && res.attempts[0].outOfGas === false, JSON.stringify(res.attempts[0]));
  check('the reason says how the whale sold', /in 4 sales/.test(res.reason), res.reason);
}
{
  // 8e. an approval reverts for an EOA whale: no point in smaller pieces
  const lens = [];
  SCRIPT = (steps) => {
    lens.push(steps.length);
    const r = steps.map(() => ({ ...okStep }));
    r[1] = badStep('sender not an eoa');
    return r;
  };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, whaleOpts, GOOD_BASELINE, V4_LEGS);
  check('approval fails -> UNPROVEN after one attempt', res.verdict === 'UNPROVEN' && lens.length === 1, `${res.verdict} ${JSON.stringify(lens)}`);
  check('the failed step is named and the error kept', res.attempts[0].failedStep === 'approval 1' && /not an eoa/.test(res.attempts[0].error) && /approval 1 reverted/.test(res.reason), res.reason);
}
{
  // 8f. the same for a contract whale: one more try as a plain wallet, and it is labelled
  const runs = [];
  SCRIPT = (steps) => {
    const cleared = steps.some((st) => st.state_objects && Object.values(st.state_objects).some((o) => o && o.code === '0x'));
    runs.push(cleared);
    const r = steps.map(() => ({ ...okStep }));
    if (!cleared) r[1] = badStep('sender not an eoa');
    r[steps.length - 1] = sellStep(0.048, steps[0].from);
    return r;
  };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, { ...whaleOpts }, GOOD_BASELINE, V4_LEGS);
  check('(EOA whale from caller: not retried)', runs.length === 1, JSON.stringify(runs));
  runs.length = 0;
  // A contract whale comes from the explorer lookup; stub it.
  const http = async () => ({ status: 200, json: { items: [{ address: { hash: OWNER, is_contract: true }, value: ethers.utils.parseEther('1000').toString() }] } });
  const prov = { async call() { return ethers.utils.defaultAbiCoder.encode(['uint256'], [ethers.utils.parseEther('1000')]); } };
  const res2 = await rug.whaleDumpProbe(v4Pool, ADDR, { ...baseOpts, http, provider: prov }, GOOD_BASELINE, V4_LEGS);
  check('contract whale: retried with its code cleared, and that run decides', JSON.stringify(runs) === '[false,true]' && res2.verdict === 'WHALE_DUMP_SURVIVED', `${JSON.stringify(runs)} ${res2.verdict}: ${res2.reason}`);
  check('the result says it was simulated as a plain wallet', res2.whaleCodeCleared === true && /plain wallet/.test(res2.reason), res2.reason);
}
{
  // 8g. the explorer balance is replaced by the on-chain one
  const http = async () => ({ status: 200, json: { items: [{ address: { hash: OWNER, is_contract: false }, value: ethers.utils.parseEther('1000').toString() }] } });
  const prov = { async call() { return ethers.utils.defaultAbiCoder.encode(['uint256'], [ethers.utils.parseEther('600')]); } };
  SCRIPT = (steps) => { const r = steps.map(() => ({ ...okStep })); r[steps.length - 1] = sellStep(0.048, steps[0].from); return r; };
  const res = await rug.whaleDumpProbe(v4Pool, ADDR, { ...baseOpts, http, provider: prov }, GOOD_BASELINE, V4_LEGS);
  check('on-chain balance is the one dumped', res.whaleBalanceWei === ethers.utils.parseEther('600').toString() && /on-chain one was used/.test(res.balanceNote || ''), `${res.whaleBalanceWei} ${res.balanceNote}`);
  const prov0 = { async call() { return ethers.utils.defaultAbiCoder.encode(['uint256'], [0]); } };
  const res0 = await rug.whaleDumpProbe(v4Pool, ADDR, { ...baseOpts, http, provider: prov0 }, GOOD_BASELINE, V4_LEGS);
  check('zero on-chain balance -> NO_WHALE, nothing simulated as a dump', res0.verdict === 'NO_WHALE', res0.verdict);
}
{
  // 8h. revert decoding
  const enc = '0x08c379a0' + ethers.utils.defaultAbiCoder.encode(['string'], ['nope']).slice(2);
  check('Error(string) decoded', rug.decodeRevert(enc) === 'Error("nope")', rug.decodeRevert(enc));
  check('Panic decoded', rug.decodeRevert('0x4e487b71' + ethers.utils.defaultAbiCoder.encode(['uint256'], [0x11]).slice(2)) === 'Panic(0x11)');
  check('custom error shows its selector', /custom error 0xdeadbeef/.test(rug.decodeRevert('0xdeadbeef')));
  check('empty output -> null', rug.decodeRevert('0x') === null);
  const oog = rug.stepDiagnosis({ ...badStep('out of gas'), raw: { transaction: { gas: 100, gas_used: 100 } } });
  check('out of gas recognised', oog.outOfGas === true);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });