// extras/ready-times.js — READY-TIME RECORDER. READ-ONLY. Added 2026-11-09.
//
// The question: for every token that passed the screens, at what exact moment could
// it first be traded? "Tradable" is the definition agreed on 3 Nov: the latest of
//   1. the Uniswap pool is live (the launch block),
//   2. the token's source code is published,
//   3. all screens have passed.
// Items 1 and 2 are facts about the chain and the explorer. Item 3 depends on how fast
// the bot screens, so it is kept apart: this script records
//   tradable_utc   = the latest of 1 and 2: the moment the token COULD be traded, if
//                    the screens took no time at all;
//   bot_marked_utc = when the bot actually finished screening and marked it;
//   bot_lag_s      = the gap between the two: how late the bot was.
// It also labels the case:
//   code first   = the source was already published when the pool appeared;
//   trades first = the pool appeared first and the source was published later.
//
// 2026-11-10: the explorer's verified_at can be EARLIER than the moment the source
// could really be read (LGND, AGENTDOM: the bot asked the explorer directly after that
// time and was told "not published"). The code time is therefore checked against the
// bot's own checks, which are stored in each screen file:
//   code_absent_utc = the last check that still said "not published" (a scheduled
//                     check, or the feed's previous read when the feed found it);
//   code_seen_utc   = the check that found the source;
//   code_explorer_utc = what the explorer says.
// The source appeared between code_absent and code_seen. The explorer time is used if
// it lies in that window; if it is earlier, code_absent is used and explorer_early_s
// says by how much; if it is later, code_seen is used (seen on Sourcify, or a twin).
//
// What it reads: the bot's screens/ files (never changed), one getBlock per launch
// block (plain RPC), and one Blockscout lookup per token for the time the source was
// verified (verified_at), through the bot's own explorer route and key. It does not
// screen, decide, sign or send anything, and the bot does not know it exists.
//
//   node extras/ready-times.js                      all SNIPs and Gate 6 rejects (passed 0-5), all dates
//   node extras/ready-times.js --live               only screens not yet recorded (cron, every 15 min)
//   node extras/ready-times.js --dates 2026-11-05   one day (comma-separate several)
//   node extras/ready-times.js --show 2026-11-09    print the recorded rows from that date,
//                                                   in Edmonton time (reads the file only)
//   [--verdicts SNIP,6] [--out extras/ready/ready-times] [--fresh] [--no-explorer] [--delay 300]
//
// Output: <out>.jsonl (one line per token; a rerun skips tokens already in it, --fresh
// starts over) and <out>.csv, rebuilt from the .jsonl after every run.
// Explorer cost: one request per new token (about 5-10 a day in live mode).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) { /* optional */ }

const lc = (a) => String(a || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.round(t / 1000) : null; };
const isoOf = (sec) => (sec == null ? '' : new Date(sec * 1000).toISOString().replace('.000Z', 'Z'));

// ---------------------------------------------------------------- screens

function readScreens(screensDir, { dates = null } = {}) {
  const out = [];
  let days;
  try { days = fs.readdirSync(screensDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch (_) { return out; }
  if (dates && dates.length) days = days.filter((d) => dates.includes(d));
  for (const day of days) {
    const dir = path.join(screensDir, day);
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
      if (!j || !j.record) continue;
      out.push({ file: path.join(day, f), date: day, time: f.slice(0, 6), j });
    }
  }
  return out;
}

// Which screens count. "SNIP" matches the verdict; a number matches the gate that
// rejected the token (6 = passed Gates 0-5, rejected at Gate 6).
function selected(s, verdicts) {
  const r = s.j.record;
  return verdicts.some((v) => (/^\d+[a-z]?$/i.test(v) ? String(r.gate) === v : r.verdict === v));
}

// ---------------------------------------------------------------- explorer

// The time the explorer says the source was verified. One request per address.
// Returns { at: unix seconds | null, note }.
async function verifiedAt(addr, get) {
  let res;
  try { res = await get(addr); } catch (e) { return { at: null, note: `explorer error: ${String(e && e.message || e).slice(0, 80)}` }; }
  const { status, json } = res || {};
  if (status === 402) return { at: null, note: 'explorer credits used up (HTTP 402)', quota: true };
  if (status !== 200 || !json || typeof json !== 'object') return { at: null, note: `explorer HTTP ${status}` };
  if (json.is_verified !== true) return { at: null, note: 'explorer: not verified' };
  const at = tsOf(json.verified_at);
  return at == null ? { at: null, note: 'explorer: verified, no verified_at' } : { at, note: '' };
}

function explorerGetter() {
  const sg = require('../source-gate');
  const H = sg.explorerHttp();
  return (addr) => H(sg.explorerUrl(`/smart-contracts/${addr}`), { userAgent: sg.explorerUA(), attempts: 2 });
}

// ---------------------------------------------------------------- code time

// From the bot's own record of a token that waited for its source: the last moment the
// source was still not readable (lb) and the moment it was found (ub), unix seconds.
// The bot's check times are counted from detection (watch-launches.js checkSourceWait).
//   - every scheduled check before the one that found it said "not published";
//   - when the feed found it (and named it only once), the feed's previous read, one
//     feed interval earlier, did not list it yet.
// Slot times are lower bounds of when each check ran, so lb never comes out too late.
function codeBounds(rc, detected) {
  if (!rc || detected == null || rc.foundAfterSec == null) return { lb: null, ub: null };
  const found = rc.foundAfterSec;
  const ub = detected + found;
  const slots = Array.isArray(rc.schedule) ? rc.schedule.map(Number).filter(Number.isFinite) : [];
  let failed = [];
  if (rc.foundBy === 'schedule') {
    const foundSlot = Math.max(...slots.filter((x) => x <= found), -Infinity);
    failed = slots.filter((x) => x < foundSlot);
  } else {
    failed = slots.filter((x) => x < found);
  }
  const feedEvery = rc.feed && Number(rc.feed.everySec);
  if (rc.foundBy === 'feed' && feedEvery > 0 && !(Number(rc.feed.lookups) > 1)) failed.push(Math.max(0, found - feedEvery));
  const last = failed.length ? Math.max(...failed) : null;
  return { lb: last == null ? null : detected + last, ub };
}

// The code time from the explorer's stamp (ex) and the bot's window [lb, ub].
function codeTime({ ex, lb, ub }) {
  if (ex == null) return ub == null ? { code: null, from: '', early: null } : { code: ub, from: 'bot observation (upper bound)', early: null };
  if (ub != null && ex > ub) return { code: ub, from: 'bot (earlier than explorer stamp)', early: null };
  if (lb != null && ex < lb) return { code: lb, from: 'bot checks (explorer time early)', early: lb - ex };
  return { code: ex, from: 'explorer verified_at', early: null };
}

// ---------------------------------------------------------------- one token

// Builds the row for one screen file. get(addr) -> explorer response, or null to skip
// the explorer; blockTime(n) -> unix seconds of block n.
async function readyRow(s, { blockTime, get }) {
  const r = s.j.record;
  const src = (s.j.detail && s.j.detail.source) || {};
  const rc = r.sourceRecheck || null;
  const detected = tsOf(r.detectedAt);
  const marked = tsOf(r.screenedAt);
  const subject = src.verificationSubject || r.token;
  const notes = [];

  let launch = null;
  if (r.launchBlock != null) {
    try { launch = await blockTime(r.launchBlock); } catch (e) { notes.push('launch block time unavailable'); }
  }

  // What the bot itself saw: published at detection (code first), or found later.
  // A token screened again after its source appeared has sourceHidden false in its final
  // file; sourceRecheck.hiddenAtLaunch keeps what was true at launch.
  const hiddenAtLaunch = !!(r.sourceHidden || (rc && rc.hiddenAtLaunch));
  const caseLabel = !hiddenAtLaunch ? 'code first' : (rc && rc.foundAfterSec != null ? 'trades first' : 'never published');
  // The bot's window for the code: code first = seen at detection (no lower bound);
  // trades first = between its last "not published" check and the check that found it.
  const bounds = !hiddenAtLaunch ? { lb: null, ub: detected } : codeBounds(rc, detected);

  let ex = { at: null, note: 'explorer skipped' };
  if (get) ex = await verifiedAt(subject, get);
  if (ex.note) notes.push(ex.note);
  const ct = codeTime({ ex: ex.at, lb: bounds.lb, ub: bounds.ub });
  const code = ct.code; const codeFrom = ct.from;
  if (ct.early != null) notes.push(`explorer time ${ct.early} s before the bot's last "not published" check`);

  let tradable = null;
  if (launch != null && code != null) tradable = Math.max(launch, code);
  else if (launch != null && caseLabel === 'code first') tradable = launch;

  const d = (a, b) => (a != null && b != null ? a - b : null);
  return {
    date: s.date, time: s.time, symbol: r.symbol, token: r.token,
    verdict: r.verdict, gate: r.gate == null ? '' : String(r.gate), case: caseLabel,
    launch_block: r.launchBlock, launch_utc: isoOf(launch), detected_utc: isoOf(detected),
    code_published_utc: isoOf(code), code_from: codeFrom,
    code_explorer_utc: isoOf(ex.at), code_absent_utc: isoOf(bounds.lb), code_seen_utc: isoOf(bounds.ub), explorer_early_s: ct.early,
    tradable_utc: isoOf(tradable), bot_marked_utc: isoOf(marked),
    detect_lag_s: d(detected, launch), code_after_launch_s: d(code, launch),
    bot_lag_s: d(marked, tradable), marked_after_launch_s: d(marked, launch),
    found_by: rc ? (rc.foundBy || '') : '',
    notes: notes.join('; '), quota: !!ex.quota,
  };
}

// ---------------------------------------------------------------- files

const COLS = ['date', 'time', 'symbol', 'token', 'verdict', 'gate', 'case', 'launch_block', 'launch_utc', 'detected_utc',
  'code_published_utc', 'code_from', 'code_explorer_utc', 'code_absent_utc', 'code_seen_utc', 'explorer_early_s', 'tradable_utc', 'bot_marked_utc', 'detect_lag_s', 'code_after_launch_s',
  'bot_lag_s', 'marked_after_launch_s', 'found_by', 'notes'];
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function readJsonl(file) {
  const rows = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (line.trim()) { try { rows.push(JSON.parse(line)); } catch (_) { /* skip */ } } }
  } catch (_) { /* none yet */ }
  return rows;
}

function writeCsv(file, rows) {
  const sorted = [...rows].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  fs.writeFileSync(file, [COLS.join(','), ...sorted.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
}

function median(xs) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function summary(rows) {
  const lines = [];
  for (const c of ['code first', 'trades first']) {
    const x = rows.filter((r) => r.case === c && r.verdict === 'SNIP');
    if (!x.length) continue;
    lines.push(`${c}: ${x.length} SNIPs; median code after launch ${median(x.map((r) => r.code_after_launch_s))} s; median bot lag after tradable ${median(x.map((r) => r.bot_lag_s))} s`);
  }
  return lines;
}

// ---------------------------------------------------------------- show

// Edmonton time with the date, e.g. "Nov 09 01:46:42 AM". Falls back to UTC.
function local(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Edmonton', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).replace(',', '');
  } catch (_) { return iso.replace('T', ' ').replace('Z', ' UTC'); }
}

function showRows(rows, since, log) {
  const x = rows.filter((r) => !since || r.date >= since).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  log(`${'symbol'.padEnd(12)} ${'verdict'.padEnd(17)} ${'case'.padEnd(15)} ${'tradable (Edmonton)'.padEnd(22)} ${'bot lag'.padStart(8)}  code from`);
  for (const r of x) {
    const v = r.verdict === 'DO NOT SNIP' && r.gate ? `DO NOT SNIP (G${r.gate})` : r.verdict;
    log(`${String(r.symbol).slice(0, 12).padEnd(12)} ${String(v).padEnd(17)} ${String(r.case).padEnd(15)} ${local(r.tradable_utc).padEnd(22)} ${(r.bot_lag_s == null ? '?' : `${r.bot_lag_s} s`).padStart(8)}  ${r.code_from || ''}${r.explorer_early_s != null ? ` (explorer ${r.explorer_early_s} s early)` : ''}`);
  }
  log(`${x.length} row(s)`);
  return x;
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const o = { show: null, live: false, dates: null, verdicts: ['SNIP', '6'], out: path.join(ROOT, 'extras', 'ready', 'ready-times'), fresh: false, explorer: true, delayMs: 300 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => { i += 1; if (i >= argv.length) throw new Error(`${a} needs a value`); return argv[i]; };
    if (a === '--live') o.live = true;
    else if (a === '--show') o.show = val();
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--no-explorer') o.explorer = false;
    else if (a === '--dates') o.dates = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--verdicts') o.verdicts = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--delay') o.delayMs = Number(val());
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main(inject = {}) {
  const o = inject.opts || parseArgs(process.argv.slice(2));
  const log = inject.log || console.log;
  const screensDir = inject.screensDir || path.join(ROOT, 'screens');
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const jsonl = `${o.out}.jsonl`;
  if (o.show) { const rows = showRows(readJsonl(jsonl), o.show, log); return { added: 0, total: rows.length, rows }; }
  if (o.fresh) { try { fs.unlinkSync(jsonl); } catch (_) { /* none */ } }

  let blockTime = inject.blockTime;
  if (!blockTime) {
    // config.RPC_URL (Robinhood Chain), like the bot itself. NOT RPC_URL from .env,
    // which may point at another chain (on the server it is an Ethereum endpoint).
    const { ethers } = require('ethers');
    const config = require('../config');
    const p = new ethers.providers.StaticJsonRpcProvider(config.RPC_URL);
    const net = await p.getNetwork();
    if (Number(net.chainId) !== Number(config.CHAIN_ID)) throw new Error(`RPC is chain ${net.chainId}, expected ${config.CHAIN_ID}: stopping`);
    const cache = new Map();
    blockTime = async (n) => { if (!cache.has(n)) { const b = await p.getBlock(n); if (!b) throw new Error('no block'); cache.set(n, b.timestamp); } return cache.get(n); };
  }
  const get = o.explorer ? (inject.get || explorerGetter()) : null;

  // Rows that failed for a passing reason (no block time, explorer error) are dropped
  // and done again; complete rows are kept.
  // An explorer error is retried only while the token is under 2 days old: some
  // addresses fail every time (HTTP 500), and retrying those for ever would cost
  // explorer credits on every run. Older ones keep the bot's own observation.
  const prev = readJsonl(jsonl);
  const nowSec = inject.nowSec || Math.round(Date.now() / 1000);
  const retryExplorer = (r) => /explorer (HTTP [^4]|error)/.test(r.notes || '') && nowSec - (tsOf(r.bot_marked_utc) || 0) < 2 * 86400;
  const complete = prev.filter((r) => r.launch_utc && !retryExplorer(r));
  if (complete.length !== prev.length) fs.writeFileSync(jsonl, complete.map((r) => JSON.stringify(r) + '\n').join(''));
  const done = new Set(complete.map((r) => lc(r.token) + '|' + r.date + r.time));
  const todo = readScreens(screensDir, { dates: o.dates })
    .filter((s) => selected(s, o.verdicts))
    .filter((s) => !done.has(lc(s.j.record.token) + '|' + s.date + s.time));

  let added = 0; let noTime = 0;
  for (const s of todo) {
    const row = await readyRow(s, { blockTime, get });
    // Fail loudly instead of filling the file with empty rows.
    noTime = row.launch_utc ? 0 : noTime + 1;
    if (noTime >= 3) throw new Error('3 launch block times in a row unavailable: check the RPC (nothing more written)');
    if (row.quota) { log('explorer credits used up (HTTP 402): stopping; the rest will be done on the next run'); break; }
    delete row.quota;
    fs.appendFileSync(jsonl, JSON.stringify(row) + '\n');
    added += 1;
    if (!o.live) log(`${row.date} ${row.time} ${String(row.symbol).padEnd(10)} ${row.case.padEnd(12)} tradable ${row.tradable_utc || '?'}  bot +${row.bot_lag_s ?? '?'} s`);
    if (get && o.delayMs) await sleep(o.delayMs);
  }

  const rows = readJsonl(jsonl);
  writeCsv(`${o.out}.csv`, rows);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  log(`${stamp} ready-times: ${added} new, ${rows.length} in total`);
  if (!o.live) for (const l of summary(rows)) log(l);
  return { added, total: rows.length, rows };
}

module.exports = { main, parseArgs, readyRow, verifiedAt, codeBounds, codeTime, showRows, selected, readScreens, summary, median, COLS };

if (require.main === module) {
  main().catch((e) => { console.error(`ready-times: ${e && e.stack || e}`); process.exit(1); });
}
