// Offline tests for extras/ready-times.js. No RPC, no explorer.
//
//   node extras/test-ready-times.js
//
// A fake chain (block n at T0 + n/10 s) and a fake explorer. Checks the two cases,
// the "earlier of explorer and bot" rule, proxies, explorer failures, the 402 stop,
// selection by verdict/gate, and that a rerun adds nothing. Since 2026-11-10 also the
// explorer time checked against the bot's own checks (real cases), and --show.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./ready-times');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};

const T0 = 1_792_000_000;
const blockTime = async (n) => T0 + Math.floor(n / 10);
const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
const local = (sec) => new Date(sec * 1000).toISOString(); // detectedAt/screenedAt as the bot writes them (any offset parses)

function screen({ sym, token, verdict = 'SNIP', gate = null, launchBlock, detected, marked, hidden = false, foundAfterSec = null, subject = null }) {
  return {
    record: {
      symbol: sym, token, verdict, gate, launchBlock, sourceHidden: hidden && foundAfterSec == null,
      detectedAt: local(detected), screenedAt: local(marked),
      // as the bot writes it: a found token's final file says sourceHidden false, hiddenAtLaunch true
      sourceRecheck: hidden ? (foundAfterSec != null ? { hiddenAtLaunch: true, foundAfterSec, foundBy: 'feed' } : { hiddenAtLaunch: true, gaveUpAfterSec: 86400 }) : null,
    },
    detail: { source: { verificationSubject: subject || token } },
  };
}

const A = '0x' + 'a'.repeat(40); const B = '0x' + 'b'.repeat(40); const C = '0x' + 'c'.repeat(40);
const D = '0x' + 'd'.repeat(40); const E = '0x' + 'e'.repeat(40); const IMPL = '0x' + '1'.repeat(40);
const F = '0x' + 'f'.repeat(40);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-'));
  const sdir = path.join(dir, 'screens', '2026-11-05');
  fs.mkdirSync(sdir, { recursive: true });
  const put = (time, s) => fs.writeFileSync(path.join(sdir, `${time}_${s.record.symbol}_${s.record.token}.json`), JSON.stringify(s));

  const L = 10000; const launch = T0 + 1000; // block 10000 -> T0+1000
  // 1. code first: verified 1 h before launch; bot marks 57 s after launch
  put('100000', screen({ sym: 'CODEFIRST', token: A, launchBlock: L, detected: launch + 2, marked: launch + 57 }));
  // 2. trades first: feed found it 25 s after detection; explorer stamp 20 s after launch
  put('100100', screen({ sym: 'TRADES', token: B, launchBlock: L, detected: launch + 1, marked: launch + 60, hidden: true, foundAfterSec: 25 }));
  // 3. code first, explorer stamp later than the bot saw it (twin match) -> bot time used
  put('100200', screen({ sym: 'TWIN', token: C, launchBlock: L, detected: launch + 3, marked: launch + 50 }));
  // 4. proxy: explorer asked about the implementation
  put('100300', screen({ sym: 'PROXY', token: D, launchBlock: L, detected: launch + 2, marked: launch + 40, subject: IMPL }));
  // 5. gate 6 reject, explorer fails -> falls back to the bot's observation
  put('100400', screen({ sym: 'G6', token: E, verdict: 'DO NOT SNIP', gate: 6, launchBlock: L, detected: launch + 2, marked: launch + 30 }));
  // 6. not selected: gate 1b rejection
  put('100500', screen({ sym: 'G1B', token: F, verdict: 'DO NOT SNIP', gate: '1b', launchBlock: L, detected: launch + 2, marked: launch + 3 }));

  const asked = [];
  const ex = {
    [A]: { status: 200, json: { is_verified: true, verified_at: iso(launch - 3600) } },
    [B]: { status: 200, json: { is_verified: true, verified_at: iso(launch + 20) } },
    [C]: { status: 200, json: { is_verified: true, verified_at: iso(launch + 600) } },
    [IMPL]: { status: 200, json: { is_verified: true, verified_at: iso(launch - 60) } },
    [E]: { status: 503, json: null },
  };
  const get = async (addr) => { asked.push(addr); return ex[addr] || { status: 404 }; };
  const out = path.join(dir, 'out', 'ready-times');
  const NOW = launch + 3600; // the fake screens are 1 h old
  const opts = { live: false, dates: null, verdicts: ['SNIP', '6'], out, fresh: false, explorer: true, delayMs: 0 };
  const logs = [];
  const res = await R.main({ nowSec: NOW, opts, screensDir: path.join(dir, 'screens'), blockTime, get, log: (l) => logs.push(l) });
  const by = Object.fromEntries(res.rows.map((r) => [r.symbol, r]));

  console.log('\nselection');
  check('5 rows (SNIPs + gate 6), gate 1b left out', res.rows.length === 5 && !by.G1B, `${res.rows.length}`);

  console.log('\ncode first');
  check('case label', by.CODEFIRST.case === 'code first');
  check('code published = explorer time (1 h before launch)', by.CODEFIRST.code_published_utc === iso(launch - 3600) && by.CODEFIRST.code_from === 'explorer verified_at');
  check('tradable = launch', by.CODEFIRST.tradable_utc === iso(launch));
  check('bot lag = 57 s', by.CODEFIRST.bot_lag_s === 57, `${by.CODEFIRST.bot_lag_s}`);
  check('detect lag = 2 s', by.CODEFIRST.detect_lag_s === 2);

  console.log('\ntrades first');
  check('case label', by.TRADES.case === 'trades first');
  check('code published = explorer +20 s (earlier than bot +26 s)', by.TRADES.code_after_launch_s === 20, `${by.TRADES.code_after_launch_s}`);
  check('tradable = code published', by.TRADES.tradable_utc === iso(launch + 20));
  check('bot lag = 40 s', by.TRADES.bot_lag_s === 40, `${by.TRADES.bot_lag_s}`);
  check('found_by kept', by.TRADES.found_by === 'feed');

  console.log('\nexplorer later than the bot');
  check('earlier (bot) time used', by.TWIN.code_after_launch_s === 3 && by.TWIN.code_from.startsWith('bot'), `${by.TWIN.code_after_launch_s} ${by.TWIN.code_from}`);
  check('tradable = launch + 3 s', by.TWIN.tradable_utc === iso(launch + 3));

  console.log('\nproxy and failures');
  check('proxy: explorer asked about the implementation', asked.includes(IMPL) && !asked.includes(D));
  check('proxy: code before launch, tradable = launch', by.PROXY.tradable_utc === iso(launch));
  check('explorer 503: falls back to bot observation, noted', by.G6.code_from === 'bot observation (upper bound)' && /HTTP 503/.test(by.G6.notes), by.G6.notes);
  check('csv written with header + 5 rows', fs.readFileSync(`${out}.csv`, 'utf8').trim().split('\n').length === 6);

  console.log('\nrerun and quota');
  const n0 = asked.length;
  const res2 = await R.main({ nowSec: NOW, opts: { ...opts, live: true }, screensDir: path.join(dir, 'screens'), blockTime, get, log: () => {} });
  check('rerun: only the explorer-outage row is retried', res2.added === 1 && asked.length === n0 + 1 && asked[asked.length - 1] === E, `${res2.added} ${asked.length - n0}`);
  put('100600', screen({ sym: 'NEW1', token: '0x' + '2'.repeat(40), launchBlock: L, detected: launch + 2, marked: launch + 50 }));
  put('100700', screen({ sym: 'NEW2', token: '0x' + '3'.repeat(40), launchBlock: L, detected: launch + 2, marked: launch + 50 }));
  const quotaGet = async () => ({ status: 402 });
  const res3 = await R.main({ nowSec: NOW, opts: { ...opts, live: true }, screensDir: path.join(dir, 'screens'), blockTime, get: quotaGet, log: () => {} });
  check('HTTP 402: stops, records nothing new (outage row waits for the next run)', res3.added === 0 && res3.total === 4, `${res3.added} ${res3.total}`);
  const res4 = await R.main({ nowSec: NOW, opts: { ...opts, live: true }, screensDir: path.join(dir, 'screens'), blockTime, get, log: () => {} });
  check('next run picks them all up', res4.added === 3 && res4.total === 7, `${res4.added} ${res4.total}`);

  console.log('\nretries and failing loudly');
  // a stored row with an explorer 500 and one with no block time are done again
  const jl = `${out}.jsonl`;
  const lines = fs.readFileSync(jl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bySym = (x) => lines.find((l) => l.symbol === x);
  bySym('CODEFIRST').notes = 'explorer HTTP 500'; bySym('TRADES').launch_utc = ''; bySym('TRADES').notes = 'launch block time unavailable';
  fs.writeFileSync(jl, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const res5 = await R.main({ nowSec: NOW, opts: { ...opts, live: true }, screensDir: path.join(dir, 'screens'), blockTime, get, log: () => {} });
  check('failed rows redone (2 marked + the outage row), total unchanged', res5.added === 3 && res5.total === 7, `${res5.added} ${res5.total}`);
  const after = Object.fromEntries(res5.rows.map((r) => [r.symbol, r]));
  check('redone rows are complete again', after.CODEFIRST.notes === '' && after.TRADES.bot_lag_s === 40);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ready2-'));
  let threw = null;
  try {
    await R.main({ nowSec: NOW, opts: { ...opts, out: path.join(dir2, 'rt') }, screensDir: path.join(dir, 'screens'), blockTime: async () => { throw new Error('no block'); }, get, log: () => {} });
  } catch (e) { threw = e.message; }
  check('3 missing block times in a row: stops with a clear error', /check the RPC/.test(threw || ''), threw);
  check('...and wrote at most 2 rows', fs.readFileSync(path.join(dir2, 'rt.jsonl'), 'utf8').trim().split('\n').length <= 2);

  // explorer errors older than 2 days are kept, not retried
  const res6 = await R.main({ nowSec: NOW + 3 * 86400, opts: { ...opts, live: true }, screensDir: path.join(dir, 'screens'), blockTime, get, log: () => {} });
  check('explorer error older than 2 days: not retried', res6.added === 0 && res6.total === 7, `${res6.added} ${res6.total}`);

  console.log('\nnever published');
  const s = screen({ sym: 'NEVER', token: '0x' + '4'.repeat(40), launchBlock: L, detected: launch + 2, marked: launch + 86400, hidden: true });
  const row = await R.readyRow({ date: 'x', time: 'y', j: s }, { blockTime, get: async () => ({ status: 200, json: { is_verified: false } }) });
  check('case never published, no tradable time', row.case === 'never published' && row.tradable_utc === '');

  console.log('\nexplorer time vs the bot\'s checks (2026-11-10, real cases)');
  const SCHED = [30, 300, 1800, 7200, 86400];
  const fed = (found, extra = {}) => ({ hiddenAtLaunch: true, schedule: SCHED, feed: { everySec: 60, lookups: 1 }, foundAfterSec: found, foundBy: 'feed', ...extra });
  // AGENTDOM: explorer says verified 448 s BEFORE the pool; feed found it 971 s after detection
  let bb = R.codeBounds(fed(971), launch + 2);
  check('AGENTDOM: window = [det+911, det+971]', bb.lb === launch + 913 && bb.ub === launch + 973, `${bb.lb - launch} ${bb.ub - launch}`);
  let ct = R.codeTime({ ex: launch - 448, ...bb });
  check('AGENTDOM: explorer time early -> last "not published" check used', ct.code === launch + 913 && ct.from === 'bot checks (explorer time early)' && ct.early === 1361, `${ct.code - launch} ${ct.from} ${ct.early}`);
  // LGND: explorer +1278 s; checks at 30, 300, 1800 said no; feed found it at 2067
  bb = R.codeBounds(fed(2067), launch);
  ct = R.codeTime({ ex: launch + 1278, ...bb });
  check('LGND: 1800 s check said no, feed read at 2007 -> code = +2007', ct.code === launch + 2007 && ct.early === 729, `${ct.code - launch} ${ct.early}`);
  // ONION: explorer +33 s; check at 30 said no; feed found it at 36 -> explorer fits the window
  ct = R.codeTime({ ex: launch + 33, ...R.codeBounds(fed(36), launch) });
  check('ONION: explorer time inside the window -> explorer used', ct.code === launch + 33 && ct.from === 'explorer verified_at' && ct.early == null, `${ct.code - launch} ${ct.from}`);
  // SUNFIRE: found by the 30 s scheduled check at +35; explorer +21
  bb = R.codeBounds({ hiddenAtLaunch: true, schedule: SCHED, feed: { everySec: 60, lookups: 0 }, foundAfterSec: 35, foundBy: 'schedule' }, launch);
  check('found by the first check: no lower bound', bb.lb === null && bb.ub === launch + 35);
  ct = R.codeTime({ ex: launch + 21, ...bb });
  check('SUNFIRE: explorer used', ct.code === launch + 21 && ct.from === 'explorer verified_at');
  // found by the 30 min check: the 30 s and 5 min checks said no
  bb = R.codeBounds({ hiddenAtLaunch: true, schedule: SCHED, feed: null, foundAfterSec: 1805, foundBy: 'schedule' }, launch);
  check('found by the 30 min check (no feed): lower bound = the 5 min check', bb.lb === launch + 300, `${bb.lb - launch}`);
  // the feed named it twice (first look-up failed): the feed gives no lower bound
  bb = R.codeBounds(fed(971, { feed: { everySec: 60, lookups: 2 } }), launch);
  check('feed named it twice: lower bound from the schedule only (5 min check)', bb.lb === launch + 300, `${bb.lb - launch}`);
  check('explorer later than the bot (Sourcify): bot time used', R.codeTime({ ex: launch + 500, lb: launch + 300, ub: launch + 400 }).code === launch + 400);
  check('no explorer time: bot observation (upper bound)', R.codeTime({ ex: null, lb: launch + 300, ub: launch + 400 }).from === 'bot observation (upper bound)');

  // the whole row, AGENTDOM-like
  const AG = '0x' + '5'.repeat(40);
  const sAG = screen({ sym: 'AGENTDOM', token: AG, verdict: 'DO NOT SNIP', gate: 6, launchBlock: L, detected: launch + 2, marked: launch + 1028 });
  sAG.record.sourceRecheck = fed(971);
  const rowAG = await R.readyRow({ date: '2026-11-09', time: '171544', j: sAG }, { blockTime, get: async () => ({ status: 200, json: { is_verified: true, verified_at: iso(launch - 448) } }) });
  check('row: tradable = last "not published" check, not the explorer time', rowAG.tradable_utc === iso(launch + 913) && rowAG.bot_lag_s === 115, `${rowAG.tradable_utc} ${rowAG.bot_lag_s}`);
  check('row: all three code times kept, early by 1361 s, noted', rowAG.code_explorer_utc === iso(launch - 448) && rowAG.code_absent_utc === iso(launch + 913) && rowAG.code_seen_utc === iso(launch + 973) && rowAG.explorer_early_s === 1361 && /explorer time 1361 s before/.test(rowAG.notes), `${rowAG.notes}`);

  console.log('\n--show');
  const shown = [];
  const resS = await R.main({ opts: { ...opts, show: '2026-11-05' }, screensDir: path.join(dir, 'screens'), log: (l) => shown.push(l) });
  check('--show prints the rows without touching the chain or explorer', resS.total === 7 && shown.length === 9 && /TRADES/.test(shown.join('\n')), `${resS.total} ${shown.length}`);
  check('--show writes times in Edmonton time with the date', /(Nov|Oct|Sep|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug) \d\d \d\d:\d\d:\d\d (AM|PM)/.test(shown[2]) || / UTC/.test(shown[2]), shown[2]);

  console.log(failures ? `\ntest-ready-times: ${failures} FAILED` : '\ntest-ready-times: all checks passed');
  process.exit(failures ? 1 : 0);
})();
