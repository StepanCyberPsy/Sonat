// Test entry point injected only into the disposable copy on the macOS runner.
const { app } = require('electron');
const { createHash } = require('node:crypto');
const fs = require('original-fs').promises;
const path = require('node:path');
const assert = require('node:assert/strict');
const { Updater } = require(path.join(process.resourcesPath, 'app/app/updates.cjs'));
const { version } = require(path.join(process.resourcesPath, 'app/package.json'));

async function run() {
  assert.equal(process.type, 'browser');
  const executable = app.getPath('exe');
  const archive = await fs.readFile(process.env.SONAT_TEST_ARCHIVE);
  const digest = 'sha256:' + createHash('sha256').update(archive).digest('hex');
  let relaunch;
  const updater = new Updater({
    app: { getVersion: () => '0.0.0', getPath: name => app.getPath(name), relaunch: args => { relaunch = args; }, quit: () => {} },
    fetch: async url => {
      if (url.endsWith('/releases/latest')) return Response.json({ tag_name: `v${version}`, assets: [{ name: `Sonat-${version}-darwin-${process.arch}.zip`, size: archive.length, digest, browser_download_url: `https://github.com/StepanCyberPsy/Sonat/releases/download/v${version}/Sonat-${version}-darwin-${process.arch}.zip` }] });
      if (url.includes('/commits/')) return Response.json({ sha: process.env.GITHUB_SHA });
      return new Response(archive);
    }
  });
  await updater.check();
  await updater.install();
  assert.equal(relaunch.execPath, executable, 'Dock/Finder bundle path preserved');
}
app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
