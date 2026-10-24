// template-match.js — Gate 0 shortcut (added 2026-10-16): a token whose source is not
// published YET, but whose runtime bytecode is identical to a known, verified
// launchpad template.
//
// Why: on 15 Oct 2026 (first full day on the droplet) 8 Pons launchpad tokens were
// stopped at Gate 0 because Blockscout had not verified them yet. A re-check hours
// later found all 8 published as PonsV2LauncherToken — the same verified template as
// HRX, the bot's first SNIP. Blockscout itself verifies these by recognising the
// template, a few seconds to minutes after launch. This does the same check at
// launch: compare the token's runtime bytecode with a verified reference token's.
//
// The rule is deliberately narrow:
//   - identical runtime bytecode, ignoring only the Solidity metadata tail (the CBOR
//     block the compiler appends, which holds a source hash and never runs). Any
//     other difference — one opcode, one constant, one immutable — is no match;
//   - only templates listed in known-templates.json, each pinned to a reference
//     token whose source IS verified;
//   - optionally only for pools on a named hook (the Pons hook for PonsV2).
// A token with the 1770-byte template, or anything else unlisted, never matches.
//
// Turn it off with TEMPLATE_MATCH=0 in .env.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const lc = (s) => String(s || '').toLowerCase();

// Strip the Solidity CBOR metadata tail if there is one. The last two bytes give
// its length; the block itself starts with a CBOR map header (0xa1-0xa5).
// Returns lowercase hex without 0x.
function stripMetadata(codeHex) {
  let hex = lc(codeHex);
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length < 4 || hex.length % 2) return hex;
  const n = parseInt(hex.slice(-4), 16);
  const total = hex.length / 2;
  if (!n || n + 2 > total) return hex;
  const start = (total - 2 - n) * 2;
  const first = parseInt(hex.slice(start, start + 2), 16);
  if (first < 0xa1 || first > 0xa5) return hex;
  return hex.slice(0, start);
}

// { sizeBytes, sha256, sha256NoMeta } of a runtime bytecode, or null.
function codeFingerprint(codeHex) {
  if (!codeHex || codeHex === '0x' || codeHex === '0x0') return null;
  let hex = lc(codeHex);
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length % 2 || /[^0-9a-f]/.test(hex)) return null;
  const sha = (h) => crypto.createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');
  return { sizeBytes: hex.length / 2, sha256: sha(hex), sha256NoMeta: sha(stripMetadata(hex)) };
}

function loadTemplates(file = path.join(__dirname, 'known-templates.json')) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j.templates || []).filter((t) => t && t.name && /^0x[0-9a-fA-F]{40}$/.test(t.reference || ''));
  } catch (_) {
    return [];
  }
}

/**
 * Build a matcher. The reference bytecode is fetched once per reference and cached.
 * @param opts.getCode   async (address) => hex  (provider.getCode in the bot; a fake in tests)
 * @param opts.templates list from known-templates.json (default: that file)
 * @param opts.hookName  (hooks) => name|null   (pool-resolve.js knownHookName by default)
 * @returns async (src, pool) => { matched, name?, reference?, reason }
 */
function createTemplateMatcher({ getCode, templates = loadTemplates(), hookName = null } = {}) {
  const refCache = new Map(); // reference -> fingerprint | { error }
  const nameOfHook = hookName || ((h) => {
    try { return require('./pool-resolve').knownHookName(h); } catch (_) { return null; }
  });

  async function refPrint(ref) {
    const k = lc(ref);
    if (refCache.has(k)) return refCache.get(k);
    let v;
    try {
      const fp = codeFingerprint(await getCode(ref));
      v = fp || { error: 'reference has no bytecode' };
    } catch (e) {
      v = { error: `reference bytecode lookup failed: ${e.message}` };
    }
    // a failed lookup is not cached, so the next token tries again
    if (!v.error) refCache.set(k, v);
    return v;
  }

  return async function templateMatch(src, pool) {
    if (process.env.TEMPLATE_MATCH === '0') return { matched: false, reason: 'template match turned off (TEMPLATE_MATCH=0)' };
    if (!src || !src.codeSha256NoMeta) return { matched: false, reason: 'no bytecode fingerprint from Gate 0' };
    if (src.isProxy) return { matched: false, reason: 'proxy — a template match is only accepted for plain contracts' };
    if (!templates.length) return { matched: false, reason: 'no known templates listed' };
    const why = [];
    for (const t of templates) {
      if (t.hook) {
        const hn = pool && pool.hooks ? nameOfHook(pool.hooks) : null;
        if (!hn || !new RegExp(t.hook, 'i').test(hn)) { why.push(`${t.name}: pool is not on the ${t.hook} hook`); continue; }
      }
      if (t.sizeBytes && src.bytecodeSizeBytes != null && Number(t.sizeBytes) !== Number(src.bytecodeSizeBytes)) {
        why.push(`${t.name}: size ${src.bytecodeSizeBytes} bytes, template ${t.sizeBytes}`); continue;
      }
      const ref = await refPrint(t.reference);
      if (ref.error) { why.push(`${t.name}: ${ref.error}`); continue; }
      if (ref.sha256NoMeta === src.codeSha256NoMeta) {
        return {
          matched: true, name: t.name, reference: t.reference,
          reason: `bytecode identical to the verified ${t.name} template (reference ${t.referenceSymbol || ''} ${t.reference}; metadata tail ignored)`.replace('  ', ' '),
        };
      }
      why.push(`${t.name}: bytecode differs`);
    }
    return { matched: false, reason: why.join('; ') || 'no template matched' };
  };
}

module.exports = { stripMetadata, codeFingerprint, loadTemplates, createTemplateMatcher };
