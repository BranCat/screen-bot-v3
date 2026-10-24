// Offline tests for allowance-probe.js (Gate 5c). No RPC, no Tenderly.
//
//   node test-allowance-probe.js
//
// The centre piece is a model of the Moo Daeng token (fixtures/moo-daeng.sol),
// the contract that cost Frank 70 of his 100 tokens: transferFrom() skips the
// allowance check for moves to 0xdead and for "_feeExcluded" callers, and
// moves to 0xdead emit no Transfer event. The probe must call that a backdoor.
// An honest token must come back with no finding at all.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const client = require('./tenderly-client');
let MODEL_FACTORY = null;
let BUNDLE_CALLS = 0;
client.simulateBundle = async (steps) => {
  BUNDLE_CALLS += 1;
  return simulateAgainstModel(steps, MODEL_FACTORY());
};

const probe = require('./allowance-probe');
const { ADDR } = require('./config');

let failures = 0;
let passes = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passes += 1; } else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);

const T = (x) => ethers.utils.parseUnits(String(x), 18);
const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a || '').toLowerCase();
const TOKEN = '0x1111111111111111111111111111111111111111';
const DEPLOYER = ethers.utils.getAddress('0xde00000000000000000000000000000000000001');
const UNKNOWN_CONTRACT = ethers.utils.getAddress('0xc0c0000000000000000000000000000000000002');
const DEAD = probe.DEAD;

const pool = {
  version: 'v4', tokenAddr: TOKEN, base: 'ETH', fee: 10000, poolId: '0x' + 'ab'.repeat(32),
  hooks: ADDR.ZERO, label: 'Uniswap v4, 1.00% fee, native ETH',
  poolKey: { currency0: ADDR.ZERO, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: ADDR.ZERO },
};

const iface = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
]);
const SIG = {
  balanceOf: iface.getSighash('balanceOf'),
  transfer: iface.getSighash('transfer'),
  transferFrom: iface.getSighash('transferFrom'),
};
const word = (v) => ethers.utils.hexZeroPad(BN(v).toHexString(), 32);
const topicAddr = (a) => ethers.utils.hexZeroPad(lc(a), 32);
const argAddr = (data, i) => ethers.utils.getAddress('0x' + data.slice(10 + i * 64 + 24, 10 + (i + 1) * 64));
const argUint = (data, i) => BN('0x' + data.slice(10 + i * 64, 10 + (i + 1) * 64));

// --------------------------------------------------------------------------
// token model
//   allowanceRule(m, { caller, from, to }) -> true when the allowance must be checked
//   emitRule(to) -> true when a Transfer event is emitted
// --------------------------------------------------------------------------
const HONEST = { allowanceRule: () => true, emitRule: () => true };
const MOO_DAENG = {
  // if (!_feeExcluded[msg.sender] && (sender == pair || recipient != _deadAddr)) check allowance
  allowanceRule: (m, { caller, from, to }) => !m.excluded.has(lc(caller)) && (lc(from) === lc(ADDR.UNIV4_POOL_MANAGER) || lc(to) !== lc(DEAD)),
  // if (to != _deadAddr) emit Transfer
  emitRule: (to) => lc(to) !== lc(DEAD),
};

function makeModel(behaviour, { excluded = [], buyReverts = false, noLogs = false, buyHidden = false, selfTransferReverts = false } = {}) {
  return {
    ...behaviour, buyReverts, noLogs, buyHidden, selfTransferReverts,
    excluded: new Set(excluded.map(lc)),
    bal: new Map([[lc(ADDR.UNIV4_POOL_MANAGER), T(500000000)]]),
  };
}
const get = (m, a) => m.bal.get(lc(a)) || BN(0);
const add = (m, a, v) => m.bal.set(lc(a), get(m, a).add(v));
const sub = (m, a, v) => m.bal.set(lc(a), get(m, a).sub(v));

const transferLog = (from, to, amt) => ({
  name: 'Transfer',
  raw: { address: TOKEN, topics: [probe.TRANSFER_TOPIC, topicAddr(from), topicAddr(to)], data: word(amt) },
});
const ok = (m, returnData = '0x', logs = []) => ({
  reverted: false, indeterminate: false, returnData, errorMessage: null,
  raw: { transaction: { status: true, transaction_info: m.noLogs ? {} : { logs } } },
});
const rev = (msg) => ({ reverted: true, indeterminate: false, returnData: '0x', errorMessage: msg, raw: { transaction: { status: false } } });

function move(m, from, to, amt) {
  sub(m, from, amt);
  add(m, to, amt);
  return m.emitRule(to) ? [transferLog(from, to, amt)] : [];
}

function simulateAgainstModel(steps, m) {
  return steps.map((s) => {
    const to = lc(s.to);
    const data = s.input || '0x';
    if (to === lc(ADDR.UNIVERSAL_ROUTER)) {
      if (m.buyReverts) return rev('execution reverted: trading not open');
      const out = T(1000000);
      sub(m, ADDR.UNIV4_POOL_MANAGER, out);
      add(m, s.from, out);
      return ok(m, '0x', m.buyHidden ? [transferLog(ADDR.UNIV4_POOL_MANAGER, s.from, out.div(2))] : [transferLog(ADDR.UNIV4_POOL_MANAGER, s.from, out)]);
    }
    if (to === lc(TOKEN)) {
      if (data.startsWith(SIG.balanceOf)) return ok(m, word(get(m, argAddr(data, 0))));
      if (data.startsWith(SIG.transfer)) {
        if (m.selfTransferReverts) return rev('execution reverted: transfers paused');
        const dst = argAddr(data, 0); const amt = argUint(data, 1);
        if (get(m, s.from).lt(amt)) return rev('execution reverted: insufficient balance');
        return ok(m, word(1), move(m, s.from, dst, amt));
      }
      if (data.startsWith(SIG.transferFrom)) {
        const owner = argAddr(data, 0); const dst = argAddr(data, 1); const amt = argUint(data, 2);
        if (get(m, owner).lt(amt)) return rev('execution reverted: insufficient balance');
        // Nobody in these tests ever approves anyone: every transferFrom is unapproved.
        if (m.allowanceRule(m, { caller: s.from, from: owner, to: dst })) return rev('execution reverted: ERC20: transfer amount exceeds allowance');
        return ok(m, word(1), move(m, owner, dst, amt));
      }
    }
    return ok(m);
  });
}

function makeProvider({ owner = null, contracts = [] } = {}) {
  return {
    async getBalance() { return T(1); },
    async getCode(a) { return contracts.map(lc).includes(lc(a)) ? '0x6080' : '0x'; },
    async call({ data }) {
      if (data.startsWith(iface.getSighash('owner'))) {
        if (!owner) throw new Error('execution reverted');
        return iface.encodeFunctionResult('owner', [owner]);
      }
      throw new Error('not stubbed');
    },
  };
}

const MOO_SOURCE = fs.readFileSync(path.join(__dirname, 'fixtures', 'moo-daeng.sol'), 'utf8');
const OZ_SOURCE = `
contract ERC20 {
  function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
    address spender = _msgSender();
    _spendAllowance(from, spender, value);
    _transfer(from, to, value);
    return true;
  }
  function _spendAllowance(address owner, address spender, uint256 value) internal virtual {
    uint256 currentAllowance = allowance(owner, spender);
    if (currentAllowance != type(uint256).max) {
      _approve(owner, spender, currentAllowance - value, false);
    }
  }
  function _update(address from, address to, uint256 value) internal virtual {
    emit Transfer(from, to, value);
  }
}`;
const SOLMATE_SOURCE = `
contract ERC20 {
  function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
    balanceOf[from] -= amount;
    unchecked { balanceOf[to] += amount; }
    emit Transfer(from, to, amount);
    return true;
  }
}`;

const fetchJsonFor = ({ creator = null, source = null }) => async (p) => {
  if (p.startsWith('/addresses/')) return { json: creator ? { creator_address_hash: creator } : {}, error: null };
  if (p.startsWith('/smart-contracts/')) return source ? { json: { source_code: source }, error: null } : { json: null, error: 'HTTP 404' };
  return { json: null, error: 'unexpected path' };
};

async function run(behaviour, modelOpts = {}, { owner = null, creator = null, source = null, contracts = [] } = {}) {
  MODEL_FACTORY = () => makeModel(behaviour, modelOpts);
  BUNDLE_CALLS = 0;
  const r = await probe.allowanceProbe(TOKEN, {
    p: pool, amountEth: 0.05, prov: makeProvider({ owner, contracts }),
    fetchJson: fetchJsonFor({ creator, source }),
  });
  return r;
}
const sev = (r, s) => (r.findings || []).filter((f) => f.severity === s);
const byKey = (r, k) => (r.probes || []).find((x) => x.key === k);

(async () => {
  section('1. honest token (OpenZeppelin-style source, owner and creator known)');
  {
    const r = await run(HONEST, {}, { owner: DEPLOYER, creator: DEPLOYER, source: OZ_SOURCE });
    check('completes', r.ok, r.reason);
    check('stranger -> 0xdead reverts', byKey(r, 'stranger_dead') && !byKey(r, 'stranger_dead').succeeded);
    check('stranger -> own address reverts', byKey(r, 'stranger_any') && !byKey(r, 'stranger_any').succeeded);
    check('deployer probed once (owner()+creator merged)', r.privileged.length === 1 && r.privileged[0].roles.join('/') === 'owner()/creator', JSON.stringify(r.privileged));
    check('deployer probe reverts', byKey(r, 'priv_0') && !byKey(r, 'priv_0').succeeded);
    check('own burn and control both succeed', byKey(r, 'self_dead').succeeded && byKey(r, 'self_fresh').succeeded);
    check('no ghosts', r.ghosts.length === 0, JSON.stringify(r.ghosts));
    check('no findings at all', r.findings.length === 0, JSON.stringify(r.findings));
    check('nothing missing', r.missing.length === 0, r.missing.join(';'));
    check('source scanned', r.source.scanned);
    check('two bundles (buy sizing + probe)', BUNDLE_CALLS === 2, String(BUNDLE_CALLS));
  }

  section('2. Moo Daeng model — the token that took 70 of Frank\'s 100');
  {
    const r = await run(MOO_DAENG, { excluded: [DEPLOYER] }, { owner: null, creator: DEPLOYER, source: MOO_SOURCE });
    check('completes', r.ok, r.reason);
    const sd = byKey(r, 'stranger_dead');
    check('stranger -> 0xdead SUCCEEDS without approval', sd && sd.succeeded && BN(sd.lostWei).gt(0));
    check('...and no Transfer event (ghost)', sd && sd.ghost && sd.eventNetWei === '0');
    check('stranger -> own address still reverts', !byKey(r, 'stranger_any').succeeded);
    const pv = r.probes.find((x) => x.who === 'privileged' && x.candidate && lc(x.candidate.address) === lc(DEPLOYER));
    check('renounced owner, but creator found as a candidate', Boolean(pv));
    check('deployer takes tokens without approval', pv && pv.succeeded && BN(pv.lostWei).gt(0));
    const high = sev(r, 'high');
    check('stranger backdoor is HIGH', high.some((f) => /stranger moves your tokens to 0xdead/.test(f.title)));
    check('deployer (wallet) backdoor is HIGH', high.some((f) => /ordinary wallet holds this power/.test(f.title)));
    const sel = sev(r, 'medium').map((f) => f.title).join(' | ');
    check('own burn to 0xdead flagged as a ghost transfer', /GHOST TRANSFER on you burn tokens to 0xdead/.test(sel), sel);
    check('source: conditional allowance flagged', /transferFrom\(\) only checks the allowance under a condition/.test(sel), sel);
    check('source: conditional Transfer event flagged', /Transfer event is only emitted under a condition/.test(sel), sel);
    check('router address from the source probed, and reverts', r.probes.some((x) => x.candidate && lc(x.candidate.address) === lc('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D') && !x.succeeded));
  }

  section('3. hidden burn events only (allowance enforced, no event on 0xdead)');
  {
    const r = await run({ allowanceRule: () => true, emitRule: MOO_DAENG.emitRule }, {}, { source: null });
    check('completes', r.ok, r.reason);
    check('no HIGH (nobody can take tokens)', sev(r, 'high').length === 0, JSON.stringify(sev(r, 'high')));
    check('ghost on own burn is MEDIUM -> UNKNOWN', sev(r, 'medium').some((f) => /GHOST TRANSFER on you burn/.test(f.title)));
    check('source unavailable is only info', sev(r, 'info').some((f) => /source scan not run/.test(f.title)));
  }

  section('4. a privileged CONTRACT');
  {
    const unknown = await run(HONEST_EXCEPT([UNKNOWN_CONTRACT]), { excluded: [UNKNOWN_CONTRACT] }, { owner: UNKNOWN_CONTRACT, contracts: [UNKNOWN_CONTRACT] });
    check('unknown contract with the power -> MEDIUM', sev(unknown, 'medium').some((f) => /can move holders' tokens without approval/.test(f.title)), JSON.stringify(unknown.findings));
    check('...not HIGH', sev(unknown, 'high').length === 0);
    const pons = await run(HONEST_EXCEPT([ADDR.PONS_V2_LAUNCH_FACTORY]), { excluded: [ADDR.PONS_V2_LAUNCH_FACTORY] }, { creator: ADDR.PONS_V2_LAUNCH_FACTORY, contracts: [ADDR.PONS_V2_LAUNCH_FACTORY] });
    check('Pons factory with the power -> info only', sev(pons, 'info').some((f) => /Pons launch factory/.test(f.title)) && sev(pons, 'medium').length === 0 && sev(pons, 'high').length === 0, JSON.stringify(pons.findings));
  }

  section('5. buy event understates what arrived (hidden mint/credit)');
  {
    const r = await run(HONEST, { buyHidden: true });
    check('ghost on the buy is MEDIUM', sev(r, 'medium').some((f) => /GHOST TRANSFER on the buy/.test(f.title)), JSON.stringify(r.findings));
  }

  section('6. failure paths are never a pass');
  {
    const r = await run(HONEST, { buyReverts: true });
    check('buy revert -> not ok', !r.ok && /buy reverted/.test(r.reason), r.reason);
    const nl = await run(HONEST, { noLogs: true });
    check('no logs from Tenderly -> reported missing', nl.ok && nl.missing.some((x) => /Transfer events/.test(x)), JSON.stringify(nl.missing));
    const sr = await run(HONEST, { selfTransferReverts: true });
    check('own transfer reverting -> MEDIUM', sev(sr, 'medium').some((f) => /reverted/.test(f.title)));
  }

  section('7. source scan on its own');
  {
    check('Moo Daeng: 2 findings', probe.scanSource(MOO_SOURCE).length === 2, JSON.stringify(probe.scanSource(MOO_SOURCE)));
    check('OpenZeppelin: clean', probe.scanSource(OZ_SOURCE).length === 0, JSON.stringify(probe.scanSource(OZ_SOURCE)));
    check('Solmate max-allowance shortcut: clean', probe.scanSource(SOLMATE_SOURCE).length === 0, JSON.stringify(probe.scanSource(SOLMATE_SOURCE)));
    check('interface declaration ignored', probe.functionBodies('interface I { function transferFrom(address a) external returns (bool); }', 'transferFrom').length === 0);
    check('fee-token `if (fee > 0) emit Transfer` is clean', probe.scanSource('function _t(){ if (fee > 0) emit Transfer(from, feeWallet, fee); if (0 != taxAmount) { emit Transfer(a, b, taxAmount); } }').length === 0);
    check('`if (to != dead) emit Transfer` is flagged', probe.scanSource('function _t(){ if (to != DEAD) emit Transfer(from, to, amount); }').length === 1);
    check('comments ignored', probe.scanSource('// if (x) emit Transfer(a,b,c);\n/* if (y) _approve(a,b,c); */').length === 0);
    check('hard-coded addresses extracted', probe.addressesInSource(MOO_SOURCE).includes('0x7a250d5630b4cf539739df2c5dacb4c659f2488d'));
  }

  console.log(failures ? `\n${failures} check(s) FAILED (${passes} ok)` : `\nall checks passed (${passes})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// An honest token, except the given callers skip the allowance check.
function HONEST_EXCEPT() {
  return { allowanceRule: (m, { caller }) => !m.excluded.has(lc(caller)), emitRule: () => true };
}
