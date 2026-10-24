// Offline tests for pool-resolve.js.
//
//   node test-pool-resolve.js
//
// The dangerous failure here is returning a PoolKey that is merely plausible.
// A wrong key reverts, and a revert looks exactly like a hostile token — so
// most of these tests are about the module refusing to answer.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const pr = require('./pool-resolve');
const { ADDR } = require('./config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);

const TOKEN = '0x617270Ac9A960718f6B2aE73809c07db6D3FC6e4';
const POOL_ID = '0xa24cadd9985fab26dfdcfafb6d5bdb2b3430d8c120312d438b216a13a4b1e11d';
const TOKEN2 = '0x9Ce1b7bF1657f9174B170Db304f9F211DE882eB0';
const POOL_ID2 = '0xbb7484edb0015cefc86274a2fc5e2370ff49b7d2e9588c40bfe7b3f6308366cf';

const tmpCache = path.join(__dirname, '_tmp-cache.jsonl');
function writeCache(records) {
  fs.writeFileSync(tmpCache, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

async function main() {

// ==========================================================================
section('1. the PoolKey is rebuilt from the poolId, on real pools');
// ==========================================================================
{
  // These two are real: their poolIds come straight out of the user's
  // v2-screening-data.jsonl, recorded by the old screener in September.
  const a = pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 100, hooks: ADDR.ZERO, poolId: POOL_ID });
  check('real pool #1 reconstructs', a !== null);
  check('fee 100 -> tickSpacing 1', a && a.tickSpacing === 1, a && String(a.tickSpacing));
  check('and it is marked verified', a && a.verified === true);
  check('hashing the rebuilt key reproduces the recorded poolId',
    a && pr.poolIdOf(a.poolKey).toLowerCase() === POOL_ID.toLowerCase());

  const b = pr.reconstructV4PoolKey({ tokenAddr: TOKEN2, baseAddr: ADDR.ZERO, fee: 10000, hooks: ADDR.ZERO, poolId: POOL_ID2 });
  check('real pool #2 reconstructs', b !== null);
  check('fee 10000 -> tickSpacing 200', b && b.tickSpacing === 200, b && String(b.tickSpacing));
}

// ==========================================================================
section('2. it refuses rather than guessing');
// ==========================================================================
{
  check('wrong fee -> null',
    pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 3000, hooks: ADDR.ZERO, poolId: POOL_ID }) === null);
  check('wrong hooks -> null',
    pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 100, hooks: TOKEN2, poolId: POOL_ID }) === null);
  check('wrong base currency -> null',
    pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.WETH, fee: 100, hooks: ADDR.ZERO, poolId: POOL_ID }) === null);
  check('wrong token -> null',
    pr.reconstructV4PoolKey({ tokenAddr: TOKEN2, baseAddr: ADDR.ZERO, fee: 100, hooks: ADDR.ZERO, poolId: POOL_ID }) === null);
  check('no poolId -> null',
    pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 100, hooks: ADDR.ZERO, poolId: null }) === null);
  check('no fee -> null',
    pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: null, hooks: ADDR.ZERO, poolId: POOL_ID }) === null);
}

// ==========================================================================
section('3. both currency orderings are tried');
// ==========================================================================
{
  // A synthetic pool where the TOKEN sorts below the base, so it is currency0.
  const low = '0x0000000000000000000000000000000000000abc';
  const key = { currency0: ethers.utils.getAddress(low), currency1: ADDR.WETH, fee: 500, tickSpacing: 10, hooks: ADDR.ZERO };
  const id = pr.poolIdOf(key);
  const got = pr.reconstructV4PoolKey({ tokenAddr: low, baseAddr: ADDR.WETH, fee: 500, hooks: ADDR.ZERO, poolId: id });
  check('a token that sorts first is still found', got !== null);
  check('and it is placed as currency0', got && got.poolKey.currency0.toLowerCase() === low.toLowerCase());
}

// ==========================================================================
section('4. an unusual tickSpacing is still found by search');
// ==========================================================================
{
  const key = { currency0: ADDR.ZERO, currency1: ethers.utils.getAddress(TOKEN), fee: 2500, tickSpacing: 50, hooks: ADDR.ZERO };
  const id = pr.poolIdOf(key);
  const got = pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 2500, hooks: ADDR.ZERO, poolId: id });
  check('a fee with no canonical spacing still resolves', got !== null && got.tickSpacing === 50, got && String(got.tickSpacing));
}

// ==========================================================================
section('5. reading the cache');
// ==========================================================================
{
  writeCache([
    { timestamp: '2026-09-01', tokenAddr: TOKEN, version: 'v4', base: 'ETH', fee: 100, hooks: ADDR.ZERO, poolId: POOL_ID, baseLiquidity: 1.1, tokenLiquidity: 5 },
    { timestamp: '2026-09-02', tokenAddr: TOKEN2, version: 'v4', base: 'ETH', fee: 10000, hooks: ADDR.ZERO, poolId: POOL_ID2, baseLiquidity: 2.2, tokenLiquidity: 6 },
    { timestamp: '2026-09-03', tokenAddr: TOKEN, version: 'v4', base: 'ETH', fee: 100, hooks: ADDR.ZERO, poolId: POOL_ID, baseLiquidity: 9.9, tokenLiquidity: 7 },
  ]);

  const rec = pr.readCache(TOKEN, tmpCache);
  check('the latest record wins for a token seen twice', rec && rec.baseLiquidity === 9.9, rec && String(rec.baseLiquidity));
  check('lookup is case-insensitive', pr.readCache(TOKEN.toLowerCase(), tmpCache) !== null);
  check('an unknown token returns null', pr.readCache('0x' + '11'.repeat(20), tmpCache) === null);
  check('a missing file returns null rather than throwing', pr.readCache(TOKEN, path.join(__dirname, '_nope.jsonl')) === null);

  const d = pr.descriptorFromCache(rec, ADDR);
  check('the descriptor carries a verified poolKey', d && d.poolKey && d.poolKey.tickSpacing === 1);
  check('the label says the key was verified', d && /verified against poolId/.test(d.label), d && d.label);
  check('cached reserves are carried for sell sizing', d && d.cachedBaseLiquidity === 9.9);

  // A cache record whose poolId does not match its fee cannot produce a key.
  const bad = pr.descriptorFromCache(
    { tokenAddr: TOKEN, version: 'v4', base: 'ETH', fee: 3000, hooks: ADDR.ZERO, poolId: POOL_ID }, ADDR);
  check('a cache record that fails the hash check yields null, not a guess', bad === null);

  const v3 = pr.descriptorFromCache(
    { tokenAddr: TOKEN, version: 'v3', base: 'WETH', fee: 3000, poolAddress: TOKEN2 }, ADDR);
  check('a v3 cache record becomes a v3 descriptor', v3 && v3.version === 'v3' && v3.poolAddress === TOKEN2);
  check('and needs no poolKey', v3 && v3.poolKey === undefined);
}

// ==========================================================================
section('6. resolvePool route order');
// ==========================================================================
{
  const live = { version: 'v4', tokenAddr: TOKEN, base: 'ETH', fee: 100, poolId: POOL_ID, poolKey: {}, label: 'LIVE' };

  const a = await pr.resolvePool(TOKEN, { addr: ADDR, cacheFile: tmpCache, discover: async () => live });
  check('live wins by default', a.source === 'live' && a.label === 'LIVE', `${a.source}`);

  const b = await pr.resolvePool(TOKEN, { addr: ADDR, cacheFile: tmpCache, discover: async () => live, prefer: 'cache' });
  check('--prefer-cache flips the order', b.source === 'cache', `${b.source}`);

  const c = await pr.resolvePool(TOKEN, { addr: ADDR, cacheFile: tmpCache, discover: async () => null });
  check('a live scan that finds nothing falls through to the cache', c.source === 'cache', `${c.source}`);
  check('and the fallthrough is explained', Array.isArray(c.notes) && c.notes.some((n) => /found nothing in range/.test(n)),
    JSON.stringify(c.notes));

  const d = await pr.resolvePool(TOKEN, { addr: ADDR, cacheFile: tmpCache, discover: async () => { throw new Error('rpc exploded'); } });
  check('a live scan that throws still falls through', d.source === 'cache');

  const e = await pr.resolvePool('0x' + '22'.repeat(20), { addr: ADDR, cacheFile: tmpCache, discover: async () => null });
  check('nothing anywhere -> an error object, never a half-built pool', Boolean(e.error) && !e.poolKey, JSON.stringify(e).slice(0, 80));

  // Explicit overrides everything.
  const f = await pr.resolvePool(TOKEN, { addr: ADDR, cacheFile: tmpCache, discover: async () => live, poolId: POOL_ID, fee: 100 });
  check('--pool-id takes precedence over both routes', f.source === 'explicit', f.source);
  check('and its key is verified', f.poolKey && pr.poolIdOf(f.poolKey).toLowerCase() === POOL_ID.toLowerCase());

  const g = await pr.resolvePool(TOKEN, { addr: ADDR, poolId: POOL_ID, fee: 3000 });
  check('--pool-id with the wrong fee is refused with an explanation',
    Boolean(g.error) && /does not hash back/.test(g.error), g.error && g.error.slice(0, 70));
  check('the refusal says why a guess would be dangerous',
    g.error && /look like a hostile token/.test(g.error));
}

// ==========================================================================
section('7. USDG-paired pools (the 25-token gap from the first sweep)');
// ==========================================================================
{
  // Real: straight out of v2-screening-data.jsonl, base recorded as 'USDG'.
  const T = '0x5f534974af2e51c7c1C6112113B9471bAB84eF6C';
  const ID = '0xe06f63f3bcaa29a7fce0838363f5b9a2d74eb91b3edac512cfac952408bf4285';
  const HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';

  check('config carries a USDG address', /^0x[0-9a-fA-F]{40}$/.test(ADDR.USDG || ''));
  const bi = pr.baseInfo('USDG', ADDR);
  check('baseInfo(USDG) is 6 decimals', bi && bi.baseDecimals === 6);
  check('baseInfo(ETH) is the zero sentinel, 18 decimals', pr.baseInfo('ETH', ADDR).baseAddr === ADDR.ZERO);
  check('an unknown base is refused', pr.baseInfo('DOGE', ADDR) === null);

  const a = pr.reconstructV4PoolKey({ tokenAddr: T, baseAddr: ADDR.USDG, fee: 0, hooks: HOOK, poolId: ID });
  check('a real USDG pool reconstructs', a !== null);
  check('with tickSpacing 200 and the hook in place', a && a.tickSpacing === 200 && a.poolKey.hooks === HOOK);
  check('the same pool as ETH is refused',
    pr.reconstructV4PoolKey({ tokenAddr: T, baseAddr: ADDR.ZERO, fee: 0, hooks: HOOK, poolId: ID }) === null);
  check('the same pool as WETH is refused',
    pr.reconstructV4PoolKey({ tokenAddr: T, baseAddr: ADDR.WETH, fee: 0, hooks: HOOK, poolId: ID }) === null);

  // A dynamic-fee USDG pool: fee is the 0x800000 flag, different hook.
  const dyn = pr.reconstructV4PoolKey({
    tokenAddr: '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B', baseAddr: ADDR.USDG, fee: 8388608,
    hooks: '0xc91645963A8777Fb7c57f88f0989B07Df70645c7',
    poolId: '0x6d73b7de55aa6be79e410675968c12ec35d41abc3f08b29b7527e2caab109cf5' });
  check('a dynamic-fee USDG pool reconstructs (tickSpacing 1)', dyn && dyn.tickSpacing === 1, dyn && String(dyn.tickSpacing));

  const d = pr.descriptorFromCache(
    { tokenAddr: T, version: 'v4', base: 'USDG', fee: 0, hooks: HOOK, poolId: ID, baseLiquidity: 8090 }, ADDR);
  check('a USDG cache record becomes a descriptor', d !== null);
  check('the descriptor says base USDG, 6 decimals', d && d.base === 'USDG' && d.baseDecimals === 6 && d.baseAddr === ADDR.USDG);
  check('and the label says USDG, not WETH', d && /USDG pair/.test(d.label), d && d.label);

  // An old record that mislabels the base is still proved by the hash — and
  // the descriptor reports what the hash proved, not the label.
  const mis = pr.descriptorFromCache(
    { tokenAddr: T, version: 'v4', base: 'ETH', fee: 0, hooks: HOOK, poolId: ID }, ADDR);
  check('a mislabelled base is corrected by the hash', mis && mis.base === 'USDG');

  const ex = await pr.resolvePool(T, { addr: ADDR, poolId: ID, fee: 0, hooks: HOOK, base: 'USDG' });
  check('--base USDG works on the explicit route', ex.source === 'explicit' && ex.base === 'USDG', ex.error || ex.base);
  const exBad = await pr.resolvePool(T, { addr: ADDR, poolId: ID, fee: 0, hooks: HOOK, base: 'DOGE' });
  check('--base with an unknown currency is refused', Boolean(exBad.error));
}

// ==========================================================================
section('8. tickSpacings outside the candidate list (the other 2 of 27)');
// ==========================================================================
{
  const t0 = Date.now();
  const a = pr.reconstructV4PoolKey({
    tokenAddr: '0x7dbf38976f6D3b9c529e7D9484A71898B409eE6a', baseAddr: ADDR.ZERO, fee: 9777, hooks: ADDR.ZERO,
    poolId: '0xb4535c48a18c52cd6ad8e86fe0f0e9192cb3e24c269010d4848fdfbcb7b2c9cf' });
  check('real ETH pool, fee 9777 -> tickSpacing 98', a && a.tickSpacing === 98, a && String(a.tickSpacing));

  const b = pr.reconstructV4PoolKey({
    tokenAddr: '0xfe09Fb328bE1c286B4f597eD34764b7472ae72c5', baseAddr: ADDR.ZERO, fee: 140001, hooks: ADDR.ZERO,
    poolId: '0x2bd671ae40b997e443e0a631c7947df8be2a4d7f848747d04cda202da84b49bd' });
  check('real ETH pool, fee 140001 -> tickSpacing 1400', b && b.tickSpacing === 1400, b && String(b.tickSpacing));

  const c = pr.reconstructV4PoolKey({
    tokenAddr: '0xba527c23903EFf094A987197cCD643f2da76e4Ff', baseAddr: ADDR.USDG, fee: 30000, hooks: ADDR.ZERO,
    poolId: '0x14064595ffaaee74a86fa57319d2f8bd701bfdb9273f5dc7d5593f19a58529cc' });
  check('real USDG pool, fee 30000 -> tickSpacing 600', c && c.tickSpacing === 600, c && String(c.tickSpacing));

  const top = { currency0: ADDR.ZERO, currency1: ethers.utils.getAddress(TOKEN), fee: 777, tickSpacing: 32767, hooks: ADDR.ZERO };
  const d = pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 777, hooks: ADDR.ZERO, poolId: pr.poolIdOf(top) });
  check('the maximum tickSpacing (32767) is reachable', d && d.tickSpacing === 32767, d && String(d.tickSpacing));

  // The fast path must agree with the reference encoder, or every "proof" is wrong.
  check('the fast hash loop agrees with abi.encode', d && pr.poolIdOf(d.poolKey) === pr.poolIdOf(top));

  const t1 = Date.now();
  const none = pr.reconstructV4PoolKey({ tokenAddr: TOKEN, baseAddr: ADDR.ZERO, fee: 3000, hooks: ADDR.ZERO, poolId: POOL_ID });
  const miss = Date.now() - t1;
  check('an exhaustive miss is still a refusal', none === null);
  check(`an exhaustive miss is fast enough to run in a sweep (<3s, took ${miss}ms)`, miss < 3000);
  console.log(`        (section 8 took ${Date.now() - t0}ms)`);
}

// ==========================================================================
section('9. hook permissions are read from the hook address');
// ==========================================================================
{
  const pons = pr.hookPermissions('0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044');
  check('Pons hook: beforeInitialize', pons && pons.beforeInitialize === true);
  check('Pons hook: afterSwap + afterSwapReturnsDelta', pons && pons.afterSwap && pons.afterSwapReturnsDelta);
  check('Pons hook: can take a swap fee', pons && pons.canTakeSwapFee === true);
  check('Pons hook: does NOT gate liquidity removal', pons && pons.gatesLiquidityRemoval === false);
  check('Pons hook: nothing else set', pons && pons.bits === 0x2044, pons && pons.bits.toString(16));
  check('Pons hook has a known name', /Pons/.test(pr.knownHookName('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044') || ''));
  check('the zero address is "no hook"', pr.hookPermissions(ADDR.ZERO) === null);
  check('garbage is "no hook"', pr.hookPermissions('nope') === null);
  const rm = pr.hookPermissions('0x0000000000000000000000000000000000000200');
  check('beforeRemoveLiquidity is read as gating removal', rm && rm.gatesLiquidityRemoval === true && rm.canTakeSwapFee === false);
}

fs.unlinkSync(tmpCache);
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
