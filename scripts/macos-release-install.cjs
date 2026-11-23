// Exercise the user installation path before publishing a new release. Only the
// HTTPS downloads are substituted with the exact, locally built release bytes.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');
(async () => {
  if (process.platform !== 'darwin') throw Error('macOS required');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sonat-zip-install-'));
  try {
    const asset = `Sonat-${version}-darwin-${process.arch}.zip`;
    const archive = path.resolve('dist', asset);
    const bytes = await fs.readFile(archive);
    const url = `https://github.com/StepanCyberPsy/Sonat/releases/download/v${version}/${asset}`;
    const metadata = path.join(temporary, 'release.json');
    await fs.writeFile(metadata, JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: asset, browser_download_url: url, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] }));
    const bin = path.join(temporary, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'curl'), `#!/bin/bash\nset -euo pipefail\nsource_file=''\noutput=''\nwhile (( $# )); do\n  case "$1" in\n    -o) output="$2"; shift ;;\n    https://api.github.com/repos/StepanCyberPsy/Sonat/releases/tags/v*) source_file="$SONAT_TEST_METADATA" ;;\n    https://github.com/StepanCyberPsy/Sonat/releases/download/*) source_file="$SONAT_TEST_ARCHIVE" ;;\n  esac\n  shift\ndone\n[[ -n "$source_file" && -n "$output" ]]\n/bin/cp "$source_file" "$output"\n`, { mode: 0o755 });
    // A source build would fail here even though CI has Xcode installed.
    await fs.writeFile(path.join(bin, 'xcrun'), '#!/bin/bash\necho "Compiler must not run during release installation" >&2\nexit 99\n', { mode: 0o755 });
    const home = path.join(temporary, 'home');
    await fs.mkdir(home);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SONAT_BUILD_FROM_SOURCE: '0', SONAT_TEST_METADATA: metadata, SONAT_TEST_ARCHIVE: archive };
    execFileSync('/bin/bash', ['Установить Sonat.command', '--no-open'], { env, stdio: 'inherit' });
    const bundle = path.join(home, 'Applications/Sonat.app');
    assert.equal(JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/sonat-release.json'), 'utf8')).version, version);
    execFileSync(process.execPath, ['scripts/smoke-call-probe.cjs', bundle], { stdio: 'inherit' });
    // Corrupted bytes must be rejected before installing anything.
    await fs.writeFile(path.join(temporary, 'corrupted.zip'), Buffer.concat([bytes, Buffer.from('corrupt')]));
    const badHome = path.join(temporary, 'bad-home');
    await fs.mkdir(badHome);
    assert.throws(() => execFileSync('/bin/bash', ['Установить Sonat.command', '--no-open'], { env: { ...env, HOME: badHome, SONAT_TEST_ARCHIVE: path.join(temporary, 'corrupted.zip') }, stdio: 'pipe' }));
    assert.equal(await fs.stat(path.join(badHome, 'Applications/Sonat.app')).then(() => true, () => false), false);
    console.log('PASS: release ZIP installed without a compiler; wrong checksum rejected');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
