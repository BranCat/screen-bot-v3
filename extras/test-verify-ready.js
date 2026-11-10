// Offline tests for extras/verify-ready.js. No RPC, no explorer.
//
//   node extras/test-verify-ready.js
//
// A fake chain (block n at T0 + n/10 s) with v4 PoolManager and v3 pool logs. Cases:
// code first that agrees, trades first that agrees (with trades before the code),
// a trade before the bot's launch block, a wrongly recorded time, a v3 pool, a token
// with no pool, and the chunking of getLogs. Since 2026-11-10 also the explorer time
// checked against the bot's checks, Sourcify, the narrower flags, --days and history.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const V = require('./verify-ready');
const config = require('../config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};

const T0 = 1_792_000_000;
const tOf = (n) => T0 + Math.floor(n / 10);
const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
const T = V.topics();
const PM = config.ADDR.UNIV4_POOL_MANAGER;
const id = (k) => ethers.utils.hexZeroPad(ethers.utils.hexlify(k), 32);
const enc = (types, vals) => ethers.utils.defaultAbiCoder.encode(types, vals);

// logs: address -> list of {topics, data, blockNumber, logIndex}
const LOGS = [];
const v4log = (kind, pid, block, delta = 1000) => {
  const t = T.v4[kind];
  const data = kind === 'liq' ? enc(['int24', 'int24', 'int256', 'bytes32'], [-100, 100, delta, ethers.constants.HashZero])
    : kind === 'swap' ? enc(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], [1, -1, 1, 1, 0, 0]) : '0x';
  LOGS.push({ address: PM, topics: [t, pid, ethers.constants.HashZero], data, blockNumber: block, logIndex: 0 });
};
const v3log = (kind, addr, block) => LOGS.push({ address: addr, topics: [T.v3[kind]], data: '0x', blockNumber: block, logIndex: 0 });
let calls = 0; let maxRange = 0;
const getLogs = async (f) => {
  calls += 1; maxRange = Math.max(maxRange, f.toBlock - f.fromBlock + 1);
  return LOGS.filter((l) => lc(l.address) === lc(f.address) && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock
    && (Array.isArray(f.topics[0]) ? f.topics[0].includes(l.topics[0]) : true)
    && (f.topics[1] == null || l.topics[1] === f.topics[1]));
};
const lc = (a) => String(a || '').toLowerCase();
const blockTime = async (n) => tOf(n);

const L = 1_000_000; const live = tOf(L);
const screen = (pool) => ({ record: {}, detail: { pool, source: {} } });
const v4pool = (k) => ({ version: 'v4', poolId: id(k) });
const rec = (o) => ({ symbol: o.sym, token: o.token, verdict: 'SNIP', case: o.case, launch_block: L, tradable_utc: o.tradable, code_published_utc: o.code || '', date: '2026-11-09', time: '000000' });
const explorer = {};
const get = async (addr) => (explorer[lc(addr)] ? { status: 200, json: { is_verified: true, verified_at: explorer[lc(addr)] } } : { status: 404 });
const base = { getLogs, blockTime, head: L + 2_000_000, get, ADDR: config.ADDR, T, backSec: 6 * 3600, tol: 2 };

(async () => {
  console.log('\ncode first, agrees');
  // pool created 10 min before, liquidity at L, first swap 2 s after; code verified 1 h before
  v4log('init', id(1), L - 6000); v4log('liq', id(1), L); v4log('swap', id(1), L + 20);
  explorer[lc('0x' + '1'.repeat(40))] = iso(live - 3600);
  let r = await V.verifyOne(rec({ sym: 'A', token: '0x' + '1'.repeat(40), case: 'code first', tradable: iso(live) }), screen(v4pool(1)), base);
  check('AGREES, diff 0', r.result === 'AGREES' && r.diff_s === 0, `${r.result} ${r.diff_s} ${r.reason}`);
  check('pool created 10 min before launch', r.pool_created_utc === iso(live - 600));
  check('first swap 2 s after launch', r.first_swap_utc === iso(live + 2));

  console.log('\ntrades first, agrees (trades before the code are not flagged)');
  v4log('init', id(2), L - 100); v4log('liq', id(2), L); v4log('swap', id(2), L + 50); v4log('swap', id(2), L + 4000);
  explorer[lc('0x' + '2'.repeat(40))] = iso(live + 300); // code 5 min after launch
  r = await V.verifyOne(rec({ sym: 'B', token: '0x' + '2'.repeat(40), case: 'trades first', tradable: iso(live + 300) }), screen(v4pool(2)), base);
  check('AGREES, diff 0', r.result === 'AGREES' && r.diff_s === 0, `${r.result} ${r.diff_s} ${r.reason}`);
  check('first swap (before code) reported', r.first_swap_utc === iso(live + 5));
  check('first swap after code = +400 s', r.first_swap_after_code_utc === iso(live + 400), r.first_swap_after_code_utc);

  console.log('\ntrade before the bot\'s launch block');
  v4log('init', id(3), L - 5000); v4log('liq', id(3), L - 3000, 10); v4log('swap', id(3), L - 2000); v4log('liq', id(3), L);
  explorer[lc('0x' + '3'.repeat(40))] = iso(live - 7200);
  r = await V.verifyOne(rec({ sym: 'C', token: '0x' + '3'.repeat(40), case: 'code first', tradable: iso(live) }), screen(v4pool(3)), base);
  check('CHECK, trade 200 s before launch block named', r.result === 'CHECK' && /trade 200 s before/.test(r.reason), r.reason);
  check('first liquidity 300 s before named', /first liquidity 300 s before/.test(r.reason), r.reason);

  console.log('\nwrongly recorded time');
  v4log('init', id(4), L - 10); v4log('liq', id(4), L); v4log('swap', id(4), L + 5);
  explorer[lc('0x' + '4'.repeat(40))] = iso(live - 60);
  r = await V.verifyOne(rec({ sym: 'D', token: '0x' + '4'.repeat(40), case: 'code first', tradable: iso(live + 45) }), screen(v4pool(4)), base);
  check('CHECK, recorded 45 s later', r.result === 'CHECK' && r.diff_s === 45 && /later than the chain by 45 s/.test(r.reason), `${r.diff_s} ${r.reason}`);

  console.log('\nremoved liquidity is not "first liquidity"');
  v4log('init', id(5), L - 10); v4log('liq', id(5), L - 500, -5); v4log('liq', id(5), L);
  explorer[lc('0x' + '5'.repeat(40))] = iso(live - 60);
  r = await V.verifyOne(rec({ sym: 'E', token: '0x' + '5'.repeat(40), case: 'code first', tradable: iso(live) }), screen(v4pool(5)), base);
  check('negative ModifyLiquidity ignored', r.first_liquidity_utc === iso(live) && r.result === 'AGREES', `${r.first_liquidity_utc} ${r.reason}`);

  console.log('\nv3 pool');
  const P3 = '0x' + '9'.repeat(40);
  v3log('init', P3, L - 30); v3log('liq', P3, L); v3log('swap', P3, L + 10);
  explorer[lc('0x' + '6'.repeat(40))] = iso(live - 60);
  r = await V.verifyOne(rec({ sym: 'F', token: '0x' + '6'.repeat(40), case: 'code first', tradable: iso(live) }), screen({ version: 'v3', poolAddress: P3 }), base);
  check('v3 events read, AGREES', r.result === 'AGREES' && r.pool_created_utc === iso(live - 3) && r.first_swap_utc === iso(live + 1), `${r.result} ${r.reason}`);

  console.log('\nincomplete and explorer fallback');
  r = await V.verifyOne(rec({ sym: 'G', token: '0x' + '7'.repeat(40), case: 'code first', tradable: iso(live) }), screen(null), base);
  check('no pool -> INCOMPLETE', r.result === 'INCOMPLETE' && /no pool/.test(r.reason));
  v4log('init', id(8), L - 10); v4log('liq', id(8), L);
  r = await V.verifyOne(rec({ sym: 'H', token: '0x' + '8'.repeat(40), case: 'code first', tradable: iso(live), code: iso(live - 99) }), screen(v4pool(8)), base);
  check('explorer 404 -> record code time used, said so', r.result === 'AGREES' && /code time from the record/.test(r.reason), r.reason);

  console.log('\nchunking');
  check('getLogs never asked for more than 10,000 blocks', maxRange <= 10000, `${maxRange}`);
  check('stops early once a swap after launch and code is found (code-first A: few calls)', calls < 200, `${calls}`);

  console.log('\nmain + sample picks both cases');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const ready = path.join(dir, 'rt.jsonl');
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push({ ...rec({ sym: `C${i}`, token: '0x' + '1'.repeat(40), case: 'code first', tradable: iso(live) }) });
  for (let i = 0; i < 6; i += 1) rows.push({ ...rec({ sym: `T${i}`, token: '0x' + '2'.repeat(40), case: 'trades first', tradable: iso(live + 300) }) });
  fs.writeFileSync(ready, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const picked = V.pick(rows, { sample: 4, verdicts: ['SNIP'], seed: 7 });
  check('sample of 4 = 2 code first + 2 trades first', picked.filter((x) => x.case === 'code first').length === 2 && picked.filter((x) => x.case === 'trades first').length === 2);
  const lines = [];
  const out = await V.main({ opts: { sample: 4, verdicts: ['SNIP'], seed: 7, backSec: 3600, tol: 2, out: path.join(dir, 'v'), ready }, screensDir: path.join(dir, 'none'), config, T, getLogs, blockTime, head: L + 2_000_000, get, log: (l) => lines.push(l) });
  check('main runs; no screen files -> INCOMPLETE, csv written', out.length === 4 && out.every((x) => x.result === 'INCOMPLETE') && fs.existsSync(path.join(dir, 'v.csv')));
  check('summary line printed', /verify-ready: 0 agree, 0 to check, 4 incomplete; explorer time corrected for 0/.test(lines[lines.length - 1]), lines[lines.length - 1]);

  console.log('\n2026-11-10: explorer time vs the bot\'s checks, Sourcify, false flags (real cases)');
  const SCHED = [30, 300, 1800, 7200, 86400];
  const local = (sec) => new Date(sec * 1000).toISOString();
  const screenR = (pool, record) => ({ record, detail: { pool, source: {} } });
  const fed = (found) => ({ hiddenAtLaunch: true, schedule: SCHED, feed: { everySec: 60, lookups: 1 }, foundAfterSec: found, foundBy: 'feed' });
  // AGENTDOM: explorer says verified 448 s before the pool; the bot's checks say not before +913
  v4log('init', id(11), L - 100); v4log('liq', id(11), L); v4log('swap', id(11), L + 10); v4log('swap', id(11), L + 9500);
  explorer[lc('0x' + 'b1'.repeat(20))] = iso(live - 448);
  r = await V.verifyOne(rec({ sym: 'AGENTDOM', token: '0x' + 'b1'.repeat(20), case: 'trades first', tradable: iso(live + 913) }),
    screenR(v4pool(11), { sourceHidden: false, detectedAt: local(live + 2), sourceRecheck: fed(971) }), base);
  check('AGENTDOM: AGREES with the corrected time, diff 0', r.result === 'AGREES' && r.diff_s === 0, `${r.result} ${r.diff_s} ${r.reason}`);
  check('AGENTDOM: explorer early by 1361 s, said so, explorer time kept', r.explorer_early_s === 1361 && /explorer time 1361 s early/.test(r.reason) && r.code_explorer_utc === iso(live - 448), r.reason);
  // pSQD: code first, the bot saw the code (Sourcify) 160 s before Blockscout's stamp
  v4log('init', id(12), L - 10); v4log('liq', id(12), L); v4log('swap', id(12), L + 30);
  explorer[lc('0x' + 'b2'.repeat(20))] = iso(live + 161);
  r = await V.verifyOne(rec({ sym: 'pSQD', token: '0x' + 'b2'.repeat(20), case: 'code first', tradable: iso(live + 1) }),
    screenR(v4pool(12), { sourceHidden: false, detectedAt: local(live + 1), sourceRecheck: null }), base);
  check('pSQD: Sourcify time accepted, AGREES', r.result === 'AGREES' && r.diff_s === 0 && /Sourcify/.test(r.reason), `${r.result} ${r.diff_s} ${r.reason}`);
  // BPCATE: a trade 51 s before the launch block, but the code came 5 min after launch
  v4log('init', id(13), L - 1000); v4log('liq', id(13), L - 600, 5); v4log('swap', id(13), L - 510); v4log('liq', id(13), L); v4log('swap', id(13), L + 3100);
  explorer[lc('0x' + 'b3'.repeat(20))] = iso(live + 305);
  r = await V.verifyOne(rec({ sym: 'BPCATE', token: '0x' + 'b3'.repeat(20), case: 'trades first', tradable: iso(live + 305) }),
    screenR(v4pool(13), { sourceHidden: false, detectedAt: local(live), sourceRecheck: fed(320) }), base);
  check('BPCATE: trade before launch but before the code -> not flagged, AGREES', r.result === 'AGREES' && /51 s before the launch block, before the code/.test(r.reason), `${r.result} ${r.reason}`);
  // "p" token: liquidity 2000 s before the launch block, nobody traded until launch
  v4log('init', id(14), L - 30000); v4log('liq', id(14), L - 20000, 5); v4log('liq', id(14), L); v4log('swap', id(14), L + 5);
  explorer[lc('0x' + 'b4'.repeat(20))] = iso(live - 3600);
  r = await V.verifyOne(rec({ sym: 'pDOS', token: '0x' + 'b4'.repeat(20), case: 'code first', tradable: iso(live) }),
    screenR(v4pool(14), { sourceHidden: false, detectedAt: local(live + 1) }), base);
  check('p token: liquidity alone before launch is reported, not flagged', r.result === 'AGREES' && /first liquidity 2000 s before/.test(r.reason), `${r.result} ${r.reason}`);

  console.log('\n--days and the history file');
  const dRows = [{ date: '2026-11-08', time: '1', tradable_utc: 'x', verdict: 'SNIP' }, { date: '2026-11-10', time: '2', tradable_utc: 'x', verdict: 'SNIP' }];
  check('--days 1 keeps only the last day', V.pick(dRows, { days: 1, verdicts: ['SNIP'], nowMs: Date.parse('2026-11-10T12:00:00Z') }).length === 1);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'verify2-'));
  const ready2 = path.join(dir2, 'rt.jsonl');
  const r2 = [rec({ sym: 'X1', token: '0x' + 'c1'.repeat(20), case: 'code first', tradable: iso(live) }), { ...rec({ sym: 'X2', token: '0x' + 'c2'.repeat(20), case: 'code first', tradable: iso(live) }), time: '000001' }];
  fs.writeFileSync(ready2, r2.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const o2 = { since: '2026-11-01', verdicts: ['SNIP'], backSec: 3600, tol: 2, out: path.join(dir2, 'v'), ready: ready2 };
  await V.main({ opts: o2, screensDir: path.join(dir2, 'none'), config, T, getLogs, blockTime, head: L + 2_000_000, get, log: () => {} });
  await V.main({ opts: { ...o2, tokens: ['0x' + 'c1'.repeat(20)] }, screensDir: path.join(dir2, 'none'), config, T, getLogs, blockTime, head: L + 2_000_000, get, log: () => {} });
  const histRows = fs.readFileSync(path.join(dir2, 'v-all.csv'), 'utf8').trim().split('\n');
  check('history: two runs, one row per token (header + 2)', histRows.length === 3, `${histRows.length}`);
  check('history has first liquidity and first trade columns', /first_liquidity_utc/.test(histRows[0]) && /first_swap_utc/.test(histRows[0]));

  console.log(failures ? `\ntest-verify-ready: ${failures} FAILED` : '\ntest-verify-ready: all checks passed');
  process.exit(failures ? 1 : 0);
})();
