// Offline tests for swap-legs.js — the shared v3/v4 leg builder.
//
//   node test-swap-legs.js
//
// The calldata this module produces is what every other script sends to
// Tenderly, so a mistake here is invisible until a simulation reverts and gets
// blamed on the token. Everything below decodes the bytes back and checks them
// against what the protocol actually expects.

const { ethers } = require('ethers');
const { legsFor, resolveV3RouterShape, _shapeCache } = require('./swap-legs');
const { ADDR } = require('./config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);

const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL3 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AMT = ethers.utils.parseEther('0.05');

const v3Pool = { version: 'v3', tokenAddr: TOKEN, base: 'WETH', baseAddr: ADDR.WETH, fee: 3000, poolAddress: POOL3 };
const v4Native = {
  version: 'v4', tokenAddr: TOKEN, base: 'ETH', fee: 10000,
  poolKey: { currency0: ADDR.ZERO, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: ADDR.ZERO },
};
const v4Weth = {
  version: 'v4', tokenAddr: TOKEN, base: 'WETH', fee: 3000,
  poolKey: { currency0: ADDR.WETH, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ADDR.ZERO },
};

const SEL_02 = '0x04e45aaf';
const SEL_01 = '0x414bf389';
const codeWith = (...sels) => '0x60806040' + sels.map((x) => x.slice(2)).join('60') + '00';
const provWith = (code) => ({ async getCode() { return code; } });

const r02 = new ethers.utils.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
]);
const r01 = new ethers.utils.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
]);

async function main() {

// ==========================================================================
section('1. the router shape is read from bytecode, not assumed');
// ==========================================================================
{
  _shapeCache.clear();
  const a = await resolveV3RouterShape('0x01', provWith(codeWith(SEL_02)));
  check('SwapRouter02 selector -> SwapRouter02', a.shape.id === 'SwapRouter02' && a.how === 'bytecode');
  check('and no warning note is produced', a.note === null || /resolved from bytecode/.test(a.note || ''));

  _shapeCache.clear();
  const b = await resolveV3RouterShape('0x02', provWith(codeWith(SEL_01)));
  check('SwapRouter v1 selector -> SwapRouter', b.shape.id === 'SwapRouter' && b.how === 'bytecode');

  _shapeCache.clear();
  const c = await resolveV3RouterShape('0x03', provWith(codeWith(SEL_02, SEL_01)));
  check('both selectors -> defaults to SwapRouter02 with a note', c.shape.id === 'SwapRouter02' && /both/.test(c.note));

  _shapeCache.clear();
  const d = await resolveV3RouterShape('0x04', provWith('0x6080604052'));
  check('neither selector -> default plus an actionable note',
    d.how === 'default' && /V3_ROUTER_STYLE=SwapRouter/.test(d.note), d.note);

  _shapeCache.clear();
  const e = await resolveV3RouterShape('0x05', provWith('0x'));
  check('no code at the address is called out as a bad address', /probably wrong/.test(e.note), e.note);

  _shapeCache.clear();
  const f = await resolveV3RouterShape('0x06', { async getCode() { throw new Error('rpc down'); } });
  check('an RPC failure degrades to the default rather than throwing',
    f.shape.id === 'SwapRouter02' && /rpc down/.test(f.note), f.note);

  // The cache means one lookup per router per process.
  _shapeCache.clear();
  let calls = 0;
  const counting = { async getCode() { calls += 1; return codeWith(SEL_02); } };
  await resolveV3RouterShape('0x07', counting);
  await resolveV3RouterShape('0x07', counting);
  check('the bytecode is fetched once per router, then cached', calls === 1, String(calls));

  _shapeCache.clear();
  process.env.V3_ROUTER_STYLE = 'SwapRouter';
  const g = await resolveV3RouterShape('0x08', provWith(codeWith(SEL_02)));
  check('V3_ROUTER_STYLE overrides the bytecode', g.shape.id === 'SwapRouter' && g.how === 'override');
  delete process.env.V3_ROUTER_STYLE;
  _shapeCache.clear();
}

// ==========================================================================
section('2. v3 legs: classic approve, no Permit2, correct struct');
// ==========================================================================
{
  _shapeCache.clear();
  const legs = await legsFor(v3Pool, ADDR, { provider: provWith(codeWith(SEL_02)) });
  check('base is WETH and readable', legs.baseIsErc20 === true && legs.isNative === false);
  check('poolHolder is the v3 pool contract itself', legs.poolHolder === POOL3);
  check('router is SwapRouter02', legs.router === ADDR.SWAP_ROUTER_02);

  const buy = legs.buySteps({ from: FROM, amountInWei: AMT });
  check('buy is deposit, approve, swap', buy.length === 3);
  check('the deposit carries the ETH value', buy[0].to === ADDR.WETH && buy[0].value === AMT.toString());
  check('NO Permit2 anywhere in the v3 buy', !buy.some((s) => s.to === ADDR.PERMIT2));
  const approve = new ethers.utils.Interface(['function approve(address,uint256)']).parseTransaction({ data: buy[1].input });
  check('WETH is approved to the router, not to Permit2', approve.args[0] === ADDR.SWAP_ROUTER_02);

  const swap = r02.parseTransaction({ data: buy[2].input });
  check('the swap is exactInputSingle', swap.name === 'exactInputSingle');
  check('buy direction is WETH -> token',
    swap.args.params.tokenIn === ADDR.WETH && swap.args.params.tokenOut === TOKEN);
  check('fee tier carried through', swap.args.params.fee === 3000);
  check('recipient is the trader', swap.args.params.recipient === ethers.utils.getAddress(FROM));
  check('amountOutMinimum is 0 and there is no price limit',
    swap.args.params.amountOutMinimum.isZero() && swap.args.params.sqrtPriceLimitX96.isZero());
  check('no deadline field on the SwapRouter02 struct', swap.args.params.deadline === undefined);

  const sell = legs.sellSteps({ from: FROM, amountInWei: AMT });
  check('sell is approve then swap — two steps, not four', sell.length === 2);
  const sellSwap = r02.parseTransaction({ data: sell[1].input });
  check('sell direction is token -> WETH',
    sellSwap.args.params.tokenIn === TOKEN && sellSwap.args.params.tokenOut === ADDR.WETH);
}

// ==========================================================================
section('3. v3 with the older router: the deadline field appears');
// ==========================================================================
{
  _shapeCache.clear();
  const legs = await legsFor(v3Pool, ADDR, { provider: provWith(codeWith(SEL_01)) });
  check('shape reported as SwapRouter', legs.routerShape === 'SwapRouter');
  const buy = legs.buySteps({ from: FROM, amountInWei: AMT });
  const swap = r01.parseTransaction({ data: buy[2].input });
  check('the struct now carries a deadline', swap.args.params.deadline && swap.args.params.deadline.gt(0));
  check('and it is in the future', swap.args.params.deadline.toNumber() > Math.floor(Date.now() / 1000));
  check('the selector differs from SwapRouter02', buy[2].input.slice(0, 10) === SEL_01, buy[2].input.slice(0, 10));
}

// ==========================================================================
section('4. v4 native: one step in, Permit2 only on the way out');
// ==========================================================================
{
  const legs = await legsFor(v4Native, ADDR, {});
  check('flagged native', legs.isNative === true && legs.baseIsErc20 === false);
  check('poolHolder is the PoolManager singleton', legs.poolHolder === ADDR.UNIV4_POOL_MANAGER);
  check('router is the UniversalRouter', legs.router === ADDR.UNIVERSAL_ROUTER);

  const buy = legs.buySteps({ from: FROM, amountInWei: AMT });
  check('native buy is a single step — no wrap, no approvals', buy.length === 1);
  check('and it carries the ETH as call value', buy[0].value === AMT.toString());
  check('the ETH balance override seeds the wallet', Boolean(buy[0].state_objects));

  const sell = legs.sellSteps({ from: FROM, amountInWei: AMT });
  check('sell is approve, permit2 approve, execute', sell.length === 3);
  check('the Permit2 approval is present — it is what exposes a transferFrom trap',
    sell[1].to === ADDR.PERMIT2);
  check('the swap goes to the UniversalRouter', sell[2].to === ADDR.UNIVERSAL_ROUTER);
}

// ==========================================================================
section('5. v4 WETH-paired: wraps first, and the base becomes readable');
// ==========================================================================
{
  const legs = await legsFor(v4Weth, ADDR, {});
  check('not native, so the base side can be read with balanceOf',
    legs.isNative === false && legs.baseIsErc20 === true && legs.baseAddr === ADDR.WETH);
  const buy = legs.buySteps({ from: FROM, amountInWei: AMT });
  check('buy is deposit, approve, permit2, execute', buy.length === 4);
  check('Permit2 is in the v4 buy path', buy.some((s) => s.to === ADDR.PERMIT2));
}

// ==========================================================================
section('6. bad input is refused loudly');
// ==========================================================================
{
  let msg = null;
  try { await legsFor({ version: 'v5' }, ADDR, {}); } catch (e) { msg = e.message; }
  check('an unknown version throws', /unknown pool version v5/.test(msg || ''), msg);

  msg = null;
  try { await legsFor({ version: 'v3', tokenAddr: TOKEN, fee: 3000 }, ADDR, { provider: provWith('0x') }); }
  catch (e) { msg = e.message; }
  check('a v3 descriptor with no poolAddress throws', /no poolAddress/.test(msg || ''), msg);

  msg = null;
  try { await legsFor(v3Pool, ADDR, {}); } catch (e) { msg = e.message; }
  check('v3 without a provider throws, rather than guessing the router shape',
    /needs opts.provider/.test(msg || ''), msg);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
