// Offline tests for extras/restart-gap-check.js. No RPC.
//
//   node extras/test-restart-gap-check.js
//
// A fake chain with v3 Mint and v4 Initialize / ModifyLiquidity logs, and a fake
// detections.jsonl. Cases: a v3 pool that reaches the minimum after the restart
// (MISSED), one already launched, one created inside the replay, one already past
// its 24 h, one that reaches the minimum only after its 24 h, a v4 ETH pool whose
// token was screened anyway, a v4 USDG pool with only a removal, liquidity counted
// before the replay start, and getLogs chunking.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const G = require('./restart-gap-check');
const config = require('../config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};

const T = G.topics();
const PM = config.ADDR.UNIV4_POOL_MANAGER;
const A = config.ADDR;
const enc = (types, vals) => ethers.utils.defaultAbiCoder.encode(types, vals);
const addr = (n) => ethers.utils.getAddress(ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 20));
const id = (n) => ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);
const E18 = ethers.BigNumber.from(10).pow(18);
const eth = (x) => E18.mul(Math.round(x * 1000)).div(1000);

const T0 = 1_792_000_000;
const tOf = (n) => T0 + Math.floor(n / 10);
const REPLAY = 2_000_000;                 // replay start block
const RESTART = tOf(REPLAY) + 900;
const TTL = 24 * 3600 * 10;

// tokens: high addresses so the token sorts after WETH? WETH is 0x0Bd7..., USDG 0x5fc5...
const tokA = addr('0xf000000000000000000000000000000000000001'); // > WETH: token is token1, ETH amount = amount0
const tokB = addr('0xf000000000000000000000000000000000000002');
const tokC = addr('0xf000000000000000000000000000000000000003');
const tokD = addr('0xf000000000000000000000000000000000000004');
const tokE = addr('0xf000000000000000000000000000000000000005');
const tokF = addr('0x0000000000000000000000000000000000000f06'); // < WETH: token is token0, ETH amount = amount1
const tokG = addr('0xf000000000000000000000000000000000000007');
const poolA = addr('0xa0000000000000000000000000000000000000a1');
const poolB = addr('0xa0000000000000000000000000000000000000b1');
const poolD = addr('0xa0000000000000000000000000000000000000d1');
const poolE = addr('0xa0000000000000000000000000000000000000e1');
const poolF = addr('0xa0000000000000000000000000000000000000f1');
const idC = id(0xc1);
const idG = id(0x71);

const det = [
  { event: 'pool_created', knownToken: false, block: REPLAY - 5000, token: tokA, version: 'v3', base: 'WETH', pool: poolA },
  { event: 'liquidity', block: REPLAY - 4000, token: tokA, pool: poolA, base: 'WETH', added: 0.4, total: 0.4, minimum: 1 },
  { event: 'pool_created', knownToken: false, block: REPLAY - 6000, token: tokB, version: 'v3', base: 'WETH', pool: poolB },
  { event: 'launched', block: REPLAY - 3000, token: tokB, version: 'v3', base: 'WETH', pool: poolB },
  { event: 'pool_created', knownToken: false, block: REPLAY - 7000, token: tokC, version: 'v4', base: 'ETH', pool: idC },
  { event: 'pool_created', knownToken: false, block: REPLAY + 100, token: tokD, version: 'v3', base: 'WETH', pool: poolD },
  { event: 'pool_created', knownToken: false, block: REPLAY - TTL - 10, token: tokE, version: 'v3', base: 'WETH', pool: poolE },
  { event: 'pool_created', knownToken: false, block: REPLAY - 8000, token: tokF, version: 'v3', base: 'WETH', pool: poolF },
  { event: 'pool_created', knownToken: false, block: REPLAY - 9000, token: tokG, version: 'v4', base: 'USDG', pool: idG },
];

const mint = (pool, block, a0, a1) => ({ address: pool, blockNumber: block, logIndex: 0,
  topics: [T.mint, ethers.utils.hexZeroPad('0x01', 32), ethers.utils.hexZeroPad('0x00', 32), ethers.utils.hexZeroPad('0x10', 32)],
  data: enc(['address', 'uint128', 'uint256', 'uint256'], [addr(9), 1, a0, a1]) });
const modify = (pid, block, lower, upper, delta) => ({ address: PM, blockNumber: block, logIndex: 1,
  topics: [T.modify, pid, ethers.utils.hexZeroPad(addr(9), 32)],
  data: enc(['int24', 'int24', 'int256', 'bytes32'], [lower, upper, delta, ethers.constants.HashZero]) });
const init = (pid, block, c0, c1, sqrt) => ({ address: PM, blockNumber: block, logIndex: 0,
  topics: [T.initialize, pid, ethers.utils.hexZeroPad(c0, 32), ethers.utils.hexZeroPad(c1, 32)],
  data: enc(['uint24', 'int24', 'address', 'uint160', 'int24'], [3000, 60, A.ZERO, sqrt, 0]) });

const Q96 = ethers.BigNumber.from(2).pow(96);
const chain = [
  mint(poolA, REPLAY - 4000, eth(0.4), 0),          // already counted in detections (before replay)
  mint(poolA, REPLAY + 25_000, eth(0.7), 1000),     // token is token1 -> ETH is amount0: 0.4 + 0.7 >= 1
  mint(poolF, REPLAY - 8000 + TTL + 5, 0, eth(5)),  // after F's 24 h: ignored
  mint(poolF, REPLAY + 50, eth(9), eth(0.2)),       // token is token0 -> ETH is amount1 = 0.2 only
  init(idC, REPLAY - 7000, A.ZERO, tokC, Q96),      // price 1
  modify(idC, REPLAY + 15_000, -600, 600, E18.mul(40)), // ~1.17 ETH each side at price 1
  modify(idG, REPLAY + 200, -600, 600, E18.mul(-5)),    // a removal only
];

let calls = 0;
const getLogs = async (f) => {
  calls += 1;
  const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map((x) => x.toLowerCase());
  return chain.filter((l) => {
    if (l.blockNumber < f.fromBlock || l.blockNumber > f.toBlock) return false;
    if (!addrs.includes(l.address.toLowerCase())) return false;
    return f.topics.every((t, i) => t == null || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(l.topics[i].toLowerCase()) : t.toLowerCase() === l.topics[i].toLowerCase()));
  });
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
  const detections = path.join(dir, 'detections.jsonl');
  const launches = path.join(dir, 'launches.jsonl');
  fs.writeFileSync(detections, det.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(launches, JSON.stringify({ token: tokC, verdict: 'DO NOT SNIP (Gate 1b)' }) + '\n');
  const lines = [];
  const r = await G.main({
    opts: { restartSec: RESTART, replaySec: 900, minEth: 1, minUsdg: 1000, detections, launches, concurrency: 3, outDir: dir },
    log: (s) => lines.push(s),
    getLogs,
    blockAtTime: async (sec) => (sec - T0) * 10,
    blockTime: async (n) => tOf(n),
    head: REPLAY + TTL + 100_000,
  });

  console.log('restart-gap-check');
  check('replay start block from restart - 15 min', r.replayBlock === REPLAY, r.replayBlock);
  const keys = r.pools.map((p) => p.token).sort();
  check('dropped = A, C, F, G (not launched B, replayed D, expired E)', JSON.stringify(keys) === JSON.stringify([tokA, tokC, tokF, tokG].sort()), keys.join(' '));
  check('A counted 0.4 from detections before the replay', r.pools.find((p) => p.token === tokA).before === 0.4);
  const got = Object.fromEntries(r.reached.map((x) => [x.token, x]));
  check('A reached the minimum (0.4 + 0.7)', got[tokA] && Math.abs(got[tokA].total - 1.1) < 1e-9, got[tokA] && got[tokA].total);
  check('A is MISSED', got[tokA] && got[tokA].screened === false);
  check('A reached at the right block', got[tokA] && got[tokA].reachedBlock === REPLAY + 25_000);
  check('C (v4 native ETH) reached the minimum', !!got[tokC], JSON.stringify(Object.keys(got)));
  check('C screened anyway (in launches.jsonl)', got[tokC] && got[tokC].screened === true);
  check('F: base side is amount1 when the token sorts first, and later mints are past 24 h', !got[tokF]);
  check('G: a removal does not count', !got[tokG]);
  check('only A is MISSED', r.missed.length === 1 && r.missed[0].token === tokA);
  check('getLogs chunked (many 10k-block ranges)', calls > 100, calls);
  const csv = fs.readdirSync(dir).filter((f) => f.startsWith('gap-'));
  check('CSV written', csv.length === 1 && fs.readFileSync(path.join(dir, csv[0]), 'utf8').split('\n').length === 4, csv.join(','));
  check('summary line', lines.some((l) => /MISSED: 1\./.test(l)), lines.join(' | '));

  // a pool with no Initialize log found is skipped, not a crash
  const r2 = await G.main({
    opts: { restartSec: RESTART, replaySec: 900, minEth: 1, minUsdg: 1000, detections, launches, concurrency: 2, outDir: dir },
    log: () => {}, getLogs: async (f) => (f.topics[0] === T.initialize ? [] : getLogs(f)),
    blockAtTime: async (sec) => (sec - T0) * 10, blockTime: async (n) => tOf(n), head: REPLAY + TTL + 100_000,
  });
  check('missing Initialize: v4 pool skipped, v3 still found', r2.reached.length === 1 && r2.reached[0].token === tokA);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
