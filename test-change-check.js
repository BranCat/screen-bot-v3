// Offline tests for change-check.js (record only). No RPC, no explorer.
//   node test-change-check.js
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cc = require('./change-check');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
}
function section(t) { console.log(`\n${t}`); }

const lc = (a) => String(a).toLowerCase();
const TOKEN = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const ADMIN = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444';
const HOOK = '0x5555555555555555555555555555555555555555';
const REF = '0x6666666666666666666666666666666666666666';
const ZERO = ethers.constants.AddressZero;
const word = (a) => ethers.utils.hexZeroPad(a, 32);
const SEL = (sig) => ethers.utils.id(sig).slice(0, 10);
const IFACE = new ethers.utils.Interface(['function supportsInterface(bytes4) view returns (bool)', 'function hasRole(bytes32,address) view returns (bool)']);

// A fake provider: calls[addr][selector] = return hex (or a function of data),
// storage[addr][slot] = word, code[addr] = hex. Anything missing reverts.
function fakeProvider({ calls = {}, storage = {}, code = {}, logs = [], head = 1000 } = {}) {
  const seen = [];
  return {
    seen,
    async call({ to, data }) {
      seen.push(['call', lc(to), data.slice(0, 10)]);
      const t = calls[lc(to)] || {};
      const r = t[data.slice(0, 10)];
      if (r === undefined) throw new Error('execution reverted');
      return typeof r === 'function' ? r(data) : r;
    },
    async getStorageAt(a, s) { return (storage[lc(a)] || {})[s] || word('0x00'); },
    async getCode(a) { return code[lc(a)] || '0x'; },
    async getBlockNumber() { return head; },
    async getLogs(f) { seen.push(['logs', f.fromBlock, f.toBlock]); return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock); },
  };
}
const ownerIs = (a) => ({ [SEL('owner()')]: word(a) });
const CLEAN_SRC = 'contract T is ERC20 { constructor() ERC20("T","T") { _mint(msg.sender, 1e27); } }';
const SWITCH_SRC = 'contract T is ERC20, Ownable { uint256 public tax; function setTax(uint256 t) external onlyOwner { tax = t; } }';
const fetchOf = (src, counter) => async () => { if (counter) counter.n += 1; return { source: src, error: null }; };
const VERIFIED = { decision: 'PASS', sourceVerified: true, isProxy: false };

async function main() {
  section('1. plain tokens');
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: VERIFIED, fetchSource: fetchOf(CLEAN_SRC) });
    check('no owner, no proxy, clean source -> PASS', r.wouldBe === 'PASS' && r.checked === true, JSON.stringify(r));
    check('marked record only', r.recordOnly === true);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider({ calls: { [lc(TOKEN)]: ownerIs(OWNER) } }), source: VERIFIED, fetchSource: fetchOf(SWITCH_SRC) });
    check('live owner + owner-only setTax -> DO NOT SNIP', r.wouldBe === 'DO NOT SNIP' && /fees/.test(r.summary) && /setTax/.test(r.summary), r.summary);
    check('the owner is recorded as live', r.owner.fn === 'owner' && r.owner.renounced === false && lc(r.owner.address) === lc(OWNER));
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider({ calls: { [lc(TOKEN)]: ownerIs(ZERO) } }), source: VERIFIED, fetchSource: fetchOf(SWITCH_SRC) });
    check('renounced owner + the same switch -> PASS (nobody can use it)', r.wouldBe === 'PASS' && /renounced/.test(r.summary), r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider({ calls: { [lc(TOKEN)]: ownerIs('0x000000000000000000000000000000000000dEaD') } }), source: VERIFIED, fetchSource: fetchOf(SWITCH_SRC) });
    check('owner = 0xdead counts as renounced', r.owner.renounced === true && r.wouldBe === 'PASS', r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider({ calls: { [lc(TOKEN)]: ownerIs(OWNER) } }), source: VERIFIED, fetchSource: fetchOf(CLEAN_SRC) });
    check('live owner but no switches in the source -> PASS, owner noted', r.wouldBe === 'PASS' && /live owner/.test(r.summary), r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider({ calls: { [lc(TOKEN)]: ownerIs(OWNER) } }), source: { decision: 'PASS', sourceVerified: false } });
    check('live owner, no source to read -> UNKNOWN', r.wouldBe === 'UNKNOWN' && /not scanned/.test(r.summary), r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: { decision: 'SKIP', reason: 'no bytecode at this address (EOA or self-destructed)' } });
    check('the reason names what Gate 0 actually said', /Gate 0 SKIP: no bytecode/.test(r.summary), r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: VERIFIED, fetchSource: async () => ({ source: null, error: 'HTTP 402' }) });
    check('source fetch fails -> UNKNOWN with the reason', r.wouldBe === 'UNKNOWN' && /HTTP 402/.test(r.summary), r.summary);
  }

  section('2. proxies');
  const proxySrc = (via, note) => ({ decision: 'PASS', sourceVerified: true, isProxy: true, implementationVia: via, implementationAddr: IMPL, implementationNote: note || null });
  {
    cc._sourceCache.clear();
    const prov = fakeProvider({ storage: { [lc(TOKEN)]: { [cc.SLOT_1967_ADMIN]: word(ADMIN) } } });
    const r = await cc.changeCheck(TOKEN, { provider: prov, source: proxySrc('eip1967'), fetchSource: fetchOf(CLEAN_SRC) });
    check('EIP-1967 proxy with an EOA admin -> DO NOT SNIP', r.wouldBe === 'DO NOT SNIP' && r.proxy.upgrader === ethers.utils.getAddress(ADMIN), r.summary);
    check('the implementation source is the one scanned', lc(r.switches.subject) === lc(IMPL));
  }
  {
    cc._sourceCache.clear();
    const prov = fakeProvider({
      storage: { [lc(TOKEN)]: { [cc.SLOT_1967_ADMIN]: word(ADMIN) } },
      code: { [lc(ADMIN)]: '0x6080' },
      calls: { [lc(ADMIN)]: ownerIs(ZERO) },
    });
    const r = await cc.changeCheck(TOKEN, { provider: prov, source: proxySrc('eip1967'), fetchSource: fetchOf(CLEAN_SRC) });
    check('proxy whose ProxyAdmin is owned by nobody -> PASS', r.wouldBe === 'PASS' && r.proxy.upgraderRenounced === true, r.summary);
  }
  {
    cc._sourceCache.clear();
    const prov = fakeProvider({ calls: { [lc(TOKEN)]: ownerIs(OWNER) } });
    const r = await cc.changeCheck(TOKEN, { provider: prov, source: proxySrc('eip1967'), fetchSource: fetchOf(CLEAN_SRC) });
    check('UUPS proxy (no admin) with a live owner -> DO NOT SNIP', r.wouldBe === 'DO NOT SNIP' && /UUPS/.test(r.proxy.upgraderVia), r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: proxySrc('eip1967'), fetchSource: fetchOf(CLEAN_SRC) });
    check('proxy, no admin, no owner -> UNKNOWN (who can upgrade is unknown)', r.wouldBe === 'UNKNOWN' && /unknown/.test(r.summary), r.summary);
  }
  {
    cc._sourceCache.clear();
    const BEACON = '0x7777777777777777777777777777777777777777';
    const prov = fakeProvider({ calls: { [lc(BEACON)]: ownerIs(OWNER) } });
    const r = await cc.changeCheck(TOKEN, { provider: prov, source: proxySrc('beacon', `beacon ${BEACON}`), fetchSource: fetchOf(CLEAN_SRC) });
    check('beacon proxy, beacon owned by a live wallet -> DO NOT SNIP', r.wouldBe === 'DO NOT SNIP' && r.proxy.upgraderVia === 'beacon owner', r.summary);
  }
  {
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: proxySrc('bytecode-immediate'), fetchSource: fetchOf(CLEAN_SRC) });
    check('minimal clone -> not upgradeable, PASS', r.wouldBe === 'PASS' && r.proxy.upgradeable === false, r.summary);
  }

  section('3. roles');
  {
    cc._sourceCache.clear();
    const ROLE = ethers.utils.id('MINTER_ROLE');
    const logs = [{ blockNumber: 900, topics: [ethers.utils.id('RoleGranted(bytes32,address,address)'), ROLE, word(OWNER), word(OWNER)] }];
    const prov = fakeProvider({
      logs,
      calls: { [lc(TOKEN)]: {
        [SEL('supportsInterface(bytes4)')]: IFACE.encodeFunctionResult('supportsInterface', [true]),
        [SEL('hasRole(bytes32,address)')]: IFACE.encodeFunctionResult('hasRole', [true]),
      } },
    });
    const src = 'contract T is ERC20, AccessControl { function mint(address to, uint256 a) external onlyRole(MINTER_ROLE) { _mint(to, a); } }';
    const r = await cc.changeCheck(TOKEN, { provider: prov, source: VERIFIED, fetchSource: fetchOf(src) });
    check('a live MINTER_ROLE holder + onlyRole mint -> DO NOT SNIP', r.wouldBe === 'DO NOT SNIP' && /mint/.test(r.summary), r.summary);
    check('the holder is listed and confirmed with hasRole', r.roles.holders.length === 1 && r.roles.holders[0].confirmed === true);
  }
  {
    cc._sourceCache.clear();
    const ROLE = ethers.utils.id('MINTER_ROLE');
    const logs = [{ blockNumber: 900, topics: [ethers.utils.id('RoleGranted(bytes32,address,address)'), ROLE, word(OWNER), word(OWNER)] }];
    const prov = fakeProvider({
      logs,
      calls: { [lc(TOKEN)]: {
        [SEL('supportsInterface(bytes4)')]: IFACE.encodeFunctionResult('supportsInterface', [true]),
        [SEL('hasRole(bytes32,address)')]: IFACE.encodeFunctionResult('hasRole', [false]),
      } },
    });
    const src = 'contract T is ERC20, AccessControl { function mint(address to, uint256 a) external onlyRole(MINTER_ROLE) { _mint(to, a); } }';
    const r = await cc.changeCheck(TOKEN, { provider: prov, source: VERIFIED, fetchSource: fetchOf(src) });
    check('the role was granted and later revoked -> PASS', r.wouldBe === 'PASS' && r.roles.holders.length === 0, r.summary);
  }

  section('4. source scan');
  {
    const moo = fs.readFileSync(path.join(__dirname, 'fixtures', 'moo-daeng.sol'), 'utf8');
    const s = cc.scanSwitches(moo);
    const names = s.found.map((f) => f.fn).sort();
    check('Moo Daeng: enableTrading, removeLimits and setTaxWallet found', JSON.stringify(names) === JSON.stringify(['enableTrading', 'removeLimits', 'setTaxWallet']), JSON.stringify(s.found));
    check('setTaxWallet is guarded by a special address list, not the owner', s.found.find((f) => f.fn === 'setTaxWallet').guard === 'special');
    check('transferFrom is not a switch (Gate 5c tests it)', !names.includes('transferFrom'));
    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider({ calls: { [lc(TOKEN)]: ownerIs(ZERO) } }), source: VERIFIED, fetchSource: fetchOf(moo) });
    check('Moo Daeng with ownership renounced: still DO NOT SNIP (the special-address switch)', r.wouldBe === 'DO NOT SNIP' && /setTaxWallet/.test(r.summary), r.summary);
  }
  {
    const src = `contract T {
      function getFee() external view onlyOwner returns (uint256) { return 1; }
      function _setFee(uint256 f) internal { fee = f; }
      function claim() external { _mint(msg.sender, 1); }
      function withdraw() external onlyOwner { payable(msg.sender).transfer(address(this).balance); }
      function pause() external { require(msg.sender == owner(), "no"); paused = true; }
      function blockBot(address a) external { require(_isDev[msg.sender]); bots[a] = true; }
      function setMax(uint256 m) external auth { maxWallet = m; }
    }`;
    const f = cc.scanSwitches(src).found;
    const by = Object.fromEntries(f.map((x) => [x.fn, x]));
    check('view, internal and unguarded functions are ignored', !by.getFee && !by._setFee && !by.claim, JSON.stringify(f));
    check('withdraw is not one of the categories', !by.withdraw);
    check('require(msg.sender == owner()) counts as an owner guard', by.pause && by.pause.guard === 'owner' && by.pause.category === 'trading');
    check('require(_isDev[msg.sender]) counts as a special guard', by.blockBot && by.blockBot.guard === 'special' && by.blockBot.category === 'blacklist');
    check('a custom modifier (auth) counts, and a body-only hit is categorised', by.setMax && by.setMax.category === 'limits');
  }
  {
    const s = cc.scanSwitches('contract T { function kill() external onlyOwner { selfdestruct(payable(msg.sender)); } }');
    check('selfdestruct is noted', s.notes.includes('selfdestruct in the source'));
    const j = cc.judge({ owner: { fn: null }, proxy: { isProxy: false }, roles: { accessControl: false, holders: [] }, switches: s, hook: null });
    check('... and makes a plain contract UNKNOWN', j.wouldBe === 'UNKNOWN', j.summary);
  }
  {
    const s = cc.scanSwitches('interface I { function setFee(uint256 f) external; }');
    check('interface declarations are not functions with a body', s.found.length === 0);
  }

  section('4b. only the token\'s own contract is scanned');
  {
    // KILTR, 24 Oct: the explorer returned the token bundled with the whole
    // launchpad (hook, factory). Their admin functions are not the token's.
    const BUNDLE = `
      abstract contract Ownable { address private _owner; modifier onlyOwner() { require(msg.sender == _owner); _; } }
      interface IHook { function setHookFeeBps(uint256 b) external; }
      contract LaunchToken is ERC20 { constructor() ERC20("A", "A") { _mint(msg.sender, 1e27); } }
      contract LaunchFactory is Ownable { uint256 fee; function setLaunchFee(uint256 f) external onlyOwner { fee = f; }
        function deployLaunch() external onlyOwner { _mint(address(this), 1); } }
      contract MemeHook is Ownable { uint256 bps; function setHookFeeBps(uint256 b) external onlyOwner { bps = b; } }`;
    const scoped = cc.scanSwitches(BUNDLE, { contract: 'LaunchToken' });
    check('with the token\'s name: only LaunchToken is scanned, nothing found', scoped.contract === 'LaunchToken' && scoped.found.length === 0 && scoped.scoped === true, JSON.stringify(scoped));
    const blind = cc.scanSwitches(BUNDLE);
    check('without a name and 3 candidate contracts: not scoped', blind.scoped === false && blind.found.length > 0, JSON.stringify(blind));
    const j = cc.judge({ owner: { fn: null }, proxy: { isProxy: false }, roles: { accessControl: false, holders: [] }, switches: blind, hook: null });
    check('... which makes it UNKNOWN, never DO NOT SNIP', j.wouldBe === 'UNKNOWN' && /could not be told apart/.test(j.summary), j.summary);

    cc._sourceCache.clear();
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: VERIFIED, fetchSource: async () => ({ source: BUNDLE, name: 'LaunchToken', error: null }) });
    check('end to end: the explorer\'s contract name scopes the scan -> PASS', r.wouldBe === 'PASS' && r.switches.contract === 'LaunchToken', r.summary);

    cc._sourceCache.clear();
    const r2 = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: { ...VERIFIED, explorer_name: 'LaunchToken' }, fetchSource: async () => ({ source: BUNDLE, error: null }) });
    check('... or Gate 0\'s explorer name when the fetch gives none', r2.wouldBe === 'PASS' && r2.switches.contract === 'LaunchToken', r2.summary);
  }
  {
    // A switch in a contract the token inherits from does count.
    const SRC = `
      abstract contract Ownable { address private _owner; modifier onlyOwner() { require(msg.sender == _owner); _; } }
      abstract contract Taxed is Ownable { uint256 public tax; function setTax(uint256 t) external onlyOwner { tax = t; } }
      contract Other is Ownable { function setFee(uint256 f) external onlyOwner {} }
      contract Token is ERC20("T", "T"), Taxed { }`;
    const s1 = cc.scanSwitches(SRC, { contract: 'Token' });
    check('a switch inherited from a parent contract is found', s1.found.map((f) => f.fn).join() === 'setTax' && s1.inherits.includes('Taxed') && s1.inherits.includes('Ownable'), JSON.stringify(s1));
    check('constructor arguments in the "is" list are handled', s1.contract === 'Token');
    const s2 = cc.scanSwitches(SRC);
    check('without a name, "the contract nobody inherits from" is ambiguous here (Token, Other)', s2.scoped === false);
  }
  {
    const moo = fs.readFileSync(path.join(__dirname, 'fixtures', 'moo-daeng.sol'), 'utf8');
    const s = cc.scanSwitches(moo);
    check('Moo Daeng without a name: the single most-derived contract is found', s.scoped === true && s.contract && s.found.length === 3, JSON.stringify({ c: s.contract, n: s.found.length }));
  }

  section('5. template tokens and the source cache');
  {
    cc._sourceCache.clear();
    const n = { n: 0 };
    let asked = null;
    const fetch = async (a) => { n.n += 1; asked = a; return { source: CLEAN_SRC, error: null }; };
    const tm = { matched: true, name: 'PonsV2LauncherToken', reference: REF };
    const src = { decision: 'PASS', sourceVerified: false, isProxy: false, codeSha256NoMeta: 'abc' };
    const r = await cc.changeCheck(TOKEN, { provider: fakeProvider(), source: src, template: tm, fetchSource: fetch });
    check('template token: the reference source is scanned', r.switches.scanned && lc(asked) === lc(REF) && r.switches.viaTemplate === 'PonsV2LauncherToken', JSON.stringify(r.switches));
    check('... and it is PASS, not "not scanned"', r.wouldBe === 'PASS', r.summary);
    const TOKEN2 = '0x8888888888888888888888888888888888888888';
    const r2 = await cc.changeCheck(TOKEN2, { provider: fakeProvider(), source: { ...src }, template: tm, fetchSource: fetch });
    check('a second token of the same template is not fetched again', n.n === 1 && r2.switches.cached === true, String(n.n));
    const r3 = await cc.changeCheck('0x9999999999999999999999999999999999999999', { provider: fakeProvider(), source: { ...VERIFIED, codeSha256NoMeta: 'abc' }, fetchSource: fetch });
    check('a verified token with the same bytecode uses the cache too', n.n === 1 && r3.switches.cached === true, String(n.n));
  }

  section('6. the v4 hook is reported, not judged');
  {
    cc._sourceCache.clear();
    const pool = { version: 'v4', hooks: HOOK };
    const prov = fakeProvider({ code: { [lc(HOOK)]: '0x6080' }, calls: { [lc(HOOK)]: ownerIs(OWNER) } });
    const r = await cc.changeCheck(TOKEN, { provider: prov, pool, source: VERIFIED, fetchSource: fetchOf(CLEAN_SRC) });
    check('hook with a live owner: recorded', r.hook && r.hook.owner === ethers.utils.getAddress(OWNER) && r.hook.ownerRenounced === false);
    check('... in the notes, but wouldBe stays PASS', r.wouldBe === 'PASS' && /hook/.test(r.summary), r.summary);
    const r2 = await cc.changeCheck(TOKEN, { provider: prov, pool: { version: 'v3', poolAddress: HOOK }, source: VERIFIED, fetchSource: fetchOf(CLEAN_SRC) });
    check('v3 pool: no hook part', r2.hook === null);
  }

  section('7. it never throws');
  {
    cc._sourceCache.clear();
    const slow = { ...fakeProvider(), call: () => new Promise(() => {}) };
    const r = await cc.changeCheck(TOKEN, { provider: slow, source: VERIFIED, fetchSource: fetchOf(CLEAN_SRC), timeoutMs: 200 });
    check('a hung RPC -> NOT CHECKED after the timeout', r.checked === false && r.wouldBe === 'NOT CHECKED' && /timed out/.test(r.error), JSON.stringify(r));
    const r2 = await cc.changeCheck(TOKEN, { provider: null, source: VERIFIED, fetchSource: fetchOf(CLEAN_SRC) });
    check('no provider at all -> a result, not a crash', typeof r2.wouldBe === 'string', JSON.stringify(r2));
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
