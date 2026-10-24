// Offline tests for controller-check.js. No RPC: a small fake chain answers
// getBlock / getLogs / getCode / eth_call.
//
//   node test-controller-check.js
//
// The failure that matters most is a false LOCKED — telling a buyer liquidity
// is safe when an ordinary wallet can pull it. Several cases exist only to make
// sure that cannot happen.

const { ethers } = require('ethers');
const cc = require('./controller-check');
const { ADDR } = require('./config');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);
const BN = (x) => ethers.BigNumber.from(x);
const lc = (a) => String(a).toLowerCase();

const pm = new ethers.utils.Interface([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);
const sv = new ethers.utils.Interface([
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);
const nft = new ethers.utils.Interface(['function ownerOf(uint256 tokenId) view returns (address)']);

const T0 = 1_780_000_000; // unix seconds at block 0
const HEAD = 20_000_000;
const tsOf = (n) => T0 + Math.floor(n / 10); // 10 blocks per second
const POOL_ID = '0x' + 'ab'.repeat(32);
const TOKEN = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const SAFE = '0x3333333333333333333333333333333333333333'; // a contract, not a known locker
const LOCKER = ADDR.PONS_V2_LAUNCH_LOCKER;
const POSM = cc.POSITION_MANAGER;

const salt = (id) => ethers.utils.hexZeroPad(BN(id).toHexString(), 32);

// A fake chain. `positions`: { sender, tokenId|null, owner (for NFTs), added, now, block }
function fakeChain({ positions, createdBlock = 15_000_000, codeAt = {}, refuseLogs = false }) {
  const logs = [];
  const initFrag = pm.getEvent('Initialize');
  const e = pm.encodeEventLog(initFrag, [POOL_ID, ADDR.ZERO, TOKEN, 10000, 200, ADDR.ZERO, BN(2).pow(96), 0]);
  logs.push({ ...e, address: ADDR.UNIV4_POOL_MANAGER, blockNumber: createdBlock });
  for (const p of positions) {
    const s = p.tokenId != null ? salt(p.tokenId) : ethers.constants.HashZero;
    const ev = pm.encodeEventLog(pm.getEvent('ModifyLiquidity'), [POOL_ID, p.sender, -887200, 887200, BN(p.added), s]);
    logs.push({ ...ev, address: ADDR.UNIV4_POOL_MANAGER, blockNumber: p.block ?? createdBlock + 5 });
  }
  const code = { [lc(POSM)]: '0x60', [lc(LOCKER)]: '0x60', [lc(SAFE)]: '0x60', ...codeAt };
  return {
    async getBlock(tag) {
      const n = tag === 'latest' ? HEAD : Number(tag);
      return n > HEAD ? null : { number: n, timestamp: tsOf(n) };
    },
    async getBlockNumber() { return HEAD; },
    async getCode(a) { return code[lc(a)] || '0x'; },
    async getLogs(f) {
      if (refuseLogs) throw new Error('range too large');
      return logs.filter((l) => l.topics[0] === f.topics[0] && l.topics[1] === f.topics[1]
        && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
    async call({ to, data }) {
      if (lc(to) === lc(cc.STATE_VIEW) && data.startsWith(sv.getSighash('getPositionInfo'))) {
        const [, owner, , , sl] = sv.decodeFunctionData('getPositionInfo', data);
        const p = positions.find((x) => lc(x.sender) === lc(owner)
          && (x.tokenId != null ? salt(x.tokenId) : ethers.constants.HashZero) === sl);
        return sv.encodeFunctionResult('getPositionInfo', [BN(p ? p.now : 0), 0, 0]);
      }
      if (lc(to) === lc(cc.STATE_VIEW) && data.startsWith(sv.getSighash('getLiquidity'))) {
        return sv.encodeFunctionResult('getLiquidity', [positions.reduce((a, x) => a.add(x.now), BN(0))]);
      }
      if (lc(to) === lc(POSM) && data.startsWith(nft.getSighash('ownerOf'))) {
        const [id] = nft.decodeFunctionData('ownerOf', data);
        const p = positions.find((x) => x.tokenId != null && BN(x.tokenId).eq(id));
        if (!p || !p.owner) throw new Error('ERC721: invalid token ID');
        return nft.encodeFunctionResult('ownerOf', [p.owner]);
      }
      throw new Error('not stubbed');
    },
  };
}

const pool = { version: 'v4', poolId: POOL_ID, hooks: ADDR.ZERO, tokenAddr: TOKEN };
const around = new Date(tsOf(15_000_000 + 3000) * 1000).toISOString(); // first seen ~5 min after creation

async function main() {

section('1. finding the block for a time');
{
  const chain = fakeChain({ positions: [] });
  for (const n of [1_000, 5_000_000, 15_000_000, 19_999_000]) {
    const got = await cc.blockAtTime(chain, tsOf(n));
    check(`block ${n} is found within 2s of its time`, Math.abs(tsOf(got) - tsOf(n)) <= 2, `${got}`);
  }
  check('a future time returns the head', (await cc.blockAtTime(chain, tsOf(HEAD) + 999)) === HEAD);
}

section('2. creator-seeded pool, the creator still holds the NFT -> CREATOR_CAN_PULL');
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 42, owner: CREATOR, added: 1e12, now: 1e12 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('verdict CREATOR_CAN_PULL', r.verdict === 'CREATOR_CAN_PULL', `${r.verdict}: ${r.reason}`);
  check('names the wallet', lc(r.controller || '') === lc(CREATOR));
  check('100% held by an ordinary wallet', r.eoaSharePct === 100);
  check('found the creation block', r.createdBlock === 15_000_000);
  check('resolved through the PositionManager NFT', r.positions[0].via === 'PositionManager NFT' && r.positions[0].tokenId === '42');
}

section('3. Pons graduate: the locker holds the NFT -> LOCKED');
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 7, owner: LOCKER, added: 5e12, now: 5e12 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('verdict LOCKED', r.verdict === 'LOCKED', `${r.verdict}: ${r.reason}`);
  check('names the Pons locker', /PonsV2LaunchLocker/.test(r.reason));
  check('100% locked', r.lockedSharePct === 100);
}

section('4. drained: the seeding position is empty now -> DRAINED');
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 9, owner: CREATOR, added: 1e12, now: 0 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('verdict DRAINED', r.verdict === 'DRAINED', `${r.verdict}: ${r.reason}`);
}
{
  // Burned NFT: the creator removed the liquidity and burned the position.
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 10, owner: null, added: 1e12, now: 0 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('a burned position NFT with no liquidity is DRAINED too', r.verdict === 'DRAINED', `${r.verdict}`);
}

section('5. never a false LOCKED');
{
  // Mostly locked, but a wallet still holds 20%: the wallet can pull a fifth of
  // the pool, and that is the verdict that must win.
  const chain = fakeChain({ positions: [
    { sender: POSM, tokenId: 1, owner: LOCKER, added: 8e12, now: 8e12 },
    { sender: POSM, tokenId: 2, owner: CREATOR, added: 2e12, now: 2e12 },
  ] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('80% locked + 20% wallet -> CREATOR_CAN_PULL, not LOCKED', r.verdict === 'CREATOR_CAN_PULL', `${r.verdict}`);
  check('the wallet share is 20%', r.eoaSharePct === 20, String(r.eoaSharePct));
}
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 3, owner: SAFE, added: 1e12, now: 1e12 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('an unknown contract holder -> UNKNOWN, not LOCKED', r.verdict === 'UNKNOWN', `${r.verdict}`);
  check('and says so', /unknown contract/.test(r.reason));
}
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 4, owner: ADDR.PONS_V2_LAUNCH_FACTORY, added: 1e12, now: 1e12 }],
    codeAt: { [lc(ADDR.PONS_V2_LAUNCH_FACTORY)]: '0x60' } });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('a launchpad contract (not a locker) -> UNKNOWN, labelled', r.verdict === 'UNKNOWN' && /launchpad/.test(r.reason), `${r.verdict}: ${r.reason}`);
}
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 5, owner: CREATOR, added: 1e12, now: 1e12, block: 1_000 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('seeding outside the window -> UNKNOWN ("found nothing" is not a pass)', r.verdict === 'UNKNOWN', `${r.verdict}`);
}
{
  const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 6, owner: LOCKER, added: 1e12, now: 1e12 }], refuseLogs: true });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('the RPC refusing logs -> UNKNOWN with a note', r.verdict === 'UNKNOWN' && r.notes.some((n) => /refused/.test(n)), `${r.verdict}`);
}

section('6. a direct (non-NFT) position held by a wallet contract call');
{
  // A contract that called the PoolManager itself: the holder is the caller.
  const chain = fakeChain({ positions: [{ sender: SAFE, tokenId: null, added: 1e12, now: 1e12 }] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('holder is the caller itself, classified as a contract', r.positions[0].holder === SAFE && r.positions[0].holderKind === 'contract');
}

section('7. the fresh-launch window (no first-sighting time)');
{
  const chain = fakeChain({ createdBlock: HEAD - 1000, positions: [{ sender: POSM, tokenId: 11, owner: CREATOR, added: 1e12, now: 1e12, block: HEAD - 990 }] });
  const r = await cc.controllerCheck(pool, { provider: chain });
  check('a pool created minutes ago is found in the recent window', r.verdict === 'CREATOR_CAN_PULL', `${r.verdict}: ${r.reason}`);
}

section('8. v3 and missing pools are UNKNOWN, never a pass');
{
  const r = await cc.controllerCheck({ version: 'v3', poolAddress: TOKEN }, { provider: fakeChain({ positions: [] }) });
  check('v3 -> UNKNOWN with a reason', r.verdict === 'UNKNOWN' && /v3/.test(r.reason));
  const r2 = await cc.controllerCheck(null, { provider: fakeChain({ positions: [] }) });
  check('no pool -> UNKNOWN', r2.verdict === 'UNKNOWN');
}

section('10. contract holders recognised by their runtime code');
{
  const FEE_SPLITTER = '0xeFF166AAf189323c58dc27eD1206EB2C37FaACDf';
  const OTHER_SPLITTER = '0x4444444444444444444444444444444444444444';
  const SPLITTER_CODE = '0x6080604052' + 'ab'.repeat(40);
  const codeAt = { [lc(FEE_SPLITTER)]: SPLITTER_CODE, [lc(OTHER_SPLITTER)]: SPLITTER_CODE };
  {
    const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 20, owner: FEE_SPLITTER, added: 1e12, now: 1e12 }], codeAt });
    const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
    check('the reviewed FeeSplitter instance -> LOCKED', r.verdict === 'LOCKED' && /FeeSplitter/.test(r.reason), `${r.verdict}: ${r.reason}`);
    check('its code hash is reported', r.positions[0].holderCodeHash === ethers.utils.keccak256(SPLITTER_CODE));
  }
  {
    const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 21, owner: OTHER_SPLITTER, added: 1e12, now: 1e12 }], codeAt });
    const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
    check('ANOTHER deployment with identical code -> LOCKED too', r.verdict === 'LOCKED', `${r.verdict}: ${r.reason}`);
  }
  {
    const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 22, owner: OTHER_SPLITTER, added: 1e12, now: 1e12 }],
      codeAt: { [lc(FEE_SPLITTER)]: SPLITTER_CODE, [lc(OTHER_SPLITTER)]: SPLITTER_CODE + '00' } });
    const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
    check('one byte of different code -> UNKNOWN, not LOCKED', r.verdict === 'UNKNOWN', `${r.verdict}`);
  }
  {
    // EIP-7702: an ordinary wallet that delegated to some code is still a wallet.
    const chain = fakeChain({ positions: [{ sender: POSM, tokenId: 23, owner: CREATOR, added: 1e12, now: 1e12 }],
      codeAt: { [lc(CREATOR)]: '0xef0100' + '55'.repeat(20) } });
    const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
    check('an EIP-7702 delegated wallet is still a wallet -> CREATOR_CAN_PULL', r.verdict === 'CREATOR_CAN_PULL', `${r.verdict}: ${r.reason}`);
  }
}

section('11. launch positions gone, but others added liquidity later');
{
  // A position added long after the window, by someone else, is live in the pool.
  const chain = fakeChain({ positions: [
    { sender: POSM, tokenId: 30, owner: CREATOR, added: 1e12, now: 0 },
    { sender: POSM, tokenId: 31, owner: SAFE, added: 5e11, now: 5e11, block: 19_000_000 },
  ] });
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: around });
  check('not DRAINED while the pool still holds liquidity', r.verdict === 'UNKNOWN', `${r.verdict}: ${r.reason}`);
  check('and it says the launch positions left', /launch position/.test(r.reason));
}

section('12. the window walks back to find a pool created long before it was first seen');
{
  const created = 15_000_000;
  const chain = fakeChain({ createdBlock: created, positions: [{ sender: POSM, tokenId: 40, owner: LOCKER, added: 1e12, now: 1e12, block: created + 5 }] });
  const lateSighting = new Date(tsOf(created + 10 * 3600 * 10) * 1000).toISOString(); // first seen 10h later
  const r = await cc.controllerCheck(pool, { provider: chain, aroundTime: lateSighting });
  check('found the creation 10h before the sighting', r.createdBlock === created, String(r.createdBlock));
  check('and got the verdict right', r.verdict === 'LOCKED', `${r.verdict}: ${r.reason}`);
  check('the window says it was extended', /extended back/.test(r.window || ''), r.window);
  const tooLate = new Date(tsOf(created + 60 * 3600 * 10) * 1000).toISOString(); // 60h later: beyond the 48h cap
  const r2 = await cc.controllerCheck(pool, { provider: chain, aroundTime: tooLate });
  check('beyond 48h it stops and says UNKNOWN, not a guess', r2.verdict === 'UNKNOWN', `${r2.verdict}`);
}

section('13. a token with several pools is timed from THIS pool\'s first sighting');
{
  const fs = require('fs'); const path = require('path');
  const f = path.join(__dirname, '_tmp-cc-cache.jsonl');
  fs.writeFileSync(f, [
    { timestamp: '2026-09-11T12:00:00Z', tokenAddr: TOKEN, poolId: '0x' + '01'.repeat(32) },
    { timestamp: '2026-09-11T14:00:00Z', tokenAddr: TOKEN, poolId: '0x' + '02'.repeat(32) },
    { timestamp: '2026-09-11T15:00:00Z', tokenAddr: TOKEN, poolId: '0x' + '02'.repeat(32) },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const idx = cc.cacheIndex(f);
  check('the second pool is timed from ITS first sighting (14:00), not the token\'s (12:00)',
    cc.firstSeenFor(idx, TOKEN, '0x' + '02'.repeat(32)) === '2026-09-11T14:00:00Z');
  check('an unknown poolId falls back to the token\'s first sighting',
    cc.firstSeenFor(idx, TOKEN, '0x' + '09'.repeat(32)) === '2026-09-11T12:00:00Z');
  fs.unlinkSync(f);
}

section('9. scoring against the drain labels');
{
  const rows = [
    { verdict: 'LOCKED', drained: 'still has liquidity' },
    { verdict: 'LOCKED', drained: 'DRAINED' },
    { verdict: 'DRAINED', drained: 'DRAINED' },
    { verdict: 'CREATOR_CAN_PULL', drained: 'still has liquidity' },
    { verdict: 'UNKNOWN', drained: '' },
  ];
  const t = cc.scoreRows(rows);
  check('LOCKED row counts one alive and one drained', t.LOCKED.alive === 1 && t.LOCKED.drained === 1);
  check('DRAINED row counts drained', t.DRAINED.drained === 1);
  check('unlabelled is kept separate', t.UNKNOWN.unlabelled === 1);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
