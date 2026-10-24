// rescreen-published.js — run the full screener (Gates 0-6) on tokens whose
// source was hidden at launch but has been published since, to see which of
// them can actually be bought and sold safely.
//
// READ-ONLY: never trades. Gates 2-6 are Tenderly simulations (they use
// Tenderly quota); Gates 0-1b are plain RPC reads. Tokens that fail Gate 1b
// (creator can pull / drained) never reach Tenderly.
//
// IMPORTANT: this screens each token's CURRENT state (hours or days after
// launch), not its state at launch. A pool that has been drained since will
// now fail Gate 1b — which is itself the answer to "did it rug?".
//
//   node rescreen-published.js
//     [--recheck recheck-full-1016.jsonl]   which tokens are public now (from recheck-source.js)
//     [--launches launches-snap-1016.jsonl] launch records (pool hints, launch path)
//     [--out rescreen-1016.jsonl]           one line per token (appended)
//     [--only all|hooks]                    hooks = Pons + custom hooks only (default all;
//                                           hooks are always screened first)
//     [--max-sim 60]                        stop after this many tokens reached the
//                                           Tenderly gates (2-6), to cap quota use
//     [--limit N] [--delay 500] [--amount 0.05]
//
// Tokens already in --out are skipped, so a stopped run can simply be restarted.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const util = require('util');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const here = (f) => path.resolve(__dirname, f);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : []);
const lc = (s) => String(s || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIM_GATES = new Set([2, 3, 4, 5, 6, '2', '3', '4', '5', '6', '5b', '5c', '5d']);

// Pure: pick the tokens to screen, hooks first. Exported for tests.
function pickTargets(recheckRows, launchRows, { only = 'all' } = {}) {
  const byTok = new Map();
  for (const r of launchRows) if (r && r.token && !byTok.has(lc(r.token))) byTok.set(lc(r.token), r);
  const seen = new Set();
  const out = [];
  for (const x of recheckRows) {
    if (!x || !x.token || !x.gate0 || x.gate0.decision !== 'PASS') continue;
    const k = lc(x.token);
    if (seen.has(k)) continue;
    seen.add(k);
    const rec = byTok.get(k) || {};
    const launchPath = x.launchPath || rec.launchPath || 'unknown';
    const isDirect = /^direct /.test(launchPath);
    if (only === 'hooks' && isDirect) continue;
    out.push({ token: x.token, symbol: x.symbol || rec.symbol || null, launchPath, isDirect,
      detectedAt: rec.detectedAt || x.detectedAt || null, launchVerdict: rec.verdict || null, launchGate: rec.gate ?? null });
  }
  out.sort((a, b) => Number(a.isDirect) - Number(b.isDirect));
  return out;
}

// Pure: summary buckets. Exported for tests.
function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const g = /^direct /.test(r.launchPath || '') ? 'direct pools' : /pons/i.test(r.launchPath || '') ? 'Pons launchpad' : 'custom hooks';
    const key = r.verdict === 'DO NOT SNIP' ? `DO NOT SNIP @ gate ${r.gate}` : r.verdict;
    by[g] = by[g] || { total: 0 };
    by[g].total += 1;
    by[g][key] = (by[g][key] || 0) + 1;
  }
  return by;
}

async function main() {
  const recheckFile = here(flag('--recheck', 'recheck-full-1016.jsonl'));
  const launchesFile = here(flag('--launches', 'launches-snap-1016.jsonl'));
  const outFile = here(flag('--out', 'rescreen-1016.jsonl'));
  const only = flag('--only', 'all');
  const maxSim = Number(flag('--max-sim', 60));
  const limit = Number(flag('--limit', 0));
  const delayMs = Number(flag('--delay', 500));
  const amountEth = Number(flag('--amount', 0.05));

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const logFile = here(path.join('logs', `rescreen-${stamp}.txt`));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const orig = console.log.bind(console);
  const toLog = (...a) => { try { fs.appendFileSync(logFile, util.format(...a) + '\n'); } catch (_) { /* keep going */ } };
  const say = (...a) => { orig(...a); toLog(...a); };     // progress: screen + log
  console.log = (...a) => toLog(...a);                     // screener chatter: log only

  const { screen, poolHintsFromLaunches } = require('./screen-token');
  const done = new Set(readJsonl(outFile).map((r) => lc(r.token)));
  let targets = pickTargets(readJsonl(recheckFile), readJsonl(launchesFile), { only }).filter((t) => !done.has(lc(t.token)));
  if (limit > 0) targets = targets.slice(0, limit);

  say(`rescreen-published — ${new Date().toISOString()}`);
  say(`${targets.length} published tokens to screen (${done.size} already in ${path.basename(outFile)}); --only ${only}, --max-sim ${maxSim}`);
  say(`Log: ${logFile}\n`);

  let simCount = 0;
  for (const [i, t] of targets.entries()) {
    if (simCount >= maxSim) { say(`\nReached --max-sim ${maxSim} tokens at the Tenderly gates — stopping. Re-run to continue.`); break; }
    const t0 = Date.now();
    let r;
    try {
      const poolHints = poolHintsFromLaunches(t.token, launchesFile);
      r = await screen(t.token, { amountEth, poolHints, hiddenSource: 'final' });
    } catch (e) {
      r = { verdict: 'UNKNOWN', reason: `screener error: ${e.message}`, gate: null, flags: [] };
    }
    const reachedSim = SIM_GATES.has(r.gate) || r.verdict === 'SNIP';
    if (reachedSim) simCount += 1;
    const row = { screenedAt: new Date().toISOString(), ...t, verdict: r.verdict, gate: r.gate ?? null,
      reason: r.reason, flags: r.flags || [], reachedSim, seconds: Math.round((Date.now() - t0) / 1000) };
    fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
    say(`${String(i + 1).padStart(4)}  ${(t.symbol || '?').slice(0, 12).padEnd(12)} ${t.launchPath.slice(0, 22).padEnd(22)}  ${r.verdict}${r.gate != null ? ` @${r.gate}` : ''} — ${String(r.reason || '').slice(0, 90)}`);
    if (delayMs) await sleep(delayMs);
  }

  const all = readJsonl(outFile);
  say('\n--- summary (everything in the output file) ---');
  const s = summarize(all);
  for (const [g, v] of Object.entries(s)) {
    const { total, ...rest } = v;
    say(`${g.padEnd(15)} ${String(total).padStart(5)}  ${Object.entries(rest).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(' · ')}`);
  }
  const snips = all.filter((r) => r.verdict === 'SNIP');
  if (snips.length) say(`\nSNIP now: ${snips.map((r) => `${r.symbol} ${r.token}`).join(', ')}`);
  say(`Tenderly-gate tokens this run: ${simCount}`);
}

module.exports = { pickTargets, summarize };
if (require.main === module) main().catch((e) => { console.error(`rescreen error: ${e.stack || e.message}`); process.exit(2); });
