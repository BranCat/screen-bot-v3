// Offline tests for extras/gate6-recheck.js. No RPC, no Tenderly, no explorer.
//
//   node extras/test-gate6-recheck.js
//
// The fake Tenderly reproduces LEGEND (19 Oct): on the screen's own block the
// rug check's buy-and-sell works; on a later block (an unpinned bundle) the
// price has fallen, the victim's buy returns fewer tokens than Gate 3's, and
// every rung of the sell ladder reverts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');

// ---- stub Tenderly before gate6-recheck (and through it rug-check) loads ----
const client = require('../tenderly-client');
let SCRIPT = null;
const SENT = []; // block_number of every step of every bundle
client.simulateBundle = async (steps) => {
  SENT.push(steps.map((s) => (s.block_number == null ? null : s.block_number)));
  return SCRIPT(steps);
};
// Any explorer lookup that bypasses the test's own stub would reach the real
// explorer on the server (it did, 20 Oct). Make such a call loud instead.
const sg = require('../source-gate');
let STRAY_EXPLORER = 0;
sg.explorerHttp = () => async () => { STRAY_EXPLORER += 1; return { status: 200, error: null, json: { items: [{ address: { hash: '0x' + '4'.repeat(40), is_contract: false }, value: '1000' }] } }; };
const G = require('./gate6-recheck');
const rug = require('../rug-check');
const ADDR = require('../config').ADDR;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};
const section = (t) => console.log(`\n${t}`);
const E = (x) => ethers.utils.parseEther(String(x));

const TOKEN = '0x9758a9CF6318211d3548F3005ddd4464dF12a407';
const WHALE = '0x5555555555555555555555555555555555555555';
const POSM = ADDR.UNIV4_POSITION_MANAGER;
const LOCKER = ADDR.PONS_V2_LAUNCH_LOCKER;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const PIN_BLOCK = 92467635;
const HEAD = PIN_BLOCK + 300000;
const POOL_ID = '0x' + 'cd'.repeat(32);

const okStep = { reverted: false, indeterminate: false, returnData: '0x', errorMessage: null, raw: {} };
const badStep = (msg) => ({ reverted: true, indeterminate: false, returnData: '0x', errorMessage: msg, raw: {} });
const sellStep = (eth, victim) => ({
  reverted: false, indeterminate: false, returnData: '0x', errorMessage: null,
  raw: { transaction: { transaction_info: { balance_diff: [{ address: victim, original: '0', dirty: E(eth).toString() }] } } },
});

// Tenderly model. pinned: the screen block. Unpinned: a later block where the
// price fell 20%, so a 100/99/95/90% sell of Gate 3's tokens always reverts.
// dumpRecovery: what the victim gets after the whale's dump, as a share of 0.047.
let MODEL = { dumpRecovery: 0.85, whaleSellReverts: false };
SCRIPT = (steps) => {
  const pinned = steps.every((s) => s.block_number === PIN_BLOCK);
  const victim = steps[0].from;
  const r = steps.map(() => ({ ...okStep }));
  const last = steps.length - 1;
  const hasDump = steps.some((s) => String(s.from).toLowerCase() === WHALE.toLowerCase());
  if (!pinned) { r[last] = badStep('execution reverted: insufficient balance'); return r; }
  if (hasDump) {
    if (MODEL.whaleSellReverts) {
      const i = steps.findIndex((s) => String(s.from).toLowerCase() === WHALE.toLowerCase());
      r[i] = badStep('execution reverted: transfer amount exceeds balance');
      return r;
    }
    r[last] = sellStep(0.047 * MODEL.dumpRecovery, victim);
    return r;
  }
  r[last] = sellStep(0.047, victim);
  return r;
};

// RPC model: the position belongs to `owner`; the whale held `whaleAtPin` on the
// screen block and nothing now; `noHistory` makes old-block reads fail.
const pm = new ethers.utils.Interface(['event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)']);
const erc20 = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)']);
function rpc({ owner = LOCKER, whaleAtPin = E(4_000_000), noHistory = false } = {}) {
  const seen = { callTags: [], getLogsTo: [] };
  return {
    seen,
    async getBlockNumber() { return HEAD; },
    async getBlock(n) { return { number: n === 'latest' ? HEAD : n, timestamp: 1_792_000_000 }; },
    async getLogs(f) {
      seen.getLogsTo.push(f.toBlock);
      const salt = ethers.utils.hexZeroPad(ethers.BigNumber.from(3900332).toHexString(), 32);
      const ev = pm.encodeEventLog(pm.getEvent('ModifyLiquidity'), [POOL_ID, POSM, -887200, 887200, ethers.BigNumber.from('29277002188455996518849'), salt]);
      return [{ address: ADDR.UNIV4_POOL_MANAGER, topics: ev.topics, data: ev.data, blockNumber: PIN_BLOCK - 5000 }];
    },
    async getCode(a) { const x = String(a).toLowerCase(); return (x === POSM.toLowerCase() || x === LOCKER.toLowerCase()) ? '0xdeadbeef' : '0x'; },
    async call({ to, data }, tag) {
      seen.callTags.push(tag);
      if (noHistory && tag !== 'latest') throw new Error('missing trie node 0xabc (path ) state is not available');
      if (String(to).toLowerCase() === POSM.toLowerCase() && data.startsWith('0x6352211e')) return ethers.utils.hexZeroPad(owner, 32);
      if (data.startsWith('0x70a08231')) {
        return erc20.encodeFunctionResult('balanceOf', [tag === PIN_BLOCK ? whaleAtPin : 0]);
      }
      throw new Error('unexpected call');
    },
    async getNetwork() { return { chainId: 4663 }; },
  };
}
// The explorer's holders list: the whale, with today's (different) balance.
const http = async () => ({ status: 200, error: null, json: { items: [{ address: { hash: WHALE, is_contract: false }, value: E(3_000_000).toString() }] } });

function screenFile({ verdict = 'PASSED GATES 0-5', gate = 6, controller = 'LOCKED', pinned = true, rt = true, version = 'v4', symbol = 'LEGEND', token = TOKEN } = {}) {
  const pool = {
    version, tokenAddr: token, base: 'ETH', baseAddr: ADDR.ZERO, fee: 0, poolId: POOL_ID,
    hooks: ADDR.PONS_V2_MEME_HOOK,
    poolKey: { currency0: ADDR.ZERO, currency1: token, fee: 0, tickSpacing: 200, hooks: ADDR.PONS_V2_MEME_HOOK },
  };
  return {
    record: { symbol, token, version, verdict, gate, reason: 'gates 0-5 clean, but the rug check is inconclusive: removal probe: UNPROVEN (no usable baseline: baseline sell reverted …)', createdBlock: PIN_BLOCK - 5000, audit: pinned ? { pinnedBlock: PIN_BLOCK } : null },
    result: { rug: { whaleDump: null } },
    detail: {
      pool,
      controller: { verdict: controller, reason: controller === 'LOCKED' ? '100% of the liquidity is held by PonsV2LaunchLocker (permanent lock)' : 'v3 pools are not covered by the controller check yet' },
      roundTrips: rt ? { sim1: { amountEth: 0.05, tokensReceivedWei: E(2_500_000).toString(), soldBps: 10000, pinnedBlock: pinned ? PIN_BLOCK : null } } : {},
    },
  };
}
const asScreen = (j, file = '2026-10-19/021620_LEGEND_x.json') => ({ file, date: file.slice(0, 10), time: file.slice(11, 17), j });

async function main() {
  section('1. what the recheck reads from a screen file');
  {
    const inp = G.inputsOf(screenFile());
    check('the screen\'s pinned block', inp.block === PIN_BLOCK, String(inp.block));
    check('Gate 3\'s tokens size the sells', inp.tokenOutWei.eq(E(2_500_000)));
    check('the controller verdict is carried over', inp.controller.verdict === 'LOCKED');
    check('a file from before 18 Oct (no pinned block) is not run', /no pinned block/.test(G.inputsOf(screenFile({ pinned: false })).error || ''));
    check('a token that stopped before Gate 3 is not run', /before Gate 3/.test(G.inputsOf(screenFile({ rt: false })).error || ''));
  }

  section('2. which tokens it picks');
  {
    const s = [
      asScreen(screenFile(), '2026-10-19/021620_LEGEND_a.json'),
      asScreen(screenFile({ verdict: 'SNIP', gate: null, symbol: 'OPSIS', token: '0x' + '7'.repeat(40) }), '2026-10-19/210659_OPSIS_b.json'),
      asScreen(screenFile({ verdict: 'DO NOT SNIP', gate: 6, symbol: 'CROPZ', token: '0x' + '8'.repeat(40) }), '2026-10-19/144417_CROPZ_c.json'),
      asScreen(screenFile({ verdict: 'DO NOT SNIP', gate: '1b', symbol: 'PULL', token: '0x' + '9'.repeat(40) }), '2026-10-19/150000_PULL_d.json'),
    ];
    check('default: the PASSED GATES 0-5 tokens', G.pick(s).map((x) => x.j.record.symbol).join() === 'LEGEND');
    check('--set snip: the SNIPs', G.pick(s, { set: 'snip' }).map((x) => x.j.record.symbol).join() === 'OPSIS');
    check('--set gate6: everything judged at Gate 6', G.pick(s, { set: 'gate6' }).map((x) => x.j.record.symbol).join() === 'LEGEND,CROPZ,OPSIS');
    check('--token: that token, any verdict', G.pick(s, { token: '0x' + '9'.repeat(40) }).length === 1);
  }

  section('3. LEGEND reproduced: unpinned, the baseline sell reverts (what the bot saw)');
  {
    SENT.length = 0;
    const r = await rug.rugCheck(screenFile().detail.pool, ADDR, {
      provider: rpc(), baseAmountWei: E(0.05), baselineTokenOutWei: E(2_500_000), controller: { verdict: 'LOCKED', reason: 'locker' },
      whale: WHALE, whaleBalanceWei: E(4_000_000),
    });
    check('live-bot behaviour: UNPROVEN with "baseline sell reverted"', r.decision === 'UNPROVEN' && /baseline sell reverted/.test(r.reason), `${r.decision}: ${r.reason}`);
    check('every rung of the ladder was tried (4 bundles), none pinned', SENT.length === 4 && SENT.every((b) => b.every((x) => x == null)), JSON.stringify(SENT.map((b) => b[0])));
  }

  section('4. the second opinion on the same token, pinned to its screen block');
  {
    SENT.length = 0;
    MODEL = { dumpRecovery: 0.85, whaleSellReverts: false };
    const prov = rpc();
    const row = await G.recheck(asScreen(screenFile()), { provider: prov, http });
    check('baseline works on the screen block', row.baselineOk === true && Math.abs(row.baselineRatio - 0.94) < 1e-6, `${row.baselineOk} ${row.baselineRatio}`);
    check('second opinion: WOULD SNIP', row.secondOpinion === 'WOULD SNIP', `${row.secondOpinion}: ${row.reason}`);
    check('whale dump measured: 85% recovered', row.whaleRecovery === 0.85, String(row.whaleRecovery));
    check('agreement says the bot missed a SNIP', G.agreement(row) === 'bot missed a SNIP');
    check('every Tenderly step carried the screen block', SENT.length >= 2 && SENT.every((b) => b.every((x) => x === PIN_BLOCK)), JSON.stringify(SENT));
    check('every RPC read was made as of the screen block', prov.seen.callTags.length > 0 && prov.seen.callTags.every((t) => t === PIN_BLOCK), JSON.stringify(prov.seen.callTags));
    check('the position census stopped at the screen block', prov.seen.getLogsTo.every((t) => t <= PIN_BLOCK), JSON.stringify(prov.seen.getLogsTo));
    check('the whale\'s on-chain balance at that block was used, and the explorer gap noted', /on-chain one was used/.test(row.whaleNote || ''), row.whaleNote);
    check('the pin is released afterwards', G.PIN.block === null);
  }

  section('5. other answers');
  {
    MODEL = { dumpRecovery: 0.3, whaleSellReverts: false };
    const bad = await G.recheck(asScreen(screenFile()), { provider: rpc(), http });
    check('a dump that leaves 30% -> DO NOT SNIP', bad.secondOpinion === 'DO NOT SNIP' && /30\.0%/.test(bad.reason), `${bad.secondOpinion}: ${bad.reason}`);
    check('... which the bot missed', G.agreement(bad) === 'bot missed a rejection');

    MODEL = { dumpRecovery: 0.85, whaleSellReverts: true };
    const stuck = await G.recheck(asScreen(screenFile()), { provider: rpc(), http });
    check('the whale\'s own sell reverting on the pinned block -> STILL INCONCLUSIVE', stuck.secondOpinion === 'STILL INCONCLUSIVE' && /top holder's own sell reverted/.test(stuck.reason), `${stuck.secondOpinion}: ${stuck.reason}`);

    MODEL = { dumpRecovery: 0.85, whaleSellReverts: false };
    const empty = await G.recheck(asScreen(screenFile()), { provider: rpc({ whaleAtPin: E(0) }), http });
    check('a top holder with nothing at the screen block is said so', /held nothing at the screen block/.test(empty.whaleNote || ''), empty.whaleNote);
    check('... and the whale dump stays unproven', empty.secondOpinion === 'STILL INCONCLUSIVE', empty.secondOpinion);
  }

  section('6. the v3 rule: no SNIP without a known liquidity controller');
  {
    MODEL = { dumpRecovery: 0.85, whaleSellReverts: false };
    // A burned position passes the removal probe, so only the controller rule stops it.
    const row = await G.recheck(asScreen(screenFile({ controller: 'UNKNOWN' })), { provider: rpc({ owner: DEAD }), http });
    check('a pass with controller UNKNOWN is "PASS, LIQUIDITY CONTROL UNKNOWN"', row.secondOpinion === 'PASS, LIQUIDITY CONTROL UNKNOWN', `${row.secondOpinion}: ${row.reason}`);
    check('never "WOULD SNIP"', row.secondOpinion !== 'WOULD SNIP');
    check('the v3 note is attached', row.notes.some((n) => /v3 rule/.test(n)), row.notes.join(' | '));
    const lockerUnknown = await G.recheck(asScreen(screenFile({ controller: 'UNKNOWN' })), { provider: rpc(), http });
    check('a contract-held position with controller UNKNOWN stays inconclusive', lockerUnknown.secondOpinion === 'STILL INCONCLUSIVE', lockerUnknown.secondOpinion);
  }

  section('7. an RPC without old state');
  {
    MODEL = { dumpRecovery: 0.85, whaleSellReverts: false };
    SENT.length = 0;
    const row = await G.recheck(asScreen(screenFile()), { provider: rpc({ noHistory: true }), http });
    check('RPC reads fall back to the newest block and say so', row.notes.some((n) => /fell back to the newest block/.test(n)), row.notes.join(' | '));
    check('Tenderly stays pinned anyway', SENT.every((b) => b.every((x) => x === PIN_BLOCK)));
  }

  section('8. the run: files, resume, --max');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-'));
    const sd = path.join(dir, 'screens', '2026-10-19');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, '021620_LEGEND_a.json'), JSON.stringify(screenFile()));
    fs.writeFileSync(path.join(sd, '031911_IAF_b.json'), JSON.stringify(screenFile({ symbol: 'IAF', token: '0x' + '6'.repeat(40) })));
    fs.writeFileSync(path.join(sd, '010000_ROUTR_z.json'), JSON.stringify(screenFile({ symbol: 'ROUTR', token: '0x' + '2'.repeat(40), pinned: false })));
    const out = path.join(dir, 'out');
    const log = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' '));
    const pw = process.stdout.write.bind(process.stdout); process.stdout.write = (s) => { lines.push(String(s)); return true; };
    try {
      await G.main({ argv: ['node', 'g6', '--screens', path.join(dir, 'screens'), '--out', out, '--max', '1'], provider: rpc(), http });
      await G.main({ argv: ['node', 'g6', '--screens', path.join(dir, 'screens'), '--out', out], provider: rpc(), http });
      await G.main({ argv: ['node', 'g6', '--screens', path.join(dir, 'screens'), '--out', out], provider: rpc(), http });
    } finally { console.log = log; process.stdout.write = pw; }
    const rows = fs.readFileSync(path.join(out, 'gate6.jsonl'), 'utf8').trim().split('\n');
    check('--max 1 then a full run: each token recorded once (2 rechecked, 1 too old)', rows.length === 3, String(rows.length));
    check('the too-old file did not use up --max 1', lines.some((l) => /running 1 \(--max 1\); 1 too old/.test(l)), lines.filter((l) => /to recheck/.test(l)).join(' | '));
    check('the too-old file is recorded as NOT RUN', rows.some((l) => /ROUTR/.test(l) && /NOT RUN/.test(l)));
    check('a third run finds nothing new', lines.some((l) => /0 token\(s\) to recheck/.test(l)), lines.filter((l) => /to recheck/.test(l)).join(' | '));
    const csv = fs.readFileSync(path.join(out, 'gate6.csv'), 'utf8').trim().split('\n');
    check('CSV has a header and all three tokens', csv.length === 4 && csv[0].startsWith('date,time,symbol'), csv[0]);
    check('CSV says what the bot missed', csv.filter((l) => l.includes('bot missed a SNIP')).length === 2, csv.join(' || '));
    check('the run says the live verdicts are unchanged', lines.some((l) => /verdicts are unchanged/.test(l)));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  section('9. agreement table');
  {
    const a = (live, so) => G.agreement({ liveVerdict: live, secondOpinion: so });
    check('SNIP + WOULD SNIP agrees', a('SNIP', 'WOULD SNIP') === 'agrees');
    check('SNIP + DO NOT SNIP is flagged loudly', /DISAGREES/.test(a('SNIP', 'DO NOT SNIP')));
    check('NOT RUN has no agreement', a('PASSED GATES 0-5', 'NOT RUN') === '');
  }

  section('10. no explorer call escaped the test stubs');
  check('the real explorer would never have been asked', STRAY_EXPLORER === 0, String(STRAY_EXPLORER));

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test harness threw:', e); process.exit(1); });
