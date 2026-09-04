// Auth gate. Runs BEFORE probe 00.
//
// Why this exists: probe 00 passed against an invalid key, because the voice
// catalog endpoint does not reject unauthenticated reads. A green catalog
// therefore says nothing about credentials, and reporting it first made six
// downstream 401s look like six separate problems instead of one.
//
// Rime's documented 401 bodies: "missing headers" (no Authorization header) vs
// "invalid api key" (token unrecognised, or sent without the Bearer scheme).
// We distinguish them so the message names the actual fault.
export async function checkAuth() {
  const url = process.env.RIME_REST_URL || 'https://users.rime.ai/v1/rime-tts';
  const key = (process.env.RIME_API_KEY || '').trim();
  const body = JSON.stringify({ text: 'auth check', speaker: 'abbie', modelId: 'mistv2', lang: 'eng' });
  const post = (headers) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', ...headers },
    body,
  });

  let res;
  try { res = await post({ Authorization: `Bearer ${key}` }); }
  catch (e) { return { ok: false, status: 'BLOCKED', note: `Cannot reach ${url}: ${e.message}` }; }

  if (res.ok) return { ok: true, status: 'PASS', note: `credential accepted (HTTP ${res.status})` };

  const deny = res.headers.get('x-deny-reason');
  const text = (await res.text()).slice(0, 160);
  if (deny || /not in allowlist|host_not_allowed/i.test(text)) {
    return { ok: false, status: 'BLOCKED', note: `Network egress blocked, not a credential result: HTTP ${res.status} ${text}` };
  }
  if (res.status !== 401) return { ok: false, status: 'FAIL', note: `HTTP ${res.status}: ${text}` };

  // Control: does an unauthenticated call return a DIFFERENT error? If so, our
  // header is well-formed and the token value itself is what is being rejected.
  let control = '';
  try { control = (await (await post({})).text()).slice(0, 60); } catch {}

  const headerFine = /missing header/i.test(control) && /invalid api key/i.test(text);
  return {
    ok: false, status: 'FAIL',
    note: `401 "${text}". ` + (headerFine
      ? `The Authorization header is being sent correctly (an unauthenticated control returns "${control}"), ` +
        `so the header is not the problem - THE TOKEN VALUE IS REJECTED. ` +
        `Regenerate at https://app.rime.ai/tokens, check for a stale shell export shadowing .env ` +
        `(env | grep RIME_API_KEY), then run: npm run auth`
      : `Control request returned "${control}". Run: npm run auth`),
  };
}
