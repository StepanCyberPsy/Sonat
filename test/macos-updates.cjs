// Real macOS archive, signature, renamex_np and launch acceptance test.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { version } = require('../package.json');
(async () => {
  if (process.env.SONAT_TEST_REAL_UPDATE !== '1') return;
  if (process.platform !== 'darwin') throw Error('macOS required');
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sonat-real-update-'));
  let processHandle;
  try {
    const bundle = path.join(temporary, 'Sonat.app');
    execFileSync('/usr/bin/ditto', [path.join(os.homedir(), 'Applications/Sonat.app'), bundle]);
    const executable = path.join(bundle, 'Contents/MacOS/Electron');
    const profile = path.join(temporary, 'profile');
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'settings.json'), '{}\n');
    // Run the installer in a packaged Electron main process, where Node's fs is patched.
    const entry = path.join(bundle, 'Contents/Resources/app/app/main.cjs');
    await fs.copyFile('scripts/macos-update-driver.cjs', entry);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.stepancyberpsy.sonat', bundle]);
    const backup = path.join(temporary, '.Sonat.app.sonat-backup');
    const legacyResources = path.join(backup, 'previous.app/Contents/Resources');
    await fs.mkdir(legacyResources, { recursive: true });
    await fs.writeFile(path.join(legacyResources, 'default_app.asar'), 'legacy archive fixture');
    await fs.writeFile(path.join(backup, 'owner.json'), JSON.stringify({ format: 1, repository: 'StepanCyberPsy/Sonat', target: bundle }));
    execFileSync(executable, [`--user-data-dir=${profile}`], {
      stdio: 'inherit', timeout: 180000,
      env: { ...process.env, SONAT_TEST_ARCHIVE: path.resolve(`dist/Sonat-${version}-darwin-${process.arch}.zip`) }
    });
    assert.equal(await fs.readFile(path.join(profile, 'settings.json'), 'utf8'), '{}\n');
    assert.equal((await fs.readdir(temporary)).filter(name => name.endsWith('.sonat-backup')).length, 1);
    assert.equal((await fs.readdir(temporary)).some(name => name.startsWith('.sonat-update-')), false);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    let output = '';
    processHandle = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle.stdout.on('data', chunk => { output += chunk; });
    processHandle.stderr.on('data', chunk => { output += chunk; });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (processHandle.exitCode !== null) throw Error(`Updated application exited: ${output}`);
      try {
        const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        if (pages.some(page => page.url === 'sonat://studio/index.html' && page.title === 'Sonat')) {
          execFileSync(process.execPath, ['test/macos-settings.cjs', port, path.join(profile, 'settings.json')], { stdio: 'inherit' });
          console.log('PASS: verified archive, atomic replacement, previous version retained, settings preserved, updated app launched at original path');
          return;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error(`Updated application did not open: ${output}`);
  } finally {
    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill();
      await new Promise(resolve => processHandle.once('exit', resolve));
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
