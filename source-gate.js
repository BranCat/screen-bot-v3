// source-gate.js — GATE 0 of screen-token.js: is the token's contract source published?
//
// Node port of source-gate.py (same logic, same decisions), so the whole screener runs as one
// Node process. Kept deliberately 1:1 with the Python version — if you change one, change both.
//
//   1. eth_getCode
//   2. if the bytecode has a DELEGATECALL (at a real opcode boundary) it is a proxy — resolve the
//      implementation:  a. EIP-1967 impl slot   b. EIP-1967 beacon -> implementation()
//                       c. OpenZeppelin legacy slot   d. single PUSH20 in a tiny stub (clones)
//   3. ask Sourcify about the IMPLEMENTATION if there is one, otherwise about the token
//   3b. if Sourcify does not have it (or cannot be reached), ask the chain's own block explorer
//       (Blockscout). Source verified there is public too. Added 2026-10-08 after a 3-hour live
//       replay skipped 140 of 145 launches — including both Pons launchpad tokens — on Sourcify
//       alone. The Python source-gate.py does NOT have this step yet.
//       Only the explorer's own verification counts. A contract the explorer merely matches to a
//       *similar* verified contract ("verified twin") is still SKIP; the twin is recorded.
//   4. decision: PASS (source published) | SKIP (not published / no code / unresolved proxy) | ERROR
//
// SKIP stops the screen before any Tenderly simulation is spent. ERROR means "could not tell" —
// the screener reports UNKNOWN for it, never PASS.

const axios = require('axios');

const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const SOURCIFY = (chain, addr) => `https://sourcify.dev/server/v2/contract/${chain}/${addr}`;
// Robinhood Chain's official explorer (same base v1 used; lookalike domains exist — never use them).
const EXPLORER_API = process.env.blockscout_api_base || 'https://robinhoodchain.blockscout.com/api/v2';
// 2026-10-10: Blockscout's official API (api.blockscout.com, free key from dev.blockscout.com,
// docs.blockscout.com/robinhood-api). With BLOCKSCOUT_API_KEY in .env every explorer lookup goes
// there with a plain Node request: no curl, no browser identity. Added because the explorer
// website started answering every connection from Frank's PC (Node, curl and Chrome alike) with
// a connection reset, while api.blockscout.com loaded fine. Without a key the old route is used.
// Read lazily, so it works whatever order dotenv and this module are loaded in.
const PRO_API = 'https://api.blockscout.com/4663/api/v2';
const apiKey = () => (process.env.BLOCKSCOUT_API_KEY || '').trim();
const usingProApi = () => Boolean(apiKey()) && !process.env.blockscout_api_base;
const explorerBase = () => (usingProApi() ? PRO_API : EXPLORER_API);
function explorerUrl(path) {
  const u = `${explorerBase()}${path}`;
  return usingProApi() ? `${u}${u.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(apiKey())}` : u;
}
// Never let the key reach a log line or launches.jsonl.
function redact(text) {
  const k = apiKey();
  let t = String(text == null ? '' : text);
  if (k) t = t.split(k).join('***').split(encodeURIComponent(k)).join('***');
  return t.replace(/apikey=[^&\s)]+/g, 'apikey=***');
}
// The request function and identity for explorer lookups: plain Node with the official API,
// curl with the short browser identity on the old website route.
// 2026-10-18: every explorer request is counted by HTTP status, so the watcher can report
// credit use per hour and see an exhausted quota (HTTP 402) at once. On 17 Oct the
// Blockscout key ran out of credits for 13 hours and nothing said so.
const explorerStats = { calls: 0, byStatus: {} };
function countExplorer(H) {
  const counted = async (url, o) => {
    const r = await H(url, o);
    explorerStats.calls += 1;
    const k = r && r.status != null ? String(r.status) : 'error';
    explorerStats.byStatus[k] = (explorerStats.byStatus[k] || 0) + 1;
    return r;
  };
  counted.base = H; // the request function underneath (http or curlHttp)
  return counted;
}
const explorerHttp = () => countExplorer(usingProApi() ? http : curlHttp);
const explorerUA = () => (usingProApi() ? UA : EXPLORER_UA);
const EXPLORER = (addr) => explorerUrl(`/smart-contracts/${addr}`);
// The explorer's bot protection answers 403 to scripts. Tested 2026-10-08 on Frank's PC:
// curl with its default User-Agent -> 403, curl with a browser User-Agent -> 200, but Node
// (axios) with the same browser User-Agent -> still 403, so the protection looks at more than
// the header. Explorer lookups therefore go through curl itself (curlHttp below), exactly the
// request that worked; axios is only the fallback if curl is missing.
// Override the User-Agent with EXPLORER_USER_AGENT if that ever stops working.
const EXPLORER_UA = process.env.EXPLORER_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
// Keep it this short: on 2026-10-08 the full Chrome string ("... AppleWebKit/537.36 (KHTML, like
// Gecko) Chrome/129.0 Safari/537.36") got 403 from both curls on Frank's PC, this one got 200.
const UA = 'source-gate/1.0 (node)';

const SLOT_1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SLOT_1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const SLOT_OZ_LEGACY = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const SEL_IMPLEMENTATION = '0x5c60da1b'; // implementation()
const CLONE_MAX_BYTES = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> { status, json, error }. 400/401/402/403/404 are answers, not errors (same as the Python http()).
async function http(url, { data = null, timeout = 20000, attempts = 4, userAgent = UA } = {}) {
  let delay = 1000;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios({
        url, method: data ? 'post' : 'get', data: data || undefined, timeout,
        headers: { 'User-Agent': userAgent, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json' } : {}) },
        validateStatus: () => true,
        transformResponse: [(t) => t], // parse ourselves so non-JSON is reported, not thrown
      });
      const st = res.status;
      let json = null;
      try { json = JSON.parse(res.data); } catch (_) { /* non-JSON */ }
      if (st >= 200 && st < 300) return json ? { status: st, json, error: null } : { status: st, json: null, error: 'non-JSON response' };
      if ([400, 401, 402, 403, 404].includes(st)) return { status: st, json, error: null };
      if ([429, 500, 502, 503, 504].includes(st) && i < attempts - 1) { await sleep(delay); delay *= 2; continue; }
      return { status: st, json: null, error: `HTTP ${st}` };
    } catch (e) {
      if (i < attempts - 1) { await sleep(delay); delay *= 2; continue; }
      return { status: null, json: null, error: e.message };
    }
  }
  return { status: null, json: null, error: 'exhausted retries' };
}

// Same contract as http() ({ status, json, error }), but the request is made by the curl
// program. GET only. Retries 429/5xx like http().
function curlOnce(url, { timeout = 20000, userAgent = UA } = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    // -sS: silent, but curl still prints its own error text to stderr, so a failure
    // says why (DNS, TLS, blocked by antivirus, ...) instead of a bare "Command failed".
    execFile('curl', ['-sS', '-A', userAgent, '--max-time', String(Math.ceil(timeout / 1000)), '-w', '\n%{http_code}', url],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ missing: true });
        const out = String(stdout || '');
        const cut = out.lastIndexOf('\n');
        const st = Number(out.slice(cut + 1).trim());
        if (!st) {
          const why = String(stderr || '').trim()
            || (err && (err.signal ? `curl was killed (${err.signal}) — possibly blocked by antivirus`
              : err.code != null ? `curl exited with code ${err.code}, no message — possibly blocked by antivirus` : err.message))
            || 'no response from curl';
          return resolve({ status: null, body: null, error: why });
        }
        resolve({ status: st, body: out.slice(0, cut), error: null });
      });
  });
}
async function curlHttp(url, { timeout = 20000, attempts = 4, userAgent = UA } = {}) {
  let delay = 1000;
  for (let i = 0; i < attempts; i++) {
    const r = await curlOnce(url, { timeout, userAgent });
    if (r.missing) return http(url, { timeout, attempts, userAgent }); // no curl on this machine
    if (r.status == null) {
      if (i < attempts - 1) { await sleep(delay); delay *= 2; continue; }
      return { status: null, json: null, error: r.error };
    }
    let json = null;
    try { json = JSON.parse(r.body); } catch (_) { /* non-JSON */ }
    if (r.status >= 200 && r.status < 300) return json ? { status: r.status, json, error: null } : { status: r.status, json: null, error: 'non-JSON response' };
    if ([400, 401, 402, 403, 404].includes(r.status)) return { status: r.status, json, error: null };
    if ([429, 500, 502, 503, 504].includes(r.status) && i < attempts - 1) { await sleep(delay); delay *= 2; continue; }
    return { status: r.status, json: null, error: `HTTP ${r.status}` };
  }
  return { status: null, json: null, error: 'exhausted retries' };
}

async function rpc(url, method, params, H = http) {
  const { json, error } = await H(url, { data: { jsonrpc: '2.0', id: 1, method, params } });
  if (error) return { result: null, error };
  if (!json || typeof json !== 'object') return { result: null, error: 'bad RPC response' };
  if (json.error) return { result: null, error: String(json.error.message || JSON.stringify(json.error)) };
  return { result: json.result, error: null };
}

// 32-byte hex word -> lowercase address, or null if zero/garbage.
function addrFromWord(word) {
  if (typeof word !== 'string' || !word.startsWith('0x') || word.length < 42) return null;
  const a = '0x' + word.slice(-40);
  return BigInt(a) === 0n ? null : a.toLowerCase();
}

// Walk instruction boundaries -> { hasDelegatecall, push20s }. A plain byte search for 0xf4 is
// wrong: 0xf4 appears inside PUSH immediates all the time.
function scanCode(codeHex) {
  if (!codeHex || codeHex === '0x' || codeHex === '0x0') return { hasDelegatecall: false, push20s: [] };
  const hex = codeHex.startsWith('0x') ? codeHex.slice(2) : codeHex;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return { hasDelegatecall: false, push20s: [] };
  const len = hex.length / 2;
  let hasDelegatecall = false;
  const push20s = [];
  let i = 0;
  while (i < len) {
    const op = parseInt(hex.substr(i * 2, 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 20 && i + 1 + n <= len) push20s.push('0x' + hex.substr((i + 1) * 2, 40));
      i += 1 + n;
    } else {
      if (op === 0xf4) hasDelegatecall = true;
      i += 1;
    }
  }
  return { hasDelegatecall, push20s };
}

// -> { impl, how, note }
async function resolveImplementation(rpcUrl, addr, codeHex, H = http) {
  let r = await rpc(rpcUrl, 'eth_getStorageAt', [addr, SLOT_1967_IMPL, 'latest'], H);
  if (!r.error) { const got = addrFromWord(r.result); if (got) return { impl: got, how: 'eip1967', note: null }; }

  r = await rpc(rpcUrl, 'eth_getStorageAt', [addr, SLOT_1967_BEACON, 'latest'], H);
  if (!r.error) {
    const beacon = addrFromWord(r.result);
    if (beacon) {
      const c = await rpc(rpcUrl, 'eth_call', [{ to: beacon, data: SEL_IMPLEMENTATION }, 'latest'], H);
      const got = c.error ? null : addrFromWord(c.result);
      if (got) return { impl: got, how: 'beacon', note: `beacon ${beacon}` };
      return { impl: null, how: 'beacon', note: `beacon ${beacon} but implementation() unreadable` };
    }
  }

  r = await rpc(rpcUrl, 'eth_getStorageAt', [addr, SLOT_OZ_LEGACY, 'latest'], H);
  if (!r.error) { const got = addrFromWord(r.result); if (got) return { impl: got, how: 'oz-legacy', note: null }; }

  if (codeHex && codeHex.length <= 2 + 2 * CLONE_MAX_BYTES) {
    const { hasDelegatecall, push20s } = scanCode(codeHex);
    if (hasDelegatecall) {
      if (push20s.length === 1) return { impl: push20s[0].toLowerCase(), how: 'bytecode-immediate', note: 'minimal/gas-golfed clone' };
      if (push20s.length > 1) return { impl: null, how: 'bytecode-immediate', note: `${push20s.length} PUSH20s — ambiguous` };
    }
  }
  return { impl: null, how: null, note: null };
}

// -> { ok: true|false|null, meta }
async function sourcify(chain, addr, H = http) {
  const { status, json, error } = await H(SOURCIFY(chain, addr));
  if (status === 200 && json && json.match) return { ok: true, meta: { match: json.match, verifiedAt: json.verifiedAt ?? null } };
  if (status === 404) return { ok: false, meta: {} };
  return { ok: null, meta: { error: error || `HTTP ${status}` } };
}

// -> { ok: true|false|null, meta }   the block explorer's own verification only.
async function explorer(addr, H = explorerHttp()) {
  const { status, json, error } = await H(EXPLORER(addr), { userAgent: explorerUA() });
  if (status === 404) return { ok: false, meta: {} };
  if ((status === 401 || status === 403) && usingProApi()) {
    return { ok: null, meta: { error: `HTTP ${status} (Blockscout API refused the key — check BLOCKSCOUT_API_KEY in .env)` } };
  }
  if (status === 403) return { ok: null, meta: { error: 'HTTP 403 (explorer refused the request)' } };
  // Keep "HTTP 402" in the text: watch-launches.js recognises a quota outage by it.
  if (status === 402) return { ok: null, meta: { error: 'HTTP 402 (Blockscout API credits used up; the daily allowance resets at 00:00 UTC)', quota: true } };
  if (status === 200 && json && typeof json === 'object') {
    const twin = json.verified_twin_address_hash || null;
    if (json.is_verified === true) {
      return {
        ok: true,
        meta: {
          name: json.name ?? null,
          compiler: json.compiler_version ?? null,
          fully: json.is_fully_verified ?? null,
          viaSourcify: json.is_verified_via_sourcify ?? null,
        },
      };
    }
    return { ok: false, meta: twin ? { twin } : {} };
  }
  return { ok: null, meta: { error: redact(error || `HTTP ${status}`) } };
}

/**
 * @param token   token address
 * @param opts    { rpcUrl, chain, noProxy, noExplorer, http (tests only) }
 * @returns same record shape as source-gate.py: { token, decision: 'PASS'|'SKIP'|'ERROR', reason, ... }
 */
async function sourceGate(token, opts = {}) {
  const rpcUrl = opts.rpcUrl || process.env.RPC_URL || DEFAULT_RPC;
  const chain = opts.chain || 4663;
  const r = { token, checked_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };

  const H = opts.http || http;
  const useExplorer = !opts.noExplorer && process.env.SOURCE_GATE_NO_EXPLORER !== '1';

  const code = await rpc(rpcUrl, 'eth_getCode', [token, 'latest'], H);
  if (code.error) return { ...r, decision: 'ERROR', reason: `eth_getCode failed: ${code.error}` };
  if (!code.result || code.result === '0x' || code.result === '0x0') {
    return { ...r, decision: 'SKIP', reason: 'no bytecode at this address (EOA or self-destructed)' };
  }
  r.bytecodeSizeBytes = (code.result.length - 2) / 2;
  // 2026-10-16: a fingerprint of the runtime bytecode, for the template shortcut
  // (template-match.js) and for later analysis. Additive only — no decision uses it here.
  try {
    const fp = require('./template-match').codeFingerprint(code.result);
    if (fp) { r.codeSha256 = fp.sha256; r.codeSha256NoMeta = fp.sha256NoMeta; }
  } catch (_) { /* fingerprint is optional */ }

  let impl = null;
  if (!opts.noProxy && scanCode(code.result).hasDelegatecall) {
    const res = await resolveImplementation(rpcUrl, token, code.result, H);
    impl = res.impl;
    Object.assign(r, { isProxy: true, implementationVia: res.how, implementationAddr: impl });
    if (res.note) r.implementationNote = res.note;
    if (!impl) return { ...r, decision: 'SKIP', reason: 'proxy whose implementation could not be resolved — the code that runs is unknown' };
  } else {
    r.isProxy = false;
  }

  const subject = impl || token;
  const what = impl ? 'implementation source' : 'source';
  r.verificationSubject = subject;
  const sf = await sourcify(chain, subject, H);
  for (const [k, v] of Object.entries(sf.meta)) r[(impl ? 'impl_' : '') + k] = v;

  if (sf.ok) {
    r.sourceVerified = true;
    r.verifiedBy = 'sourcify';
    return { ...r, decision: 'PASS', reason: `${what} published (Sourcify)` };
  }
  if (!useExplorer) {
    if (sf.ok === null) return { ...r, decision: 'ERROR', reason: `verification lookup failed: ${sf.meta.error}` };
    r.sourceVerified = false;
    return { ...r, decision: 'SKIP', reason: `${what} NOT published` };
  }

  // 3b. the chain's own block explorer
  const ex = await explorer(subject, opts.http || explorerHttp());
  for (const [k, v] of Object.entries(ex.meta)) r[`explorer_${k}`] = v;
  if (ex.ok) {
    r.sourceVerified = true;
    r.verifiedBy = 'explorer';
    return { ...r, decision: 'PASS', reason: `${what} published (block explorer${ex.meta.name ? `: ${ex.meta.name}` : ''})` };
  }
  if (sf.ok === null || ex.ok === null) {
    const errs = [sf.ok === null ? `Sourcify: ${sf.meta.error}` : null, ex.ok === null ? `explorer: ${ex.meta.error}` : null].filter(Boolean);
    return { ...r, decision: 'ERROR', reason: `verification lookup failed (${errs.join('; ')})` };
  }
  r.sourceVerified = false;
  const twin = ex.meta.twin ? ` — the explorer only matches it to a similar verified contract ${ex.meta.twin}, which does not count` : '';
  return { ...r, decision: 'SKIP', reason: `${what} NOT published (checked Sourcify and the block explorer)${twin}` };
}

module.exports = {
  sourceGate, scanCode, addrFromWord, resolveImplementation, explorer, curlHttp, http,
  EXPLORER_API, EXPLORER_UA, PRO_API, usingProApi, explorerBase, explorerUrl, explorerHttp, explorerUA, redact,
  explorerStats, countExplorer,
};

// CLI: node source-gate.js 0xTOKEN [0xTOKEN ...]   — same one-line output style as the Python --check
if (require.main === module) {
  (async () => {
    const toks = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!toks.length) { console.log('usage: node source-gate.js 0xTOKEN [0xTOKEN ...]'); process.exit(1); }
    for (const t of toks) {
      const r = await sourceGate(t);
      const extra = r.implementationAddr ? `  via ${r.implementationVia} -> ${r.implementationAddr}` : '';
      console.log(`${r.decision.padEnd(5)} ${r.token}  ${r.reason}${extra}`);
    }
  })();
}
