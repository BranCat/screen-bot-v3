// test-source-gate.js — offline checks for Gate 0 (source-gate.js), including the
// block-explorer fallback added 2026-10-08. A fake http() answers the RPC, Sourcify
// and explorer requests; nothing touches the network.
//
//   node test-source-gate.js

const assert = require('assert');
// These checks describe the keyless (website) route; the official-API route has its own
// checks at the end, which set the key themselves.
const SAVED_KEY = process.env.BLOCKSCOUT_API_KEY;
delete process.env.BLOCKSCOUT_API_KEY;
const sg = require('./source-gate');
const { sourceGate, EXPLORER_API, EXPLORER_UA } = sg;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const TOKEN = '0x1111111111111111111111111111111111111111';
const IMPL = '0x2222222222222222222222222222222222222222';
const PLAIN_CODE = '0x6080604052348015600f57600080fd5b50';      // no DELEGATECALL
const PROXY_CODE = '0x363d3d373d3d3d363d73' + '33'.repeat(20) + '5af43d82803e903d91602b57fd5bf3';
const ZERO_WORD = '0x' + '0'.repeat(64);
const SLOT_1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// answers: { code, implSlot, sourcify: {status,json}|'error', explorer: {status,json}|'error' }
function fakeHttp(a) {
  const calls = { sourcify: [], explorer: [], rpc: [] };
  const H = async (url, opts = {}) => {
    if (opts.data) {
      const { method, params } = opts.data;
      calls.rpc.push(method);
      if (method === 'eth_getCode') return { status: 200, json: { result: a.code ?? PLAIN_CODE }, error: null };
      if (method === 'eth_getStorageAt') {
        const slot = params[1];
        const v = slot === SLOT_1967_IMPL && a.implSlot ? '0x' + '0'.repeat(24) + a.implSlot.slice(2) : ZERO_WORD;
        return { status: 200, json: { result: v }, error: null };
      }
      return { status: 200, json: { result: '0x' }, error: null };
    }
    if (url.startsWith('https://sourcify.dev/')) {
      calls.sourcify.push(url);
      calls.sourcifyUA = opts.userAgent;
      const s = a.sourcify ?? { status: 404, json: {} };
      return s === 'error' ? { status: null, json: null, error: 'timeout' } : { ...s, error: null };
    }
    if (url.startsWith(EXPLORER_API)) {
      calls.explorer.push(url);
      calls.explorerUA = opts.userAgent;
      const e = a.explorer ?? { status: 200, json: { is_verified: false } };
      return e === 'error' ? { status: 503, json: null, error: 'HTTP 503' } : { ...e, error: null };
    }
    throw new Error(`unexpected url ${url}`);
  };
  H.calls = calls;
  return H;
}
const SF_OK = { status: 200, json: { match: 'exact_match', verifiedAt: '2026-10-07T00:00:00Z' } };
const EX_OK = { status: 200, json: { is_verified: true, name: 'PasskeysToken', compiler_version: 'v0.8.26', is_fully_verified: true } };

(async () => {
  await check('explorer is the official Robinhood Chain Blockscout', async () => {
    assert.ok(EXPLORER_API.startsWith('https://robinhoodchain.blockscout.com/api/v2') || process.env.blockscout_api_base);
  });

  await check('explorer requests identify as a browser (it 403s scripts); Sourcify requests do not', async () => {
    const H = fakeHttp({ explorer: EX_OK });
    await sourceGate(TOKEN, { http: H });
    assert.strictEqual(H.calls.explorerUA, EXPLORER_UA);
    assert.strictEqual(H.calls.explorerUA, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'the short form — the long Chrome string is refused');
    assert.strictEqual(H.calls.sourcifyUA, undefined);
  });

  await check('on Sourcify: PASS, explorer never asked', async () => {
    const H = fakeHttp({ sourcify: SF_OK });
    const r = await sourceGate(TOKEN, { http: H });
    assert.strictEqual(r.decision, 'PASS');
    assert.strictEqual(r.verifiedBy, 'sourcify');
    assert.strictEqual(H.calls.explorer.length, 0);
  });

  await check('not on Sourcify but verified on the explorer: PASS, names the source', async () => {
    const H = fakeHttp({ explorer: EX_OK });
    const r = await sourceGate(TOKEN, { http: H });
    assert.strictEqual(r.decision, 'PASS');
    assert.strictEqual(r.verifiedBy, 'explorer');
    assert.ok(/block explorer: PasskeysToken/.test(r.reason), r.reason);
    assert.strictEqual(r.explorer_compiler, 'v0.8.26');
    assert.ok(H.calls.explorer[0].endsWith(`/smart-contracts/${TOKEN}`));
  });

  await check('on neither: SKIP, reason still says NOT published', async () => {
    const r = await sourceGate(TOKEN, { http: fakeHttp({}) });
    assert.strictEqual(r.decision, 'SKIP');
    assert.ok(/NOT published \(checked Sourcify and the block explorer\)/.test(r.reason), r.reason);
    assert.strictEqual(r.sourceVerified, false);
  });

  await check('explorer 404 counts as not published', async () => {
    const r = await sourceGate(TOKEN, { http: fakeHttp({ explorer: { status: 404, json: {} } }) });
    assert.strictEqual(r.decision, 'SKIP');
  });

  await check('explorer "similar verified contract" only: still SKIP, twin recorded', async () => {
    const twin = '0x9999999999999999999999999999999999999999';
    const r = await sourceGate(TOKEN, { http: fakeHttp({ explorer: { status: 200, json: { is_verified: false, verified_twin_address_hash: twin, source_code: 'contract X {}' } } }) });
    assert.strictEqual(r.decision, 'SKIP');
    assert.strictEqual(r.explorer_twin, twin);
    assert.ok(r.reason.includes(twin) && /does not count/.test(r.reason), r.reason);
  });

  await check('Sourcify says no, explorer unreachable: ERROR (could not tell), never SKIP or PASS', async () => {
    const r = await sourceGate(TOKEN, { http: fakeHttp({ explorer: 'error' }) });
    assert.strictEqual(r.decision, 'ERROR');
    assert.ok(/explorer: HTTP 503/.test(r.reason), r.reason);
  });

  await check('Sourcify unreachable, explorer verified: PASS', async () => {
    const r = await sourceGate(TOKEN, { http: fakeHttp({ sourcify: 'error', explorer: EX_OK }) });
    assert.strictEqual(r.decision, 'PASS');
    assert.strictEqual(r.verifiedBy, 'explorer');
  });

  await check('Sourcify unreachable, explorer says no: ERROR, not SKIP', async () => {
    const r = await sourceGate(TOKEN, { http: fakeHttp({ sourcify: 'error' }) });
    assert.strictEqual(r.decision, 'ERROR');
    assert.ok(/Sourcify: timeout/.test(r.reason), r.reason);
  });

  await check('noExplorer restores the Sourcify-only behaviour', async () => {
    const H = fakeHttp({ explorer: EX_OK });
    const r = await sourceGate(TOKEN, { http: H, noExplorer: true });
    assert.strictEqual(r.decision, 'SKIP');
    assert.strictEqual(r.reason, 'source NOT published');
    assert.strictEqual(H.calls.explorer.length, 0);
  });

  await check('SOURCE_GATE_NO_EXPLORER=1 does the same', async () => {
    process.env.SOURCE_GATE_NO_EXPLORER = '1';
    try {
      const H = fakeHttp({ explorer: EX_OK });
      const r = await sourceGate(TOKEN, { http: H });
      assert.strictEqual(r.decision, 'SKIP');
      assert.strictEqual(H.calls.explorer.length, 0);
    } finally { delete process.env.SOURCE_GATE_NO_EXPLORER; }
  });

  await check('proxy: both Sourcify and the explorer are asked about the IMPLEMENTATION', async () => {
    const H = fakeHttp({ code: PROXY_CODE, implSlot: IMPL, explorer: EX_OK });
    const r = await sourceGate(TOKEN, { http: H });
    assert.strictEqual(r.decision, 'PASS');
    assert.strictEqual(r.implementationAddr, IMPL);
    assert.ok(H.calls.sourcify[0].endsWith(IMPL));
    assert.ok(H.calls.explorer[0].endsWith(IMPL));
    assert.ok(/implementation source published \(block explorer/.test(r.reason), r.reason);
  });

  await check('proxy with hidden implementation source: SKIP', async () => {
    const r = await sourceGate(TOKEN, { http: fakeHttp({ code: PROXY_CODE, implSlot: IMPL }) });
    assert.strictEqual(r.decision, 'SKIP');
    assert.ok(/implementation source NOT published/.test(r.reason));
  });

  await check('no bytecode: SKIP before any source lookup', async () => {
    const H = fakeHttp({ code: '0x' });
    const r = await sourceGate(TOKEN, { http: H });
    assert.strictEqual(r.decision, 'SKIP');
    assert.strictEqual(H.calls.sourcify.length + H.calls.explorer.length, 0);
  });

  // ---- recheck-source.js helpers
  const { pickSkipped, summarize } = require('./recheck-source');
  await check('recheck picks Gate 0 skips only, once per token, ignores junk lines', async () => {
    const L = (o) => JSON.stringify(o);
    const lines = [
      L({ token: '0xA', verdict: 'DO NOT SNIP', gate: 0, sourceHidden: true }),
      L({ token: '0xB', verdict: 'DO NOT SNIP', gate: '1b', sourceHidden: false }),
      L({ token: '0xa', verdict: 'DO NOT SNIP', gate: 0, sourceHidden: true }),
      'not json',
      '',
      L({ token: '0xC', verdict: 'DO NOT SNIP', gate: 0 }),
      L({ token: '0xD', verdict: 'UNKNOWN', gate: 0 }),
    ];
    assert.deepStrictEqual(pickSkipped(lines).map((r) => r.token), ['0xA', '0xC']);
  });
  await check('recheck summary buckets: public / hidden (+twin) / could not tell, per launch path', async () => {
    const s = summarize([
      { launchPath: 'Pons launchpad', gate0: { decision: 'PASS' } },
      { launchPath: 'Pons launchpad', gate0: { decision: 'SKIP' } },
      { launchPath: 'direct v4 pool (no hook)', gate0: { decision: 'SKIP', explorer_twin: '0x9' } },
      { launchPath: 'direct v4 pool (no hook)', gate0: { decision: 'ERROR' } },
    ]);
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.nowPublic, 1);
    assert.strictEqual(s.stillHidden, 2);
    assert.strictEqual(s.twinOnly, 1);
    assert.strictEqual(s.couldNotTell, 1);
    assert.deepStrictEqual(s.byPath['Pons launchpad'], { total: 2, nowPublic: 1 });
  });

  // ---- 2026-10-10: Blockscout's official API when BLOCKSCOUT_API_KEY is set ----
  const KEY = 'proapi_TESTKEY123';
  const withKey = async (fn) => {
    process.env.BLOCKSCOUT_API_KEY = KEY;
    try { return await fn(); } finally { delete process.env.BLOCKSCOUT_API_KEY; }
  };
  const proFake = (explorerAnswer) => {
    const calls = [];
    const H = async (url, opts = {}) => {
      if (opts.data) { // RPC
        const m = opts.data.method;
        if (m === 'eth_getCode') return { status: 200, json: { jsonrpc: '2.0', id: 1, result: PLAIN_CODE }, error: null };
        return { status: 200, json: { jsonrpc: '2.0', id: 1, result: ZERO_WORD }, error: null };
      }
      if (url.includes('sourcify.dev')) return { status: 404, json: {}, error: null };
      calls.push({ url, ua: opts.userAgent });
      return typeof explorerAnswer === 'function' ? explorerAnswer(url) : explorerAnswer;
    };
    H.calls = calls;
    return H;
  };
  await check('with a key: lookups go to api.blockscout.com/4663 with the key, no browser identity', async () => {
    await withKey(async () => {
      assert.ok(sg.usingProApi());
      const H = proFake({ status: 200, json: { is_verified: true, name: 'PasskeysToken' }, error: null });
      const r = await sourceGate(TOKEN, { http: H });
      assert.strictEqual(r.decision, 'PASS', r.reason);
      assert.ok(H.calls[0].url.startsWith('https://api.blockscout.com/4663/api/v2/smart-contracts/'), H.calls[0].url);
      assert.ok(H.calls[0].url.endsWith(`?apikey=${KEY}`), H.calls[0].url);
      assert.notStrictEqual(H.calls[0].ua, EXPLORER_UA);
    });
  });
  await check('with a key: the default request function is plain Node, not curl', async () => {
    await withKey(async () => { assert.strictEqual(sg.explorerHttp().base, sg.http); });
    assert.strictEqual(sg.explorerHttp().base, sg.curlHttp);
  });
  await check('with a key: a refused key says so, and is ERROR (could not tell)', async () => {
    await withKey(async () => {
      const r = await sourceGate(TOKEN, { http: proFake({ status: 401, json: null, error: null }) });
      assert.strictEqual(r.decision, 'ERROR');
      assert.ok(/BLOCKSCOUT_API_KEY/.test(r.reason), r.reason);
    });
  });
  await check('the key never appears in a reason, even inside an error message', async () => {
    await withKey(async () => {
      const r = await sourceGate(TOKEN, { http: proFake((url) => ({ status: null, json: null, error: `connect failed for ${url}` })) });
      assert.strictEqual(r.decision, 'ERROR');
      assert.ok(!JSON.stringify(r).includes(KEY), JSON.stringify(r));
      assert.ok(/apikey=\*\*\*/.test(r.reason), r.reason);
    });
  });
  await check('blockscout_api_base in .env still overrides the official API', async () => {
    await withKey(async () => {
      process.env.blockscout_api_base = 'https://example.invalid/api/v2';
      try { assert.ok(!sg.usingProApi()); } finally { delete process.env.blockscout_api_base; }
    });
  });

  if (SAVED_KEY !== undefined) process.env.BLOCKSCOUT_API_KEY = SAVED_KEY;
  // ---- 2026-10-18: explorer quota (HTTP 402) and request counting
  await check('explorer: HTTP 402 is a lookup failure that says "HTTP 402" and quota', async () => {
    const r = await sg.explorer('0x' + '1'.repeat(40), async () => ({ status: 402, json: { message: 'Payment Required' }, error: null }));
    assert.strictEqual(r.ok, null);
    assert.ok(/HTTP 402/.test(r.meta.error), r.meta.error);
    assert.strictEqual(r.meta.quota, true);
  });
  await check('countExplorer: counts each request by status, passes the answer through', async () => {
    const before = sg.explorerStats.calls;
    const b402 = sg.explorerStats.byStatus['402'] || 0;
    const H = sg.countExplorer(async () => ({ status: 402, json: null, error: null }));
    const r = await H('u', {});
    await H('u', {});
    assert.strictEqual(r.status, 402);
    assert.strictEqual(sg.explorerStats.calls - before, 2);
    assert.strictEqual((sg.explorerStats.byStatus['402'] || 0) - b402, 2);
  });

  console.log(failed ? `${failed} failed, ${passed} passed` : `all checks passed (${passed})`);
  process.exit(failed ? 1 : 0);
})();
