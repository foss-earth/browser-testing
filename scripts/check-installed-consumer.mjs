/** Exact archive-only public consumer. Execute only under a recorded owner check grant. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, readdir, lstat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const owner = fileURLToPath(new URL('../', import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--release', '--closure', '--output-root', '--cache'].includes(process.argv[i]));
  assert(process.argv[i + 1] && !args.has(process.argv[i])); args.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ['--release', '--closure', '--output-root', '--cache']) assert(args.has(key), 'Missing ' + key);
const release = JSON.parse(await readFile(args.get('--release'), 'utf8'));
assert.equal(release.package, '@foss-earth/browser-testing');
assert.match(release.revision, /^[a-f0-9]{40}$/); assert.match(release.sha256, /^[a-f0-9]{64}$/);
const closure = JSON.parse(await readFile(args.get('--closure'), 'utf8'));
assert.equal(closure.schemaVersion, 1); assert(Array.isArray(closure.archives));
const pins = [...closure.archives, { name: release.package, version: release.version, path: release.archive, sha256: release.sha256, bytes: release.sizeBytes }];
const output = path.resolve(args.get('--output-root')); await mkdir(output, { recursive: false });
assert.equal(await realpath(output), output);
const workspace = path.join(output, 'isolated'); await mkdir(workspace);
const cache = path.resolve(args.get('--cache')); await mkdir(cache, { recursive: true });
const emptyConfig = path.join(output, 'empty-user.npmrc'); const emptyGlobal = path.join(output, 'empty-global.npmrc'); await writeFile(emptyConfig, ''); await writeFile(emptyGlobal, '');
const dependencies = Object.create(null); const inputs = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const pin of pins) {
  assert.match(pin.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/); assert(!dependencies[pin.name]);
  assert.match(pin.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const archive = path.resolve(pin.path); assert.equal(await realpath(archive), archive); assert((await lstat(archive)).isFile());
  const bytes = await readFile(archive); assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
  dependencies[pin.name] = 'file:' + archive; inputs.push({ ...pin, path: archive });
}
for (const name of ['typescript', '@types/node', 'undici-types', '@foss-earth/ci']) assert(dependencies[name], 'Missing exact tool/common archive: ' + name);
await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'shared-browser-public-consumer', version: '1.0.0', private: true, type: 'module', dependencies }, null, 2) + '\n');
const commands = [];
async function run(argv, name, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH)$/.test(key)) delete env[key];
  Object.assign(env, { npm_config_audit: 'false', npm_config_fund: 'false', BROWSER_CONSUMER_ROOT: workspace }, extra);
  const child = spawn(argv[0], argv.slice(1), { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const limit = 1024 * 1024; let retained = Buffer.alloc(0), droppedBytes = 0, timedOut = false;
  const capture = value => { const bytes = Buffer.from(value); const room = limit - retained.length; retained = Buffer.concat([retained, bytes.subarray(0, Math.max(0, room))]); droppedBytes += Math.max(0, bytes.length - room); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let forceTimer;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 90000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); clearTimeout(forceTimer); }
  const log = path.join(output, name + '.log');
  const sanitized = retained.toString('utf8').replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]').replace(/((?:token|password|secret|authorization)[=:]\s*)\S+/gi, '$1[redacted]');
  await writeFile(log, sanitized);
  commands.push({ argv, code, log, sha256: hash(Buffer.from(sanitized)), droppedBytes, timedOut, timeoutMs: 90000 });
  assert(!timedOut, name + ' timed out; owned process exited and log retained');
  assert.equal(code, 0, name + ' failed; retained ' + log);
}
await run(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--userconfig', emptyConfig, '--globalconfig', emptyGlobal], 'install');
const installed = path.join(workspace, 'node_modules', release.package);
assert.equal(await realpath(installed), installed); assert((await lstat(installed)).isDirectory());
for (const [file, expected] of Object.entries(release.files)) {
  assert(!file.split('/').some(part => part === '..' || !part)); const target = path.join(installed, file);
  assert.equal(await realpath(target), target); assert((await lstat(target)).isFile()); assert.equal(hash(await readFile(target)), expected, 'Installed byte identity: ' + file);
}
const trusted = JSON.parse(await readFile(path.join(owner, '.attribution-release.json'), 'utf8'));
for (const [file, expected] of Object.entries(trusted.files)) { const target = path.join(workspace, 'node_modules/@foss-earth/ci', file); assert.equal(await realpath(target), target); assert.equal(hash(await readFile(target)), expected, 'Installed common byte identity: ' + file); }
const pkg = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
assert.equal(pkg.name, release.package); assert.equal(pkg.version, release.version); assert.deepEqual(pkg.exports, release.exports);
assert.deepEqual(pkg.dependencies, {});
const names = new Set();
async function inventory(root, scope = '') {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
    const target = path.join(root, entry.name); assert(entry.isDirectory()); assert.equal(await realpath(target), target);
    if (entry.name.startsWith('@') && !scope) { await inventory(target, entry.name + '/'); continue; }
    const name = scope + entry.name; assert(dependencies[name] && !names.has(name)); names.add(name);
    const info = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')); assert.equal(info.version, inputs.find(pin => pin.name === name).version);
    assert(!await lstat(path.join(target, 'node_modules')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }));
  }
}
await inventory(path.join(workspace, 'node_modules')); assert.equal(names.size, pins.length);
await writeFile(path.join(workspace, 'guard.mjs'), `import {realpath} from 'node:fs/promises';import {fileURLToPath} from 'node:url';const base=await realpath(process.env.BROWSER_CONSUMER_ROOT);export async function resolve(specifier,context,next){const result=await next(specifier,context);if(result.url.startsWith('node:'))return result;if(!result.url.startsWith('file:'))throw Error('Nonfile consumer module');const file=await realpath(fileURLToPath(result.url));if(!file.startsWith(base+'/'))throw Error('Consumer module escaped isolation');if(/[/]node_modules[/](?:playwright(?:-core)?|@foss-earth[/](?:engine|renderer|ui)|foss-earth)(?:[/]|$)/.test(file))throw Error('Eager tool/application import');return result;}`);
await writeFile(path.join(workspace, 'public.ts'), await readFile(path.join(installed, 'fixtures/types/public-consumer.ts')));
await writeFile(path.join(workspace, 'public-contract.mjs'), await readFile(path.join(installed, 'fixtures/installed/public-consumer.mjs')));
await writeFile(path.join(workspace, 'consumer.mjs'), `import assert from 'node:assert/strict';import * as cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';let spawned=0;cp.default.spawn=()=>{spawned++;throw Error('Pure consumer spawned browser')};syncBuiltinESMExports();const {publicImportContract}=await import('./public-contract.mjs');await publicImportContract();assert.equal(spawned,0);console.log('Public lazy exports and private boundaries passed; no browser started.');`);
await run([process.execPath, '--experimental-loader', './guard.mjs', './consumer.mjs'], 'public-runtime');
await run([process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--skipLibCheck', 'false', 'public.ts'], 'strict-public-types');
await mkdir(path.join(workspace, '.github/workflows'), { recursive: true });
for (const file of ['.attribution.json', '.attribution-release.json', '.github/workflows/attribution-check.yml']) await copyFile(path.join(installed, file), path.join(workspace, file));
await run([process.execPath, 'node_modules/@foss-earth/ci/bin/conformance.mjs', '--consumer', workspace, '--trusted-release', path.join(workspace, '.attribution-release.json'), '--output-root', path.join(workspace, 'build', 'common-conformance')], 'installed-common-19cases');
const record = { schemaVersion: 1, status: 'passed', releaseRevision: release.revision, archiveSha256: release.sha256, inputs, installedPath: installed, installedFileCount: Object.keys(release.files).length, publicExports: release.exports, commands, browserAccepted: false };
await writeFile(path.join(output, 'receipt.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, receipt: path.join(output, 'receipt.json'), browserAccepted: false }));
