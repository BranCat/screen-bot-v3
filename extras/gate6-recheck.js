// extras/gate6-recheck.js — a SECOND OPINION on Gate 6 (the rug check), run
// beside the live bot. It never changes a verdict and never touches the live
// files: it reads screens/ and writes extras/gate6/.
//
// Why: on 19 Oct five tokens ended "PASSED GATES 0-5" because the rug check's
// own buy-and-sell reverted ("baseline sell reverted"), although Gates 3 and 4
// had just sold the same token cleanly. rug-check.js sends its Tenderly bundles
// without a block number, so they land on whatever block is newest, while the
// sell is sized from Gate 3's buy on Gate 3's pinned block. When the price falls
// more than 10% in between, the 100/99/95/90% sell ladder asks for tokens the
// wallet never received: the same fault fixed in Gate 4 (18 Oct) and 5b (19 Oct).
//
// What this does differently, without editing rug-check.js:
//   - every Tenderly bundle is pinned to the screen's own block (record.audit.
//     pinnedBlock, the block Gates 3 to 5b used), by wrapping
//     tenderly-client.simulateBundle before rug-check.js is loaded;
//   - every RPC read (position census, owner lookups) is made "as of" that block;
//   - the whale's balance is read on-chain at that block, not taken from the
//     explorer's (possibly lagging) holder list;
//   - the v3 rule: a pass on a pool whose liquidity controller is not LOCKED
//     (every v3 pool today) is reported as "pass, liquidity control unknown",
//     never as "would SNIP".
//
//   node extras/gate6-recheck.js                       every PASSED GATES 0-5 token not yet rechecked
//   node extras/gate6-recheck.js --set snip --max 3    3 SNIPs, as a control (should agree with the bot)
//   node extras/gate6-recheck.js --set gate6           every token the bot judged at Gate 6
//   node extras/gate6-recheck.js --token 0x...         one token (its latest screen), any verdict
//   [--dates 2026-10-19,...] [--max 10] [--fresh] [--out extras/gate6]
//
// Cost: about 3 to 6 Tenderly simulations and 1 explorer lookup per token.
// --max caps the number of tokens per run (default 10).

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch (_) { /* optional */ }
const config = require('../config');
const ADDR = config.ADDR;

// ---- the pin: installed BEFORE rug-check.js is required, because it
// destructures simulateBundle from tenderly-client at load time.
const client = require('../tenderly-client');
const realSimulate = client.simulateBundle;
const PIN = { block: null, bundles: 0, refused: 0 };
client.simulateBundle = async (steps) => {
  PIN.bundles += 1;
  if (PIN.block == null) return realSimulate(steps);
  return realSimulate(steps.map((st) => ({ ...st, block_number: PIN.block })));
};
const rug = require('../rug-check');

const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a || '').toLowerCase();
const erc20 = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)']);
const NO_HISTORY_RE = /missing trie node|header not found|historical state|state (is )?not available|pruned|unknown block|block not found|state histories/i;

// A provider that answers "as of" one block. If the RPC has no state that far
// back, reads fall back to the newest block once and the result says so.
function pinnedProvider(base, block, note) {
  let fellBack = false;
  const tag = (t) => (t == null ? (fellBack ? 'latest' : block) : t);
  const guard = async (fn, t) => {
    try { return await fn(tag(t)); } catch (e) {
      if (!fellBack && NO_HISTORY_RE.test(String(e.body || e.message || e))) {
        fellBack = true;
        note('the RPC has no state for the screen block; RPC reads fell back to the newest block (Tenderly stays pinned)');
        return fn('latest');
      }
      throw e;
    }
  };
  return {
    getBlockNumber: async () => block,
    call: (tx, t) => guard((b) => base.call(tx, b), t),
    getCode: (a, t) => guard((b) => base.getCode(a, b), t),
    getBalance: (a, t) => guard((b) => base.getBalance(a, b), t),
    getStorageAt: (a, s, t) => guard((b) => base.getStorageAt(a, s, b), t),
    getLogs: (f) => base.getLogs({ ...f, toBlock: Math.min(Number(f.toBlock ?? block), block) }),
    getBlock: (b) => base.getBlock(b),
    getNetwork: () => base.getNetwork(),
    get _isProvider() { return true; },
  };
}

// ---------------------------------------------------------------- screens

function readScreens(screensDir, dates) {
  const out = [];
  let days;
  try { days = fs.readdirSync(screensDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch (_) { return out; }
  if (dates && dates.length) days = days.filter((d) => dates.includes(d));
  for (const day of days) {
    for (const f of fs.readdirSync(path.join(screensDir, day)).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(screensDir, day, f), 'utf8'));
        if (j && j.record) out.push({ file: `${day}/${f}`, date: day, time: f.slice(0, 6), j });
      } catch (_) { /* skip unreadable */ }
    }
  }
  return out;
}

// set: passed (PASSED GATES 0-5), gate6 (anything the bot judged at Gate 6,
// including its SNIPs), snip, or a token address.
function pick(screens, { set = 'passed', token = null } = {}) {
  const latest = new Map();
  for (const s of screens) if (s.j.record.token) latest.set(lc(s.j.record.token), s);
  let list = [...latest.values()];
  if (token) return list.filter((s) => lc(s.j.record.token) === lc(token));
  list = list.filter((s) => {
    const r = s.j.record;
    const v = String(r.verdict || '');
    if (set === 'snip') return v === 'SNIP';
    if (set === 'gate6') return v === 'SNIP' || String(r.gate) === '6';
    return v.startsWith('PASSED');
  });
  return list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// What the rug check needs, from the screen file. Returns { error } when the
// file was written before the fields existed.
function inputsOf(j) {
  const r = j.record || {};
  const d = j.detail || {};
  const p = d.pool;
  const rt1 = (d.roundTrips && d.roundTrips.sim1) || null;
  const block = (r.audit && r.audit.pinnedBlock) || (rt1 && rt1.pinnedBlock) || null;
  if (!p) return { error: 'no pool in the screen file' };
  if (!rt1 || !rt1.tokensReceivedWei) return { error: 'no Gate 3 round trip in the screen file (it stopped before Gate 3)' };
  if (block == null) return { error: 'no pinned block in the screen file (screened before 18 Oct)' };
  const ctl = d.controller || {};
  return {
    pool: { ...p, createdBlock: p.createdBlock ?? r.createdBlock ?? r.launchBlock ?? null },
    block: Number(block),
    amountWei: ethers.utils.parseEther(String(rt1.amountEth || 0.05)),
    tokenOutWei: BN(rt1.tokensReceivedWei),
    startSellBps: rt1.soldBps || 10000,
    controller: { verdict: ctl.verdict || 'UNKNOWN', reason: ctl.reason || 'no controller result in the screen file' },
    whaleFromScreen: (j.result && j.result.rug && j.result.rug.whaleDump && j.result.rug.whaleDump.whale) || null,
  };
}

// The top holder (from the explorer, the same lookup the bot uses), with its
// balance read on-chain at the screen block.
async function whaleAt(inp, provider, opts = {}) {
  const w = await rug.findWhale(inp.pool, ADDR, { http: opts.http });
  if (w.error) return { error: w.error };
  let bal;
  try {
    const raw = await provider.call({ to: inp.pool.tokenAddr, data: erc20.encodeFunctionData('balanceOf', [w.address]) });
    bal = erc20.decodeFunctionResult('balanceOf', raw)[0];
  } catch (e) {
    return { error: `balance of the top holder at the screen block could not be read: ${String(e.message || e).slice(0, 120)}` };
  }
  return { address: w.address, balanceWei: bal, explorerBalanceWei: w.balanceWei, isContract: w.isContract ?? null };
}

// The second opinion for one token.
async function recheck(s, { provider, http = null } = {}) {
  const r = s.j.record;
  const out = {
    date: s.date, time: s.time, file: s.file, symbol: r.symbol, token: r.token, version: r.version,
    liveVerdict: r.verdict, liveReason: r.reason, block: null,
    secondOpinion: null, reason: null, baselineOk: null, baselineRatio: null, whaleRecovery: null,
    removal: null, whale: null, whaleNote: null, controller: null, bundles: 0, notes: [],
  };
  const inp = inputsOf(s.j);
  if (inp.error) { out.secondOpinion = 'NOT RUN'; out.reason = inp.error; return out; }
  out.block = inp.block;
  out.controller = inp.controller.verdict;

  const note = (m) => { if (!out.notes.includes(m)) out.notes.push(m); };
  const prov = pinnedProvider(provider, inp.block, note);
  const head = await provider.getBlockNumber();
  const lookback = inp.pool.createdBlock != null ? Math.max(200000, inp.block - Number(inp.pool.createdBlock) + 1000) : 200000;

  const whale = await whaleAt(inp, prov, { http });
  const opts = {
    provider: prov,
    baseAmountWei: inp.amountWei,
    baselineTokenOutWei: inp.tokenOutWei,
    startSellBps: inp.startSellBps,
    controller: inp.controller,
    lookbackBlocks: lookback,
    http,
  };
  if (whale.error) {
    out.whaleNote = whale.error;
  } else {
    out.whale = whale.address;
    if (whale.balanceWei.isZero()) {
      out.whaleNote = 'today\'s top holder held nothing at the screen block; the whale dump cannot be tested this way';
      // Hand the rug check that zero balance, so it does not look the holder up
      // again and dump today's balance on the old block.
      opts.whale = whale.address;
      opts.whaleBalanceWei = BN(0);
    } else {
      opts.whale = whale.address;
      opts.whaleBalanceWei = whale.balanceWei;
      if (!whale.explorerBalanceWei.eq(whale.balanceWei)) {
        out.whaleNote = 'explorer balance differs from the on-chain balance at the screen block; the on-chain one was used';
      }
    }
    if (inp.whaleFromScreen && lc(inp.whaleFromScreen) !== lc(whale.address)) note(`the bot's whale was ${inp.whaleFromScreen}; the explorer's top holder is now ${whale.address}`);
  }
  if (head - inp.block > 0) note(`rechecked ${((head - inp.block) / 36000).toFixed(1)} h after the screen, on the screen's own block ${inp.block}`);

  PIN.block = inp.block;
  const before = PIN.bundles;
  let res;
  try {
    res = await rug.rugCheck(inp.pool, ADDR, opts);
  } catch (e) {
    res = { decision: 'ERROR', reason: String(e.message || e) };
  } finally {
    PIN.block = null;
  }
  out.bundles = PIN.bundles - before;

  const pr = res.probes || {};
  out.baselineOk = pr.baseline ? pr.baseline.ok : null;
  out.baselineRatio = pr.baseline && pr.baseline.ratio != null ? Number(pr.baseline.ratio.toFixed(4)) : null;
  out.whaleRecovery = pr.whaleDump && pr.whaleDump.recoveryFraction != null ? pr.whaleDump.recoveryFraction : null;
  out.removal = pr.removal ? pr.removal.verdict : null;
  for (const n of res.notes || []) if (!/local copy of encodeV4SwapExecute/.test(n)) note(n);

  // The v3 rule: a pass without a known liquidity controller is never a SNIP.
  const locked = inp.controller.verdict === 'LOCKED';
  if (res.decision === 'PASS') {
    out.secondOpinion = locked ? 'WOULD SNIP' : 'PASS, LIQUIDITY CONTROL UNKNOWN';
    out.reason = locked ? res.reason : `${res.reason} BUT the liquidity controller is ${inp.controller.verdict} (${inp.controller.reason}), so this is not a SNIP.`;
  } else if (res.decision === 'SKIP') {
    out.secondOpinion = 'DO NOT SNIP';
    out.reason = res.reason;
  } else if (res.decision === 'UNPROVEN') {
    out.secondOpinion = 'STILL INCONCLUSIVE';
    out.reason = res.reason;
  } else {
    out.secondOpinion = 'ERROR';
    out.reason = res.reason;
  }
  if (r.version === 'v3' || !locked) note('v3 rule: liquidity control is not established for this pool; never trust a pass here');
  return out;
}

// Does the second opinion agree with the bot?
function agreement(row) {
  const live = row.liveVerdict;
  const so = row.secondOpinion;
  if (so === 'NOT RUN' || so === 'ERROR') return '';
  if (live === 'SNIP' && so === 'WOULD SNIP') return 'agrees';
  if (live === 'DO NOT SNIP' && so === 'DO NOT SNIP') return 'agrees';
  if (String(live).startsWith('PASSED') && so === 'STILL INCONCLUSIVE') return 'agrees';
  if (String(live).startsWith('PASSED') && so === 'WOULD SNIP') return 'bot missed a SNIP';
  if (String(live).startsWith('PASSED') && so === 'DO NOT SNIP') return 'bot missed a rejection';
  if (live === 'SNIP' && so !== 'WOULD SNIP') return 'DISAGREES with a SNIP: look at it';
  return 'differs';
}

function csvOf(rows) {
  const head = ['date', 'time', 'symbol', 'token', 'version', 'live_verdict', 'second_opinion', 'agreement', 'block', 'controller',
    'baseline_ok', 'baseline_ratio', 'whale_recovery', 'removal', 'bundles', 'reason', 'whale_note', 'notes'];
  const esc = (v) => { if (v == null) return ''; const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return [head.join(','), ...rows.map((r) => [r.date, r.time, r.symbol, r.token, r.version, r.liveVerdict, r.secondOpinion, agreement(r),
    r.block, r.controller, r.baselineOk, r.baselineRatio, r.whaleRecovery, r.removal, r.bundles, r.reason, r.whaleNote,
    (r.notes || []).join('; ')].map(esc).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const a = argv.slice(2);
  const val = (f, d) => { const i = a.indexOf(f); return i >= 0 && a[i + 1] != null ? a[i + 1] : d; };
  return {
    set: val('--set', 'passed'),
    token: val('--token', null),
    dates: val('--dates', '') ? val('--dates', '').split(',').map((x) => x.trim()).filter(Boolean) : null,
    max: Number(val('--max', 10)),
    fresh: a.includes('--fresh'),
    out: val('--out', path.join('extras', 'gate6')),
    screens: val('--screens', path.join(ROOT, 'screens')),
    rpc: val('--rpc', process.env.LOOKBACK_RPC || config.RPC_URL),
  };
}

// inject: { argv, provider, http } for the offline tests only.
async function main(inject = {}) {
  const o = parseArgs(inject.argv || process.argv);
  const provider = inject.provider || new ethers.providers.StaticJsonRpcProvider(o.rpc, config.CHAIN_ID);
  fs.mkdirSync(o.out, { recursive: true });
  const jsonl = path.join(o.out, 'gate6.jsonl');
  if (o.fresh && fs.existsSync(jsonl)) fs.unlinkSync(jsonl);
  const done = new Map();
  if (fs.existsSync(jsonl)) {
    for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.set(`${lc(r.token)}|${r.file}`, r); } catch (_) { /* skip */ }
    }
  }
  const list = pick(readScreens(o.screens, o.dates), { set: o.set, token: o.token })
    .filter((s) => o.token || !done.has(`${lc(s.j.record.token)}|${s.file}`) || /^ERROR/.test(done.get(`${lc(s.j.record.token)}|${s.file}`).secondOpinion));
  // Files that cannot be rechecked (screened before the fields existed) are
  // recorded at once and do not use up --max.
  for (const s of list.filter((x) => inputsOf(x.j).error)) {
    const r = s.j.record;
    const row = { date: s.date, time: s.time, file: s.file, symbol: r.symbol, token: r.token, version: r.version, liveVerdict: r.verdict, secondOpinion: 'NOT RUN', reason: inputsOf(s.j).error, notes: [] };
    if (!done.has(`${lc(row.token)}|${row.file}`)) fs.appendFileSync(jsonl, JSON.stringify(row) + '\n');
    done.set(`${lc(row.token)}|${row.file}`, row);
  }
  const runnable = list.filter((x) => !inputsOf(x.j).error);
  const run = runnable.slice(0, o.max > 0 ? o.max : runnable.length);
  console.log(`gate6-recheck: ${runnable.length} token(s) to recheck in set "${o.token ? o.token : o.set}", running ${run.length} (--max ${o.max}); ${list.length - runnable.length} too old to recheck\n`);

  let i = 0;
  for (const s of run) {
    i += 1;
    process.stdout.write(`[${i}/${run.length}] ${String(s.j.record.symbol).padEnd(12)} live: ${String(s.j.record.verdict).padEnd(17)} `);
    let row;
    try { row = await recheck(s, { provider, http: inject.http || null }); } catch (e) {
      row = { date: s.date, time: s.time, file: s.file, symbol: s.j.record.symbol, token: s.j.record.token, liveVerdict: s.j.record.verdict, secondOpinion: 'ERROR', reason: String(e.message || e).slice(0, 200), notes: [] };
    }
    console.log(`second opinion: ${row.secondOpinion}${agreement(row) ? ` (${agreement(row)})` : ''}`);
    console.log(`        ${String(row.reason || '').slice(0, 260)}`);
    if (row.whaleNote) console.log(`        whale: ${row.whaleNote}`);
    fs.appendFileSync(jsonl, JSON.stringify(row) + '\n');
    done.set(`${lc(row.token)}|${row.file}`, row);
  }
  const all = [...done.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  fs.writeFileSync(path.join(o.out, 'gate6.csv'), csvOf(all));
  console.log(`\nwrote ${path.join(o.out, 'gate6.csv')} (${all.length} rows). Tenderly bundles this run: ${PIN.bundles}.`);
  console.log('The live bot\'s verdicts are unchanged: this is a second opinion only.');
  return 0;
}

module.exports = { main, recheck, inputsOf, pick, readScreens, pinnedProvider, agreement, csvOf, PIN };

if (require.main === module) {
  main().then((c) => process.exit(c || 0)).catch((e) => { console.error('gate6-recheck failed:', e.message || e); process.exit(1); });
}
