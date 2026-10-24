// safe-json.js — turn a screen result into plain, analysable JSON (2026-10-13).
//
// Screen results hold ethers BigNumbers, BigInts, nested pool descriptors and
// occasionally whole Tenderly responses. JSON.stringify would print a
// BigNumber as {"type":"BigNumber","hex":"0x…"}, choke on a BigInt, and loop
// forever on a cycle. toPlain() fixes all of that:
//
//   BigNumber / BigInt  -> exact decimal string ("1918887730000000000000000")
//   key "raw"           -> dropped (raw Tenderly payloads; can be megabytes)
//   strings > 4000 chars -> trimmed, with the original length noted
//   cycles / depth > 40  -> "[circular]" / "[too deep]"
//   Map / Set / Error    -> object / array / { error: message }
//   functions, undefined -> dropped

const DROP_KEYS = new Set(['raw']);
const MAX_STRING = 4000;
const MAX_DEPTH = 40;

const isBigNumber = (v) => v && typeof v === 'object' && (v._isBigNumber === true || (v.type === 'BigNumber' && typeof v.hex === 'string'));

function bnToString(v) {
  try { return BigInt(v._hex || v.hex).toString(); } catch (_) { return String(v); }
}

function toPlain(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'bigint') return value.toString();
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[trimmed, ${value.length} chars]` : value;
  if (t === 'boolean') return value;
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
  if (isBigNumber(value)) return bnToString(value);
  if (depth > MAX_DEPTH) return '[too deep]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (value instanceof Error) return { error: value.message };
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) return toPlain(Object.fromEntries(value), depth + 1, seen);
    if (value instanceof Set) return toPlain([...value], depth + 1, seen);
    if (Array.isArray(value)) return value.map((v) => { const p = toPlain(v, depth + 1, seen); return p === undefined ? null : p; });
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      const p = toPlain(v, depth + 1, seen);
      if (p !== undefined) out[k] = p;
    }
    return out;
  } finally {
    seen.delete(value); // the same object twice in different branches is fine; only a cycle is not
  }
}

const safeStringify = (value, space) => JSON.stringify(toPlain(value), null, space);

module.exports = { toPlain, safeStringify };
