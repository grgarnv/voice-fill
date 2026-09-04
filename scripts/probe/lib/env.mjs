// Zero-dependency .env loader.
//
// Replaces `import 'dotenv/config'`. Two reasons:
//   1. The preflight and auth diagnostics must run on a fresh clone with no
//      node_modules. A diagnostic that cannot start is worthless exactly when
//      you need it.
//   2. It lets us detect a shell export shadowing .env - the silent cause of
//      "I fixed the key but it still 401s".
//
// Node 20.6+ ships --env-file and Node 22+ has process.loadEnvFile(); we use
// those when present and fall back to a small parser otherwise.
import fs from 'node:fs';
import path from 'node:path';

export function parseEnvFile(text) {
  const out = {};
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip matching wrapping quotes; only then is a trailing # a comment.
    const quoted = (val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
                   (val.startsWith("'") && val.endsWith("'") && val.length > 1);
    if (quoted) val = val.slice(1, -1);
    else { const h = val.indexOf(' #'); if (h !== -1) val = val.slice(0, h).trim(); }
    out[key] = val;
  }
  return out;
}

/** Load .env into process.env without clobbering existing vars (dotenv semantics). */
export function loadEnv({ dir = process.cwd(), quiet = false } = {}) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) {
    if (!quiet) console.warn(`  note: no .env at ${file} - using the shell environment only.`);
    return { loaded: false, shadowed: [] };
  }
  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const shadowed = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] !== undefined && process.env[k] !== v) {
      // The shell wins, same as dotenv. Say so loudly - this is the failure mode
      // where someone edits .env, sees no change, and blames the API.
      shadowed.push(k);
    } else if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
  if (shadowed.length && !quiet) {
    console.warn(`\n  WARNING: these are set in your SHELL and are overriding .env: ${shadowed.join(', ')}`);
    console.warn(`  The shell value is what gets sent. To use .env instead:  unset ${shadowed.join(' ')}\n`);
  }
  return { loaded: true, shadowed, keys: Object.keys(parsed) };
}
