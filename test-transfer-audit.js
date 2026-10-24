// Offline tests for transfer-audit.js. No RPC, no Tenderly.
//
//   node test-transfer-audit.js
//
// Each case builds a token with a KNOWN hidden behaviour and checks the audit
// reports exactly that behaviour and nothing else. The point is not that the
// code runs — it is that a 5% skim reads as 5%, and that a clean token does not
// produce a finding.

const { ethers } = require('ethers');

// transfer-audit.js destructures simulateBundle at require time, so the stub
// has to be installed once, before the require, and stay the same function
// object. Per-case behaviour is swapped by changing MODEL_FACTORY, not by
// reassigning this.
const client = require('./tenderly-client');
let MODEL_FACTORY = null;
let BUNDLE_CALLS = 0;
let REFUSE_PIN = false;     // Tenderly refuses a pinned block (it may lag the chain)
let BUNDLE_BLOCKS = [];     // the block_number each bundle was sent with (null = latest)
client.simulateBundle = async (steps) => {
  if (REFUSE_PIN && steps.some((st) => st.block_number != null)) throw new Error('Tenderly simulate-bundle HTTP 400: unknown block');
  BUNDLE_CALLS += 1;
  BUNDLE_BLOCKS.push(steps[0] && steps[0].block_number != null ? steps[0].block_number : null);
  // A fresh model per bundle: each real Tenderly bundle starts from the same
  // forked state rather than continuing the previous one. An UNPINNED bundle may
  // land on a newer block (driftBps / driftBundles); a pinned one never does.
  const m = MODEL_FACTORY();
  m.bundleNo = BUNDLE_CALLS;
  m.pinned = steps.length > 0 && steps.every((st) => st.block_number != null);
  return simulateAgainstModel(steps, m);
};

const audit = require('./transfer-audit');
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
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const lc = (a) => String(a || '').toLowerCase();

const V3_POOL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const v3pool = {
  version: 'v3', tokenAddr: TOKEN, base: 'WETH', baseAddr: ADDR.WETH, fee: 3000,
  poolAddress: V3_POOL, label: 'v3 (WETH pair, fee 3000)',
};

const pool = {
  version: 'v4', tokenAddr: TOKEN, base: 'ETH', fee: 10000, poolId: '0x' + 'ab'.repeat(32),
  hooks: ADDR.ZERO, label: 'Uniswap v4, 1.00% fee, native ETH',
  poolKey: { currency0: ADDR.ZERO, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: ADDR.ZERO },
};

const iface = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const SIG = {
  balanceOf: iface.getSighash('balanceOf'),
  allowance: iface.getSighash('allowance'),
  approve: iface.getSighash('approve'),
  transfer: iface.getSighash('transfer'),
  transferFrom: iface.getSighash('transferFrom'),
};

// --------------------------------------------------------------------------
// A tiny in-memory ERC20 + pool, so a bundle can be executed for real offline.
// Each model describes one token's hidden behaviour; everything else is honest.
// --------------------------------------------------------------------------

const POOL_TOKENS_OUT = T(1000000);   // what the AMM pays out for the buy
const POOL_ETH_OUT = E(0.045);        // what the AMM pays out for a 90% sell

function makeModel({
  buySkimBps = 0,        // taken between the pool paying out and the wallet receiving
  sellSkimBps = 0,       // taken between the wallet sending and the pool receiving
  transferTaxBps = 0,    // taken by transfer()
  transferFromTaxBps = null, // taken by transferFrom(); null = same as transfer()
  transferFromReverts = false,
  exactAllowanceReverts = false,
  approveCapsAt = null,  // approve() silently stores this instead
  routerKeepsSkim = true, // where the skimmed tokens land
  ethSkimBps = 0,        // ETH kept between the pool and the wallet
  skimTo = null,         // explicit destination for token skims (e.g. a v4 hook)
  sellReverts = false,   // the DEX sell reverts (honeypot), wallet-to-wallet still works
  ethSkimTo = null,      // explicit destination for the ETH skim, shown in the balance diff
  driftBps = 0,          // unpinned bundle N buys (N-1)*driftBps fewer tokens
  driftBundles = null,   // { bundleNo: bps fewer } for a single moved bundle
} = {}) {
  return {
    driftBps, driftBundles,
    buySkimBps, sellSkimBps, transferTaxBps,
    transferFromTaxBps: transferFromTaxBps == null ? transferTaxBps : transferFromTaxBps,
    transferFromReverts, exactAllowanceReverts, approveCapsAt, routerKeepsSkim, ethSkimBps, skimTo, ethSkimTo, sellReverts,
    poolHolder: null, // set for the v3 case
    bal: new Map([
      [lc(ADDR.UNIV4_POOL_MANAGER), T(500000000)],
      [lc(V3_POOL), T(500000000)],
    ]),
    weth: new Map([[lc(V3_POOL), E(1000)]]),
    allow: new Map(),
  };
}

const get = (m, a) => m.bal.get(lc(a)) || ethers.BigNumber.from(0);
const set = (m, a, v) => m.bal.set(lc(a), v);
const add = (m, a, v) => set(m, a, get(m, a).add(v));
const sub = (m, a, v) => set(m, a, get(m, a).sub(v));

const GAS = 100000;
const ok = (returnData = '0x', extra = {}) => ({
  reverted: false, indeterminate: false, returnData, errorMessage: null,
  raw: { transaction: { gas_used: GAS, ...extra } },
});
const rev = (msg) => ({
  reverted: true, indeterminate: false, returnData: '0x', errorMessage: msg,
  raw: { transaction: { gas_used: 21000 } },
});
const word = (v) => ethers.utils.hexZeroPad(ethers.BigNumber.from(v).toHexString(), 32);
const argAddr = (data, i) => ethers.utils.getAddress('0x' + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64));
const argUint = (data, i) => ethers.BigNumber.from('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));

// Executes a bundle against the model. Router calls are recognised by their
// destination; everything else is the ERC20.
function simulateAgainstModel(steps, m) {
  return steps.map((s) => {
    const to = lc(s.to);
    const from = s.from;
    const data = s.input || '0x';

    // --- the router: buy or sell -----------------------------------------
    if (to === lc(ADDR.UNIVERSAL_ROUTER) || to === lc(ADDR.SWAP_ROUTER_02)) {
      const POOL = m.poolHolder || ADDR.UNIV4_POOL_MANAGER;
      // v4 carries the ETH on the swap call itself, so value > 0 means a buy.
      // v3 wraps first, so its swap call always has value 0 — direction has to
      // come from the struct's tokenIn instead.
      const isV3 = to === lc(ADDR.SWAP_ROUTER_02);
      const isBuy = isV3
        ? lc(argAddr(data, 0)) === lc(ADDR.WETH)
        : ethers.BigNumber.from(s.value || '0').gt(0);
      if (isBuy && m.buyReverts) return rev('execution reverted: not tradable');
      if (!isBuy && m.sellReverts) return rev('execution reverted: TRAP: sells disabled');
      if (isBuy) {
        // Price drift between bundles, as at a live launch: an unpinned bundle
        // run later buys fewer tokens for the same ETH.
        let less = 0;
        if (!m.pinned && m.driftBps) less = m.driftBps * (m.bundleNo - 1);
        if (!m.pinned && m.driftBundles && m.driftBundles[m.bundleNo]) less = m.driftBundles[m.bundleNo];
        const out = POOL_TOKENS_OUT.mul(10000 - less).div(10000);
        sub(m, POOL, out);
        const skim = out.mul(m.buySkimBps).div(10000);
        add(m, from, out.sub(skim));
        if (skim.gt(0)) add(m, m.skimTo || (m.routerKeepsSkim ? to : TOKEN), skim);
        return ok();
      }
      // sell: the wallet's tokens move to the pool, minus any skim. A step that
      // names its amount (the fake legs below) reverts when the wallet holds
      // less, exactly like a real router; the real legs sell everything held.
      if (s._sellAmount != null && get(m, from).lt(s._sellAmount)) return rev('execution reverted');
      const sent = s._sellAmount != null ? ethers.BigNumber.from(s._sellAmount) : get(m, from);
      sub(m, from, sent);
      const skim = sent.mul(m.sellSkimBps).div(10000);
      add(m, POOL, sent.sub(skim));
      if (skim.gt(0)) add(m, m.skimTo || (m.routerKeepsSkim ? to : TOKEN), skim);
      const ethKept = POOL_ETH_OUT.mul(m.ethSkimBps).div(10000);
      // WETH-paired pools settle the base side as an ERC20 transfer.
      if (m.poolHolder) {
        m.weth.set(lc(POOL), (m.weth.get(lc(POOL)) || ethers.BigNumber.from(0)).sub(POOL_ETH_OUT));
        m.weth.set(lc(WALLET), (m.weth.get(lc(WALLET)) || ethers.BigNumber.from(0)).add(POOL_ETH_OUT.sub(ethKept)));
      }
      return ok('0x', {
        transaction_info: {
          balance_diff: [
            { address: ADDR.UNIV4_POOL_MANAGER, original: '0', dirty: POOL_ETH_OUT.mul(-1).toString() },
            { address: WALLET, original: '0', dirty: POOL_ETH_OUT.sub(ethKept).toString() },
            ...(m.ethSkimTo && ethKept.gt(0) ? [{ address: m.ethSkimTo, original: '0', dirty: ethKept.toString() }] : []),
          ],
        },
      });
    }

    // --- Permit2: no-op. WETH: a real balance ledger for the v3 case ------
    if (to === lc(ADDR.PERMIT2)) return ok();
    if (to === lc(ADDR.WETH)) {
      if (data.startsWith(SIG.balanceOf)) {
        return ok(word(m.weth.get(lc(argAddr(data, 0))) || 0));
      }
      return ok();
    }

    // --- the ERC20 --------------------------------------------------------
    if (to === lc(TOKEN)) {
      if (data.startsWith(SIG.balanceOf)) return ok(word(get(m, argAddr(data, 0))));
      if (data.startsWith(SIG.allowance)) {
        const key = `${lc(argAddr(data, 0))}|${lc(argAddr(data, 1))}`;
        return ok(word(m.allow.get(key) || 0));
      }
      if (data.startsWith(SIG.approve)) {
        const spender = argAddr(data, 0);
        let amount = argUint(data, 1);
        if (m.approveCapsAt != null) amount = ethers.BigNumber.from(m.approveCapsAt);
        m.allow.set(`${lc(from)}|${lc(spender)}`, amount);
        return ok(word(1));
      }
      if (data.startsWith(SIG.transfer)) {
        const to2 = argAddr(data, 0);
        const amt = argUint(data, 1);
        if (get(m, from).lt(amt)) return rev('execution reverted: insufficient balance');
        sub(m, from, amt);
        const tax = amt.mul(m.transferTaxBps).div(10000);
        add(m, to2, amt.sub(tax));
        if (tax.gt(0)) add(m, TOKEN, tax);
        return ok(word(1));
      }
      if (data.startsWith(SIG.transferFrom)) {
        const owner = argAddr(data, 0);
        const to2 = argAddr(data, 1);
        const amt = argUint(data, 2);
        const key = `${lc(owner)}|${lc(from)}`;
        const allowed = m.allow.get(key) || ethers.BigNumber.from(0);
        const isExact = allowed.eq(amt);
        if (m.transferFromReverts) return rev('execution reverted: TRANSFER_FROM_BLOCKED');
        if (isExact && m.exactAllowanceReverts) return rev('execution reverted: SafeMath: subtraction overflow');
        if (allowed.lt(amt)) return rev('execution reverted: insufficient allowance');
        if (get(m, owner).lt(amt)) return rev('execution reverted: insufficient balance');
        sub(m, owner, amt);
        const tax = amt.mul(m.transferFromTaxBps).div(10000);
        add(m, to2, amt.sub(tax));
        if (tax.gt(0)) add(m, TOKEN, tax);
        if (!allowed.eq(ethers.constants.MaxUint256)) m.allow.set(key, allowed.sub(amt));
        return ok(word(1));
      }
    }
    return ok();
  });
}

function makeProvider() {
  const mi = new ethers.utils.Interface([
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ]);
  return {
    async getBalance() { return E(1); },
    async getGasPrice() { return ethers.utils.parseUnits('1', 'gwei'); },
    async getCode() { return '0x608004e45aaf60'; }, // SwapRouter02 selector
    async call({ data }) {
      if (data.startsWith(mi.getSighash('decimals'))) return mi.encodeFunctionResult('decimals', [18]);
      if (data.startsWith(mi.getSighash('symbol'))) return mi.encodeFunctionResult('symbol', ['TEST']);
      throw new Error('quoter/other call not stubbed'); // exercises the quoter fallback
    },
  };
}

// Each probe bundle runs against a fresh copy of the model, exactly as a real
// Tenderly bundle starts from the same forked state each time.
async function run(modelOpts) {
  MODEL_FACTORY = () => makeModel(modelOpts);
  BUNDLE_CALLS = 0;
  const r = await audit.transferAudit(TOKEN, {
    wallet: WALLET, amountEth: 0.05, prov: makeProvider(), discover: async () => pool,
  });
  return { r, calls: BUNDLE_CALLS };
}

async function runPool(p, modelOpts) {
  MODEL_FACTORY = () => makeModel(modelOpts);
  BUNDLE_CALLS = 0;
  const r = await audit.transferAudit(TOKEN, {
    wallet: WALLET, amountEth: 0.05, prov: makeProvider(), discover: async () => p,
  });
  return { r, calls: BUNDLE_CALLS };
}

async function runV3(modelOpts) {
  MODEL_FACTORY = () => { const m = makeModel(modelOpts); m.poolHolder = V3_POOL; return m; };
  BUNDLE_CALLS = 0;
  const r = await audit.transferAudit(TOKEN, {
    wallet: WALLET, amountEth: 0.05, prov: makeProvider(), discover: async () => v3pool,
  });
  return { r, calls: BUNDLE_CALLS };
}

async function main() {

// ==========================================================================
section('1. an honest token produces no findings');
// ==========================================================================
{
  const { r, calls } = await run({});
  check('the audit completed', r.ok === true, r.reason);
  check('four bundles: probe, buy, sell, transfer paths', calls === 4, String(calls));
  check('no findings at all', r.findings.length === 0, JSON.stringify(r.findings.map((f) => f.title)));
  check('the buy reconciles exactly', r.buyLeg.taxBps === 0, String(r.buyLeg.taxBps));
  check('the sell reconciles exactly', r.sellLeg.taxBps === 0, String(r.sellLeg.taxBps));
  check('the ETH side reconciles exactly', r.sellLeg.ethGapBps === 0, String(r.sellLeg.ethGapBps));
  check('both transfer paths read clean', r.paths.transfer.taxBps === 0 && r.paths.transferFrom.taxBps === 0);
  check('not flagged asymmetric', r.paths.asymmetric === false);
  check('the quoter failing is not a finding',
    r.quotedBuyWei === null && r.findings.length === 0);
}

// ==========================================================================
section('2. 5% skimmed between the pool and the wallet on the buy');
// ==========================================================================
{
  const { r } = await run({ buySkimBps: 500 });
  check('measured at exactly 5%', r.buyLeg.taxBps === 500, String(r.buyLeg.taxBps));
  check('pool paid out the full amount', r.buyLeg.poolPaidOut.eq(POOL_TOKENS_OUT));
  check('wallet received 95%', r.buyLeg.walletReceived.eq(POOL_TOKENS_OUT.mul(95).div(100)));
  check('reported as a hidden buy tax', r.findings.some((f) => /hidden buy tax of 5.00%/.test(f.title)),
    JSON.stringify(r.findings.map((f) => f.title)));
  check('the router is named as the holder', r.buyLeg.routerKept.eq(POOL_TOKENS_OUT.mul(5).div(100)));
  check('the finding says price impact cannot explain it', r.findings.some((f) => /[Pp]rice impact cannot explain/.test(f.detail)));
}

// ==========================================================================
section('3. the token contract itself absorbs the skim');
// ==========================================================================
{
  const { r } = await run({ buySkimBps: 300, routerKeepsSkim: false });
  check('still measured at 3%', r.buyLeg.taxBps === 300, String(r.buyLeg.taxBps));
  check('the token contract is named instead of the router',
    r.buyLeg.selfGained.gt(0) && r.buyLeg.routerKept.isZero());
}

// ==========================================================================
section('4. a sell-side tax');
// ==========================================================================
{
  const { r } = await run({ sellSkimBps: 1200 });
  check('measured at 12%', r.sellLeg.taxBps === 1200, String(r.sellLeg.taxBps));
  check('reported as a hidden sell tax', r.findings.some((f) => /hidden sell tax of 12.00%/.test(f.title)));
  check('the buy leg is untouched by it', r.buyLeg.taxBps === 0);
}

// ==========================================================================
section('5. ETH kept on the way out');
// ==========================================================================
{
  const { r } = await run({ ethSkimBps: 800 });
  check('the ETH gap is measured at 8%', r.sellLeg.ethGapBps === 800, String(r.sellLeg.ethGapBps));
  check('pool paid more ETH than the wallet received',
    r.sellLeg.poolPaidEth.gt(r.sellLeg.walletReceivedEth));
  check('reported', r.findings.some((f) => /ETH never reached the wallet/.test(f.title)));
  check('the token side stays clean, so the two are not confused',
    r.sellLeg.taxBps === 0 && r.buyLeg.taxBps === 0);
}

// ==========================================================================
section('6. THE ONE THAT MATTERS: transfer() clean, transferFrom() taxed');
// ==========================================================================
{
  const { r } = await run({ transferTaxBps: 0, transferFromTaxBps: 1000 });
  check('transfer() reads clean', r.paths.transfer.taxBps === 0, String(r.paths.transfer.taxBps));
  check('transferFrom() reads 10%', r.paths.transferFrom.taxBps === 1000, String(r.paths.transferFrom.taxBps));
  check('flagged asymmetric', r.paths.asymmetric === true);
  check('the exact-allowance row is measured too, not defaulted to clean',
    r.paths.exactAllowance.taxBps === 1000, String(r.paths.exactAllowance.taxBps));
  check('the finding quotes both numbers',
    r.findings.some((f) => /0\.00% vs 10\.00%/.test(f.title)),
    JSON.stringify(r.findings.map((f) => f.title)));
  check('and explains why a token would be written that way',
    r.findings.some((f) => /wallet-to-wallet check looks clean/.test(f.detail)));
}

// ==========================================================================
section('7. a symmetric tax is reported, but NOT as asymmetric');
// ==========================================================================
{
  const { r } = await run({ transferTaxBps: 500, transferFromTaxBps: 500 });
  check('both paths read 5%', r.paths.transfer.taxBps === 500 && r.paths.transferFrom.taxBps === 500);
  check('not flagged asymmetric — an honest fee-on-transfer token is not a trap',
    r.paths.asymmetric === false);
}

// ==========================================================================
section('8. transferFrom() blocked outright — the honeypot shape');
// ==========================================================================
{
  const { r } = await run({ transferFromReverts: true });
  check('transferFrom is recorded as reverted', r.paths.transferFrom.reverted === true);
  check('transfer() still works', r.paths.transfer.reverted === false);
  check('reported, and the finding says this is the DEX sell path',
    r.findings.some((f) => /transferFrom\(\) reverted/.test(f.title) && /every DEX sell uses/.test(f.detail)));
  check('the paths-disagree finding also fires', r.findings.some((f) => /one transfer path works and the other does not/.test(f.title)));
}

// ==========================================================================
section('9. exact allowance rejected, unlimited accepted');
// ==========================================================================
{
  const { r } = await run({ exactAllowanceReverts: true });
  check('unlimited-allowance transferFrom succeeds', r.paths.transferFrom.reverted === false);
  check('exact-allowance transferFrom reverts', r.paths.exactAllowance.reverted === true);
  check('reported at medium severity, not high',
    r.findings.some((f) => /exact allowance is rejected/.test(f.title) && f.severity === 'medium'));
}

// ==========================================================================
section('10. approve() silently caps the allowance');
// ==========================================================================
{
  const { r } = await run({ approveCapsAt: 1 });
  check('the allowance reads back as the cap, not the max',
    r.paths.allowance.afterMaxApprove.eq(1), String(r.paths.allowance.afterMaxApprove));
  check('maxApproveHonoured is false', r.paths.allowance.maxApproveHonoured === false);
  check('reported', r.findings.some((f) => /approve\(\) did not set the allowance/.test(f.title)));
}

// ==========================================================================
section('11. rounding noise is not reported as a tax');
// ==========================================================================
{
  // 1 bps of skim: below the NOISE_BPS floor of 2.
  const { r } = await run({ buySkimBps: 1 });
  check('the 0.01% gap is measured', r.buyLeg.taxBps === 1, String(r.buyLeg.taxBps));
  check('but not raised as a finding', r.findings.length === 0, JSON.stringify(r.findings.map((f) => f.title)));
}

// ==========================================================================
section('11b. the same audit on a Uniswap v3 pool');
// ==========================================================================
{
  const { r } = await runV3({});
  check('a v3 pool audits instead of being refused', r.ok === true, r.reason);
  check('reported as v3', r.version === 'v3');
  check('the router shape was resolved', r.routerShape === 'SwapRouter02', r.routerShape);
  check('a clean v3 token produces no findings', r.findings.length === 0,
    JSON.stringify(r.findings.map((f) => f.title)));
  check('the buy reconciles against the v3 pool contract', r.buyLeg.taxBps === 0, String(r.buyLeg.taxBps));
  check('the sell reconciles', r.sellLeg.taxBps === 0, String(r.sellLeg.taxBps));
  check('the base side is measured from WETH balances on BOTH ends',
    r.sellLeg.poolPaidEth != null && r.sellLeg.walletReceivedEth != null && r.sellLeg.ethGapBps === 0,
    JSON.stringify({ paid: String(r.sellLeg.poolPaidEth), got: String(r.sellLeg.walletReceivedEth), gap: r.sellLeg.ethGapBps }));

  const dirty = (await runV3({ buySkimBps: 500, transferFromTaxBps: 1000, ethSkimBps: 300 })).r;
  check('a v3 buy skim is measured the same way', dirty.buyLeg.taxBps === 500, String(dirty.buyLeg.taxBps));
  check('a v3 base-side skim is caught by the WETH comparison', dirty.sellLeg.ethGapBps === 300, String(dirty.sellLeg.ethGapBps));
  check('the transfer/transferFrom asymmetry is protocol-independent', dirty.paths.asymmetric === true);
}

// ==========================================================================
section('13. a v4 hook that takes a swap fee is NOT a hidden token tax');
// ==========================================================================
// The first live run (OPEN, a Pons graduate) reported "hidden buy tax 0.99%"
// and "0.99% of the ETH never reached the wallet". Both were the Pons hook's
// per-swap fee: its address carries afterSwapReturnsDelta, and the tokens and
// ETH went to it. The token's own transfers were clean.
const PONS_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const hookPool = (hooks) => ({
  ...pool, fee: 0, hooks,
  poolKey: { currency0: ADDR.ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks },
  label: 'v4 hook pool',
});
{
  const { r } = await runPool(hookPool(PONS_HOOK), { buySkimBps: 99, ethSkimBps: 99, skimTo: PONS_HOOK, ethSkimTo: PONS_HOOK });
  check('the audit completed', r.ok === true, r.reason);
  check('the hook is identified with its permissions', r.hook && r.hook.canTakeSwapFee === true && /Pons/.test(r.hook.name || ''));
  check('the hook\'s token gain is measured on the buy', r.buyLeg.hookGained && r.buyLeg.hookGained.eq(POOL_TOKENS_OUT.mul(99).div(10000)),
    r.buyLeg.hookGained && r.buyLeg.hookGained.toString());
  check('the hook\'s ETH gain is measured on the sell', r.sellLeg.hookGainedEth && r.sellLeg.hookGainedEth.eq(POOL_ETH_OUT.mul(99).div(10000)),
    r.sellLeg.hookGainedEth && r.sellLeg.hookGainedEth.toString());
  check('no high-severity finding', !r.findings.some((f) => f.severity === 'high'), JSON.stringify(r.findings.map((f) => [f.severity, f.title])));
  check('both legs reported as a hook fee', r.findings.filter((f) => f.kind === 'hookFee').length === 2,
    JSON.stringify(r.findings.map((f) => f.title)));
  check('the buy fee reads 0.99%', r.findings.some((f) => /hook takes 0.99% of each buy/.test(f.title)));
  let out = '';
  const orig = console.log; console.log = (...a) => { out += a.join(' ') + '\n'; };
  try { audit.printAudit(r); } finally { console.log = orig; }
  check('the verdict says nothing is hidden in the token', /NOTHING HIDDEN IN THE TOKEN/.test(out), out.split('\n').filter((l) => /==>/.test(l)).join(' | '));
  check('the report names where the tokens went', /to the pool's hook/.test(out));
}

// ==========================================================================
section('14. a hook WITHOUT a swap-delta permission cannot excuse a gap');
// ==========================================================================
{
  // Low bits 0x0040: afterSwap only. It can observe a swap but not change the amounts,
  // so a shortfall that lands on it is still the token's doing.
  const WATCHER = '0x0000000000000000000000000000000000010040';
  const { r } = await runPool(hookPool(WATCHER), { buySkimBps: 500, skimTo: WATCHER });
  check('the hook is read as unable to take a fee', r.hook && r.hook.canTakeSwapFee === false);
  check('the gap stays a hidden buy tax (high)', r.findings.some((f) => f.severity === 'high' && /hidden buy tax of 5.00%/.test(f.title)),
    JSON.stringify(r.findings.map((f) => [f.severity, f.title])));
}

// ==========================================================================
section('15. a fee-capable hook, but the missing tokens went somewhere else');
// ==========================================================================
{
  const { r } = await runPool(hookPool(PONS_HOOK), { buySkimBps: 300 }); // skim to the router
  check('not excused as a hook fee', !r.findings.some((f) => f.kind === 'hookFee'));
  check('flagged medium: the hook could have, but did not provably, take it',
    r.findings.some((f) => f.severity === 'medium' && /hook is allowed to take it/.test(f.title)),
    JSON.stringify(r.findings.map((f) => [f.severity, f.title])));
}

// ==========================================================================
section('16. a hook fee never hides the token\'s own behaviour');
// ==========================================================================
{
  const { r } = await runPool(hookPool(PONS_HOOK), {
    buySkimBps: 99, ethSkimBps: 99, skimTo: PONS_HOOK, ethSkimTo: PONS_HOOK, transferFromTaxBps: 1000,
  });
  check('the hook fee is still info', r.findings.some((f) => f.kind === 'hookFee'));
  check('the transferFrom-only tax is still high', r.findings.some((f) => f.severity === 'high' && /taxed differently/.test(f.title)),
    JSON.stringify(r.findings.map((f) => [f.severity, f.title])));
}

// ==========================================================================
section('17. the quoter as evidence (unit, collectFindings)');
// ==========================================================================
{
  const { hookPermissions } = require('./pool-resolve');
  const hook = hookPermissions(PONS_HOOK);
  const base = {
    hook,
    buyLeg: { taxBps: 99, missing: T(990), poolPaidOut: T(100000), walletReceived: T(99010), hookGained: null },
  };
  const a = audit.collectFindings({ ...base, quoteMatches: 'wallet' });
  check('quote == wallet received -> hook fee (info)', a.length === 1 && a[0].kind === 'hookFee' && /quoter/.test(a[0].detail),
    JSON.stringify(a));
  const b = audit.collectFindings({ ...base, quoteMatches: 'pool' });
  check('quote == pool paid out -> not excused', !b.some((f) => f.kind === 'hookFee'), JSON.stringify(b));
  const c = audit.collectFindings({ ...base, hook: null, quoteMatches: 'wallet' });
  check('no hook at all -> hidden buy tax (high)', c.some((f) => f.severity === 'high'), JSON.stringify(c));
}

// ==========================================================================
section('18. a honeypot: the buy works, the sell reverts, transfers look clean');
// ==========================================================================
// Before this fix the sell's revert was printed in the table but never became a
// finding, so this exact token ended in "NOTHING HIDDEN FOUND".
{
  const { r } = await run({ sellReverts: true });
  check('the audit completed', r.ok === true, r.reason);
  check('the sell leg recorded an error', Boolean(r.sellLeg && r.sellLeg.error));
  check('the transfer paths read clean (the trap is invisible there)', r.paths && r.paths.transferFrom.taxBps === 0 && !r.paths.transferFrom.reverted);
  check('reported HIGH: the buy works but the sell reverts',
    r.findings.some((f) => f.severity === 'high' && f.kind === 'sellReverted'), JSON.stringify(r.findings.map((f) => f.title)));
  let out = '';
  const orig = console.log; console.log = (...a) => { out += a.join(' ') + '\n'; };
  try { audit.printAudit(r); } finally { console.log = orig; }
  check('the verdict is NOT "nothing hidden"', !/NOTHING HIDDEN/.test(out) && /HIDDEN BEHAVIOUR FOUND/.test(out));
}


// ==========================================================================
section('19. pinned block (CAPA, 18 Oct): price drift between bundles is not a honeypot');
// ==========================================================================
// CAPA: the probe bought 2,631,025, the sell bundle asked for 90% (2,367,923)
// but that bundle's own buy delivered ~2,310,659 because it ran on a newer
// block. The sell reverted and read as "the buy works but the sell REVERTS".
// These fake legs make the sell carry its amount, like the real router does.
{
  const fakeLegs = async () => ({
    version: 'v4', isNative: true, baseAddr: ADDR.ZERO, poolHolder: ADDR.UNIV4_POOL_MANAGER,
    router: ADDR.UNIVERSAL_ROUTER, baseIsErc20: false, note: null,
    buySteps: ({ from, amountInWei }) => [{ from, to: ADDR.UNIVERSAL_ROUTER, input: '0x', value: amountInWei.toString() }],
    sellSteps: ({ from, amountInWei }) => [
      { from, to: ADDR.PERMIT2, input: '0x', value: '0' },
      { from, to: ADDR.UNIVERSAL_ROUTER, input: '0x', value: '0', _sellAmount: amountInWei.toString() },
    ],
  });
  const pinnedProvider = (n = 92348719) => { const pr = makeProvider(); pr.getBlockNumber = async () => n; return pr; };
  const go = async (modelOpts, opts = {}) => {
    MODEL_FACTORY = () => makeModel(modelOpts);
    BUNDLE_CALLS = 0; BUNDLE_BLOCKS = [];
    const r = await audit.transferAudit(TOKEN, { wallet: WALLET, amountEth: 0.05, prov: makeProvider(), discover: async () => pool, makeLegs: fakeLegs, ...opts });
    return { r, calls: BUNDLE_CALLS, blocks: BUNDLE_BLOCKS.slice() };
  };
  const highSell = (r) => r.findings.some((f) => f.severity === 'high' && f.kind === 'sellReverted');

  // a) the old behaviour, reproduced: unpinned + 12% drift per bundle
  const prevPin = process.env.ROUND_TRIP_PIN;
  process.env.ROUND_TRIP_PIN = '0';
  {
    const { r, calls } = await go({ driftBps: 1200 }, { prov: pinnedProvider() });
    process.env.ROUND_TRIP_PIN = prevPin === undefined ? '' : prevPin;
    if (prevPin === undefined) delete process.env.ROUND_TRIP_PIN;
    check('pin off: nothing is pinned', r.pinnedBlock == null);
    check('pin off + drift: the first sell asked for more than the wallet held', r.sellResized && /^\d+$/.test(r.sellResized.firstAskedWei) && ethers.BigNumber.from(r.sellResized.firstAskedWei).gt(r.sellResized.heldWei), JSON.stringify(r.sellResized));
    check('it retried once with a re-sized sell (5 bundles)', calls === 5, String(calls));
    check('drift kept going, so it is reported as UNMEASURED (medium) ...', r.findings.some((f) => f.severity === 'medium' && f.kind === 'sellUnmeasured'), JSON.stringify(r.findings.map((f) => [f.severity, f.title])));
    check('... and NOT as a honeypot (high)', !highSell(r));
    check('the buy drift is recorded', r.buyDriftBps === 1200, String(r.buyDriftBps));
  }

  // b) pinned (the fix): the same drifting market, every bundle on one block
  {
    const { r, calls, blocks } = await go({ driftBps: 1200 }, { prov: pinnedProvider() });
    check('pinned: the audit records its block', r.pinnedBlock === 92348719, String(r.pinnedBlock));
    check('pinned: all four bundles carry that block', calls === 4 && blocks.every((b) => b === 92348719), JSON.stringify(blocks));
    check('pinned: the sell goes through', r.sellLeg && !r.sellLeg.error, r.sellLeg && r.sellLeg.error);
    check('pinned: no findings at all', r.findings.length === 0, JSON.stringify(r.findings.map((f) => f.title)));
    check('pinned: no buy drift', r.buyDriftBps === 0, String(r.buyDriftBps));
    check('pinned: no re-size was needed', r.sellResized == null);
  }

  // c) a block passed in by the screen (Gate 3's) is used as-is
  {
    let asked = false;
    const pr = makeProvider(); pr.getBlockNumber = async () => { asked = true; return 1; };
    const { r, blocks } = await go({}, { prov: pr, pinnedBlock: 92348824 });
    check('the passed-in block is used', r.pinnedBlock === 92348824 && blocks.every((b) => b === 92348824), JSON.stringify(blocks));
    check('the chain is not asked for another block', asked === false);
  }

  // d) one unpinned bundle moved, the re-sized retry succeeds
  {
    const { r, calls } = await go({ driftBundles: { 3: 1200 } });
    check('one moved bundle: the retry measures the sell', r.sellLeg && !r.sellLeg.error && r.sellResized && r.sellResized.retryOk === true, JSON.stringify(r.sellResized));
    check('one moved bundle: 5 bundles, no findings', calls === 5 && r.findings.length === 0, `${calls} ${JSON.stringify(r.findings.map((f) => f.title))}`);
  }

  // e) a real honeypot on a pinned block is still caught (held >= asked)
  {
    const { r } = await go({ sellReverts: true }, { prov: pinnedProvider() });
    check('pinned honeypot: still HIGH "the buy works but the sell REVERTS"', highSell(r), JSON.stringify(r.findings.map((f) => [f.severity, f.title])));
    check('pinned honeypot: not mistaken for a sizing fault', r.sellLeg.oversized === false && r.sellResized == null);
  }

  // f) Tenderly refuses the pin: fall back to latest once, and say so
  {
    REFUSE_PIN = true;
    const { r, calls, blocks } = await go({}, { prov: pinnedProvider() });
    REFUSE_PIN = false;
    check('pin refused: the audit still completes', r.ok === true, r.reason);
    check('pin refused: pinFallback explains it', /refused/.test(r.pinFallback || ''), r.pinFallback);
    check('pin refused: every bundle then ran on latest', r.pinnedBlock == null && calls === 4 && blocks.every((b) => b == null), JSON.stringify(blocks));
  }
}

// ==========================================================================
section('12. the report prints for every shape');
// ==========================================================================
{
  const shapes = [];
  shapes.push((await run({})).r);
  shapes.push((await run({ buySkimBps: 500, transferFromTaxBps: 1000, ethSkimBps: 300 })).r);
  // A token whose buy reverts outright.
  MODEL_FACTORY = () => { const m = makeModel({}); m.buyReverts = true; return m; };
  shapes.push(await audit.transferAudit(TOKEN, { wallet: WALLET, prov: makeProvider(), discover: async () => pool }));

  const real = console.log;
  let printed = '';
  console.log = (...a) => { printed += a.join(' ') + '\n'; };
  let threw = null;
  try { shapes.forEach((s) => audit.printAudit(s)); } catch (e) { threw = e; }
  console.log = real;
  check('printAudit never throws', threw === null, threw && threw.message);
  check('the clean report says nothing hidden was found', /NOTHING HIDDEN FOUND/.test(printed));
  check('the clean report refuses to over-claim', /not a guarantee about the next one/.test(printed));
  // Regression guard for the bug where the exact-allowance row printed "clean"
  // while showing a shortfall, because its tax had never been computed. Scoped
  // to the transfer-path rows, whose layout is "label  sent SYM  arrived SYM  flag".
  const badRow = printed.split('\n').find((ln) => {
    if (!/^\s{2}transfer(From)?\(\)/.test(ln)) return false;
    if (!/\bclean\s*$/.test(ln)) return false;
    const nums = ln.match(/[\d,]+\.\d\d(?= TEST)/g);
    return Boolean(nums) && nums.length >= 2 && nums[0] !== nums[1];
  });
  check('no transfer row reads "clean" while showing a shortfall', !badRow, badRow);
  check('the dirty report says hidden behaviour was found', /HIDDEN BEHAVIOUR FOUND/.test(printed));
  check('a reverting buy reports as could-not-audit', /COULD NOT AUDIT/.test(printed));
  check('the reverted buy reason is carried through', /not tradable/.test(printed));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[2] === '--demo') {
  (async () => {
    const audit2 = require('./transfer-audit');
    for (const [label, opts] of [
      ['a clean token', {}],
      ['5% in, 12% out, transferFrom taxed, ETH skimmed', { buySkimBps: 500, sellSkimBps: 1200, transferTaxBps: 0, transferFromTaxBps: 1000, ethSkimBps: 300, routerKeepsSkim: false }],
    ]) {
      console.log('\n' + '#'.repeat(90) + '\n### ' + label);
      const { r } = await run(opts);
      audit2.printAudit(r);
    }
  })();
} else {
  main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
}
