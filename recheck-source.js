// recheck-source.js — run every token that Gate 0 skipped in launches.jsonl back
// through the current Gate 0 (Sourcify + block explorer), to see which of them
// really hid their source.
//
//   node recheck-source.js                 re-check every Gate 0 skip
//   node recheck-source.js --screen        ...and run the full screen-token.js on any that now pass
//   [--in launches.jsonl] [--out recheck-source.jsonl] [--limit N] [--delay 300]
//
// launches.jsonl is only read, never changed. Results go to recheck-source.jsonl
// (one line per token) and the full printout to logs/recheck-<time>.txt.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const util = require('util');
const { sourceGate } = require('./source-gate');
const { RPC_URL, CHAIN_ID } = require('./config');
const { albertaISOString } = require('./watch-launches');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure: which records to re-check (Gate 0 skips, one per token, in file order).
function pickSkipped(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const hidden = r.sourceHidden === true || (r.gate === 0 && r.verdict === 'DO NOT SNIP');
    if (!hidden || !r.token) continue;
    const k = r.token.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// Pure: tally results into the summary buckets.
function summarize(results) {
  const s = { total: results.length, stillHidden: 0, nowPublic: 0, twinOnly: 0, couldNotTell: 0, byPath: {} };
  for (const x of results) {
    const d = x.gate0.decision;
    if (d === 'PASS') s.nowPublic += 1;
    else if (d === 'ERROR') s.couldNotTell += 1;
    else { s.stillHidden += 1; if (x.gate0.explorer_twin) s.twinOnly += 1; }
    const p = x.launchPath || 'unknown';
    s.byPath[p] = s.byPath[p] || { total: 0, nowPublic: 0 };
    s.byPath[p].total += 1;
    if (d === 'PASS') s.byPath[p].nowPublic += 1;
  }
  return s;
}

async function main(args) {
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
  const inFile = path.resolve(__dirname, flag('--in', 'launches.jsonl'));
  const outFile = path.resolve(__dirname, flag('--out', 'recheck-source.jsonl'));
  const limit = Number(flag('--limit', 0));
  const delayMs = Number(flag('--delay', 300));
  const doScreen = args.includes('--screen');

  const stamp = albertaISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const logFile = path.resolve(__dirname, 'logs', `recheck-${stamp}.txt`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const orig = console.log.bind(console);
  console.log = (...a) => { orig(...a); try { fs.appendFileSync(logFile, util.format(...a) + '\n'); } catch (_) { /* keep going */ } };

  if (!fs.existsSync(inFile)) { console.log(`no ${inFile} — run watch-launches.js first`); return; }
  let todo = pickSkipped(fs.readFileSync(inFile, 'utf8').split('\n'));
  if (limit > 0) todo = todo.slice(0, limit);
  console.log(`recheck-source — ${albertaISOString()}`);
  console.log(`${todo.length} Gate 0 skips from ${inFile}`);
  console.log(`Log: ${logFile}\n`);

  const results = [];
  let refusedInARow = 0;
  for (const [i, rec] of todo.entries()) {
    let g;
    try {
      g = await sourceGate(rec.token, { rpcUrl: RPC_URL, chain: CHAIN_ID });
    } catch (e) {
      g = { decision: 'ERROR', reason: e.message };
    }
    const tag = g.decision === 'PASS' ? 'PUBLIC' : g.decision === 'ERROR' ? '??' : 'hidden';
    console.log(`${String(i + 1).padStart(4)}  ${tag.padEnd(6)}  ${(rec.symbol || '').slice(0, 12).padEnd(12)} ${rec.token}  ${rec.launchPath || ''} — ${g.reason}`);
    const row = { token: rec.token, symbol: rec.symbol || null, launchPath: rec.launchPath || null, detectedAt: rec.detectedAt || null, gate0: g };

    if (doScreen && g.decision === 'PASS') {
      const { screen } = require('./screen-token');
      try {
        const r = await screen(rec.token, { amountEth: 0.05 });
        row.screen = r;
        console.log(`        ==> ${r.verdict} — ${r.reason}`);
        (r.flags || []).forEach((f) => console.log(`        FLAG: ${f}`));
      } catch (e) {
        row.screen = { verdict: 'UNKNOWN', reason: `screener error: ${e.message}` };
        console.log(`        ==> UNKNOWN — ${e.message}`);
      }
    }
    results.push(row);
    refusedInARow = /HTTP 403/.test(g.reason || '') ? refusedInARow + 1 : 0;
    if (refusedInARow >= 5) {
      console.log('\nThe block explorer refused 5 lookups in a row (HTTP 403) — stopping instead of re-checking the rest.');
      fs.appendFileSync(outFile, JSON.stringify({ checkedAt: albertaISOString(), ...row }) + '\n');
      break;
    }
    fs.appendFileSync(outFile, JSON.stringify({ checkedAt: albertaISOString(), ...row }) + '\n');
    if (delayMs) await sleep(delayMs);
  }

  const s = summarize(results);
  console.log('\n--- summary ---');
  console.log(`re-checked ${s.total}`);
  console.log(`  source public now (Sourcify or explorer): ${s.nowPublic}`);
  console.log(`  still not published anywhere:            ${s.stillHidden}${s.twinOnly ? ` (${s.twinOnly} only match a similar verified contract)` : ''}`);
  console.log(`  could not tell (lookup failed):          ${s.couldNotTell}`);
  for (const [p, v] of Object.entries(s.byPath)) console.log(`  ${p}: ${v.nowPublic} of ${v.total} public`);
  console.log(`\nResults: ${outFile}\nLog: ${logFile}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.log(`recheck-source error: ${e.message}`); process.exit(2); });
}

module.exports = { pickSkipped, summarize };
