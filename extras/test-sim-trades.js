// Offline tests for extras/sim-trades.js. No RPC, no real data.
//
//   node extras/test-sim-trades.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./sim-trades');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;

console.log('sim-trades');
const csv = S.parseCsv('a,b,c\n1,"x, ""y""",3\r\n4,,6\n');
check('CSV: quotes, commas, CRLF, empty cell', csv.length === 2 && csv[0].b === 'x, "y"' && csv[1].b === '' && csv[1].c === '6', JSON.stringify(csv));

const p = [{ age: 0.5, v: -6 }, { age: 2, v: 10 }, { age: 5, v: -30 }, { age: 31, v: 60 }, { age: 61, v: 40 }, { age: 75, v: -20 }, { age: 365, v: 5 }, { age: 1452, v: -80 }];
check('fixed: first reading at/after the time', near(S.fixedExit(p, {}, '30m', 30).v, 60));
check('fixed: reading 1 min after +1h is used', near(S.fixedExit(p, {}, '1h', 60).v, 40));
check('fixed: +2h has no reading within 20 min -> null', S.fixedExit(p, {}, '2h', 120) === null);
check('fixed: checkpoint used when no sample', near(S.fixedExit(p, { ret_2h: '-12.5', late_min_2h: '4' }, '2h', 120).v, -12.5));
check('fixed: late checkpoint refused', S.fixedExit(p, { ret_2h: '-12.5', late_min_2h: '40' }, '2h', 120) === null);
check('fixed: +24h within 20 min', near(S.fixedExit(p, {}, '24h', 1440).v, -80));

const b1 = S.bracketExit(p, { tp: 50, sl: 25, limit: 1440 });
check('bracket: stop hit first (-30 at 5 min)', b1 && b1.why === 'sl' && near(b1.v, -30), JSON.stringify(b1));
const b2 = S.bracketExit(p, { tp: 50, sl: null, limit: 1440 });
check('bracket: no stop -> take profit at +60 (31 min)', b2 && b2.why === 'tp' && near(b2.v, 60), JSON.stringify(b2));
const b3 = S.bracketExit(p, { tp: 100, sl: null, limit: 60 });
check('bracket: neither -> sold at the time limit (+1h: 40)', b3 && b3.why === 'time' && near(b3.v, 40), JSON.stringify(b3));
check('bracket: readings starting late are excluded', S.bracketExit([{ age: 14, v: 5 }, { age: 61, v: 3 }], { tp: 50, sl: 20, limit: 60 }) === null);

const st = S.stats([{ v: 10 }, { v: -20 }, null, { v: 30 }, { v: -100 }], 0.02, 0.0001);
check('stats: n, win share, median, profit with gas', st.n === 4 && near(st.win, 0.5) && near(st.median, -5) && near(st.pnl, 0.02 * (-80) / 100 - 0.0004), JSON.stringify(st));
check('week of a Sunday is the Monday before', S.weekOf('2026-11-15') === '2026-11-09' && S.weekOf('2026-11-16') === '2026-11-16');

// end to end on a small fake scorecard
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-'));
const live = path.join(dir, 'live');
fs.mkdirSync(live);
fs.writeFileSync(path.join(live, 'lookback-live.csv'), [
  'date,time,symbol,token,verdict,gate,ret_1h,late_min_1h',
  '2026-10-20,10:00:00,OLD,0xa1,SNIP,,15,2',
  '2026-11-01,10:00:00,AAA,0xa2,SNIP,,,',
  '2026-11-12,10:00:00,BBB,0xa3,SNIP,,,',
  '2026-11-12,11:00:00,CCC,0xa4,DO NOT SNIP (Gate 6),6,,',
  '2026-11-15,11:00:00,NEW,0xa5,SNIP,,,',
].join('\n') + '\n');
const sm = ['time_utc,token,symbol,verdict,gate,age_min,ret_pct'];
const add = (tok, pts) => pts.forEach(([a, v]) => sm.push(`x,${tok},s,SNIP,,${a},${v}`));
add('0xa1', [[30, 5], [1440, 20]]);                                     // late start (19-22 Oct style)
add('0xa2', [[0.4, -5], [1, -10], [30, -40], [60, -50], [1440, 100]]);
add('0xa3', [[0.6, 3], [2, 80], [30, 10], [60, -10], [1440, -90]]);
add('0xa4', [[0.5, 1], [1440, 1]]);                                     // not a SNIP
add('0xa5', [[0.5, 1], [60, 2]]);                                       // too recent
fs.writeFileSync(path.join(live, 'samples.csv'), sm.join('\n') + '\n');
const lines = [];
const r = S.run({ liveDir: live, outDir: path.join(dir, 'sim'), verdicts: ['SNIP'], stake: 0.02, gasEth: 0, split: '2026-11-10', minAgeMin: 1440 }, (s) => lines.push(s));
check('only SNIPs, followed 24 h: OLD, AAA, BBB', r.finished.map((t) => t.symbol).join(',') === 'OLD,AAA,BBB', r.finished.map((t) => t.symbol).join(','));
check('+1h: checkpoint for OLD, samples for AAA/BBB', JSON.stringify(r.fixedRes['1h'].map((x) => x && x.v)) === JSON.stringify([15, -50, -10]));
check('+24h values', JSON.stringify(r.fixedRes['24h'].map((x) => x && x.v)) === JSON.stringify([20, 100, -90]));
const g = r.grid.find((x) => x.rule.tp === 75 && x.rule.sl === null && x.rule.limit === 1440);
check('grid: tuned on AAA only (OLD starts late), checked on BBB', g && g.tr.n === 1 && g.te.n === 1 && near(g.te.pnl, 0.02 * 0.8), JSON.stringify(g));
check('report and CSV written', fs.existsSync(path.join(dir, 'sim', 'sim-report.txt')) && fs.readFileSync(path.join(dir, 'sim', 'sim-trades.csv'), 'utf8').trim().split('\n').length === 4);
check('report mentions the too-recent token', lines.some((l) => /1 too recent/.test(l)), lines[1]);

let threw = false; try { S.run({ liveDir: path.join(dir, 'none'), outDir: dir, verdicts: ['SNIP'] }, () => {}); } catch (e) { threw = /copy it from the server/.test(e.message); }
check('missing data -> clear message', threw);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
