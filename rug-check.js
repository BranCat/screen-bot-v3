// rug-check.js — Gate 6: the liquidity-removal ("rug") simulation.
//
// This is the gate both planning documents named as the first thing to build.
// Gates 3-5 buy and sell inside one simulated block at *current* liquidity, so
// they answer "can I get out right now". They cannot answer the question that
// actually loses money on this chain: "can the liquidity be taken away from
// under me, and if it is, what do I get back?"
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT ONE BINARY TEST
// ---------------------------------------------------------------------------
// The naive version of this probe — "remove all liquidity, then try to sell" —
// is useless, because it passes for *every* pool that has ever existed. Drain a
// Uniswap pool to zero and of course you cannot sell into it. A test that fires
// on honest and dishonest tokens alike tells you nothing.
//
// What discriminates is WHO is allowed to remove, and HOW MUCH. So this module
// runs three probes:
//
//   6a  POSITION CENSUS (RPC only, no Tenderly)
//       Reconstruct every liquidity position in the pool from its own event
//       log, and find who custodies each one. Then classify: an EOA can pull
//       its position with one private key; a burn address can never pull it;
//       a contract needs resolving before we can say anything at all.
//
//   6b  REMOVAL SIMULATION (Tenderly) — v3 and v4 alike
//       For the largest position, spoof the sender as the *beneficial* owner
//       and actually try to pull the liquidity, in a bundle that also has a
//       victim buying before and selling after. This yields a number, not a
//       flag: "if the top LP exits, you recover X% of what you would have
//       recovered otherwise".
//
//   6c  WHALE-DUMP SURVIVAL (Tenderly)
//       The rug vector that 6b misses entirely. On this chain the dominant
//       honest launch path is Bags -> Uniswap v4 with BAGS_V4_HOOK and the LP
//       locked permanently (see ADDR.BAGS_V4_HOOK in token-screener-v3.js).
//       For those tokens the liquidity genuinely cannot be pulled — but the
//       launchpad hands the deployer 170M of a 1B supply, and dumping that
//       into a locked pool empties the ETH side just as effectively. 6c
//       simulates the top holder selling their whole balance and then measures
//       what the victim gets out.
//
// ---------------------------------------------------------------------------
// THE HONESTY RULE THIS MODULE IS BUILT AROUND
// ---------------------------------------------------------------------------
// A reverted removal attempt is NOT evidence that liquidity is locked. It is,
// far more often, evidence that we encoded the calldata wrong — wrong action
// byte, wrong tokenId, wrong custodian. Reading our own bug as "LP is locked,
// token is safe" is exactly the failure mode that gets a screener trusted right
// up until it clears a rug.
//
// So every removal attempt is run twice: once spoofed from the beneficial owner
// and once from a random freshly-generated address that owns nothing. Only a
// DIFFERENCE between those two runs is evidence about the pool:
//
//   owner succeeds, stranger reverts  -> removable, and the machinery works
//   owner reverts,  stranger reverts  -> tells us nothing (could be our bug)
//   owner reverts,  stranger succeeds -> something is very wrong; reported raw
//
// The verdict vocabulary reflects that. There is no "LOCK_PROVEN" value,
// because this module cannot prove a lock — only fail to break one. The
// strongest positive it will emit is LOCK_SUSPECTED.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   const { rugCheck } = require('./rug-check');
//   const result = await rugCheck(pool, ADDR, {
//     provider,                    // ethers v5 JsonRpcProvider on chain 4663
//     baseAmountWei,               // same buy size the earlier gates used
//     baselineTokenOutWei,         // actualTokenReceived from the Gate 3 round trip
//     lookbackBlocks: 200000,      // optional
//     whale, whaleBalanceWei,      // optional; otherwise read from Blockscout
//     // v3 and v4 are both handled; swap legs come from swap-legs.js
//   });
//
// The undisturbed round trip is measured inside this module rather than taken
// from Gate 3, so both probes are compared against a baseline produced by the
// same code path they run on. It costs one extra bundle and removes the worst
// false positive this gate can have; see baselineRun() for the reasoning.
//
// `pool` is the descriptor token-screener-v3.js already builds:
//   v3: { version:'v3', tokenAddr, base, fee, poolAddress, ... }
//   v4: { version:'v4', tokenAddr, base, fee, poolId, hooks, poolKey, ... }
//
// Returns { decision, probes: { census, removal, whaleDump }, notes }
// where decision is one of SKIP | PASS | UNPROVEN | ERROR.

const { ethers } = require('ethers');
const config = require('./config');
const {
  freshWallet,
  ethBalanceOverride,
  buildStep,
  simulateBundle,
  erc20Iface,
  wethIface,
  MAX_UINT256,
  MAX_UINT160,
  formatStepError,
  anyIndeterminate,
  nativeBalanceDelta,
} = require('./tenderly-client');

// encodeV4SwapExecute lives in tenderly-bundle-v4.js but is not currently
// exported. Prefer the real one so the two modules can never drift; fall back
// to the local copy below (byte-identical to the version dated 2026-09-12) so
// this file runs without editing that one. To remove the fallback, change the
// last line of tenderly-bundle-v4.js to:
//   module.exports = { simulateUniV4Txn, runOneV4RoundTrip: runOneRoundTrip, encodeV4SwapExecute };
let encodeV4SwapExecute;
let usingLocalSwapEncoder = false;
try {
  ({ encodeV4SwapExecute } = require('./tenderly-bundle-v4'));
} catch (_) { /* module missing entirely — handled below */ }
if (typeof encodeV4SwapExecute !== 'function') {
  encodeV4SwapExecute = localEncodeV4SwapExecute;
  usingLocalSwapEncoder = true;
}

// --------------------------------------------------------------------------
// Interfaces and constants
// --------------------------------------------------------------------------

const universalRouterIface = new ethers.utils.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
const permit2Iface = new ethers.utils.Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

// Uniswap v3 pool: the position-level events, plus burn/collect. In v3 a
// position is keyed by (msg.sender, tickLower, tickUpper), so whoever the Mint
// event names as `owner` can call burn() on the pool DIRECTLY — no position
// NFT and no NonfungiblePositionManager needed. That is what makes the v3 arm
// of probe 6b work without knowing the periphery addresses on this chain.
const v3PoolIface = new ethers.utils.Interface([
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'function burn(int24 tickLower, int24 tickUpper, uint128 amount) returns (uint256 amount0, uint256 amount1)',
  'function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested) returns (uint128 amount0, uint128 amount1)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const v4PoolManagerIface = new ethers.utils.Interface([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
]);

// Both the v3 NonfungiblePositionManager and the v4 PositionManager are ERC721s
// keyed by tokenId. That single fact is how this module resolves a custodian
// contract to a beneficial owner without knowing which periphery contract it is
// looking at: ask it ownerOf(tokenId) and see whether it answers.
const erc721Iface = new ethers.utils.Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

// Uniswap v4 PositionManager. modifyLiquidities takes an abi.encode(bytes
// actions, bytes[] params) blob — the same "unlock data" shape the periphery
// uses everywhere.
const v4PositionManagerIface = new ethers.utils.Interface([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
]);

// Action bytes from the v4-periphery Actions library. These are asserted, not
// verified — which is precisely why probe 6b always runs the stranger control.
// If these constants are wrong, BOTH runs revert identically and the verdict
// comes back UNPROVEN rather than a false clean bill of health.
const V4_ACTION_DECREASE_LIQUIDITY = 0x01;
const V4_ACTION_TAKE_PAIR = 0x11;

const V4_SWAP_COMMAND = '0x10';
const V4_ACTIONS = ethers.utils.solidityPack(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]);
const SWAP_PARAMS_TYPE =
  'tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)';

const SEED_ETH = ethers.utils.parseEther('1');
const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 3600;
const ROUTER_DEADLINE_SECONDS = 600;

// Addresses that can never move a position again. Anything here is a real lock.
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// The Bags protocol's singleton v4 hook. Every graduated Bags token carries it
// and its LP is documented as permanently locked. Recorded as a strong hint,
// never as a pass on its own — the point of probe 6b is to test the claim.
const BAGS_V4_HOOK = '0x2380aBf72C17aABAb76480244759AC7E2932EEcC';

// Below this fraction of the undisturbed recovery, the pool is effectively gone.
const FATAL_RECOVERY_FRACTION = 0.5;

// How much of the Gate 3 buy the victim sells back. 2026-10-10: this used to be
// a flat 90%, and the probes divided the proceeds by the whole buy, so the
// baseline "ratio" read ~0.85 (a ~15% loss) on Pons tokens whose real round
// trip costs ~5%. The ladder now starts at 100% (as wallet-round-trip.js does)
// and only steps down if the sell reverts on size, and every ratio is scaled to
// the share actually sold, so the baseline reads like the Gate 3 figure.
const BASELINE_SELL_LADDER_BPS = [10000, 9900, 9500, 9000];

// eth_getLogs window. The chain's block time is roughly 100ms (see the
// backfill note in token-screener-v3.js), so 200k blocks is only about six
// hours. For a brand-new token that is plenty — the pool was created minutes
// ago. For anything older the census will be incomplete, and it says so via
// `truncated` rather than quietly reporting fewer positions than exist.
const DEFAULT_LOOKBACK_BLOCKS = 200000;
const LOG_CHUNK_BLOCKS = 10000;

const BLOCKSCOUT_API =
  process.env.blockscout_api_base || 'https://robinhoodchain.blockscout.com/api/v2';

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

const lc = (a) => String(a || '').toLowerCase();
const BN = (x) => ethers.BigNumber.from(x);

function pct(part, whole) {
  if (!whole || BN(whole).isZero()) return null;
  // 4 decimal places of a fraction, done in integer math to avoid BigNumber
  // overflow when converting to Number.
  return BN(part).mul(1000000).div(whole).toNumber() / 10000;
}

async function getCodeSize(provider, address) {
  const code = await provider.getCode(address);
  return code && code !== '0x' ? (code.length - 2) / 2 : 0;
}

// Read-only contract calls go through provider.call directly rather than
// ethers.Contract. Two reasons: Contract does network detection on construction
// (an extra round trip per position, on a chain with ~100ms blocks and a public
// RPC), and a raw call is trivially stubbable in the offline tests.
// Returns null on any revert or decode failure — a question this module asks
// speculatively should never throw its way out of the census.
async function staticCall(provider, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await provider.call({ to, data });
    if (!raw || raw === '0x') return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

// Reads eth_getLogs in chunks. A single 200k-block request is rejected by most
// RPCs; a chunked loop that stops on error and reports how far it got is more
// useful than one that throws away everything it had.
async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const logs = [];
  let truncated = false;
  let cursor = toBlock;
  while (cursor >= fromBlock) {
    const start = Math.max(fromBlock, cursor - LOG_CHUNK_BLOCKS + 1);
    try {
      const chunk = await provider.getLogs({ ...filter, fromBlock: start, toBlock: cursor });
      logs.push(...chunk);
    } catch (e) {
      // Out of range, rate limited, or the node simply refused. Stop here and
      // be explicit that the census is partial.
      truncated = true;
      break;
    }
    cursor = start - 1;
  }
  return { logs, truncated };
}

// --------------------------------------------------------------------------
// Local copy of the v4 swap encoder (see the require dance at the top)
// --------------------------------------------------------------------------

function localEncodeV4SwapExecute({ poolKey, tokenAddr, baseAddr, side, amountIn, amountOutMinimum }) {
  const tokenIsCurrency0 = lc(poolKey.currency0) === lc(tokenAddr);
  const zeroForOne = side === 'buy' ? !tokenIsCurrency0 : tokenIsCurrency0;
  const inputCurrency = side === 'buy' ? baseAddr : tokenAddr;
  const outputCurrency = side === 'buy' ? tokenAddr : baseAddr;

  const swapParams = ethers.utils.defaultAbiCoder.encode([SWAP_PARAMS_TYPE], [{
    poolKey: {
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      fee: poolKey.fee,
      tickSpacing: poolKey.tickSpacing,
      hooks: poolKey.hooks,
    },
    zeroForOne,
    amountIn,
    amountOutMinimum,
    minHopPriceX36: 0, // Robinhood-fork-only field; always disabled
    hookData: '0x',
  }]);
  const settleAll = ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [inputCurrency, amountIn]);
  const takeAll = ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [outputCurrency, amountOutMinimum]);
  const routerInput = ethers.utils.defaultAbiCoder.encode(['bytes', 'bytes[]'], [V4_ACTIONS, [swapParams, settleAll, takeAll]]);
  const deadline = Math.floor(Date.now() / 1000) + ROUTER_DEADLINE_SECONDS;
  return universalRouterIface.encodeFunctionData('execute', [V4_SWAP_COMMAND, [routerInput], deadline]);
}

// --------------------------------------------------------------------------
// PROBE 6a — position census
// --------------------------------------------------------------------------

// Rebuilds the pool's liquidity positions from its event log and works out who
// custodies each one.
//
// Note on the denominator: for v3 this reports each position's share of total
// NET MINTED liquidity, not of pool.liquidity(). Those are different numbers —
// pool.liquidity() is only the currently in-range liquidity, so a position
// parked outside the current tick contributes to one and not the other.
// Concentration is the question here ("can one address pull most of it"), so
// net minted is the right denominator; the in-range figure is reported
// alongside for context rather than mixed into the share.
async function positionCensus(p, { provider, addr, lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS } = {}) {
  const head = await provider.getBlockNumber();
  const fromBlock = Math.max(0, head - lookbackBlocks);
  const byKey = new Map();
  let truncated = false;

  if (p.version === 'v3') {
    if (!p.poolAddress) return { error: 'v3 pool descriptor has no poolAddress' };
    const res = await getLogsChunked(provider, { address: p.poolAddress }, fromBlock, head);
    truncated = res.truncated;
    for (const log of res.logs) {
      let parsed;
      try { parsed = v3PoolIface.parseLog(log); } catch (_) { continue; }
      if (parsed.name !== 'Mint' && parsed.name !== 'Burn') continue;
      const { owner, tickLower, tickUpper, amount } = parsed.args;
      const key = `${lc(owner)}|${tickLower}|${tickUpper}`;
      const prev = byKey.get(key) || {
        custodian: owner, tickLower, tickUpper, salt: null, liquidity: BN(0), mints: 0, burns: 0,
      };
      if (parsed.name === 'Mint') { prev.liquidity = prev.liquidity.add(amount); prev.mints += 1; }
      else { prev.liquidity = prev.liquidity.sub(amount); prev.burns += 1; }
      byKey.set(key, prev);
    }
  } else if (p.version === 'v4') {
    if (!p.poolId) return { error: 'v4 pool descriptor has no poolId' };
    const topic = v4PoolManagerIface.getEventTopic('ModifyLiquidity');
    const res = await getLogsChunked(
      provider,
      { address: addr.UNIV4_POOL_MANAGER, topics: [topic, p.poolId] },
      fromBlock,
      head
    );
    truncated = res.truncated;
    for (const log of res.logs) {
      let parsed;
      try { parsed = v4PoolManagerIface.parseLog(log); } catch (_) { continue; }
      const { sender, tickLower, tickUpper, liquidityDelta, salt } = parsed.args;
      // In v4 the position key includes `salt`, and the PositionManager sets
      // salt = tokenId. So distinct salts under one sender are distinct NFT
      // positions, all custodied by the same periphery contract.
      const key = `${lc(sender)}|${tickLower}|${tickUpper}|${salt}`;
      const prev = byKey.get(key) || {
        custodian: sender, tickLower, tickUpper, salt, liquidity: BN(0), mints: 0, burns: 0,
      };
      prev.liquidity = prev.liquidity.add(liquidityDelta);
      if (BN(liquidityDelta).gt(0)) prev.mints += 1; else prev.burns += 1;
      byKey.set(key, prev);
    }
  } else {
    return { error: `unknown pool version ${p.version}` };
  }

  const positions = [...byKey.values()].filter((x) => x.liquidity.gt(0));
  positions.sort((a, b) => (b.liquidity.gt(a.liquidity) ? 1 : -1));
  const totalMinted = positions.reduce((acc, x) => acc.add(x.liquidity), BN(0));

  // In-range liquidity, for context only (v3 exposes it; v4 needs StateView,
  // which this module does not depend on).
  let inRangeLiquidity = null;
  if (p.version === 'v3' && p.poolAddress) {
    const res = await staticCall(provider, p.poolAddress, v3PoolIface, 'liquidity');
    if (res) inRangeLiquidity = res[0].toString();
  }

  // Classify each custodian, and resolve it to a beneficial owner where we can.
  const custodians = new Map();
  for (const pos of positions) {
    const key = lc(pos.custodian);
    if (!custodians.has(key)) {
      const codeSize = await getCodeSize(provider, pos.custodian);
      let kind;
      if (BURN_ADDRESSES.has(key)) kind = 'burn';
      else if (codeSize === 0) kind = 'eoa';
      else if (key === lc(BAGS_V4_HOOK)) kind = 'protocol-hook';
      else kind = 'contract';
      custodians.set(key, { address: pos.custodian, kind, codeSize });
    }
    pos.custodianKind = custodians.get(key).kind;

    // A contract custodian is a dead end until we know who is behind it. Both
    // v3's NonfungiblePositionManager and v4's PositionManager are ERC721s, so
    // ownerOf(tokenId) resolves it — and the tokenId is the salt in v4. A
    // revert here just means this contract is not an ERC721 position manager.
    pos.beneficialOwner = null;
    pos.beneficialOwnerKind = null;
    if (pos.custodianKind === 'contract' || pos.custodianKind === 'protocol-hook') {
      const tokenId = pos.salt ? BN(pos.salt) : null;
      if (tokenId && !tokenId.isZero()) {
        const res = await staticCall(provider, pos.custodian, erc721Iface, 'ownerOf', [tokenId]);
        if (res) {
          const owner = res[0];
          pos.beneficialOwner = owner;
          const oCode = await getCodeSize(provider, owner);
          pos.beneficialOwnerKind = BURN_ADDRESSES.has(lc(owner)) ? 'burn' : oCode === 0 ? 'eoa' : 'contract';
          pos.tokenId = tokenId.toString();
        } else {
          // Not an ERC721 position manager, or it does not know this tokenId.
          // Either way we cannot name who is behind the custodian.
          pos.beneficialOwnerKind = 'unresolved';
        }
      } else {
        pos.beneficialOwnerKind = 'no-tokenid';
      }
    }
  }

  const top = positions[0] || null;
  const concentrationPct = top ? pct(top.liquidity, totalMinted) : null;

  // Who, on the evidence, could actually take liquidity out.
  const removableBy = positions
    .filter((x) => x.custodianKind === 'eoa' || x.beneficialOwnerKind === 'eoa')
    .map((x) => (x.custodianKind === 'eoa' ? x.custodian : x.beneficialOwner));
  const lockedShare = positions
    .filter((x) => x.custodianKind === 'burn' || x.beneficialOwnerKind === 'burn')
    .reduce((acc, x) => acc.add(x.liquidity), BN(0));

  return {
    version: p.version,
    positionCount: positions.length,
    totalMinted: totalMinted.toString(),
    inRangeLiquidity,
    concentrationPct,
    lockedSharePct: pct(lockedShare, totalMinted),
    removableByEoaCount: removableBy.length,
    custodians: [...custodians.values()],
    positions: positions.slice(0, 10).map((x) => ({
      custodian: x.custodian,
      custodianKind: x.custodianKind,
      beneficialOwner: x.beneficialOwner,
      beneficialOwnerKind: x.beneficialOwnerKind,
      tokenId: x.tokenId || null,
      tickLower: Number(x.tickLower),
      tickUpper: Number(x.tickUpper),
      salt: x.salt || null,
      liquidity: x.liquidity.toString(),
      sharePct: pct(x.liquidity, totalMinted),
    })),
    _top: top, // internal: full BigNumber-bearing record for probe 6b
    truncated,
    scannedBlocks: lookbackBlocks,
  };
}

// --------------------------------------------------------------------------
// Swap-leg builders (victim side)
// --------------------------------------------------------------------------

// Buy legs for a v4 pool. Mirrors runOneRoundTrip in tenderly-bundle-v4.js:
// native-ETH pools swap directly with the call's value, WETH pools need a
// deposit plus the two approvals.
// Swap legs come from swap-legs.js, which covers v3 and v4 alike. It is loaded
// lazily to break the require cycle: swap-legs imports encodeV4SwapExecute from
// this module, so a top-level require here would be circular.
let _legsFor = null;
async function legsFor(p, opts) {
  if (!_legsFor) ({ legsFor: _legsFor } = require('./swap-legs'));
  return _legsFor(p, opts.addr || config.ADDR, { provider: opts.provider });
}

// --------------------------------------------------------------------------
// Removal-step builders (attacker side)
// --------------------------------------------------------------------------

// v3: the position owner calls the pool directly. burn() moves the liquidity
// into the position's owed balance; collect() sweeps it out. Two steps, no
// periphery contract involved.
function v3RemovalSteps({ p, from, pos, recipient }) {
  const MAXU128 = BN(2).pow(128).sub(1);
  return [
    buildStep({
      from, to: p.poolAddress, gas: 3_000_000,
      data: v3PoolIface.encodeFunctionData('burn', [pos.tickLower, pos.tickUpper, pos.liquidity]),
      stateObjects: ethBalanceOverride(from, SEED_ETH),
    }),
    buildStep({
      from, to: p.poolAddress, gas: 3_000_000,
      data: v3PoolIface.encodeFunctionData('collect', [recipient, pos.tickLower, pos.tickUpper, MAXU128, MAXU128]),
    }),
  ];
}

// v4: liquidity can only move inside a PoolManager.unlock() callback, so a
// spoofed EOA cannot call the PoolManager directly — the removal has to go
// through the PositionManager that custodies the position. DECREASE_LIQUIDITY
// takes the position down, TAKE_PAIR sweeps both currencies to a recipient.
function v4RemovalSteps({ p, from, pos, recipient }) {
  if (!pos.tokenId) return null; // no tokenId resolved -> cannot address the position
  const actions = ethers.utils.solidityPack(
    ['uint8', 'uint8'],
    [V4_ACTION_DECREASE_LIQUIDITY, V4_ACTION_TAKE_PAIR]
  );
  const decreaseParams = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
    [BN(pos.tokenId), pos.liquidity, 0, 0, '0x']
  );
  const takePairParams = ethers.utils.defaultAbiCoder.encode(
    ['address', 'address', 'address'],
    [p.poolKey.currency0, p.poolKey.currency1, recipient]
  );
  const unlockData = ethers.utils.defaultAbiCoder.encode(
    ['bytes', 'bytes[]'],
    [actions, [decreaseParams, takePairParams]]
  );
  const deadline = Math.floor(Date.now() / 1000) + ROUTER_DEADLINE_SECONDS;
  return [
    buildStep({
      from, to: pos.custodian, gas: 5_000_000,
      data: v4PositionManagerIface.encodeFunctionData('modifyLiquidities', [unlockData, deadline]),
      stateObjects: ethBalanceOverride(from, SEED_ETH),
    }),
  ];
}

// --------------------------------------------------------------------------
// PROBE 6b — removal simulation
// --------------------------------------------------------------------------

// Measures how much base currency the victim gets back out of `sellSteps`.
// Native-ETH pools are read from the balance diff; WETH pools from a balanceOf
// read appended after the sell.
function readProceeds({ results, indexes, isNative, from }) {
  if (isNative) {
    const d = nativeBalanceDelta(results[indexes.sell], from);
    return d == null ? null : d;
  }
  const raw = results[indexes.wethAfter]?.returnData;
  if (!raw || raw === '0x') return null;
  try { return BN(raw); } catch (_) { return null; }
}

// One bundle: victim buys, then `middleSteps` happen (a liquidity removal, a
// whale dump, or nothing at all), then the victim sells. Every probe in this
// module is one of these, which is what makes the comparisons meaningful — the
// same wallet lifecycle, the same sizing, the same measurement path, with only
// the middle changed.
async function oneRun({ p, addr, legs, victimBuyWei, victimSellWei, middleSteps = [], sellBps = 10000 }) {
  const isNative = !legs.baseIsErc20;
  const victim = freshWallet().address;

  const buy = legs.buySteps({ from: victim, amountInWei: victimBuyWei });
  const sell = legs.sellSteps({ from: victim, amountInWei: victimSellWei });

  const steps = [...buy, ...middleSteps, ...sell];
  const indexes = {
    middleStart: buy.length,
    middleEnd: buy.length + middleSteps.length - 1,
    sell: buy.length + middleSteps.length + sell.length - 1,
  };
  if (!isNative) {
    steps.push(buildStep({ from: victim, to: legs.baseAddr, data: erc20Iface.encodeFunctionData('balanceOf', [victim]) }));
    indexes.wethAfter = steps.length - 1;
  }

  let results;
  try {
    results = await simulateBundle(steps);
  } catch (e) {
    return { internalError: e.message };
  }
  if (anyIndeterminate(results)) {
    return { indeterminate: true, reason: 'at least one step had no parseable status' };
  }

  const middleResults = middleSteps.length
    ? results.slice(indexes.middleStart, indexes.middleEnd + 1)
    : [];
  const middleReverted = middleResults.some((r) => !r || r.reverted);
  const middleError = middleResults.map((r) => (r && r.reverted ? formatStepError(r) : null)).find(Boolean) || null;

  const buyResult = results[buy.length - 1];
  const buyReverted = !buyResult || buyResult.reverted;

  const sellResult = results[indexes.sell];
  const sellReverted = !sellResult || sellResult.reverted;
  const proceeds = sellReverted ? null : readProceeds({ results, indexes, isNative, from: victim });

  return {
    victim,
    buyReverted,
    buyError: buyReverted ? formatStepError(buyResult) : null,
    middleReverted,
    middleError,
    sellReverted,
    sellError: sellReverted ? formatStepError(sellResult) : null,
    proceedsWei: proceeds ? proceeds.toString() : null,
    // Scaled to the share of the position that was sold, so selling 99% of it
    // does not read as a 1% loss.
    sellBps,
    ratio: proceeds
      ? (Number(ethers.utils.formatEther(proceeds)) / Number(ethers.utils.formatEther(victimBuyWei))) * (10000 / sellBps)
      : null,
  };
}

// The undisturbed round trip, measured through THIS module's own bundle rather
// than borrowed from Gate 3.
//
// It is the denominator for both probes, and it is also the positive control
// for the whole gate. Without it, a bug in this module's swap legs would make
// the victim's sell revert in every run — and a reverting sell after a
// simulated removal reads as "the liquidity was pulled and you are trapped".
// That is the single most dangerous false positive this gate can produce, so it
// gets its own bundle: if the victim cannot complete a plain buy and sell with
// nothing happening in between, nothing else here is reported as a finding.
async function baselineRun({ p, addr, legs, victimBuyWei, victimSellWei, tokenOutWei, startSellBps = 10000 }) {
  // Old call shape (a fixed sell size): one attempt, ratio unscaled.
  if (tokenOutWei == null) return judgeBaseline(await oneRun({ p, addr, legs, victimBuyWei, victimSellWei }), 10000);

  // New shape: sell the whole Gate 3 position, stepping down only when the sell
  // itself reverts. Anything else that goes wrong ends the ladder at once.
  const ladder = BASELINE_SELL_LADDER_BPS.filter((b) => b <= startSellBps);
  if (!ladder.length) ladder.push(startSellBps);
  let last = null;
  for (const bps of ladder) {
    const sellWei = BN(tokenOutWei).mul(bps).div(10000);
    if (sellWei.isZero()) continue;
    const run = await oneRun({ p, addr, legs, victimBuyWei, victimSellWei: sellWei, sellBps: bps });
    last = { run, bps };
    if (run.internalError || run.indeterminate || run.buyReverted || !run.sellReverted) break;
  }
  if (!last) return { ok: false, reason: 'baseline sell size rounded to zero' };
  return judgeBaseline(last.run, last.bps);
}

function judgeBaseline(run, bps) {
  if (run.internalError) return { ok: false, reason: `baseline round trip errored: ${run.internalError}`, run };
  if (run.indeterminate) return { ok: false, reason: `baseline round trip was indeterminate: ${run.reason}`, run };
  if (run.buyReverted) return { ok: false, reason: `baseline buy reverted (${run.buyError}) — this module's own swap legs, not a finding about the token`, run };
  if (run.sellReverted) return { ok: false, reason: `baseline sell reverted (${run.sellError}) — with no undisturbed round trip to compare against, a reverting sell after a removal proves nothing`, run };
  if (run.ratio == null) return { ok: false, reason: 'baseline proceeds could not be measured, so there is no denominator for the recovery fraction', run };
  return { ok: true, ratio: run.ratio, proceedsWei: run.proceedsWei, sellBps: bps, run };
}

// The probes sell the same share of the position the baseline managed to sell.
function probeSellSize(opts, baseline) {
  const sellBps = (baseline && baseline.sellBps) || 10000;
  return { sellBps, victimSellWei: BN(opts.baselineTokenOutWei).mul(sellBps).div(10000) };
}

async function liquidityRemovalProbe(p, addr, opts, census, baseline, legs) {
  if (!legs) {
    return { verdict: 'UNPROVEN', reason: 'swap legs could not be built for this pool' };
  }
  if (!baseline || !baseline.ok) {
    return { verdict: 'UNPROVEN', reason: `no usable baseline: ${baseline ? baseline.reason : 'baseline not run'}` };
  }
  const pos = census && census._top;
  if (!pos) {
    return { verdict: 'NO_POSITIONS_FOUND', reason: 'the census found no live liquidity positions in the scanned window' };
  }

  // Who we spoof as. Prefer the resolved beneficial owner (the address that
  // really controls the position); fall back to the custodian, which answers
  // the weaker question "can whoever controls this contract get it out".
  const remover = pos.beneficialOwner || pos.custodian;
  const removerIsBeneficial = Boolean(pos.beneficialOwner);
  const removerKind = pos.beneficialOwner ? pos.beneficialOwnerKind : pos.custodianKind;

  // 2026-10-10 fix. Spoofing only means something when the remover is an EOA:
  // a simulated call "from" a contract runs none of that contract's code, so
  // every rule a locker enforces (no withdraw function, a timelock, an owner
  // check) is skipped and the removal "succeeds". On CRTN and Passkeys the
  // owner is PonsV2LaunchLocker, and the probe reported REMOVABLE for exactly
  // that reason. The same artifact applies to the burn address. So for any
  // non-EOA owner the removal is not simulated: a burn is a lock, and for a
  // contract the probe defers to the controller check (Gate 1b), which only
  // says LOCKED for a holder whose source has been reviewed.
  const position = {
    custodian: pos.custodian,
    custodianKind: pos.custodianKind,
    beneficialOwner: pos.beneficialOwner,
    beneficialOwnerKind: pos.beneficialOwnerKind || null,
    tokenId: pos.tokenId || null,
    liquidity: pos.liquidity.toString(),
    sharePct: census.concentrationPct,
  };
  if (removerKind === 'burn') {
    return {
      position, remover, removerIsBeneficial, removerKind,
      verdict: 'LOCKED_BURNED',
      reason: `the top position (${census.concentrationPct}% of liquidity) is owned by the burn address ${remover}; nobody can remove it. Not simulated: spoofing the burn address would skip the fact that no one holds its key.`,
    };
  }
  if (removerKind !== 'eoa') {
    const ctl = opts.controller || null;
    const why = `the top position (${census.concentrationPct}% of liquidity) is owned by a contract (${remover}, ${removerKind || 'unclassified'}). ` +
      'Not simulated: spoofing a contract skips its code, so a removal would "succeed" whatever the contract allows.';
    if (ctl && ctl.verdict === 'LOCKED') {
      return {
        position, remover, removerIsBeneficial, removerKind, controller: ctl.verdict,
        verdict: 'LOCKED_PER_CONTROLLER',
        reason: `${why} The controller check recognises the lock: ${ctl.reason}`,
      };
    }
    return {
      position, remover, removerIsBeneficial, removerKind, controller: ctl ? ctl.verdict : null,
      verdict: 'CONTRACT_OWNER',
      reason: `${why} The controller check ${ctl ? `said ${ctl.verdict}${ctl.reason ? ` (${ctl.reason})` : ''}` : 'was not supplied'}, so whether this contract can release the liquidity is not established.`,
    };
  }

  const victimBuyWei = BN(opts.baseAmountWei);
  const { sellBps, victimSellWei } = probeSellSize(opts, baseline);
  const sink = freshWallet().address; // where the pulled liquidity is swept

  const buildRemoval = (from) => (p.version === 'v3'
    ? v3RemovalSteps({ p, from, pos, recipient: sink })
    : v4RemovalSteps({ p, from, pos, recipient: sink }));

  const ownerRemoval = buildRemoval(remover);
  if (!ownerRemoval) {
    return {
      verdict: 'UNPROVEN',
      reason: 'could not build a removal transaction for this position (no tokenId resolved)',
    };
  }

  const ownerRun = await oneRun({ p, addr, legs, victimBuyWei, victimSellWei, sellBps, middleSteps: ownerRemoval });
  if (ownerRun.internalError) return { verdict: 'ERROR', reason: ownerRun.internalError, ownerRun };
  if (ownerRun.indeterminate) return { verdict: 'UNPROVEN', reason: ownerRun.reason, ownerRun };

  // The control. A random address owns nothing, so its removal MUST fail. If it
  // does not, our reading of the removal path is wrong and nothing here means
  // what we think it means.
  const stranger = freshWallet().address;
  const strangerRun = await oneRun({
    p, addr, legs, victimBuyWei, victimSellWei, sellBps, middleSteps: buildRemoval(stranger),
  });

  const base = {
    position,
    remover,
    removerKind,
    removerIsBeneficial,
    baselineRatio: Number(baseline.ratio.toFixed(6)),
    ownerRun,
    strangerRun,
  };

  // Control failed in the informative direction: a nobody could pull the
  // liquidity. Either the position is unowned or we are misreading the call.
  if (strangerRun && !strangerRun.internalError && !strangerRun.indeterminate && !strangerRun.middleReverted) {
    return {
      ...base,
      verdict: 'CONTROL_FAILED',
      reason: 'a freshly generated address with no position was also able to execute the removal — this probe cannot be trusted for this pool, and the result says nothing about the token either way',
    };
  }

  if (ownerRun.middleReverted) {
    // Owner could not pull it, stranger could not pull it. That is consistent
    // with a real lock AND with our calldata being wrong. Say so.
    return {
      ...base,
      verdict: 'LOCK_SUSPECTED',
      reason: `the removal reverted when sent from ${removerIsBeneficial ? 'the position\'s owner' : 'the custodian contract'} (${ownerRun.middleError || 'no error detail'}). ` +
        'This is consistent with locked liquidity, but it is equally consistent with this module encoding the removal incorrectly — the control run reverted too, so there is no positive evidence that the removal path works at all. Not proof of a lock.',
    };
  }

  // Removal succeeded from the owner and failed for a stranger: the machinery
  // works and the liquidity is genuinely pullable. Now the number that matters.
  if (ownerRun.sellReverted) {
    return {
      ...base,
      verdict: 'REMOVABLE_AND_FATAL',
      recoveryFraction: 0,
      reason: `the position owner pulled ${census.concentrationPct}% of pooled liquidity and the victim's sell then reverted outright (${ownerRun.sellError || 'no error detail'}), where the same sell succeeded in the undisturbed baseline. A holder who buys before that transaction cannot get out.`,
    };
  }
  if (ownerRun.ratio == null) {
    return {
      ...base,
      verdict: 'REMOVABLE',
      recoveryFraction: null,
      reason: 'the position owner was able to pull the liquidity and the victim\'s sell still went through, but its proceeds could not be measured, so the severity is unknown.',
    };
  }
  const recoveryFraction = ownerRun.ratio / baseline.ratio;
  if (recoveryFraction < FATAL_RECOVERY_FRACTION) {
    return {
      ...base,
      verdict: 'REMOVABLE_AND_FATAL',
      recoveryFraction: Number(recoveryFraction.toFixed(4)),
      reason: `the position owner pulled ${census.concentrationPct}% of pooled liquidity; the victim's sell then returned ${(recoveryFraction * 100).toFixed(1)}% of what the same sell returned in the undisturbed baseline.`,
    };
  }
  return {
    ...base,
    verdict: 'REMOVABLE',
    recoveryFraction: Number(recoveryFraction.toFixed(4)),
    reason: `the position owner can pull ${census.concentrationPct}% of pooled liquidity, but the victim still recovered ${(recoveryFraction * 100).toFixed(1)}% of the undisturbed proceeds afterwards. The vector is open; this size of buy survives it.`,
  };
}

// --------------------------------------------------------------------------
// PROBE 6c — whale-dump survival
// --------------------------------------------------------------------------

// Top holder that is not the pool, the PoolManager, the token itself, a burn
// address, or the zero address. Those five are exactly the balances that are
// not somebody's sellable position.
async function findWhale(p, addr, opts) {
  if (opts.whale && opts.whaleBalanceWei) {
    return { address: opts.whale, balanceWei: BN(opts.whaleBalanceWei), source: 'caller-supplied' };
  }
  // Also excluded: the pool's hook (Pons hooks collect fees in the token; they
  // are not a holder that can decide to dump) and known permanent lockers.
  const exclude = new Set(
    [p.poolAddress, addr.UNIV4_POOL_MANAGER, p.tokenAddr, addr.ZERO, ...BURN_ADDRESSES,
      p.hooks, p.poolKey && p.poolKey.hooks, addr.PONS_V2_LAUNCH_LOCKER]
      .filter(Boolean).map(lc)
  );
  // 2026-10-10 fix: the explorer's bot protection answered Node's fetch() with
  // HTTP 403. Same route as Gate 0 now: the curl program with the short browser
  // identity (source-gate.js curlHttp / EXPLORER_UA, overridable with
  // EXPLORER_USER_AGENT in .env). opts.http lets the tests stub it.
  // With BLOCKSCOUT_API_KEY set, this goes to Blockscout's official API instead
  // (plain Node request; see source-gate.js explorerUrl).
  const sg = require('./source-gate');
  const H = opts.http || sg.explorerHttp();
  const url = sg.explorerUrl(`/tokens/${p.tokenAddr}/holders`);
  let r;
  try {
    r = await H(url, { userAgent: sg.explorerUA() });
  } catch (e) {
    return { error: `explorer holders lookup threw: ${sg.redact(e.message)}` };
  }
  if ((r.status === 401 || r.status === 403) && sg.usingProApi()) {
    return { error: `Blockscout API refused the key (HTTP ${r.status}) — check BLOCKSCOUT_API_KEY in .env` };
  }
  if (r.status === 403) {
    return { error: 'explorer holders lookup refused (HTTP 403, bot protection) — if this keeps happening, test identities with curl again and set EXPLORER_USER_AGENT in .env' };
  }
  if (r.error || !r.json || r.status < 200 || r.status >= 300) {
    return { error: `explorer holders lookup failed (${sg.redact(r.error || `HTTP ${r.status}`)})` };
  }
  const items = Array.isArray(r.json.items) ? r.json.items : [];
  for (const it of items) {
    const a = it?.address?.hash || it?.address;
    if (!a || typeof a !== 'string' || exclude.has(lc(a))) continue;
    const v = it?.value ?? it?.amount;
    if (v == null) continue;
    let bal;
    try { bal = BN(String(v)); } catch (_) { continue; }
    return { address: a, balanceWei: bal, isContract: it?.address?.is_contract ?? null, source: 'explorer' };
  }
  return { error: 'no eligible holder found in the explorer holders list' };
}

async function whaleDumpProbe(p, addr, opts, baseline, legs) {
  if (!legs) {
    return { verdict: 'UNPROVEN', reason: 'swap legs could not be built for this pool' };
  }
  if (!baseline || !baseline.ok) {
    return { verdict: 'UNPROVEN', reason: `no usable baseline: ${baseline ? baseline.reason : 'baseline not run'}` };
  }
  const whale = await findWhale(p, addr, opts);
  if (whale.error) return { verdict: 'NO_WHALE', reason: whale.error };
  if (whale.balanceWei.isZero()) return { verdict: 'NO_WHALE', reason: 'top eligible holder has a zero balance' };

  const victimBuyWei = BN(opts.baseAmountWei);
  const { sellBps, victimSellWei } = probeSellSize(opts, baseline);

  // The whale sells its entire balance. No state override is needed — this is
  // the real balance the chain already shows for that address, which is what
  // makes this probe a statement about the actual pool rather than a fabricated
  // scenario.
  const dump = legs.sellSteps({ from: whale.address, amountInWei: whale.balanceWei });
  const run = await oneRun({ p, addr, legs, victimBuyWei, victimSellWei, sellBps, middleSteps: dump });

  const common = {
    whale: whale.address,
    whaleSource: whale.source,
    // A contract whale is simulated as if it could sell freely, which may
    // overstate the risk (its code is skipped). Recorded so a SKIP from it can
    // be checked by hand.
    whaleIsContract: whale.isContract ?? null,
    whaleBalanceWei: whale.balanceWei.toString(),
    baselineRatio: Number(baseline.ratio.toFixed(6)),
  };

  if (run.internalError) return { ...common, verdict: 'ERROR', reason: run.internalError };
  if (run.indeterminate) return { ...common, verdict: 'UNPROVEN', reason: run.reason };

  if (run.middleReverted) {
    // The whale itself could not sell. That is a finding about the token, but
    // it belongs to the sell-cap gate, not here — and it means this probe did
    // not get to test what it exists to test.
    return {
      ...common,
      verdict: 'UNPROVEN',
      reason: `the top holder's own sell reverted (${run.middleError}), so the post-dump state was never reached. Worth noting separately: a balance that large may simply exceed a per-transaction sell cap.`,
    };
  }

  const ratio = run.ratio;
  const recoveryFraction = ratio == null ? null : ratio / baseline.ratio;
  const out = {
    ...common,
    ratio: ratio == null ? null : Number(ratio.toFixed(6)),
    recoveryFraction: recoveryFraction == null ? null : Number(recoveryFraction.toFixed(4)),
  };

  if (run.sellReverted) {
    return { ...out, verdict: 'WHALE_DUMP_FATAL', reason: `after the top holder sold its entire balance, the victim's sell reverted (${run.sellError}) — the same sell succeeded in the undisturbed baseline.` };
  }
  if (recoveryFraction == null) {
    return { ...out, verdict: 'UNPROVEN', reason: 'the victim sold successfully after the dump, but its proceeds could not be measured, so the severity is unknown.' };
  }
  if (recoveryFraction < FATAL_RECOVERY_FRACTION) {
    return { ...out, verdict: 'WHALE_DUMP_FATAL', reason: `after the top holder sold its entire balance, the victim recovered ${(recoveryFraction * 100).toFixed(1)}% of the undisturbed proceeds.` };
  }
  return { ...out, verdict: 'WHALE_DUMP_SURVIVED', reason: `the top holder sold its entire balance and the victim still recovered ${(recoveryFraction * 100).toFixed(1)}% of the undisturbed proceeds.` };
}

// --------------------------------------------------------------------------
// Gate 6 orchestration
// --------------------------------------------------------------------------

async function rugCheck(p, addr = config.ADDR, opts = {}) {
  const notes = [];
  if (usingLocalSwapEncoder && p.version === 'v4') {
    notes.push('using this module\'s local copy of encodeV4SwapExecute — export the real one from tenderly-bundle-v4.js so the two cannot drift');
  }
  if (!opts.provider) return { decision: 'ERROR', reason: 'opts.provider is required (an ethers v5 provider on chain 4663)', notes };
  if (opts.baseAmountWei == null) return { decision: 'ERROR', reason: 'opts.baseAmountWei is required', notes };
  if (opts.baselineTokenOutWei == null) {
    // The sell leg has to be sized from a real post-buy balance. Gate 3 already
    // measured one (actualTokenReceived in the bundle module's variant record),
    // so this is a wiring mistake rather than something to work around: a
    // guessed size that reverts would be indistinguishable from a trap.
    return {
      decision: 'ERROR',
      reason: 'opts.baselineTokenOutWei is required — pass actualTokenReceived from the Gate 3 round trip so the sell legs can be sized from a real balance',
      notes,
    };
  }

  let census;
  try {
    census = await positionCensus(p, { provider: opts.provider, addr, lookbackBlocks: opts.lookbackBlocks });
  } catch (e) {
    return { decision: 'ERROR', reason: `position census failed: ${e.message}`, notes };
  }
  if (census.error) return { decision: 'ERROR', reason: census.error, notes };
  if (census.truncated) {
    notes.push(`the log scan was cut short, so the census may be missing positions (scanned back ${census.scannedBlocks} blocks at most)`);
  }

  // The undisturbed round trip: denominator for both probes and positive
  // control for the gate. Run once and shared.
  let legs = null;
  try {
    legs = await legsFor(p, { ...opts, addr });
  } catch (e) {
    notes.push(`could not build swap legs for this pool: ${e.message}`);
  }
  if (legs && legs.note) notes.push(legs.note);
  let baseline = null;
  if (legs) {
    baseline = await baselineRun({
      p, addr, legs,
      victimBuyWei: BN(opts.baseAmountWei),
      tokenOutWei: BN(opts.baselineTokenOutWei),
      startSellBps: opts.startSellBps || 10000,
    });
    if (!baseline.ok) notes.push(`baseline round trip unusable — ${baseline.reason}`);
  }

  const removal = await liquidityRemovalProbe(p, addr, opts, census, baseline, legs);
  const whaleDump = await whaleDumpProbe(p, addr, opts, baseline, legs);

  // Strip the internal BigNumber-bearing record before returning.
  const censusOut = { ...census };
  delete censusOut._top;
  const probes = {
    census: censusOut,
    baseline: baseline ? { ok: baseline.ok, ratio: baseline.ratio ?? null, sellBps: baseline.sellBps ?? null, reason: baseline.reason ?? null } : null,
    removal,
    whaleDump,
  };

  // Decision. A fatal result in either probe is a SKIP. A PASS needs BOTH
  // probes to come back positive — and since the removal probe cannot prove a
  // lock, LOCK_SUSPECTED is the strongest input a PASS can ever have.
  if (removal.verdict === 'REMOVABLE_AND_FATAL' || whaleDump.verdict === 'WHALE_DUMP_FATAL') {
    const which = [];
    if (removal.verdict === 'REMOVABLE_AND_FATAL') which.push(`liquidity removal: ${removal.reason}`);
    if (whaleDump.verdict === 'WHALE_DUMP_FATAL') which.push(`whale dump: ${whaleDump.reason}`);
    return { decision: 'SKIP', reason: which.join(' | '), probes, notes };
  }
  if (removal.verdict === 'CONTROL_FAILED') {
    return { decision: 'UNPROVEN', reason: `removal probe control failed — ${removal.reason}`, probes, notes };
  }
  const removalOk = ['LOCK_SUSPECTED', 'REMOVABLE', 'LOCKED_PER_CONTROLLER', 'LOCKED_BURNED'].includes(removal.verdict);
  if (removalOk && whaleDump.verdict === 'WHALE_DUMP_SURVIVED') {
    const caveat = {
      LOCK_SUSPECTED: 'the liquidity could not be pulled in simulation, though that is not proof of a lock',
      LOCKED_PER_CONTROLLER: `the top position is held by a reviewed permanent locker (${removal.position.sharePct}% of liquidity; from the controller check, not simulated)`,
      LOCKED_BURNED: `the top position (${removal.position && removal.position.sharePct}% of liquidity) is owned by the burn address`,
    }[removal.verdict] || `the liquidity can be pulled, but this buy size survived it (${(removal.recoveryFraction * 100).toFixed(1)}% recovery)`;
    return {
      decision: 'PASS',
      reason: `${caveat}; and the top holder dumping its whole balance still left ${(whaleDump.recoveryFraction * 100).toFixed(1)}% recovery.`,
      probes,
      notes,
    };
  }
  return {
    decision: 'UNPROVEN',
    reason: `removal probe: ${removal.verdict} (${removal.reason}) | whale-dump probe: ${whaleDump.verdict} (${whaleDump.reason})`,
    probes,
    notes,
  };
}

module.exports = {
  rugCheck,
  positionCensus,
  baselineRun,
  liquidityRemovalProbe,
  whaleDumpProbe,
  findWhale,
  // The v4 swap encoder, resolved once: the real one from tenderly-bundle-v4.js
  // when it is exported, this module's checked copy otherwise. Other scripts
  // (wallet-round-trip.js) import it from here so there is exactly one place
  // that decides which copy is in use.
  encodeV4SwapExecute,
  usingLocalSwapEncoder,
  // exported for the offline encoder tests in test-rug-check.js
  v3RemovalSteps,
  v4RemovalSteps,
};
