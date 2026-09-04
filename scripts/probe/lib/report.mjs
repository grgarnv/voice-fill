import fs from 'node:fs';
import path from 'node:path';
const ART = path.resolve('artifacts/preflight');

export const results = [];

export function record(id, title, status, detail = {}) {
  results.push({ id, title, status, detail, at: new Date().toISOString() });
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'BLOCKED';
  console.log(`[${icon}] ${id} ${title}`);
  if (detail.note) console.log(`        ${detail.note}`);
  return status === 'PASS';
}

export function flush(file = 'preflight.json') {
  fs.mkdirSync(ART, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    pass: results.filter(r => r.status === 'PASS').length,
    fail: results.filter(r => r.status === 'FAIL').length,
    blocked: results.filter(r => r.status === 'BLOCKED').length,
    results,
  };
  fs.writeFileSync(path.join(ART, file), JSON.stringify(summary, null, 2));
  return summary;
}

/** Classify a thrown error so a network-blocked run never masquerades as a Rime bug. */
export function classify(err) {
  const m = String(err?.message || err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|host_not_allowed|deny-reason|ETIMEDOUT|ECONNRESET|fetch failed|Unexpected server response: 403|handshake/i.test(m)) {
    return { status: 'BLOCKED', note: `Network/egress blocked, not a Rime result: ${m}` };
  }
  if (/Missing required env var/i.test(m)) return { status: 'BLOCKED', note: m };
  return { status: 'FAIL', note: m };
}
