const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Updater, newer, allowedURL } = require('../app/updates.cjs');
const commit = 'a'.repeat(40);
const archive = Buffer.from('test archive bytes');
function release(bytes = archive) {
  return { tag_name: 'v0.4.1', draft: false, prerelease: false, assets: [{ name: 'Sonat-0.4.1-darwin-arm64.zip', browser_download_url: 'https://github.com/StepanCyberPsy/Sonat/releases/download/v0.4.1/Sonat-0.4.1-darwin-arm64.zip', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), size: bytes.length }] };
}
function network(metadata = release(), bytes = archive) {
  return async url => {
    if (url.endsWith('/releases/latest')) return Response.json(metadata);
    if (url.includes('/commits/')) return Response.json({ sha: commit });
    return new Response(bytes);
  };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sonat-update-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'Sonat.app');
  const executable = path.join(target, 'Contents/MacOS/Electron');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, 'previous binary');
  await fs.writeFile(path.join(directory, 'settings.json'), 'preserved settings');
  const calls = [];
  const app = { getVersion: () => '0.4.0', getPath: () => executable, relaunch: value => calls.push(['relaunch', value]), quit: () => calls.push(['quit']) };
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command.endsWith('plutil')) return { stdout: args[1] === 'CFBundleIdentifier' ? 'com.stepancyberpsy.sonat\n' : '0.4.1\n' };
    if (command.endsWith('unzip')) return { stdout: options.listing || 'Sonat.app/Contents/MacOS/Electron\n' };
    if (command.endsWith('ditto')) {
      const bundle = path.join(args[3], 'Sonat.app');
      await fs.mkdir(path.join(bundle, 'Contents/Resources'), { recursive: true });
      await fs.mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
      await fs.writeFile(path.join(bundle, 'Contents/MacOS/Electron'), 'new binary');
      await fs.writeFile(path.join(bundle, 'Contents/Resources/sonat-release.json'), JSON.stringify({ repository: 'StepanCyberPsy/Sonat', commit: options.wrongCommit ? 'b'.repeat(40) : commit, version: '0.4.1', arch: 'arm64' }));
    }
    if (command.endsWith('codesign') && options.badSignature) throw Error('Invalid signature');
    if (command.endsWith('osascript')) {
      if (options.swapFailure) throw Error('Atomic swap unavailable');
      const a = args.at(-2), b = args.at(-1), temp = a + '.swap-test';
      await fs.rename(a, temp); await fs.rename(b, a); await fs.rename(temp, b);
    }
    return { stdout: '' };
  };
  const updater = new Updater({ app, run, fetch: options.fetch || network(), platform: 'darwin', arch: 'arm64' });
  return { updater, directory, target, executable, calls };
}

test('versions compare numerically, reject ambiguous and prerelease versions', () => {
  assert.equal(newer('0.10.0', '0.9.9'), true);
  assert.equal(newer('0.4.0', '0.4.0'), false);
  assert.equal(newer('0.3.9', '0.4.0'), false);
  for (const value of ['1.2', '01.2.3', '1.2.3-beta', '999999999999999999.1.1']) assert.throws(() => newer(value, '0.4.0'));
});
test('only approved HTTPS GitHub origins accepted', () => {
  for (const value of ['http://github.com/x', 'https://github.com.evil/x', 'https://evil.com/x', 'https://user:pass@github.com/x', 'https://github.com:444/x']) assert.throws(() => allowedURL(value));
});
test('current version and incomplete release do not become installable', async t => {
  const metadata = release(); metadata.tag_name = 'v0.4.0';
  const f = await fixture(t, { fetch: network(metadata) });
  assert.equal((await f.updater.check()).state, 'current');
  await assert.rejects(f.updater.install(), /Сначала/);
  const missing = release(); delete missing.assets[0].digest;
  const g = await fixture(t, { fetch: network(missing) });
  await assert.rejects(g.updater.check(), /контрольной суммы/);
});
test('complete verified bundle replaces original path; old copy and settings retained; relaunch after cleanup', async t => {
  const f = await fixture(t);
  assert.equal((await f.updater.check()).availableVersion, '0.4.1');
  await f.updater.install();
  assert.equal(await fs.readFile(f.executable, 'utf8'), 'new binary');
  assert.equal(await fs.readFile(path.join(f.directory, 'settings.json'), 'utf8'), 'preserved settings');
  const names = await fs.readdir(f.directory);
  const backup = names.find(name => name.endsWith('.sonat-backup'));
  assert.equal(await fs.readFile(path.join(f.directory, backup, 'previous.app/Contents/MacOS/Electron'), 'utf8'), 'previous binary');
  assert.equal(names.some(name => name.startsWith('.sonat-update-')), false);
  assert.deepEqual(f.calls.slice(-2), [['relaunch', { execPath: f.executable, args: [] }], ['quit']]);
});
for (const [name, options] of [
  ['corrupted bytes', { fetch: network(release(), Buffer.from('damaged')) }],
  ['mismatched commit', { wrongCommit: true }],
  ['invalid signature', { badSignature: true }],
  ['zip traversal', { listing: 'Sonat.app/../../outside\n' }],
  ['unavailable atomic swap', { swapFailure: true }]
]) test(`${name} preserves original and does not restart`, async t => {
  const f = await fixture(t, options);
  await f.updater.check();
  await assert.rejects(f.updater.install());
  assert.equal(await fs.readFile(f.executable, 'utf8'), 'previous binary');
  assert.equal(f.calls.some(call => call[0] === 'relaunch'), false);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['Sonat.app', 'settings.json']);
});
test('redirect to a foreign origin rejected', async t => {
  const f = await fixture(t, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/release' } }) });
  await assert.rejects(f.updater.check(), /адрес обновления/);
});

test('successive updates keep only one owned previous bundle', async t => {
  const f = await fixture(t);
  await f.updater.check();
  await f.updater.install();
  await f.updater.check();
  await f.updater.install();
  const backups = (await fs.readdir(f.directory)).filter(name => name.endsWith('.sonat-backup'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(f.directory, backups[0], 'previous.app/Contents/MacOS/Electron'), 'utf8'), 'new binary');
});

test('cleanup failure preserves the original verification error and installed app', async t => {
  const f = await fixture(t, { badSignature: true });
  const realRemove = fs.rm;
  const mock = t.mock.method(fs, 'rm', async (directory, options) => {
    if (path.basename(directory).startsWith('.sonat-update-')) {
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    }
    return realRemove(directory, options);
  });
  try {
    await f.updater.check();
    await assert.rejects(f.updater.install(), /Invalid signature/);
    assert.equal(await fs.readFile(f.executable, 'utf8'), 'previous binary');
  } finally { mock.mock.restore(); }
});
