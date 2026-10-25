// change-check.js — "can this token be changed after release?"  RECORD ONLY.
//
// Added 2026-10-24. Gates 0-6 test how a token behaves at the moment it is
// screened. They do not ask whether somebody can change the rules afterwards.
// This module asks, and writes the answer into the screen file. It NEVER
// changes a verdict: screen-token.js only records what it returns, and any
// error in here is caught and recorded as "not checked".
//
// What it looks at:
//   1. proxy   is the token an upgradeable proxy, and who can upgrade it
//              (EIP-1967 admin slot, the admin contract's owner, a beacon's
//              owner, or for UUPS the token's own owner)
//   2. owner   owner() / getOwner(): renounced (zero or burn address) or live
//   3. roles   OpenZeppelin AccessControl: who still holds a role
//              (RoleGranted events, confirmed with hasRole)
//   4. switches  the published source, scanned for functions only a privileged
//              caller can use that change fees or taxes, limits, blacklists,
//              trading on/off or pausing, or mint new tokens. A heuristic.
//   5. hook    v4 only: is the pool's hook upgradeable, and does it have an owner
//
// `wouldBe` is what the planned hard rule would say. It is a note for the
// review after a week of data, nothing more:
//   DO NOT SNIP  an upgradeable proxy with a live upgrader; or a live owner or
//                role holder who can use a switch found in the source
//   UNKNOWN      a part that matters could not be measured, or something the
//                rule cannot judge (a live owner with no source to read,
//                selfdestruct/delegatecall in a plain contract, ...)
//   PASS         none of the above
// The v4 hook is reported but does not affect wouldBe yet: what a hook owner
// can do depends on that hook's own code, to be reviewed once (planned).

const { ethers } = require('ethers');
const config = require('./config');

const ADDR = config.ADDR;
const lc = (a) => String(a || '').toLowerCase();
const DEAD = '0x000000000000000000000000000000000000dead';
const isBurn = (a) => !a || /^0x0{40}$/i.test(String(a)) || lc(a) === DEAD;

// EIP-1967 admin slot: bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
const SLOT_1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
// OpenZeppelin's pre-1967 admin slot: keccak256("org.zeppelinos.proxy.admin")
const SLOT_OZ_LEGACY_ADMIN = '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b';
const SLOT_1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SLOT_1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const ROLE_GRANTED_TOPIC = ethers.utils.id('RoleGranted(bytes32,address,address)');
const IACCESSCONTROL_ID = '0x7965db0b';

const iface = new ethers.utils.Interface([
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function hasRole(bytes32,address) view returns (bool)',
]);

function addrFromWord(word) {
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]+$/.test(word) || word.length < 42) return null;
  const a = '0x' + word.slice(-40);
  return /^0x0{40}$/i.test(a) ? null : ethers.utils.getAddress(a.toLowerCase());
}

// owner()/getOwner()/pendingOwner(): { fn, address, renounced } or { fn: null }
async function readOwner(prov, addr) {
  for (const fn of ['owner', 'getOwner']) {
    try {
      const raw = await prov.call({ to: addr, data: iface.encodeFunctionData(fn) });
      if (!raw || raw === '0x' || raw.length < 66) continue;
      const a = iface.decodeFunctionResult(fn, raw)[0];
      const out = { fn, address: ethers.utils.getAddress(lc(a)), renounced: isBurn(a) };
      try {
        const p = await prov.call({ to: addr, data: iface.encodeFunctionData('pendingOwner') });
        if (p && p.length >= 66) {
          const pa = iface.decodeFunctionResult('pendingOwner', p)[0];
          if (!isBurn(pa)) out.pendingOwner = ethers.utils.getAddress(lc(pa));
        }
      } catch (_) { /* no pendingOwner() */ }
      return out;
    } catch (_) { /* this function does not exist */ }
  }
  return { fn: null, address: null, renounced: null };
}

async function isContract(prov, a) {
  try { const c = await prov.getCode(a); return Boolean(c && c !== '0x' && c !== '0x0'); } catch (_) { return null; }
}

async function slot(prov, addr, s) {
  try { return addrFromWord(await prov.getStorageAt(addr, s)); } catch (_) { return undefined; }
}

// Who can change the code behind a proxy. `src` is Gate 0's result.
async function proxyPart(prov, token, src, tokenOwner) {
  if (!src || !src.isProxy) return { isProxy: false };
  const out = {
    isProxy: true,
    via: src.implementationVia || null,
    implementation: src.implementationAddr || null,
  };
  if (src.implementationVia === 'bytecode-immediate') {
    // A minimal clone: the implementation address is part of its code, so it
    // can never point anywhere else.
    return { ...out, upgradeable: false, note: 'minimal clone: the implementation is fixed in its bytecode' };
  }
  out.upgradeable = true;
  if (src.implementationVia === 'beacon') {
    const beacon = (String(src.implementationNote || '').match(/0x[0-9a-fA-F]{40}/) || [])[0] || await slot(prov, token, SLOT_1967_BEACON);
    out.beacon = beacon || null;
    if (!beacon) return { ...out, upgrader: null, upgraderRenounced: null, note: 'beacon address unreadable' };
    const bo = await readOwner(prov, beacon);
    return { ...out, upgrader: bo.address, upgraderVia: 'beacon owner', upgraderRenounced: bo.fn ? bo.renounced : null,
      note: bo.fn ? null : 'the beacon has no owner() to read' };
  }
  const adminSlot = src.implementationVia === 'oz-legacy' ? SLOT_OZ_LEGACY_ADMIN : SLOT_1967_ADMIN;
  const admin = await slot(prov, token, adminSlot);
  if (admin === undefined) return { ...out, upgrader: null, upgraderRenounced: null, note: 'admin slot unreadable' };
  if (admin) {
    out.admin = admin;
    out.adminIsContract = await isContract(prov, admin);
    if (out.adminIsContract) {
      // Normally an OpenZeppelin ProxyAdmin: whoever owns it can upgrade.
      const ao = await readOwner(prov, admin);
      if (ao.fn) return { ...out, upgrader: ao.address, upgraderVia: 'admin contract owner', upgraderRenounced: ao.renounced };
      return { ...out, upgrader: admin, upgraderVia: 'admin contract (no owner() to read)', upgraderRenounced: null };
    }
    return { ...out, upgrader: admin, upgraderVia: 'admin', upgraderRenounced: false };
  }
  // No admin: a UUPS proxy, upgraded through the implementation's own
  // upgradeTo(), which is normally guarded by the token's owner.
  if (tokenOwner && tokenOwner.fn) {
    return { ...out, upgrader: tokenOwner.address, upgraderVia: 'UUPS: the token owner', upgraderRenounced: tokenOwner.renounced };
  }
  return { ...out, upgrader: null, upgraderRenounced: null, note: 'no admin slot and no owner(): who can upgrade is unknown' };
}

// AccessControl role holders that still hold their role.
async function rolesPart(prov, token, { lookbackBlocks = 200000, source = null } = {}) {
  let ac = null;
  try {
    const raw = await prov.call({ to: token, data: iface.encodeFunctionData('supportsInterface', [IACCESSCONTROL_ID]) });
    if (raw && raw.length >= 66) ac = iface.decodeFunctionResult('supportsInterface', raw)[0];
  } catch (_) { /* no ERC-165 */ }
  const mentioned = source ? /\bAccessControl\b|\bonlyRole\s*\(|\bhasRole\s*\(/.test(source) : false;
  if (!ac && !mentioned) return { accessControl: false, holders: [] };
  let logs;
  try {
    const head = await prov.getBlockNumber();
    const from = Math.max(0, head - lookbackBlocks);
    logs = [];
    for (let s = from; s <= head; s += 10000) {
      // eslint-disable-next-line no-await-in-loop
      logs.push(...await prov.getLogs({ address: token, topics: [ROLE_GRANTED_TOPIC], fromBlock: s, toBlock: Math.min(head, s + 9999) }));
    }
  } catch (e) {
    return { accessControl: true, holders: null, note: `role events unreadable: ${String(e.message || e).slice(0, 120)}` };
  }
  const seen = new Map();
  for (const l of logs) {
    const role = l.topics[1];
    const account = addrFromWord(l.topics[2]);
    if (account) seen.set(`${role}|${lc(account)}`, { role, account });
  }
  const holders = [];
  for (const { role, account } of seen.values()) {
    let still = null;
    try {
      const raw = await prov.call({ to: token, data: iface.encodeFunctionData('hasRole', [role, account]) });
      still = iface.decodeFunctionResult('hasRole', raw)[0];
    } catch (_) { /* unreadable: keep null */ }
    if (still !== false && !isBurn(account)) {
      holders.push({ role: role === ethers.constants.HashZero ? 'DEFAULT_ADMIN_ROLE' : role, account, confirmed: still === true });
    }
  }
  return { accessControl: true, holders, note: logs.length ? null : `no RoleGranted events in the last ${lookbackBlocks} blocks` };
}

// ---------------------------------------------------------------- source scan

function stripComments(src) {
  return String(src || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function matchParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') d += 1;
    else if (s[i] === ')') { d -= 1; if (d === 0) return i; }
  }
  return -1;
}
function matchBrace(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') d += 1;
    else if (s[i] === '}') { d -= 1; if (d === 0) return i; }
  }
  return -1;
}

// Every function with a body: { name, header, body }
function functionsOf(src) {
  const out = [];
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const close = matchParen(src, m.index + m[0].length - 1);
    if (close < 0) continue;
    const brace = src.indexOf('{', close);
    const semi = src.indexOf(';', close);
    if (brace < 0 || (semi >= 0 && semi < brace)) continue; // interface or abstract declaration
    const end = matchBrace(src, brace);
    if (end < 0) continue;
    out.push({ name: m[1], header: src.slice(close + 1, brace), body: src.slice(brace, end + 1) });
  }
  return out;
}

// Ownership and role plumbing, and the ordinary token functions (Gate 5c tests
// those by behaviour), are not "switches".
const STANDARD = /^(transferOwnership|renounceOwnership|acceptOwnership|grantRole|revokeRole|renounceRole|transfer|transferFrom|approve|increaseAllowance|decreaseAllowance|permit|_\w+)$/;
const SENDER = '(?:_?msgSender\\(\\)|msg\\.sender)';
const OWNER_WORD = /\b(_?owner\(?\)?|_owner|owner|admin|_admin|dev|_dev|deployer|operator|governance|controller)\b/i;

// What guards this function: 'owner', 'role', 'special' (a mapping or hard-coded
// address), or null (anyone can call it).
function guardOf(fn, modifierBodies) {
  const h = fn.header;
  if (/\b(internal|private|view|pure)\b/.test(h)) return null; // not callable from outside, or cannot change anything
  if (/\bonlyRole\s*\(/.test(h)) return 'role';
  const mods = (h.match(/\b(only\w+|auth\w*|authorized|isAuthorized)\b/g) || []);
  for (const mname of mods) {
    if (/^onlyRole$/.test(mname)) return 'role';
    const mb = modifierBodies[mname];
    if (mb && /\b(hasRole|_checkRole)\s*\(/.test(mb)) return 'role';
    if (mb && new RegExp(`${SENDER}\\s*\\]`).test(mb)) return 'special';
    return 'owner';
  }
  const head = fn.body.slice(0, 400);
  if (/\b_checkOwner\s*\(/.test(head)) return 'owner';
  if (/\b_checkRole\s*\(|\bhasRole\s*\(/.test(head)) return 'role';
  const reqs = head.match(/\b(require|if)\s*\(([^;{]*)/g) || [];
  for (const r of reqs) {
    if (!new RegExp(SENDER).test(r)) continue;
    if (new RegExp(`\\[\\s*${SENDER}\\s*\\]`).test(r)) return 'special';
    if (/0x[0-9a-fA-F]{40}/.test(r)) return 'special';
    if (OWNER_WORD.test(r)) return 'owner';
    return 'special';
  }
  return null;
}

const CATEGORIES = [
  ['mint', /\bmint|_mint\s*\(/i],
  ['trading', /pause|trading|enabletrading|opentrading|starttrading|swapenabled|launch/i],
  ['blacklist', /blacklist|blocklist|isbot|\bbots?\b|setbot|ban\b|blocked|sniper/i],
  ['limits', /maxtx|maxwallet|max_?transaction|max_?wallet|maxsell|maxbuy|limit|cooldown/i],
  ['fees', /fee|tax/i],
  ['exemptions', /exclude|exempt|whitelist|allowlist/i],
];
const DANGEROUS = new Set(['mint', 'trading', 'blacklist', 'limits', 'fees']);

// Every contract / abstract contract / library / interface block in the source:
// name -> { kind, parents, text }. Solidity does not nest them.
function contractsOf(src) {
  const out = {};
  const re = /\b(abstract\s+contract|contract|library|interface)\s+([A-Za-z_$][\w$]*)\s*(?:is\s+([^{]*))?\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const end = matchBrace(src, open);
    if (end < 0) break;
    const parents = [];
    if (m[3]) {
      let depth = 0; let cur = '';
      for (const ch of m[3]) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { parents.push(cur); cur = ''; } else cur += ch;
      }
      parents.push(cur);
    }
    out[m[2]] = {
      kind: m[1].replace(/\s+/g, ' '),
      parents: parents.map((p) => (p.trim().match(/^[A-Za-z_$][\w$.]*/) || [''])[0].split('.').pop()).filter(Boolean),
      text: src.slice(m.index, end + 1),
    };
    re.lastIndex = end + 1;
  }
  return out;
}

// The token's own contract and everything it inherits from. A verified source
// often bundles other contracts (Pons tokens can carry the whole launchpad:
// hook, factory, locker); their admin functions are not the token's.
// `name` is the contract name the explorer reports. Without it, the one
// concrete contract that nothing else inherits from is taken, if there is
// exactly one. Returns { text, main, scoped }.
function tokenScope(src, name) {
  const all = contractsOf(src);
  const concrete = Object.entries(all).filter(([, c]) => /contract/.test(c.kind));
  let main = name && all[name] ? name : null;
  if (!main) {
    const inherited = new Set(concrete.flatMap(([, c]) => c.parents));
    const leaves = concrete.filter(([n, c]) => c.kind === 'contract' && !inherited.has(n)).map(([n]) => n);
    if (leaves.length === 1) [main] = leaves;
  }
  if (!main) return { text: src, main: null, scoped: concrete.length <= 1, contracts: concrete.length };
  const seen = new Set();
  const stack = [main];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n) || !all[n]) continue;
    seen.add(n);
    stack.push(...all[n].parents);
  }
  const text = [...seen].filter((n) => /contract/.test(all[n].kind)).map((n) => all[n].text).join('\n');
  return { text, main, scoped: true, contracts: concrete.length, inherits: [...seen].filter((n) => n !== main) };
}

function scanSwitches(source, { contract = null } = {}) {
  const full = stripComments(source);
  if (!full.trim()) return { scanned: false, found: [], notes: [] };
  const scope = tokenScope(full, contract);
  const src = scope.text;
  const modifierBodies = {};
  const mre = /\bmodifier\s+(\w+)\s*(\([^)]*\))?[^{;]*\{/g;
  let m;
  while ((m = mre.exec(src))) {
    const open = src.indexOf('{', m.index);
    const end = matchBrace(src, open);
    if (end > 0) modifierBodies[m[1]] = src.slice(open, end + 1);
  }
  const found = [];
  for (const fn of functionsOf(src)) {
    if (STANDARD.test(fn.name)) continue;
    const guard = guardOf(fn, modifierBodies);
    if (!guard) continue;
    const text = `${fn.name} ${fn.body}`;
    const nameHit = CATEGORIES.find(([, re]) => re.test(fn.name));
    const bodyHit = nameHit || CATEGORIES.find(([, re]) => re.test(fn.body));
    if (!bodyHit) continue;
    found.push({ fn: fn.name, category: bodyHit[0], guard, dangerous: DANGEROUS.has(bodyHit[0]), byName: Boolean(nameHit), _text: text.length });
  }
  const notes = [];
  if (/\bselfdestruct\s*\(/.test(src)) notes.push('selfdestruct in the source');
  if (/\.delegatecall\s*\(/.test(src)) notes.push('delegatecall in the source');
  if (!scope.scoped) notes.push(`could not tell which of the ${scope.contracts} contracts in the source is the token; all were scanned`);
  return {
    scanned: true, found: found.map(({ _text, ...x }) => x), notes,
    contract: scope.main, scoped: scope.scoped, ...(scope.inherits ? { inherits: scope.inherits } : {}),
  };
}

// ---------------------------------------------------------------- source fetch

const sourceCache = new Map(); // address or code fingerprint -> { source, error }

async function defaultFetchSource(addr) {
  const sg = require('./source-gate');
  if (!sg.usingProApi()) return { source: null, error: 'BLOCKSCOUT_API_KEY not set' };
  const H = sg.explorerHttp();
  const { status, json, error } = await H(sg.explorerUrl(`/smart-contracts/${addr}`), { userAgent: sg.explorerUA() });
  if (status !== 200 || !json) return { source: null, error: sg.redact(error || `HTTP ${status}`) };
  const parts = [json.source_code || ''];
  for (const s of json.additional_sources || []) parts.push(s.source_code || '');
  const source = parts.join('\n');
  return source.trim() ? { source, name: json.name || null, error: null } : { source: null, error: 'no source in the explorer response' };
}

async function getSource(addr, fingerprint, fetchSource) {
  const keys = [lc(addr), fingerprint ? `fp:${fingerprint}` : null].filter(Boolean);
  for (const k of keys) if (sourceCache.has(k)) return { ...sourceCache.get(k), cached: true };
  let r;
  try { r = await fetchSource(addr); } catch (e) { r = { source: null, error: String(e.message || e).slice(0, 160) }; }
  if (r.source) keys.forEach((k) => sourceCache.set(k, { source: r.source, name: r.name || null, error: null }));
  return r;
}

// ---------------------------------------------------------------- v4 hook

async function hookPart(prov, pool) {
  const hook = pool && pool.version === 'v4' ? (pool.hooks || (pool.poolKey && pool.poolKey.hooks)) : null;
  if (!hook || isBurn(hook)) return null;
  let name = null;
  try { name = require('./pool-resolve').knownHookName(hook); } catch (_) { /* optional */ }
  const out = { address: hook, name };
  try {
    const code = await prov.getCode(hook);
    const { scanCode } = require('./source-gate');
    out.hasDelegatecall = scanCode(code).hasDelegatecall;
  } catch (_) { out.hasDelegatecall = null; }
  const impl = await slot(prov, hook, SLOT_1967_IMPL);
  if (impl) {
    out.isProxy = true;
    out.implementation = impl;
    const admin = await slot(prov, hook, SLOT_1967_ADMIN);
    if (admin) {
      const ao = (await isContract(prov, admin)) ? await readOwner(prov, admin) : { fn: 'admin', address: admin, renounced: false };
      out.upgrader = ao.address || admin;
      out.upgraderRenounced = ao.fn ? ao.renounced : null;
    }
  } else {
    out.isProxy = false;
  }
  const o = await readOwner(prov, hook);
  out.owner = o.fn ? o.address : null;
  out.ownerRenounced = o.fn ? o.renounced : null;
  return out;
}

// ---------------------------------------------------------------- judgement

function judge(c) {
  const no = [];
  const unk = [];
  const info = [];
  const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '?');

  const px = c.proxy || {};
  if (px.isProxy && px.upgradeable) {
    if (px.upgraderRenounced === true) info.push('upgradeable proxy, but its upgrader is renounced');
    else if (px.upgraderRenounced === false) no.push(`upgradeable proxy: ${short(px.upgrader)} (${px.upgraderVia}) can replace the code`);
    else unk.push(`upgradeable proxy: who can upgrade is unknown${px.note ? ` (${px.note})` : ''}`);
  } else if (px.isProxy) info.push(px.note || 'proxy, not upgradeable');

  const ow = c.owner || {};
  const ownerLive = ow.fn && ow.renounced === false;
  if (ownerLive) info.push(`live owner ${short(ow.address)}`);
  else if (ow.fn && ow.renounced) info.push('ownership renounced');
  if (ow.pendingOwner) info.push(`pending owner ${short(ow.pendingOwner)}`);

  const rl = c.roles || {};
  const roleLive = Array.isArray(rl.holders) && rl.holders.length > 0;
  if (rl.accessControl && rl.holders === null) unk.push(`uses roles, but the role holders could not be read${rl.note ? ` (${rl.note})` : ''}`);
  if (roleLive) info.push(`${rl.holders.length} live role holder(s)`);

  const sw = c.switches || {};
  const dangerous = (sw.found || []).filter((f) => f.dangerous);
  const usable = dangerous.filter((f) => (f.guard === 'owner' && (ownerLive || !ow.fn)) || (f.guard === 'role' && (roleLive || rl.holders === null)) || f.guard === 'special');
  if (usable.length && sw.scoped === false) {
    unk.push(`switches found, but the source holds several contracts and the token's could not be told apart: ${usable.slice(0, 3).map((f) => f.fn).join(', ')}`);
  } else if (usable.length) {
    const cats = [...new Set(usable.map((f) => f.category))].join(', ');
    no.push(`switches a privileged caller can still use (${cats}): ${usable.slice(0, 4).map((f) => f.fn).join(', ')}${usable.length > 4 ? ', ...' : ''}`);
  } else if (dangerous.length) {
    info.push(`switches in the source, but their owner/role is renounced: ${dangerous.slice(0, 3).map((f) => f.fn).join(', ')}`);
  }
  if (!sw.scanned) {
    if (ownerLive || roleLive || ow.fn == null) unk.push(`source not scanned (${sw.error || 'no source'})${ownerLive ? ' and the owner is live' : ''}`);
    else info.push(`source not scanned (${sw.error || 'no source'})`);
  }
  for (const n of sw.notes || []) {
    if (/could not tell which/.test(n)) continue; // handled above
    (px.isProxy ? info : unk).push(n);
  }

  const hk = c.hook;
  if (hk) {
    const bits = [];
    if (hk.isProxy) bits.push(hk.upgraderRenounced === true ? 'upgradeable, upgrader renounced' : 'upgradeable');
    if (hk.owner) bits.push(hk.ownerRenounced ? 'owner renounced' : `live owner ${short(hk.owner)}`);
    info.push(`hook ${hk.name || short(hk.address)}${bits.length ? `: ${bits.join(', ')}` : ': no owner, not a proxy'}`);
  }

  const wouldBe = no.length ? 'DO NOT SNIP' : unk.length ? 'UNKNOWN' : 'PASS';
  const reasons = [...no, ...unk];
  return { wouldBe, reasons, info, summary: (reasons.length ? reasons : info).join('; ') || 'no proxy, no owner, no switches found' };
}

/**
 * @param tokenAddr
 * @param opts { provider, pool, source: Gate 0 result, template: Gate 0 template match,
 *               fetchSource (tests), lookbackBlocks, timeoutMs }
 * Never throws. Returns { checked: true, wouldBe, ... } or { checked: false, error }.
 */
async function changeCheck(tokenAddr, opts = {}) {
  const prov = opts.provider;
  const t0 = Date.now();
  const run = async () => {
    const src = opts.source || {};
    const owner = await readOwner(prov, tokenAddr);
    const proxy = await proxyPart(prov, tokenAddr, src, owner);
    let switches;
    // A token accepted at Gate 0 by its template (identical bytecode, source not
    // published yet) is scanned with the template reference's source.
    const tmpl = opts.template && opts.template.matched && opts.template.reference ? opts.template : null;
    if (src.sourceVerified === true || tmpl) {
      const subject = (proxy.isProxy && proxy.implementation) || (src.sourceVerified === true ? tokenAddr : tmpl.reference);
      const fp = proxy.isProxy ? null : src.codeSha256NoMeta;
      const s = await getSource(subject, fp, opts.fetchSource || defaultFetchSource);
      switches = s.source
        ? { ...scanSwitches(s.source, { contract: s.name || (tmpl && src.sourceVerified !== true ? tmpl.name : null) || src.explorer_name || null }), subject, cached: Boolean(s.cached), ...(src.sourceVerified === true ? {} : { viaTemplate: tmpl.name }) }
        : { scanned: false, error: s.error, found: [], notes: [] };
      switches._source = s.source || null;
    } else {
      // Say what Gate 0 actually found, not only "not published".
      const why = src.decision ? `Gate 0 ${src.decision}: ${String(src.reason || '').slice(0, 120)}` : 'no Gate 0 result';
      switches = { scanned: false, error: src.sourceVerified === false ? `source not published (${why})` : why, found: [], notes: [] };
    }
    const roles = await rolesPart(prov, tokenAddr, { lookbackBlocks: opts.lookbackBlocks, source: switches._source });
    delete switches._source;
    const hook = await hookPart(prov, opts.pool);
    const c = { checked: true, recordOnly: true, owner, proxy, roles, switches, hook };
    return { ...c, ...judge(c), ms: Date.now() - t0 };
  };
  const timeoutMs = opts.timeoutMs || 30000;
  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
  } catch (e) {
    return { checked: false, recordOnly: true, wouldBe: 'NOT CHECKED', error: String(e.message || e).slice(0, 200), summary: `not checked: ${String(e.message || e).slice(0, 120)}`, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { changeCheck, scanSwitches, functionsOf, contractsOf, tokenScope, judge, readOwner, proxyPart, rolesPart, hookPart, _sourceCache: sourceCache, SLOT_1967_ADMIN };

// CLI: node change-check.js 0xTOKEN [--json]   (looks up the token's pool and Gate 0 result first; read-only)
if (require.main === module) {
  (async () => {
    const token = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!token) { console.log('usage: node change-check.js 0xTOKEN'); process.exit(1); }
    require('dotenv').config({ quiet: true });
    // The same connection and Gate 0 call as the live bot (screen-token.js):
    // config.RPC_URL, never RPC_URL from .env, which may point elsewhere.
    const prov = new ethers.providers.JsonRpcProvider(config.RPC_URL);
    const { sourceGate } = require('./source-gate');
    const src = await sourceGate(token, { rpcUrl: config.RPC_URL, chain: config.CHAIN_ID });
    let pool = null;
    try { const st = require('./screen-token'); pool = await st.discoverPool(token, { allowUsdg: true, hints: st.poolHintsFromLaunches ? st.poolHintsFromLaunches(token) : [] }); } catch (_) { /* pool optional */ }
    let template = null;
    if (src.decision === 'SKIP' && src.sourceVerified === false && pool) {
      try { template = await require('./template-match').createTemplateMatcher({ getCode: (a) => prov.getCode(a) })(src, pool); } catch (_) { /* optional */ }
    }
    const r = await changeCheck(token, { provider: prov, pool, source: src, template });
    if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`${token}  ${pool ? pool.label || pool.version : 'no pool found'}`);
    console.log(`would be: ${r.wouldBe}   (record only)`);
    console.log(`  ${r.summary}`);
    if (r.checked) {
      console.log(`  proxy:    ${r.proxy.isProxy ? `${r.proxy.via}${r.proxy.upgradeable === false ? ', not upgradeable' : `, upgrader ${r.proxy.upgrader || 'unknown'}${r.proxy.upgraderRenounced ? ' (renounced)' : ''}`}` : 'no'}`);
      console.log(`  owner:    ${r.owner.fn ? `${r.owner.address}${r.owner.renounced ? ' (renounced)' : ' (LIVE)'}` : 'no owner() function'}`);
      console.log(`  roles:    ${r.roles.accessControl ? `${r.roles.holders ? r.roles.holders.length : '?'} live holder(s)` : 'none'}`);
      if (r.switches.scanned) console.log(`  scanned:  ${r.switches.contract ? `contract ${r.switches.contract}${r.switches.inherits && r.switches.inherits.length ? ` + ${r.switches.inherits.length} parent(s)` : ''}` : 'the whole source (token contract not identified)'}`);
      console.log(`  switches: ${r.switches.scanned ? (r.switches.found.length ? r.switches.found.map((f) => `${f.fn} (${f.category}, ${f.guard})`).join(', ') : 'none found') : `not scanned: ${r.switches.error}`}${r.switches.viaTemplate ? `  [source of the ${r.switches.viaTemplate} template]` : ''}`);
      if (r.hook) console.log(`  hook:     ${r.hook.name || r.hook.address}, ${r.hook.isProxy ? 'proxy' : 'not a proxy'}, owner ${r.hook.owner ? `${r.hook.owner}${r.hook.ownerRenounced ? ' (renounced)' : ' (live)'}` : 'none'}`);
    }
    console.log('(add --json for everything)');
  })().catch((e) => { console.error(e); process.exit(1); });
}
