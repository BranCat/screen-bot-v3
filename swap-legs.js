// swap-legs.js — one place that knows how to buy and sell on this chain,
// for BOTH Uniswap v3 and v4.
//
// Every other script here (rug-check, wallet-round-trip, transfer-audit) needs
// the same two things: the steps that buy a token, and the steps that sell it.
// They were each growing their own copy, and the v3 half was missing from all
// of them. This module is the single implementation, so a fix lands everywhere
// at once and a v3 pool is a first-class case rather than a refusal.
//
// ---------------------------------------------------------------------------
// THE TWO PROTOCOLS ARE NOT SHAPED THE SAME
// ---------------------------------------------------------------------------
//
//   v4   the PoolManager is a singleton: every pool's tokens sit at ONE
//        address, swaps go through the (Robinhood-forked) UniversalRouter, and
//        the token side is pulled via Permit2. The base currency can be native
//        ETH, which has no balanceOf to read.
//
//   v3   each pool is its own contract holding its own two tokens, swaps go
//        through SwapRouter02, and the token side is pulled with a plain
//        ERC20 approve() — no Permit2. There is no native-ETH pool: v3 pairs
//        are always ERC20/ERC20, so the base is always WETH.
//
// That second point is quietly useful. Because v3's base is always WETH, the
// ETH side of a sell is an ordinary ERC20 balance on both the pool and the
// wallet — so the "did all the ETH arrive" check is a direct measurement on v3,
// where on a native v4 pool it has to come out of the balance diff.
//
// ---------------------------------------------------------------------------
// WHICH SwapRouter IS THIS?
// ---------------------------------------------------------------------------
// Two incompatible exactInputSingle structs exist in the wild: SwapRouter02
// dropped the `deadline` field that SwapRouter v1 had. They therefore have
// different selectors:
//
//     0x04e45aaf   SwapRouter02   (tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,sqrtPriceLimitX96)
//     0x414bf389   SwapRouter v1  (...,recipient,deadline,amountIn,...)
//
// Guessing wrong produces a revert that looks exactly like a hostile token. So
// this module does not guess: it reads the router's deployed bytecode once and
// looks for the selector. One eth_getCode, no simulation, and a definite
// answer. config.js says this chain has the swap-router-contracts deployment
// (SwapRouter02), and this check confirms it rather than trusting it.

const { ethers } = require('ethers');
const config = require('./config');
const { encodeV4SwapExecute } = require('./rug-check');
const {
  buildStep,
  ethBalanceOverride,
  erc20Iface,
  wethIface,
  MAX_UINT256,
  MAX_UINT160,
} = require('./tenderly-client');

const permit2Iface = new ethers.utils.Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

const v3Router02Iface = new ethers.utils.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const v3Router01Iface = new ethers.utils.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

const ROUTER_SHAPES = [
  { id: 'SwapRouter02', iface: v3Router02Iface, hasDeadline: false },
  { id: 'SwapRouter', iface: v3Router01Iface, hasDeadline: true },
];

const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 3600;
const V3_DEADLINE_SECONDS = 600;
const SEED_ETH = ethers.utils.parseEther('1');

// Gas limit for the swap call itself.
//
// 5,000,000 was inherited from tenderly-bundle-v4.js and is not enough for
// every pool on this chain. A concentrated-liquidity swap pays gas per
// INITIALIZED TICK it crosses, so the cost scales with how far the price moves
// and how fine the tick spacing is. A fee-100 pool has tickSpacing 1 — the
// finest Uniswap offers — so a buy that is large relative to current liquidity
// can cross thousands of ticks and burn millions of gas. The first live run
// hit exactly this and reported "out of gas", which reads like a hostile token
// and is nothing of the sort.
//
// 15M is comfortably above what any single swap should need while staying
// under a normal block limit. Override with SWAP_GAS if a pool needs more, and
// note that a smaller --amount is usually the better answer: less price
// movement means fewer ticks crossed.
const SWAP_GAS = Number(process.env.SWAP_GAS || 15_000_000);

// One lookup per router address per process.
const _shapeCache = new Map();

/**
 * Decides which exactInputSingle struct the router on this chain expects, by
 * looking for the selector in its deployed bytecode.
 *
 * Returns { shape, how, note }. `how` is 'bytecode' when the selector was
 * found, 'override' when forced by V3_ROUTER_STYLE, and 'default' when the
 * bytecode could not be read or was ambiguous — in which case SwapRouter02 is
 * assumed and `note` says so, because a wrong guess here reverts in a way that
 * looks like a hostile token and the caller should be able to say otherwise.
 */
async function resolveV3RouterShape(routerAddr, provider) {
  const key = String(routerAddr).toLowerCase();
  if (_shapeCache.has(key)) return _shapeCache.get(key);

  const forced = process.env.V3_ROUTER_STYLE;
  if (forced) {
    const shape = ROUTER_SHAPES.find((s) => s.id.toLowerCase() === forced.toLowerCase());
    if (shape) {
      const r = { shape, how: 'override', note: `router shape forced to ${shape.id} by V3_ROUTER_STYLE` };
      _shapeCache.set(key, r);
      return r;
    }
  }

  let result;
  try {
    const code = await provider.getCode(routerAddr);
    if (!code || code === '0x') {
      result = {
        shape: ROUTER_SHAPES[0], how: 'default',
        note: `no contract code at the configured v3 router ${routerAddr} — assuming SwapRouter02, but this address is probably wrong`,
      };
    } else {
      const found = ROUTER_SHAPES.filter((s) => code.includes(s.iface.getSighash('exactInputSingle').slice(2)));
      if (found.length === 1) {
        result = { shape: found[0], how: 'bytecode', note: null };
      } else if (found.length > 1) {
        result = {
          shape: found[0], how: 'default',
          note: 'the router exposes both exactInputSingle variants; using SwapRouter02. Set V3_ROUTER_STYLE=SwapRouter to force the other.',
        };
      } else {
        result = {
          shape: ROUTER_SHAPES[0], how: 'default',
          note: 'neither exactInputSingle selector appears in the router bytecode (it may be a proxy). Assuming SwapRouter02; if v3 swaps revert, set V3_ROUTER_STYLE=SwapRouter.',
        };
      }
    }
  } catch (e) {
    result = {
      shape: ROUTER_SHAPES[0], how: 'default',
      note: `could not read the v3 router bytecode (${e.message}); assuming SwapRouter02`,
    };
  }
  _shapeCache.set(key, result);
  return result;
}

function encodeV3ExactInputSingle({ shape, tokenIn, tokenOut, fee, recipient, amountIn }) {
  const params = shape.hasDeadline
    ? {
      tokenIn, tokenOut, fee, recipient,
      deadline: Math.floor(Date.now() / 1000) + V3_DEADLINE_SECONDS,
      amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    }
    : { tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 };
  return shape.iface.encodeFunctionData('exactInputSingle', [params]);
}

/**
 * The swap legs for one pool, plus the addresses a caller needs to watch.
 *
 * @param p    pool descriptor from discoverPool() in screen-token.js
 * @param addr config.ADDR
 * @param opts { provider } — required for v3 (the router-shape lookup)
 *
 * Returns:
 *   version       'v3' | 'v4'
 *   isNative      true when the base currency is native ETH (v4 only)
 *   baseAddr      WETH address, or the zero sentinel for native
 *   poolHolder    the address whose TOKEN balance is the pool's side of a
 *                 trade — the v3 pool itself, or the v4 PoolManager singleton
 *   router        the address that moves the tokens on your behalf
 *   baseIsErc20   true when the base side can be read with balanceOf
 *   note          anything the caller should print about how this was resolved
 *   buySteps({ from, amountInWei, seedWei })
 *   sellSteps({ from, amountInWei })
 */
async function legsFor(p, addr = config.ADDR, opts = {}) {
  if (!p || !p.version) throw new Error('legsFor needs a pool descriptor with a version');

  if (p.version === 'v4') {
    const isNative = p.base === 'ETH';
    const baseAddr = isNative ? addr.ZERO : addr.WETH;
    return {
      version: 'v4',
      isNative,
      baseAddr,
      poolHolder: addr.UNIV4_POOL_MANAGER,
      router: addr.UNIVERSAL_ROUTER,
      baseIsErc20: !isNative,
      note: null,

      buySteps({ from, amountInWei, seedWei }) {
        const data = encodeV4SwapExecute({
          poolKey: p.poolKey, tokenAddr: p.tokenAddr, baseAddr,
          side: 'buy', amountIn: amountInWei, amountOutMinimum: 0,
        });
        if (isNative) {
          return [buildStep({
            from, to: addr.UNIVERSAL_ROUTER, data, value: amountInWei, gas: SWAP_GAS,
            stateObjects: ethBalanceOverride(from, seedWei || SEED_ETH),
          })];
        }
        const now = Math.floor(Date.now() / 1000);
        return [
          buildStep({ from, to: addr.WETH, data: wethIface.encodeFunctionData('deposit'), value: amountInWei, stateObjects: ethBalanceOverride(from, seedWei || SEED_ETH) }),
          buildStep({ from, to: addr.WETH, data: erc20Iface.encodeFunctionData('approve', [addr.PERMIT2, MAX_UINT256]) }),
          buildStep({ from, to: addr.PERMIT2, data: permit2Iface.encodeFunctionData('approve', [addr.WETH, addr.UNIVERSAL_ROUTER, MAX_UINT160, now + PERMIT2_EXPIRY_SECONDS]) }),
          buildStep({ from, to: addr.UNIVERSAL_ROUTER, data, gas: SWAP_GAS }),
        ];
      },

      sellSteps({ from, amountInWei }) {
        const now = Math.floor(Date.now() / 1000);
        const data = encodeV4SwapExecute({
          poolKey: p.poolKey, tokenAddr: p.tokenAddr, baseAddr,
          side: 'sell', amountIn: amountInWei, amountOutMinimum: 0,
        });
        return [
          buildStep({ from, to: p.tokenAddr, data: erc20Iface.encodeFunctionData('approve', [addr.PERMIT2, MAX_UINT256]) }),
          buildStep({ from, to: addr.PERMIT2, data: permit2Iface.encodeFunctionData('approve', [p.tokenAddr, addr.UNIVERSAL_ROUTER, MAX_UINT160, now + PERMIT2_EXPIRY_SECONDS]) }),
          buildStep({ from, to: addr.UNIVERSAL_ROUTER, data, gas: SWAP_GAS }),
        ];
      },
    };
  }

  if (p.version === 'v3') {
    if (!p.poolAddress) throw new Error('v3 pool descriptor has no poolAddress');
    if (!opts.provider) throw new Error('legsFor needs opts.provider for a v3 pool (to resolve the router shape)');
    const router = addr.SWAP_ROUTER_02;
    if (!router) throw new Error('config.ADDR.SWAP_ROUTER_02 is not set');
    const resolved = await resolveV3RouterShape(router, opts.provider);
    const shape = resolved.shape;

    return {
      version: 'v3',
      // v3 pairs are ERC20/ERC20 — there is no native-ETH v3 pool, so the base
      // is always WETH and always readable with balanceOf.
      isNative: false,
      baseAddr: addr.WETH,
      poolHolder: p.poolAddress,
      router,
      baseIsErc20: true,
      routerShape: shape.id,
      note: resolved.note || (resolved.how === 'bytecode' ? `v3 router resolved from bytecode as ${shape.id}` : null),

      buySteps({ from, amountInWei, seedWei }) {
        return [
          buildStep({ from, to: addr.WETH, data: wethIface.encodeFunctionData('deposit'), value: amountInWei, stateObjects: ethBalanceOverride(from, seedWei || SEED_ETH) }),
          // Classic ERC20 approval — this deployment is unmodified Uniswap, so
          // there is no Permit2 in the path (see config.js).
          buildStep({ from, to: addr.WETH, data: erc20Iface.encodeFunctionData('approve', [router, MAX_UINT256]) }),
          buildStep({
            from, to: router, gas: SWAP_GAS,
            data: encodeV3ExactInputSingle({
              shape, tokenIn: addr.WETH, tokenOut: p.tokenAddr, fee: p.fee,
              recipient: from, amountIn: amountInWei,
            }),
          }),
        ];
      },

      sellSteps({ from, amountInWei }) {
        return [
          buildStep({ from, to: p.tokenAddr, data: erc20Iface.encodeFunctionData('approve', [router, MAX_UINT256]) }),
          buildStep({
            from, to: router, gas: SWAP_GAS,
            data: encodeV3ExactInputSingle({
              shape, tokenIn: p.tokenAddr, tokenOut: addr.WETH, fee: p.fee,
              recipient: from, amountIn: amountInWei,
            }),
          }),
        ];
      },
    };
  }

  throw new Error(`unknown pool version ${p.version}`);
}

module.exports = {
  legsFor,
  resolveV3RouterShape,
  encodeV3ExactInputSingle,
  ROUTER_SHAPES,
  _shapeCache,
};
