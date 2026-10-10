// Syntax/metadata check only; run under the separately granted owner check slot.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@foss-earth/browser-testing');
assert.equal(manifest.engines.node, '>=22');
assert.deepEqual(manifest.dependencies, {});
async function visit(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const rel = path.join(directory, entry.name);
    if (entry.isDirectory()) { await visit(rel); continue; }
    if (!rel.endsWith('.mjs')) continue;
    const child = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding: 'utf8' });
    assert.equal(child.status, 0, 'Syntax check failed: ' + rel);
    if (directory === 'src' || directory.startsWith('src/')) {
      const source = await readFile(path.join(root, rel), 'utf8');
      assert(!/from\s+["'](?:foss-earth|@foss-earth\/(?:engine|renderer|ui|sky|360|scenes)|@0sfs|@umn-vr)/.test(source), 'Application/provider import: ' + rel);
      // Generic path-redaction expressions may name OS directory prefixes.
      assert(!source.includes('/Users/felg/') && !source.includes('/Applications/Google Chrome') && !source.includes('/Applications/Firefox') && !source.includes('../../build/tools/'), 'Hardcoded machine/tool location: ' + rel);
    }
  }
}
for (const dir of ['src', 'tests', 'scripts', 'fixtures']) await visit(dir);
for (const key of ['.', './core', './chrome', './firefox', './page']) {
  const target = manifest.exports[key]; assert(target.import.endsWith('.mjs') && target.types.endsWith('.d.ts'));
  await readFile(path.join(root, target.import)); await readFile(path.join(root, target.types));
}
console.log('Shared generic source and declared public targets checked; no browser/backend acceptance inferred.');
