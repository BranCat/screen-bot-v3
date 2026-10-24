// test-template-match.js — offline checks for template-match.js and the bytecode
// fingerprint that source-gate.js now records. No RPC: getCode is faked.
//
//   node test-template-match.js

const assert = require('assert');
const { stripMetadata, codeFingerprint, createTemplateMatcher, loadTemplates } = require('./template-match');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (e) { failed += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// A real-shaped Solidity metadata tail: a2 64 'ipfs' 58 22 <34 bytes> 64 'solc' 43 <3 bytes> 0033
const meta = (fill) => 'a2' + '64' + '69706673' + '5822' + '1220' + fill.repeat(32) + '64' + '736f6c63' + '43' + '000823' + '0033';
const BODY = '6080604052348015600f57600080fd5b50'.repeat(10);
const codeA = '0x' + BODY + meta('11');
const codeA2 = '0x' + BODY + meta('22');            // same code, different metadata
const codeB = '0x' + BODY.replace(/52/, '53') + meta('11'); // one byte different
const REF = '0xFCc86D9c23FfB9f27258534eA316C096F1Af51b9';
const PONS_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
const TEMPLATES = [{ name: 'PonsV2LauncherToken', reference: REF, referenceSymbol: 'HRX', hook: 'pons' }];
const srcOf = (code, over = {}) => {
  const fp = codeFingerprint(code);
  return { decision: 'SKIP', sourceVerified: false, isProxy: false, bytecodeSizeBytes: fp.sizeBytes, codeSha256: fp.sha256, codeSha256NoMeta: fp.sha256NoMeta, ...over };
};
const ponsPool = { version: 'v4', hooks: PONS_HOOK };
const hooklessPool = { version: 'v4', hooks: '0x0000000000000000000000000000000000000000' };

(async () => {
  await check('stripMetadata removes exactly the CBOR tail', async () => {
    assert.strictEqual(stripMetadata(codeA), BODY);
    assert.strictEqual(stripMetadata(codeA2), BODY);
  });
  await check('stripMetadata leaves code without a valid tail untouched', async () => {
    assert.strictEqual(stripMetadata('0x' + BODY), BODY);
    assert.strictEqual(stripMetadata('0x6000ffff'), '6000ffff'); // length larger than the code
  });
  await check('codeFingerprint: same code, other metadata -> same NoMeta hash, different full hash', async () => {
    const a = codeFingerprint(codeA); const b = codeFingerprint(codeA2);
    assert.strictEqual(a.sha256NoMeta, b.sha256NoMeta);
    assert.notStrictEqual(a.sha256, b.sha256);
    assert.strictEqual(a.sizeBytes, (codeA.length - 2) / 2);
  });
  await check('codeFingerprint: empty or garbage -> null', async () => {
    assert.strictEqual(codeFingerprint('0x'), null);
    assert.strictEqual(codeFingerprint('0xzz'), null);
  });
  await check('match: identical code on the Pons hook', async () => {
    const m = createTemplateMatcher({ getCode: async () => codeA2, templates: TEMPLATES, hookName: () => 'Pons V2 meme hook' });
    const r = await m(srcOf(codeA), ponsPool);
    assert.strictEqual(r.matched, true, r.reason);
    assert.strictEqual(r.name, 'PonsV2LauncherToken');
  });
  await check('no match: one byte different', async () => {
    const m = createTemplateMatcher({ getCode: async () => codeA, templates: TEMPLATES, hookName: () => 'Pons V2 meme hook' });
    const r = await m(srcOf(codeB), ponsPool);
    assert.strictEqual(r.matched, false);
    assert.ok(/differs/.test(r.reason));
  });
  await check('no match: identical code but not on the Pons hook', async () => {
    const m = createTemplateMatcher({ getCode: async () => codeA, templates: TEMPLATES, hookName: () => null });
    const r = await m(srcOf(codeA), hooklessPool);
    assert.strictEqual(r.matched, false);
    assert.ok(/not on the pons hook/i.test(r.reason));
  });
  await check('no match: proxies are never accepted by template', async () => {
    const m = createTemplateMatcher({ getCode: async () => codeA, templates: TEMPLATES, hookName: () => 'Pons' });
    const r = await m(srcOf(codeA, { isProxy: true }), ponsPool);
    assert.strictEqual(r.matched, false);
  });
  await check('no match: size pinned in the template and different', async () => {
    const m = createTemplateMatcher({ getCode: async () => codeA, templates: [{ ...TEMPLATES[0], sizeBytes: 3248 }], hookName: () => 'Pons' });
    const r = await m(srcOf(codeA), ponsPool);
    assert.strictEqual(r.matched, false);
    assert.ok(/size/.test(r.reason));
  });
  await check('reference lookup failure -> no match, retried on the next token, then cached', async () => {
    let n = 0;
    const m = createTemplateMatcher({ getCode: async () => { n += 1; if (n === 1) throw new Error('rpc down'); return codeA; }, templates: TEMPLATES, hookName: () => 'Pons' });
    const r1 = await m(srcOf(codeA), ponsPool);
    assert.strictEqual(r1.matched, false);
    assert.ok(/rpc down/.test(r1.reason));
    assert.strictEqual((await m(srcOf(codeA), ponsPool)).matched, true);
    assert.strictEqual((await m(srcOf(codeA), ponsPool)).matched, true);
    assert.strictEqual(n, 2, 'reference fetched once after it succeeded');
  });
  await check('TEMPLATE_MATCH=0 turns it off', async () => {
    process.env.TEMPLATE_MATCH = '0';
    try {
      const m = createTemplateMatcher({ getCode: async () => codeA, templates: TEMPLATES, hookName: () => 'Pons' });
      assert.strictEqual((await m(srcOf(codeA), ponsPool)).matched, false);
    } finally { delete process.env.TEMPLATE_MATCH; }
  });
  await check('no fingerprint from Gate 0 -> no match', async () => {
    const m = createTemplateMatcher({ getCode: async () => codeA, templates: TEMPLATES, hookName: () => 'Pons' });
    assert.strictEqual((await m({ decision: 'SKIP' }, ponsPool)).matched, false);
  });
  await check('known-templates.json loads the PonsV2LauncherToken entry pinned to HRX', async () => {
    const t = loadTemplates();
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].name, 'PonsV2LauncherToken');
    assert.strictEqual(t[0].reference.toLowerCase(), REF.toLowerCase());
    assert.strictEqual(t[0].hook, 'pons');
  });
  await check('the real Pons hook address is named Pons by pool-resolve.js', async () => {
    const { knownHookName } = require('./pool-resolve');
    assert.ok(/pons/i.test(knownHookName(PONS_HOOK) || ''), String(knownHookName(PONS_HOOK)));
  });
  await check('source-gate.js records the fingerprint (fake RPC)', async () => {
    const { sourceGate } = require('./source-gate');
    const http = async (url, o = {}) => {
      if (o.data && o.data.method === 'eth_getCode') return { status: 200, json: { result: codeA }, error: null };
      if (o.data) return { status: 200, json: { result: '0x' + '0'.repeat(64) }, error: null };
      return { status: 404, json: null, error: null };
    };
    const r = await sourceGate('0x' + '12'.repeat(20), { http, rpcUrl: 'http://x' });
    assert.strictEqual(r.decision, 'SKIP');
    assert.strictEqual(r.codeSha256NoMeta, codeFingerprint(codeA).sha256NoMeta);
  });

  console.log(failed ? `${failed} failed, ${passed} passed` : `all checks passed (${passed})`);
  process.exit(failed ? 1 : 0);
})();
