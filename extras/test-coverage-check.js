// Offline tests for extras/coverage-check.js. No RPC.
//
//   node extras/test-coverage-check.js
//
// A fake chain with v3 PoolCreated / Mint and v4 Initialize / ModifyLiquidity logs, a fake
// detections.jsonl, launches.jsonl and bot log. Cases: a launch the bot logged (same), one it
// never logged (MISSED), a pool created in the 24 h lead and launched in the window, a launch
// across a bot restart, a token only in launches.jsonl, a launch logged at another block,
// liquidity after a pool's 24 h, a second pool of a launched token, a token launched before
// the lead, a launch the chain does not have (bot only), a USDG removal, the base side when
// the token sorts below WETH, a launch before the window, an RPC error, and the defaults.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const C = require('./coverage-check');
const config = require('../config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};

const T = C.topics();
const A = config.ADDR;
const PM = A.UNIV4_POOL_MANAGER;
const FACTORY = A.UNISWAP_V3_FACTORY;
const enc = (types, vals) => ethers.utils.defaultAbiCoder.encode(types, vals);
const addr = (h) => ethers.utils.getAddress(h);
const id = (n) => ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);
const pad = (a) => ethers.utils.hexZeroPad(a, 32);
const E18 = ethers.BigNumber.from(10).pow(18);
const eth = (x) => E18.mul(Math.round(x * 1000)).div(1000);
const Q96 = ethers.BigNumber.from(2).pow(96);

const T0 = 1_792_000_000;
const TTL = 24 * 3600 * 10;
const FROM = 1_000_000;                 // window start block
const TO = FROM + 200_000;              // window end block
const LEAD = FROM - TTL;
const secOf = (b) => T0 + b / 10;
const RESTART_REPLAY = FROM + 50_000;   // the restart's replay start block

const tok = (n) => addr(`0xf0000000000000000000000000000000000000${n}`);
const [tA, tB, tC, tD, tE, tF, tG, tH, tI, tJ, tK, tM, tN] = ['0a', '0b', '0c', '0d', '0e', '1f', '10', '11', '12', '13', '14', '16', '17'].map(tok);
const tL = addr('0x0000000000000000000000000000000000000f15');   // sorts below WETH: token0
const pool = (n) => addr(`0xa0000000000000000000000000000000000000${n}`);
const [pA, pB, pD, pE, pF, pG, pH1, pH2, pI, pL, pM, pN] = ['0a', '0b', '0d', '0e', '1f', '10', '11', '21', '12', '15', '16', '17'].map(pool);
const idC = id(0xc1);
const idK = id(0xb1);

let li = 0;
const created = (token, p, block) => {
  const [t0, t1] = token.toLowerCase() < A.WETH.toLowerCase() ? [token, A.WETH] : [A.WETH, token];
  return { address: FACTORY, blockNumber: block, logIndex: li++, topics: [T.poolCreated, pad(t0), pad(t1), pad('0x0bb8')], data: enc(['int24', 'address'], [60, p]) };
};
const mint = (p, block, a0, a1) => ({ address: p, blockNumber: block, logIndex: li++,
  topics: [T.mint, pad('0x01'), pad('0x00'), pad('0x10')], data: enc(['address', 'uint128', 'uint256', 'uint256'], [tok('99'), 1, a0, a1]) });
const init = (pid, block, c0, c1, sqrt) => ({ address: PM, blockNumber: block, logIndex: li++,
  topics: [T.initialize, pid, pad(c0), pad(c1)], data: enc(['uint24', 'int24', 'address', 'uint160', 'int24'], [3000, 60, A.ZERO, sqrt, 0]) });
const modify = (pid, block, lower, upper, delta) => ({ address: PM, blockNumber: block, logIndex: li++,
  topics: [T.modify, pid, pad(tok('99'))], data: enc(['int24', 'int24', 'int256', 'bytes32'], [lower, upper, delta, ethers.constants.HashZero]) });

const chain = [
  created(tA, pA, FROM + 100), mint(pA, FROM + 200, eth(1.5), 0),                  // A: same
  created(tB, pB, FROM + 300), mint(pB, FROM + 400, eth(2), 0),                    // B: MISSED
  init(idC, FROM - 5000, A.ZERO, tC, Q96), modify(idC, FROM + 5000, -600, 600, E18.mul(40)), // C: lead -> window, same
  created(tD, pD, FROM + 40_000), mint(pD, FROM + 60_000, eth(1), 0),              // D: restart
  created(tE, pE, FROM + 70_000), mint(pE, FROM + 70_100, eth(1), 0),              // E: screened
  created(tF, pF, FROM + 80_000 - 10), mint(pF, FROM + 80_000, eth(3), 0),         // F: other block
  created(tG, pG, LEAD + 10), mint(pG, FROM + 20, eth(3), 0),                      // G: after its 24 h
  created(tH, pH1, FROM + 90_000), mint(pH1, FROM + 90_100, eth(1), 0),            // H: launch on pool 1
  created(tH, pH2, FROM + 90_050), mint(pH2, FROM + 90_200, eth(5), 0),            //    pool 2 no second launch
  created(tI, pI, FROM + 95_000), mint(pI, FROM + 95_100, eth(4), 0),              // I: launched before the lead
  init(idK, FROM + 99_000, A.USDG, tK, Q96), modify(idK, FROM + 99_100, -600, 600, E18.mul(-5)), // K: removal only
  created(tL, pL, FROM + 100_000), mint(pL, FROM + 100_100, eth(9), eth(0.5)), mint(pL, FROM + 100_200, 0, eth(0.6)), // L
  created(tM, pM, LEAD + 500), mint(pM, LEAD + 600, eth(1), 0),                    // M: launch in the lead only
  created(tN, pN, FROM + 110_000), mint(pN, FROM + 110_100, eth(2), 0),            // N: screened before detections.jsonl began
];

const det = [
  { event: 'launched', block: FROM + 200, token: tA, version: 'v3', base: 'WETH', pool: pA },
  { event: 'launched', block: FROM + 5000, token: tC, version: 'v4', base: 'ETH', pool: idC },
  { event: 'launched', block: FROM + 80_005, token: tF, version: 'v3', base: 'WETH', pool: pF },
  { event: 'launched', block: FROM + 90_100, token: tH, version: 'v3', base: 'WETH', pool: pH1 },
  { event: 'launched', block: LEAD - 100, token: tI, version: 'v3', base: 'WETH', pool: pool('ee') },
  { event: 'launched', block: FROM + 150_000, token: tJ, version: 'v3', base: 'WETH', pool: pool('ff') },
  { event: 'launched', block: FROM + 100_200, token: tL, version: 'v3', base: 'WETH', pool: pL },
  { event: 'launched', block: LEAD + 600, token: tM, version: 'v3', base: 'WETH', pool: pM },
  { event: 'pool_created', knownToken: false, block: FROM + 100, token: tA, version: 'v3', base: 'WETH', pool: pA },
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
const localIso = (sec) => `${new Date((sec - 7 * 3600) * 1000).toISOString().slice(0, 19)}-07:00`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  const detections = path.join(dir, 'detections.jsonl');
  const launches = path.join(dir, 'launches.jsonl');
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(detections, det.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(launches, [...[tA, tE].map((t) => JSON.stringify({ token: t })), JSON.stringify({ token: tN, detectedAt: '2026-10-08T00:06:40-06:00' })].join('\n') + '\n');
  const startSec = secOf(RESTART_REPLAY) + 900;
  fs.writeFileSync(path.join(logsDir, 'watch-x.txt'), `watch-launches — Robinhood Chain 4663 — ${localIso(startSec)}\nReplaying...\n`);
  fs.writeFileSync(path.join(logsDir, 'watch-old.txt'), `watch-launches — Robinhood Chain 4663 — ${localIso(T0 - 10 * 86400)}\n`);

  console.log('coverage-check');
  const starts = C.botStarts(logsDir);
  check('bot start read from the log\'s first line (local time with offset)', starts.some((s) => s.startSec === startSec), JSON.stringify(starts));

  const lines = [];
  const r = await C.main({
    opts: { fromSec: secOf(FROM), toSec: secOf(TO), minEth: 1, minUsdg: 1000, replaySec: 900, detections, launches, logsDir, concurrency: 3, outDir: dir },
    log: (s) => lines.push(s), getLogs,
    blockAtTime: async (sec) => Math.round((sec - T0) * 10),
    blockTime: async (n) => Math.floor(secOf(n)),
    head: TO + 1000,
  });
  const cls = Object.fromEntries(r.rows.map((x) => [x.token, x.cls]));
  check('window blocks', r.fromBlock === FROM && r.toBlock === TO && r.lead === LEAD, `${r.fromBlock} ${r.toBlock} ${r.lead}`);
  check('A: logged by the bot -> same', cls[tA] === 'same', cls[tA]);
  check('B: not logged anywhere -> MISSED', cls[tB] === 'MISSED', cls[tB]);
  check('C: v4 pool created in the lead, launched in the window -> same', cls[tC] === 'same', cls[tC]);
  check('D: waiting across the restart -> restart', cls[tD] === 'restart', cls[tD]);
  check('E: only in launches.jsonl -> screened', cls[tE] === 'screened', cls[tE]);
  check('F: bot logged 5 blocks later -> other block', cls[tF] === 'other block', cls[tF]);
  check('G: liquidity after the pool\'s 24 h -> no launch', !(tG in cls));
  check('H: one launch for two pools, on the first pool', cls[tH] === 'same' && r.rows.filter((x) => x.token === tH).length === 1);
  check('I: token launched before the lead -> ignored', !(tI in cls));
  check('J: bot launch the chain does not have -> bot only', cls[tJ] === 'bot only', cls[tJ]);
  check('K: a USDG removal does not count', !(tK in cls));
  check('L: token sorts below WETH -> base is amount1 (0.5 + 0.6)', cls[tL] === 'same', cls[tL]);
  check('M: launch before the window is not listed (chain or bot)', !(tM in cls));
  check('N: screened before the lead (launches.jsonl) -> later pool is not a launch', !(tN in cls));
  check('M: but the replay found it in the lead', r.launches.some((x) => x.token === tM && x.launchBlock === LEAD + 600));
  check('summary counts', JSON.stringify(r.summary) === JSON.stringify({ chain: 8, same: 4, 'other block': 1, restart: 1, screened: 1, MISSED: 1, 'bot only': 1 }), JSON.stringify(r.summary));
  check('getLogs chunked (10k-block ranges over lead + window)', calls > 200, calls);
  check('summary line printed', lines.some((l) => /MISSED:\s+1$/.test(l)), lines.join(' | '));
  const csv = fs.readdirSync(dir).filter((f) => f.startsWith('coverage-'));
  check('CSV written, one line per row', csv.length === 1 && fs.readFileSync(path.join(dir, csv[0]), 'utf8').trim().split('\n').length === 1 + r.rows.length, csv.join(','));

  // an RPC error must stop the run, never be read as "no events"
  let threw = false;
  try {
    await C.main({
      opts: { fromSec: secOf(FROM), toSec: secOf(TO), minEth: 1, minUsdg: 1000, replaySec: 900, detections, launches, logsDir, concurrency: 2, outDir: dir },
      log: () => {}, getLogs: async (f) => { if (f.fromBlock > FROM) throw new Error('missing response'); return getLogs(f); },
      blockAtTime: async (sec) => Math.round((sec - T0) * 10), blockTime: async (n) => Math.floor(secOf(n)), head: TO + 1000,
    });
  } catch (e) { threw = /missing response/.test(e.message); }
  check('an RPC error stops the run (no silent gap)', threw);

  const d = C.parseArgs([], 2_000_000_000);
  check('default window: the 24 h ending 30 min ago', d.toSec === 2_000_000_000 - 1800 && d.fromSec === d.toSec - 86400);
  const e = C.parseArgs(['--from', '2026-11-15T06:10:00Z', '--to', '2026-11-16T05:00:00Z']);
  check('--from / --to read as UTC', isoOf(e.fromSec) === '2026-11-15T06:10:00Z' && isoOf(e.toSec) === '2026-11-16T05:00:00Z');
  let bad = false; try { C.parseArgs(['--from', '2026-11-16T00:00:00Z', '--to', '2026-11-15T00:00:00Z']); } catch (_) { bad = true; }
  check('--from after --to is refused', bad);

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

function isoOf(sec) { return new Date(sec * 1000).toISOString().replace('.000Z', 'Z'); }
