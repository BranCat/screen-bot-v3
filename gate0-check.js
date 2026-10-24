// gate0-check.js — READ-ONLY checks to run on the droplet BEFORE switching on the
// 2026-10-16 Gate 0 change. Never trades, never simulates, never writes launches.jsonl.
//
//   node gate0-check.js templates            does the template shortcut match the right tokens?
//   node gate0-check.js timing [--limit 200] [--recheck file] [--csv out.csv] [--delay 200]
//                                            how long after launch did hidden sources get verified?
//
// templates: for every Pons launchpad token in launches.jsonl (screened or skipped) it
//   fetches the runtime bytecode and runs template-match.js against known-templates.json.
//   Expected: the PonsV2LauncherToken tokens (HRX, IRIDIUS, ... and the 8 skipped on
//   15 Oct: WINDFOIL, TOTALIS, BONT, TRT, BURROW, OpenAI, OPENAI, CUE) say MATCH.
//   As a control it also tries a few direct-pool tokens (1770-byte and PonsLauncherToken):
//   they must say no (not on the Pons hook / bytecode differs).
// timing: for Gate 0 skips that recheck-night.jsonl found published later, asks the
//   explorer when each was verified and compares that with the launch block's time.
//   Tells us whether +30s / 1m / 2m / 5m is the right re-check schedule.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const { RPC_URL } = require('./config');
const { codeFingerprint, createTemplateMatcher } = require('./template-match');

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const args = process.argv.slice(2);
const mode = args[0] || 'templates';
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : []);
const launches = readJsonl(path.join(__dirname, flag('--launches', 'launches.jsonl')));

async function templates() {
  const match = createTemplateMatcher({ getCode: (a) => provider.getCode(a) });
  const pons = launches.filter((r) => r.launchPath === 'Pons launchpad');
  const ctrl = launches.filter((r) => r.launchPath === 'direct v4 pool (no hook)' && r.gate === 0).slice(-5);
  const rows = [];
  for (const r of [...pons, ...ctrl]) {
    let src;
    try {
      const code = await provider.getCode(r.token);
      const fp = codeFingerprint(code);
      src = fp ? { isProxy: false, bytecodeSizeBytes: fp.sizeBytes, codeSha256NoMeta: fp.sha256NoMeta } : null;
    } catch (e) { rows.push([r, 'ERROR', e.message]); continue; }
    if (!src) { rows.push([r, 'no code', '']); continue; }
    const m = await match(src, { hooks: r.hooks });
    rows.push([r, m.matched ? 'MATCH' : 'no', `${src.bytecodeSizeBytes} bytes — ${m.reason}`]);
  }
  for (const [r, v, why] of rows) {
    console.log(`${String(v).padEnd(6)} ${String(r.symbol || '?').padEnd(12)} ${r.token}  gate ${String(r.gate)}  ${r.launchPath}\n        ${why}`);
  }
  const ponsRows = rows.filter(([r]) => r.launchPath === 'Pons launchpad');
  const ctrlRows = rows.filter(([r]) => r.launchPath !== 'Pons launchpad');
  console.log(`\nPons launchpad: ${ponsRows.filter((x) => x[1] === 'MATCH').length} of ${ponsRows.length} match`);
  console.log(`Controls (direct pools): ${ctrlRows.filter((x) => x[1] === 'MATCH').length} of ${ctrlRows.length} match (must be 0)`);
}

async function timing() {
  const { explorerUrl, explorerHttp, explorerUA, redact } = require('./source-gate');
  const recheck = readJsonl(path.join(__dirname, flag('--recheck', 'recheck-night.jsonl')));
  const pub = new Map(recheck.filter((x) => x.gate0 && x.gate0.sourceVerified).map((x) => [x.token.toLowerCase(), x]));
  const limit = Number(flag('--limit', 200));
  // 2026-10-16 (full run): since the re-check change, a hidden source + pullable liquidity is
  // recorded at gate '1b' with sourceHidden:true, so count those too; one row per token.
  const seenTok = new Set();
  let cands = launches.filter((r) => {
    const k = String(r.token).toLowerCase();
    if (!(r.sourceHidden === true || r.gate === 0) || !pub.has(k) || r.launchBlock == null || seenTok.has(k)) return false;
    seenTok.add(k); return true;
  });
  // every hook launch, then the most recent direct pools up to the limit
  cands = [...cands.filter((r) => r.launchPath !== 'direct v4 pool (no hook)'), ...cands.filter((r) => r.launchPath === 'direct v4 pool (no hook)').reverse()].slice(0, limit);
  const out = [];
  let shownKeys = false;
  for (const r of cands) {
    const subj = pub.get(r.token.toLowerCase()).gate0.verificationSubject || r.token;
    const H = explorerHttp();
    const { status, json, error } = await H(explorerUrl(`/smart-contracts/${subj}`), { userAgent: explorerUA() });
    const vAt = json && (json.verified_at || json.verifiedAt);
    if (!vAt) {
      if (!shownKeys && json) { console.log(`(no verified_at in the explorer answer; fields: ${Object.keys(json).slice(0, 30).join(', ')})`); shownKeys = true; }
      out.push({ r, err: redact(error || `HTTP ${status}, no verified_at`) });
      continue;
    }
    const b = await provider.getBlock(Number(r.launchBlock));
    const delay = Math.round(Date.parse(vAt) / 1000 - b.timestamp);
    out.push({ r, delay, vAt });
    await new Promise((res) => setTimeout(res, Number(flag('--delay', 200))));
  }
  const csvFile = flag('--csv', null);
  if (csvFile) {
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = ['symbol,token,launchPath,gate,bytecodeSizeBytes,launchBlock,detectedAt,verifiedAt,delaySec,error'];
    for (const x of out) {
      const g = pub.get(x.r.token.toLowerCase()).gate0 || {};
      rows.push([x.r.symbol, x.r.token, x.r.launchPath, x.r.gate, g.bytecodeSizeBytes, x.r.launchBlock, x.r.detectedAt, x.vAt, x.delay, x.err].map(esc).join(','));
    }
    fs.writeFileSync(path.resolve(__dirname, csvFile), rows.join('\n') + '\n');
    console.log(`CSV: ${csvFile} (${out.length} rows)`);
  }
  for (const x of out) {
    console.log(`${String(x.r.symbol || '?').padEnd(12)} ${x.r.token}  ${x.r.launchPath.padEnd(26).slice(0, 26)}  ${x.err ? `?  ${x.err}` : `verified ${x.delay}s after launch`}`);
  }
  const d = out.filter((x) => x.delay != null).map((x) => x.delay).sort((a, b) => a - b);
  if (!d.length) { console.log('\nno timings'); return; }
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  const within = (s) => `${d.filter((x) => x <= s).length}/${d.length}`;
  console.log(`\n${d.length} timings. median ${q(0.5)}s, p90 ${q(0.9)}s, max ${d[d.length - 1]}s`);
  console.log(`verified within 30s ${within(30)}, 60s ${within(60)}, 120s ${within(120)}, 300s ${within(300)}, 10m ${within(600)}, 15m ${within(900)}, 30m ${within(1800)}, 1h ${within(3600)}, 6h ${within(21600)}`);
  const byPath = {};
  for (const x of out) if (x.delay != null) (byPath[x.r.launchPath || 'unknown'] = byPath[x.r.launchPath || 'unknown'] || []).push(x.delay);
  for (const [lp, arr] of Object.entries(byPath)) {
    arr.sort((a, b) => a - b);
    const w = (s) => arr.filter((v) => v <= s).length;
    console.log(`  ${lp.padEnd(26)} n=${arr.length}  median ${arr[Math.floor(arr.length / 2)]}s  <=5m ${w(300)}  <=30m ${w(1800)}  <=1h ${w(3600)}  max ${arr[arr.length - 1]}s`);
  }
  console.log(`no timestamp (e.g. Sourcify only) or lookup error: ${out.filter((x) => x.delay == null).length}`);
  const hooks = out.filter((x) => x.delay != null && x.r.launchPath !== 'direct v4 pool (no hook)');
  if (hooks.length) console.log(`hook launches: ${hooks.map((x) => `${x.r.symbol} ${x.delay}s`).join(', ')}`);
}

(mode === 'timing' ? timing() : templates()).catch((e) => { console.log(`gate0-check error: ${e.message}`); process.exit(2); });
