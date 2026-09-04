// Print the SHAPE of the saved voice catalog. Structure only, no bulk contents,
// so it is safe to paste anywhere.
import fs from 'node:fs';
const p = process.argv[2] || 'artifacts/preflight/voices-all-v2.json';
if (!fs.existsSync(p)) { console.error(`no file at ${p} - run npm run preflight first`); process.exit(1); }
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

const skeleton = (n, depth = 0, path = '') => {
  const pad = '  '.repeat(depth);
  if (Array.isArray(n)) {
    const kinds = [...new Set(n.map(x => Array.isArray(x) ? 'array' : typeof x))];
    console.log(`${pad}${path || '(root)'}: array[${n.length}] of ${kinds.join('|')}`);
    if (n.length && typeof n[0] === 'string') console.log(`${pad}  e.g. ${JSON.stringify(n.slice(0, 6))}`);
    else if (n.length && depth < 4) skeleton(n[0], depth + 1, '[0]');
    return;
  }
  if (n && typeof n === 'object') {
    const keys = Object.keys(n);
    console.log(`${pad}${path || '(root)'}: object {${keys.slice(0, 12).join(', ')}${keys.length > 12 ? `, +${keys.length - 12} more` : ''}}`);
    if (depth < 4) for (const k of keys.slice(0, 6)) skeleton(n[k], depth + 1, k);
    return;
  }
  console.log(`${pad}${path}: ${typeof n} ${JSON.stringify(n).slice(0, 60)}`);
};
skeleton(j);
console.log(`\nraw head:\n${JSON.stringify(j).slice(0, 400)}`);
