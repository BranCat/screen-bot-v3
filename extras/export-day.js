// extras/export-day.js — list the tokens screened on one day, SNIPs first.
// READ-ONLY: reads screens/ and extras/live/state.json, writes one CSV.
// No RPC, no Tenderly; the live bot is never touched.
//
//   node extras/export-day.js                         yesterday (Calgary time)
//   node extras/export-day.js --date 2026-10-22       one day
//   node extras/export-day.js --all                   every verdict, not only the passes
//   [--tz America/Edmonton] [--out extras/exports/tokens-<date>.csv]
//
// Default set: SNIP, then PASSED GATES 0-5, then DO NOT SNIP at Gate 6 (passed
// Gates 0-5, held at the last step). Each row adds the live tracker's prices
// (returns on 0.05 ETH after both hook fees, before gas) when it followed the token.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const a = argv.slice(2);
  const val = (f, d) => { const i = a.indexOf(f); return i >= 0 && a[i + 1] != null ? a[i + 1] : d; };
  return {
    date: val('--date', null), tz: val('--tz', 'America/Edmonton'), all: a.includes('--all'),
    out: val('--out', null), screens: val('--screens', path.join(ROOT, 'screens')),
    live: val('--live', path.join(ROOT, 'extras', 'live', 'state.json')),
  };
}

// 'YYYY-MM-DD' and 'HH:MM' of a unix ms time in a time zone.
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
const shiftDay = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const rank = (r) => (r.verdict === 'SNIP' ? 0 : String(r.verdict || '').startsWith('PASSED') ? 1 : String(r.gate) === '6' ? 2 : 3);
const groupName = (r) => ['SNIP', 'PASSED GATES 0-5', 'DO NOT SNIP (Gate 6)'][rank(r)] || `${r.verdict} (Gate ${r.gate})`;

function collect(o, nowMs = Date.now()) {
  const day = o.date || shiftDay(localParts(nowMs, o.tz).day, -1);
  // Folder names may be UTC days: look one day either side, filter by local day.
  const byToken = new Map();
  for (const d of [shiftDay(day, -1), day, shiftDay(day, 1)]) {
    const dir = path.join(o.screens, d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (_) { continue; }
    for (const f of files) {
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
      const r = j && j.record;
      if (!r || !r.token || !r.screenedAt) continue;
      const ms = Date.parse(r.screenedAt);
      if (!Number.isFinite(ms) || localParts(ms, o.tz).day !== day) continue;
      byToken.set(String(r.token).toLowerCase(), { j, ms, file: path.join(d, f) }); // a rescreen replaces the earlier one
    }
  }
  let live = {};
  try { live = JSON.parse(fs.readFileSync(o.live, 'utf8')).tokens || {}; } catch (_) { /* tracker not installed */ }

  const all = [...byToken.entries()].map(([key, { j, ms, file }]) => {
    const r = j.record;
    const d = j.detail || {};
    const pool = d.pool || {};
    const s = live[key];
    const cp = (l) => (s && s.checkpoints && s.checkpoints[l] && s.checkpoints[l].v != null ? s.checkpoints[l].v : null);
    return {
      group: groupName(r), rank: rank(r), time: localParts(ms, o.tz).hm, ms,
      symbol: r.symbol, token: r.token, verdict: r.verdict, gate: r.gate == null ? '' : String(r.gate),
      version: r.version || pool.version || '', launchPath: r.launchPath || '',
      pool: pool.poolId || r.poolId || pool.poolAddress || r.poolAddress || '',
      costPct: (d.roundTripJudgement && d.roundTripJudgement.costPct) ?? null,
      whaleRecovery: (r.rug && r.rug.whaleRecovery) ?? null,
      // 2026-10-24: the change check (record only; see change-check.js)
      changeCheck: d.changeCheck ? d.changeCheck.wouldBe || '' : '',
      changeNotes: d.changeCheck ? d.changeCheck.summary || d.changeCheck.error || '' : '',
      tracked: s ? 'yes' : 'no',
      first: s && s.first ? s.first.v : null, firstMin: s && s.first ? s.first.min : null,
      r5m: cp('5m'), r30m: cp('30m'), r1h: cp('1h'), r6h: cp('6h'), r24h: cp('24h'), r3d: cp('3d'), r7d: cp('7d'),
      latest: s && s.last ? s.last.v : null, latestMin: s && s.last ? s.last.min : null,
      best: s && s.peak ? s.peak.v : null, bestMin: s && s.peak ? s.peak.min : null,
      worst: s && s.trough ? s.trough.v : null,
      file,
    };
  }).sort((a, b) => a.rank - b.rank || a.ms - b.ms);
  const rows = o.all ? all : all.filter((x) => x.rank <= 2);
  return { day, all, rows };
}

const COLS = [['group', 'group'], ['time', 'time_local'], ['symbol', 'symbol'], ['token', 'token'], ['verdict', 'verdict'], ['gate', 'gate'],
  ['version', 'version'], ['launchPath', 'launch_path'], ['pool', 'pool'], ['costPct', 'round_trip_cost_pct'], ['whaleRecovery', 'whale_recovery'],
  ['tracked', 'live_tracked'], ['first', 'first_pct'], ['firstMin', 'first_after_min'], ['r5m', 'ret_5m'], ['r30m', 'ret_30m'], ['r1h', 'ret_1h'], ['r6h', 'ret_6h'],
  ['r24h', 'ret_24h'], ['r3d', 'ret_3d'], ['r7d', 'ret_7d'], ['latest', 'latest_pct'], ['latestMin', 'latest_after_min'], ['best', 'best_pct'], ['bestMin', 'best_after_min'],
  ['worst', 'worst_pct'], ['file', 'screen_file'], ['changeCheck', 'change_check'], ['changeNotes', 'change_notes']];

function toCsv(rows) {
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [COLS.map((c) => c[1]).join(','), ...rows.map((r) => COLS.map((c) => esc(r[c[0]])).join(','))].join('\n') + '\n';
}

function main(argv = process.argv, log = console.log) {
  const o = parseArgs(argv);
  const { day, all, rows } = collect(o);
  const out = o.out || path.join(ROOT, 'extras', 'exports', `tokens-${day}.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(rows));
  const counts = {};
  for (const r of all) counts[r.group] = (counts[r.group] || 0) + 1;
  log(`${day} (${o.tz}): ${all.length} tokens screened — ${Object.entries(counts).map(([g, n]) => `${n} ${g}`).join(', ') || 'none'}`);
  const f = (v) => (v == null ? '     -' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`.padStart(7));
  let g = null;
  for (const r of rows) {
    if (r.group !== g) { g = r.group; log(`\n${g}`); }
    log(`  ${r.time}  ${String(r.symbol).slice(0, 10).padEnd(10)} ${r.token}  5m:${f(r.r5m)}  1h:${f(r.r1h)}  latest:${f(r.latest)}  best:${f(r.best)}${r.tracked === 'no' ? '  (not tracked)' : ''}`);
  }
  log(`\nwrote ${path.relative(process.cwd(), out) || out} (${rows.length} rows)`);
  return { out, day, rows };
}

module.exports = { main, collect, toCsv, localParts, parseArgs };
if (require.main === module) main();
