// Called only by the release workflow, after the regular installer has run.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');
(async () => {
  const commit = process.env.GITHUB_SHA;
  if (process.platform !== 'darwin' || !/^[a-f0-9]{40}$/.test(commit || '') || !['arm64', 'x64'].includes(process.arch)) throw new Error('Not a macOS release build');
  const bundle = path.join(os.homedir(), 'Applications/Sonat.app');
  const plist = path.join(bundle, 'Contents/Info.plist');
  if (execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim() !== version) throw new Error('Installer version differs from package.json');
  const installed = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/app/package.json'), 'utf8'));
  if (installed.version !== version) throw new Error('Installed source version differs');
  await fs.writeFile(path.join(bundle, 'Contents/Resources/sonat-release.json'), JSON.stringify({ repository: 'StepanCyberPsy/Sonat', version, arch: process.arch, commit }) + '\n');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.stepancyberpsy.sonat', bundle], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  await fs.mkdir('dist', { recursive: true });
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', bundle, path.resolve(`dist/Sonat-${version}-darwin-${process.arch}.zip`)], { stdio: 'inherit' });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
