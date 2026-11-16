// extras/sim-trades.js — profit simulator. Read only, offline: reads the scorecard's files, no RPC.
//
//   node extras/sim-trades.js                                  report on every SNIP
//   node extras/sim-trades.js --verdicts SNIP,PASSED --stake 0.02 --split 2026-11-08
//
// The question: if every token bot v3 marked SNIP had been bought at the mark (when the
// screen finished), what would selling it later have returned?
//
// Data (copied from the server, extras/live/):
//   lookback-live.csv  one row per token: verdict, date, time, fixed checkpoints
//   samples.csv        every reading of every token: time_utc, token, symbol, verdict, gate,
//                      age_min (minutes after the mark), ret_pct
// ret_pct is the scorecard's own round trip: the sell value of the tokens a 0.05 ETH buy got
// at the mark, as a % of the 0.05 ETH, after both Pons hook fees, before gas. A sell that
// reverts is recorded as -100. Readings: every minute for the first hour (from 23 Oct), every
// 15 min to 24 h, hourly to 7 days.
//
// Exit rules simulated:
//   fixed time   sell at +30m, +1h, +2h, +6h, +24h, +3d, +7d: the first reading at or after
//                the time, if it is close enough (3 min up to 1 h, 20 min up to 24 h, 75 min
//                after); otherwise the scorecard's own checkpoint, same limit; else no data
//   bracket      sell at the first reading >= +TP% (take profit) or <= -SL% (stop loss), else
//                at the time limit. Tuned on the tokens before --split, then checked on the
//                tokens from --split on, so a rule is never judged on the tokens it was tuned on.
//                Only tokens whose readings start within 3 min of the mark take part (an early
//                stop could otherwise have been missed).
// Readings are snapshots: a real stop could fill worse than the reading that triggered it,
// and a take-profit could have been hit between two readings. Gas is not included unless
// --gas-eth is given (ETH per round trip). Returns are for 0.05 ETH; a 0.02 ETH buy moves the
// price less, so real results would be a little better.
//
// Writes extras/sim/sim-trades.csv (one row per token) and extras/sim/sim-report.txt.
// Flags: --live-dir extras/live, --out-dir extras/sim, --verdicts SNIP, --stake 0.02,
//        --gas-eth 0, --split <date> (default: 7 days before the newest token), --min-age 24h

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXED = [['30m', 30], ['1h', 60], ['2h', 120], ['6h', 360], ['24h', 1440], ['3d', 4320], ['7d', 10080]];
const tolFor = (min) => (min <= 60 ? 3 : min <= 1440 ? 20 : 75);
const TP_GRID = [20, 30, 50, 75, 100, 150, 200, 300];
const SL_GRID = [null, 15, 25, 35, 50, 70];
const LIMIT_GRID = [['1h', 60], ['6h', 360], ['24h', 1440]];

// ---- CSV
function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const lc = (a) => String(a || '').toLowerCase();
const esc = (v) => { if (v == null) return ''; const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

function parseArgs(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const dur = (s) => { const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(String(s)); if (!m) throw new Error(`bad duration ${s}`); return Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2]]; };
  return {
    liveDir: path.resolve(ROOT, flag('--live-dir', 'extras/live')),
    outDir: path.resolve(ROOT, flag('--out-dir', 'extras/sim')),
    verdicts: flag('--verdicts', 'SNIP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    stake: Number(flag('--stake', 0.02)),
    gasEth: Number(flag('--gas-eth', 0)),
    split: flag('--split', null),
    minAgeMin: dur(flag('--min-age', '24h')),
  };
}

// ---- data
function loadTokens(liveDir, verdicts) {
  const f = path.join(liveDir, 'lookback-live.csv');
  if (!fs.existsSync(f)) throw new Error(`missing ${f}: copy it from the server first`);
  const want = (v) => verdicts.some((x) => String(v || '').toUpperCase().startsWith(x));
  return parseCsv(fs.readFileSync(f, 'utf8')).filter((r) => want(r.verdict)).map((r) => ({
    token: r.token, symbol: r.symbol, verdict: r.verdict, date: r.date, time: r.time, row: r,
  }));
}
function loadPaths(liveDir, tokens) {
  const f = path.join(liveDir, 'samples.csv');
  if (!fs.existsSync(f)) throw new Error(`missing ${f}: copy it from the server first`);
  const want = new Set(tokens.map((t) => lc(t.token)));
  const paths = new Map();
  for (const r of parseCsv(fs.readFileSync(f, 'utf8'))) {
    const k = lc(r.token);
    if (!want.has(k)) continue;
    const age = num(r.age_min); const v = num(r.ret_pct);
    if (age == null || v == null) continue;
    if (!paths.has(k)) paths.set(k, []);
    paths.get(k).push({ age, v });
  }
  for (const p of paths.values()) p.sort((a, b) => a.age - b.age);
  return paths;
}

// ---- exits
function fixedExit(pathArr, row, label, min) {
  const tol = tolFor(min);
  const hit = (pathArr || []).find((s) => s.age >= min);
  if (hit && hit.age - min <= tol) return { v: hit.v, age: hit.age, src: 'sample' };
  const c = num(row && row[`ret_${label}`]); const late = num(row && row[`late_min_${label}`]);
  if (c != null && late != null && late <= tol) return { v: c, age: min + late, src: 'checkpoint' };
  return null;
}
// Bracket: first reading >= tp or <= -sl, else the reading at the time limit.
function bracketExit(pathArr, { tp, sl, limit }) {
  if (!pathArr || !pathArr.length || pathArr[0].age > 3) return null;
  for (const s of pathArr) {
    if (s.age > limit) break;
    if (tp != null && s.v >= tp) return { v: s.v, age: s.age, why: 'tp' };
    if (sl != null && s.v <= -sl) return { v: s.v, age: s.age, why: 'sl' };
  }
  const at = fixedExit(pathArr, null, null, limit);
  return at ? { v: at.v, age: at.age, why: 'time' } : null;
}

// ---- stats
function stats(results, stake, gasEth) {
  const v = results.filter((r) => r != null).map((r) => r.v);
  if (!v.length) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const pnl = v.reduce((a, x) => a + stake * x / 100 - gasEth, 0);
  return { n: v.length, win: v.filter((x) => x > 0).length / v.length, mean: v.reduce((a, x) => a + x, 0) / v.length, median, pnl, best: s[s.length - 1], worst: s[0] };
}
const pct = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const ethf = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;
const weekOf = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

function run(o, log = console.log) {
  const all = loadTokens(o.liveDir, o.verdicts);
  const paths = loadPaths(o.liveDir, all);
  // Only tokens old enough to have been followed for --min-age (default 24 h).
  const finished = all.filter((t) => { const p = paths.get(lc(t.token)); return p && p.length && p[p.length - 1].age >= o.minAgeMin; });
  const recent = all.length - finished.length;
  const dates = finished.map((t) => t.date).sort();
  const split = o.split || (dates.length ? new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - 6 * 86400e3).toISOString().slice(0, 10) : null);
  const lines = [];
  const out = (s = '') => { lines.push(s); log(s); };

  out(`Profit simulator — ${o.verdicts.join('/')} tokens, bought at the mark, ${o.stake} ETH each${o.gasEth ? `, gas ${o.gasEth} ETH per trade` : ', gas not included'}`);
  out(`Tokens: ${all.length} in the scorecard; ${finished.length} followed for at least ${o.minAgeMin / 60} h (${dates[0] || '-'} to ${dates[dates.length - 1] || '-'}); ${recent} too recent or without readings.`);
  out('Returns are after both Pons fees (~3% each way), at 0.05 ETH.');
  out('');

  // 1. fixed times
  out('1. Sell at a fixed time');
  out('   exit    tokens  made money  average   median    profit (ETH)   best      worst');
  const perToken = finished.map((t) => ({ t, p: paths.get(lc(t.token)) }));
  const fixedRes = {};
  for (const [label, min] of FIXED) {
    fixedRes[label] = perToken.map(({ t, p }) => fixedExit(p, t.row, label, min));
    const s = stats(fixedRes[label], o.stake, o.gasEth);
    if (!s.n) { out(`   +${label.padEnd(5)}      0`); continue; }
    out(`   +${label.padEnd(5)} ${String(s.n).padStart(6)}  ${`${Math.round(s.win * 100)}%`.padStart(10)}  ${pct(s.mean).padStart(8)}  ${pct(s.median).padStart(8)}  ${ethf(s.pnl).padStart(13)}  ${pct(s.best).padStart(8)}  ${pct(s.worst).padStart(8)}`);
  }
  out('');

  // 2. per week at +1h and +24h
  out('2. Per week (week starting Monday), sell at +1h / +24h');
  const weeks = [...new Set(finished.map((t) => weekOf(t.date)))].sort();
  for (const w of weeks) {
    const idx = perToken.map((x, i) => (weekOf(x.t.date) === w ? i : -1)).filter((i) => i >= 0);
    const a = stats(idx.map((i) => fixedRes['1h'][i]), o.stake, o.gasEth);
    const b = stats(idx.map((i) => fixedRes['24h'][i]), o.stake, o.gasEth);
    out(`   ${w}: ${String(idx.length).padStart(3)} tokens   +1h: ${a.n ? `${ethf(a.pnl)} ETH, ${Math.round(a.win * 100)}% won` : 'no data'}   +24h: ${b.n ? `${ethf(b.pnl)} ETH, ${Math.round(b.win * 100)}% won` : 'no data'}`);
  }
  out('');

  // 3. bracket rules: tune before the split, check from the split on
  const train = perToken.filter((x) => x.t.date < split);
  const test = perToken.filter((x) => x.t.date >= split);
  const early = (arr) => arr.filter((x) => x.p && x.p.length && x.p[0].age <= 3);
  out(`3. Take profit / stop loss / time limit — tuned on tokens before ${split} (${early(train).length} with minute readings), checked on ${split} on (${early(test).length})`);
  const grid = [];
  for (const tp of TP_GRID) for (const sl of SL_GRID) for (const [ll, limit] of LIMIT_GRID) {
    const rule = { tp, sl, limit };
    const tr = stats(train.map((x) => bracketExit(x.p, rule)), o.stake, o.gasEth);
    if (!tr.n) continue;
    const te = stats(test.map((x) => bracketExit(x.p, rule)), o.stake, o.gasEth);
    grid.push({ name: `TP +${tp}% / ${sl == null ? 'no stop' : `SL -${sl}%`} / ${ll}`, rule, tr, te });
  }
  grid.sort((a, b) => b.tr.pnl - a.tr.pnl);
  out('   rule                              tuning: tokens  won   profit    | check: tokens  won   profit');
  for (const g of grid.slice(0, 8)) {
    out(`   ${g.name.padEnd(32)} ${String(g.tr.n).padStart(6)} ${`${Math.round(g.tr.win * 100)}%`.padStart(5)} ${ethf(g.tr.pnl).padStart(9)}  | ${String(g.te.n || 0).padStart(6)} ${g.te.n ? `${Math.round(g.te.win * 100)}%`.padStart(5) : '    -'} ${g.te.n ? ethf(g.te.pnl).padStart(9) : '        -'}`);
  }
  if (!grid.length) out('   no tokens with minute readings before the split');
  out('');
  out('Notes: readings are snapshots (a stop could fill worse, a take-profit could be missed between');
  out('readings). Few tokens: a pattern, not proof. A rule that wins only in tuning is noise.');

  // files
  fs.mkdirSync(o.outDir, { recursive: true });
  const cols = ['date', 'time', 'symbol', 'token', 'verdict', 'first_reading_min', ...FIXED.map(([l]) => `ret_${l}`), 'peak_pct', 'peak_min', 'trough_pct', 'trough_min'];
  const rows = perToken.map(({ t, p }, i) => {
    const pk = p.reduce((a, b) => (b.v > a.v ? b : a)); const tr = p.reduce((a, b) => (b.v < a.v ? b : a));
    return [t.date, t.time, t.symbol, t.token, t.verdict, p[0].age, ...FIXED.map(([l]) => (fixedRes[l][i] ? fixedRes[l][i].v : '')), pk.v, pk.age, tr.v, tr.age];
  });
  fs.writeFileSync(path.join(o.outDir, 'sim-trades.csv'), [cols.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n');
  fs.writeFileSync(path.join(o.outDir, 'sim-report.txt'), lines.join('\n') + '\n');
  log(`\nWrote ${path.relative(ROOT, path.join(o.outDir, 'sim-trades.csv'))} and sim-report.txt`);
  return { all, finished, fixedRes, grid, split };
}

module.exports = { run, parseCsv, fixedExit, bracketExit, stats, parseArgs, weekOf };

if (require.main === module) {
  try { run(parseArgs(process.argv.slice(2))); } catch (e) { console.error(`sim-trades: ${e.message}`); process.exit(1); }
}
