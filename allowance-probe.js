// allowance-probe.js — Gate 5c: "can someone ELSE move my tokens without my
// permission, and would the explorer even show it?"
//
//   node allowance-probe.js 0xTOKEN            (standalone, uses launches.jsonl for old pools)
//
// Added 2026-10-12 after Frank's Moo Daeng loss (Ethereum, ~2024): he bought
// 100 tokens, Etherscan showed 100 arriving, balanceOf() said 30. The token's
// transferFrom() looked like this:
//
//     _transfer(sender, recipient, amount);
//     if (!_feeExcluded[msg.sender] && (sender == pair || recipient != 0xdead))
//         _approve(sender, msg.sender, allowance.sub(amount));   // <- the ONLY allowance check
//
// and _transfer() ended with
//
//     if (to != 0xdead) emit Transfer(from, to, amount);
//
// Two backdoors and a cloak:
//   1. ANYONE could call transferFrom(victim, 0xdead, x) with no approval.
//   2. Any "_feeExcluded" caller (the deployer, forever — it survives
//      renounceOwnership) could move anyone's tokens anywhere.
//   3. Moves to 0xdead emitted no Transfer event, so explorers, which build
//      token history from events, kept showing the old balance.
//
// Gates 3-5b could not see any of this: every probe there is the wallet acting
// on its OWN tokens, or a spender the wallet approved. Nothing ever tried a
// stranger. This gate does exactly that, inside one Tenderly bundle:
//
//   buy (fresh victim wallet)
//   STRANGER  transferFrom(victim, 0xdead, q)      no approval given  -> must revert
//   STRANGER  transferFrom(victim, strangerDest, q) no approval given  -> must revert
//   PRIVILEGED transferFrom(victim, itself, q)     owner(), creator, addresses
//                                                  hard-coded in the source -> must revert
//   VICTIM    transfer(0xdead, q)                  a legit burn: must emit Transfer
//   VICTIM    transfer(fresh, q)                   control: must emit Transfer
//
// After every step the victim's real balanceOf() is read back and compared with
// the Transfer events that step emitted. A balance that moves without a
// matching event is a "ghost transfer": the explorer will show the wrong
// balance, which is the whole point of hiding it.
//
// Plus a source scan (when the source is published): an allowance check in
// transferFrom() that only runs under some condition, or an `emit Transfer`
// that only fires under some condition. The infinite-approval shortcut
// (`if (allowed != type(uint256).max)`) is normal and ignored.
//
// GRADING (same scale as transfer-audit.js):
//   high    a stranger, or a privileged WALLET, took tokens without approval
//           -> DO NOT SNIP
//   medium  a privileged CONTRACT (not known launchpad infrastructure) did it;
//           a ghost transfer on the victim's own moves; a suspicious source
//           pattern -> UNKNOWN (unexplained is never a pass)
//   info    known launchpad contract with that power; source scan unavailable
//
// WHAT IT CANNOT SEE: a privileged address that is neither owner(), the
// creator, nor written in the source (e.g. set later through a setter, or
// computed). The source scan is the backstop for those. One block, one size,
// as everywhere else.
//
// No private key. Tenderly spoofs senders; nothing is ever signed.

require('dotenv').config();
const ethers = require('ethers');

const config = require('./config');
const { ADDR, RPC_URL } = config;
const { legsFor } = require('./swap-legs');
const {
  buildStep,
  simulateBundle,
  formatStepError,
  anyIndeterminate,
} = require('./tenderly-client');

const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a || '').toLowerCase();

const DEAD = '0x000000000000000000000000000000000000dEaD';
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
// Event and balance may differ by rounding or a reflection share; anything
// above this fraction of the probe size is not rounding.
const GHOST_TOLERANCE_BPS = 10;
const MAX_PRIVILEGED = 5;
const PROBE_BPS = 500; // each probe moves 5% of what the buy returned

const tokenIface = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
]);

// Launchpad contracts on this chain that may legitimately hold special powers
// over their own tokens. Such a power is noted, not judged.
function knownInfra(addr) {
  const known = {
    [lc(ADDR.PONS_V2_LAUNCH_FACTORY)]: 'Pons launch factory',
    [lc(ADDR.PONS_V2_LAUNCH_LOCKER)]: 'Pons launch locker',
    [lc(ADDR.PONS_V2_MEME_HOOK)]: 'Pons meme hook',
    [lc(ADDR.UNIV4_POOL_MANAGER)]: 'Uniswap v4 PoolManager',
    [lc(ADDR.UNIVERSAL_ROUTER)]: 'UniversalRouter',
    [lc(ADDR.PERMIT2)]: 'Permit2',
    [lc(ADDR.SWAP_ROUTER_02)]: 'SwapRouter02',
  };
  return known[lc(addr)] || null;
}

// --------------------------------------------------------------------------
// source scan
// --------------------------------------------------------------------------

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

// Body of the first `function <name>(` found, by brace matching.
function functionBodies(src, name) {
  const out = [];
  const re = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    const semi = src.indexOf(';', m.index);
    if (open < 0 || (semi >= 0 && semi < open)) continue; // interface declaration
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { out.push(src.slice(open, i + 1)); break; } }
    }
  }
  return out;
}

// The condition text of every `if (...)` whose guarded statement starts with
// one of `targets`. Handles nested parentheses in the condition.
function guardedBy(body, targets) {
  const hits = [];
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < body.length; i += 1) {
      if (body[i] === '(') depth += 1;
      else if (body[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const cond = body.slice(m.index + m[0].length, i).replace(/\s+/g, ' ').trim();
    const after = body.slice(i + 1).replace(/^\s*\{?\s*/, '');
    if (targets.some((t) => after.startsWith(t))) hits.push(cond);
  }
  return hits;
}

const isMaxAllowanceShortcut = (cond) =>
  /max|uint256\s*\(\s*-1\s*\)|~\s*uint256\s*\(\s*0\s*\)|0xf{16,}/i.test(cond);

// -> [{ severity, title, detail }]
function scanSource(source) {
  const findings = [];
  const src = stripComments(source);
  if (!src.trim()) return findings;

  const DEDUCT = ['_approve(', '_spendAllowance(', '_allowances[', 'allowance[', '_allowance['];
  for (const body of functionBodies(src, 'transferFrom')) {
    const conds = guardedBy(body, DEDUCT).filter((c) => !isMaxAllowanceShortcut(c));
    if (conds.length) {
      findings.push({
        severity: 'medium',
        title: 'source: transferFrom() only checks the allowance under a condition',
        detail: `the allowance is deducted only when (${conds[0]}) — otherwise anyone may be able to move other people's tokens`,
      });
    }
  }
  // `if (fee > 0) emit Transfer(from, feeWallet, fee);` is ordinary fee-token
  // code: the event is skipped only when nothing moves. Only conditions about
  // WHO is involved (an address, a mapping, 0xdead) can hide a real move.
  const nonZeroOnly = (c) => /^\s*[\w.]+\s*(>|!=)\s*0\s*$/.test(c) || /^\s*0\s*(<|!=)\s*[\w.]+\s*$/.test(c);
  const conditionalEmit = guardedBy(src, ['emit Transfer(']).filter((c) => !nonZeroOnly(c));
  if (conditionalEmit.length) {
    findings.push({
      severity: 'medium',
      title: 'source: Transfer event is only emitted under a condition',
      detail: `emit Transfer(...) is skipped unless (${conditionalEmit[0]}) — balance changes can be hidden from explorers`,
    });
  }
  return findings;
}

// Hard-coded addresses in the source: candidates for a hidden privileged caller.
function addressesInSource(source) {
  const set = new Set();
  for (const m of stripComments(source).matchAll(/0x[0-9a-fA-F]{40}\b/g)) set.add(lc(m[0]));
  return [...set];
}

// --------------------------------------------------------------------------
// explorer lookups (creator + source). Best effort; never a finding by itself.
// --------------------------------------------------------------------------

async function defaultFetchJson(path) {
  const sg = require('./source-gate');
  if (!sg.usingProApi()) return { json: null, error: 'BLOCKSCOUT_API_KEY not set' };
  const H = sg.explorerHttp();
  const { status, json, error } = await H(sg.explorerUrl(path), { userAgent: sg.explorerUA() });
  if (status === 200 && json) return { json, error: null };
  return { json: null, error: sg.redact(error || `HTTP ${status}`) };
}

async function fetchCreator(addr, fetchJson) {
  try {
    const { json } = await fetchJson(`/addresses/${addr}`);
    const c = json && (json.creator_address_hash || (json.creator && json.creator.hash));
    return c && ethers.utils.isAddress(lc(c)) ? ethers.utils.getAddress(lc(c)) : null;
  } catch (_) { return null; }
}

async function fetchSource(addr, fetchJson) {
  try {
    const { json, error } = await fetchJson(`/smart-contracts/${addr}`);
    if (!json) return { source: null, error: error || 'no response' };
    const parts = [json.source_code || ''];
    for (const s of json.additional_sources || []) parts.push(s.source_code || '');
    const source = parts.join('\n');
    return source.trim() ? { source, error: null } : { source: null, error: 'no source in the explorer response' };
  } catch (e) { return { source: null, error: e.message }; }
}

async function readOwner(tokenAddr, prov) {
  for (const fn of ['owner', 'getOwner']) {
    try {
      const raw = await prov.call({ to: tokenAddr, data: tokenIface.encodeFunctionData(fn) });
      if (raw && raw !== '0x') {
        const a = tokenIface.decodeFunctionResult(fn, raw)[0];
        if (a && lc(a) !== lc(ADDR.ZERO) && lc(a) !== lc(DEAD)) return ethers.utils.getAddress(lc(a));
      }
    } catch (_) { /* no owner() */ }
  }
  return null;
}

async function isContract(addr, prov) {
  try { const c = await prov.getCode(addr); return Boolean(c && c !== '0x' && c !== '0x0'); } catch (_) { return null; }
}

// --------------------------------------------------------------------------
// event accounting
// --------------------------------------------------------------------------

function logsOf(result) {
  const raw = result && result.raw;
  const txn = raw && (raw.transaction || raw.simulation || raw);
  const logs = txn && txn.transaction_info && txn.transaction_info.logs;
  return Array.isArray(logs) ? logs : null;
}

// Net token movement for `who` according to the Transfer events: in - out.
// null when the step carried no readable logs at all.
function eventNet(result, tokenAddr, who) {
  const logs = logsOf(result);
  if (!logs) return null;
  let net = BN(0);
  for (const l of logs) {
    const r = l && (l.raw || l);
    if (!r || lc(r.address) !== lc(tokenAddr) || !Array.isArray(r.topics)) continue;
    if (lc(r.topics[0]) !== lc(TRANSFER_TOPIC) || r.topics.length < 3) continue;
    const from = '0x' + r.topics[1].slice(26);
    const to = '0x' + r.topics[2].slice(26);
    let v;
    try { v = BN(r.data && r.data !== '0x' ? r.data : 0); } catch (_) { continue; }
    if (lc(to) === lc(who)) net = net.add(v);
    if (lc(from) === lc(who)) net = net.sub(v);
  }
  return net;
}

const uintAt = (results, i) => {
  if (i == null) return null;
  const raw = results[i] && results[i].returnData;
  if (!raw || raw === '0x') return null;
  try { return BN(raw); } catch (_) { return null; }
};

// --------------------------------------------------------------------------
// the run
// --------------------------------------------------------------------------

/**
 * @param tokenAddr
 * @param opts { p (pool descriptor, required), victim, amountEth, prov,
 *               source (string, optional), sourceSubject (impl address for proxies),
 *               fetchJson (tests), extraPrivileged [addr] }
 * @returns { ok, reason?, probes[], ghosts[], privileged[], source{}, findings[] }
 */
async function allowanceProbe(tokenAddr, opts = {}) {
  const {
    p, amountEth = 0.05, prov = new ethers.providers.JsonRpcProvider(RPC_URL),
    fetchJson = defaultFetchJson, extraPrivileged = [],
  } = opts;
  const victim = opts.victim || ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
  const out = { token: tokenAddr, victim, ok: false };
  if (!p) return { ...out, reason: 'no pool descriptor' };

  // ---- who might be privileged, and what does the source say ------------
  const subject = opts.sourceSubject || tokenAddr;
  let source = opts.source || null;
  let sourceError = null;
  if (!source) ({ source, error: sourceError } = await fetchSource(subject, fetchJson));
  out.source = { scanned: Boolean(source), error: source ? null : sourceError };

  const [ownerAddr, creator] = await Promise.all([readOwner(tokenAddr, prov), fetchCreator(tokenAddr, fetchJson)]);
  const cands = [];
  const addCand = (addr, role) => {
    // Lower-case first: a wrongly-checksummed address from an explorer or a
    // source file is still that address, and must not silently drop out.
    if (!addr || !ethers.utils.isAddress(lc(addr))) return;
    const a = ethers.utils.getAddress(lc(addr));
    if ([lc(ADDR.ZERO), lc(DEAD), lc(tokenAddr), lc(victim)].includes(lc(a))) return;
    const have = cands.find((c) => lc(c.address) === lc(a));
    if (have) { if (!have.roles.includes(role)) have.roles.push(role); return; }
    if (cands.length < MAX_PRIVILEGED) cands.push({ address: a, roles: [role] });
  };
  addCand(ownerAddr, 'owner()');
  addCand(creator, 'creator');
  extraPrivileged.forEach((a) => addCand(a, 'given'));
  if (source) addressesInSource(source).forEach((a) => addCand(a, 'in source'));
  for (const c of cands) {
    c.isContract = await isContract(c.address, prov);
    c.infra = knownInfra(c.address);
  }
  out.privileged = cands;

  // ---- one bundle --------------------------------------------------------
  let legs;
  try { legs = await legsFor(p, ADDR, { provider: prov }); } catch (e) {
    return { ...out, reason: `could not build swap legs for this pool: ${e.message}` };
  }
  const amountInWei = ethers.utils.parseEther(String(amountEth));
  const seedWei = amountInWei.add(amountInWei.div(10));

  const steps = [];
  const at = {};
  const add = (name, st) => { if (name) at[name] = steps.length; steps.push(st); };
  const bal = (name) => add(name, buildStep({ from: victim, to: tokenAddr, data: tokenIface.encodeFunctionData('balanceOf', [victim]) }));

  const buySteps = legs.buySteps({ from: victim, amountInWei, seedWei });
  buySteps.forEach((st, i) => add(i === buySteps.length - 1 ? 'buy' : null, st));
  bal('bal_buy');

  // q is not known until the buy runs, so it is sized from a placeholder and
  // fixed after a first pass: a tiny buy-only bundle first.
  const pre = await simulateBundle(steps.slice());
  if (anyIndeterminate(pre)) return { ...out, reason: 'Tenderly returned a step with no readable status on the buy' };
  if (!pre[at.buy] || pre[at.buy].reverted) return { ...out, reason: `the buy reverted: ${formatStepError(pre[at.buy])}` };
  const bought = uintAt(pre, at.bal_buy);
  if (!bought || bought.isZero()) return { ...out, reason: 'the buy did not revert but no tokens arrived' };
  const q = bought.mul(PROBE_BPS).div(10000);
  if (q.isZero()) return { ...out, reason: 'the buy returned too few token units to probe' };
  out.boughtWei = bought.toString();
  out.quantityWei = q.toString();

  const stranger = ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
  const strangerDest = ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
  const freshDest = ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));

  const probes = [
    { key: 'stranger_dead', who: 'stranger', from: stranger, kind: 'transferFrom', to: DEAD, label: 'a stranger moves your tokens to 0xdead (no approval)' },
    { key: 'stranger_any', who: 'stranger', from: stranger, kind: 'transferFrom', to: strangerDest, label: 'a stranger moves your tokens to his own address (no approval)' },
    ...cands.map((c, i) => ({ key: `priv_${i}`, who: 'privileged', cand: c, from: c.address, kind: 'transferFrom', to: c.address, label: `${c.roles.join('/')} ${c.address} takes your tokens (no approval)` })),
    { key: 'self_dead', who: 'victim', from: victim, kind: 'transfer', to: DEAD, label: 'you burn tokens to 0xdead yourself' },
    { key: 'self_fresh', who: 'victim', from: victim, kind: 'transfer', to: freshDest, label: 'you send tokens to a fresh address (control)' },
  ];
  for (const pr of probes) {
    const data = pr.kind === 'transferFrom'
      ? tokenIface.encodeFunctionData('transferFrom', [victim, pr.to, q])
      : tokenIface.encodeFunctionData('transfer', [pr.to, q]);
    add(pr.key, buildStep({ from: pr.from, to: tokenAddr, data }));
    bal(`bal_${pr.key}`);
  }

  const res = await simulateBundle(steps);
  if (anyIndeterminate(res)) return { ...out, reason: 'Tenderly returned a step with no readable status in the allowance probe' };
  if (!res[at.buy] || res[at.buy].reverted) return { ...out, reason: `the buy reverted: ${formatStepError(res[at.buy])}` };

  // ---- read the results ---------------------------------------------------
  const ghosts = [];
  const tol = (amt) => amt.abs().mul(GHOST_TOLERANCE_BPS).div(10000);
  const ghostCheck = (stepName, label, balanceDelta, evNet, refAmount) => {
    if (evNet == null) return { measured: false };
    const gap = balanceDelta.sub(evNet);
    const isGhost = gap.abs().gt(tol(refAmount)) && !gap.isZero();
    if (isGhost) ghosts.push({ step: stepName, label, balanceDelta: balanceDelta.toString(), eventNet: evNet.toString() });
    return { measured: true, ghost: isGhost };
  };

  const buyBal = uintAt(res, at.bal_buy);
  if (buyBal == null) return { ...out, reason: 'could not read the balance after the buy' };
  const buyGhost = ghostCheck('buy', 'the buy', buyBal, eventNet(res[at.buy], tokenAddr, victim), buyBal);

  let prev = buyBal;
  const results = [];
  for (const pr of probes) {
    const r = res[at[pr.key]];
    const after = uintAt(res, at[`bal_${pr.key}`]);
    const succeeded = Boolean(r) && !r.reverted;
    const lost = after == null ? null : prev.sub(after); // positive = victim lost tokens
    const ev = succeeded ? eventNet(r, tokenAddr, victim) : BN(0);
    const g = (succeeded && lost != null) ? ghostCheck(pr.key, pr.label, lost.mul(-1), ev, q) : { measured: !succeeded };
    results.push({
      key: pr.key, who: pr.who, label: pr.label, succeeded,
      error: succeeded ? null : formatStepError(r),
      lostWei: lost == null ? null : lost.toString(),
      eventNetWei: ev == null ? null : ev.toString(),
      eventsMeasured: g.measured, ghost: Boolean(g.ghost),
      candidate: pr.cand ? { address: pr.cand.address, roles: pr.cand.roles, isContract: pr.cand.isContract, infra: pr.cand.infra } : null,
    });
    if (after != null) prev = after;
  }

  out.probes = results;
  out.ghosts = ghosts;
  out.buyEventsMeasured = buyGhost.measured;

  // Completeness: the stranger probes and the control must have produced a
  // balance read, and the control must have produced readable events —
  // otherwise "no ghost seen" would be a claim about a check that never ran.
  const missing = [];
  for (const k of ['stranger_dead', 'stranger_any', 'self_dead', 'self_fresh']) {
    const r = results.find((x) => x.key === k);
    if (!r || r.lostWei == null) missing.push(`${k} balance`);
  }
  const ctl = results.find((x) => x.key === 'self_fresh');
  if (ctl && ctl.succeeded && !ctl.eventsMeasured) missing.push('Transfer events (Tenderly returned no logs)');
  out.missing = missing;

  out.sourceFindings = source ? scanSource(source) : [];
  out.findings = collectFindings(out);
  out.ok = true;
  return out;
}

function collectFindings(r) {
  const f = [];
  const tookTokens = (x) => x.succeeded && x.lostWei != null && BN(x.lostWei).gt(0);

  for (const x of r.probes || []) {
    if (!tookTokens(x)) continue;
    if (x.who === 'stranger') {
      f.push({ severity: 'high', title: `BACKDOOR: ${x.label} — and it worked`, detail: `${x.lostWei} units left the wallet with no approval given` });
    } else if (x.who === 'privileged') {
      const c = x.candidate || {};
      if (c.infra) {
        f.push({ severity: 'info', title: `${c.infra} can move holders' tokens without approval (launchpad infrastructure)`, detail: x.label });
      } else if (c.isContract === false) {
        f.push({ severity: 'high', title: `BACKDOOR: ${x.label} — and it worked (an ordinary wallet holds this power)`, detail: `${x.lostWei} units taken with no approval` });
      } else {
        f.push({ severity: 'medium', title: `contract ${c.address} (${(c.roles || []).join('/')}) can move holders' tokens without approval`, detail: 'unknown contract — its role must be understood before this token can pass' });
      }
    }
  }
  for (const x of r.probes || []) {
    if (x.who === 'victim' && !x.succeeded) {
      f.push({ severity: 'medium', title: `${x.label} — reverted`, detail: x.error || 'reverted' });
    }
  }
  for (const g of r.ghosts || []) {
    const strangerStep = /^stranger|^priv/.test(g.step);
    if (strangerStep) continue; // already reported above as a backdoor
    f.push({
      severity: 'medium',
      title: `GHOST TRANSFER on ${g.label}: your balance changed by ${g.balanceDelta} but the Transfer events say ${g.eventNet} — explorers will show a wrong balance`,
      detail: 'balance moved without a matching Transfer event',
    });
  }
  // A stranger step that "succeeded" but took nothing, and emitted no event,
  // is odd but harmless — note it so it shows in the record.
  for (const x of r.probes || []) {
    if (x.who === 'stranger' && x.succeeded && !tookTokens(x)) {
      f.push({ severity: 'info', title: `${x.label}: call returned success but moved nothing` });
    }
  }
  for (const s of r.sourceFindings || []) f.push(s);
  if (r.source && !r.source.scanned) {
    f.push({ severity: 'info', title: `source scan not run (${r.source.error || 'no source'}) — simulation probes only` });
  }
  return f;
}

function printProbe(r) {
  if (!r.ok) { console.log(`        could not complete: ${r.reason}`); return; }
  for (const x of r.probes) {
    const status = x.succeeded ? (BN(x.lostWei || 0).gt(0) ? 'SUCCEEDED — tokens moved' : 'returned ok, nothing moved') : 'reverted (good)';
    const ghost = x.ghost ? '  [GHOST: no matching Transfer event]' : '';
    const shouldRevert = x.who !== 'victim';
    console.log(`        ${shouldRevert ? 'stranger/priv' : 'own move    '}  ${x.label}: ${shouldRevert ? status : (x.succeeded ? 'ok' : `REVERTED: ${x.error}`)}${ghost}`);
  }
  if (!r.privileged.length) console.log('        (no owner, creator or hard-coded address found to test as a privileged caller)');
  console.log(`        source scan: ${r.source.scanned ? `${r.sourceFindings.length} suspicious pattern(s)` : `not run (${r.source.error})`}`);
}

module.exports = {
  allowanceProbe, collectFindings, scanSource, addressesInSource, eventNet, printProbe,
  functionBodies, guardedBy, DEAD, TRANSFER_TOPIC,
};

// CLI
if (require.main === module) {
  (async () => {
    const token = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!token) { console.log('usage: node allowance-probe.js 0xTOKEN'); process.exit(1); }
    const prov = new ethers.providers.JsonRpcProvider(RPC_URL);
    const { discoverPool, poolHintsFromLaunches } = require('./screen-token');
    const p = await discoverPool(token, { hints: poolHintsFromLaunches(token) });
    if (!p) { console.log('no pool found'); process.exit(1); }
    console.log(`pool: ${p.label}`);
    const r = await allowanceProbe(token, { p, prov });
    printProbe(r);
    for (const f of r.findings || []) console.log(`  [${f.severity}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
    if (r.missing && r.missing.length) console.log(`  not measured: ${r.missing.join('; ')}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
