// Main-process only. The renderer supplies no URL, command, version or path.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const REPO = 'StepanCyberPsy/Sonat';
const API = `https://api.github.com/repos/${REPO}`;
const HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_ARCHIVE = 512 * 1024 * 1024;
const SWAP_SCRIPT = `ObjC.import('Foundation');
ObjC.bindFunction('renamex_np', ['int', ['string', 'string', 'unsigned int']]);
function run(argv) {
  if (argv.length !== 2) throw Error('Invalid swap arguments');
  if ($.renamex_np(argv[0], argv[1], 2) !== 0) throw Error('Atomic app replacement unavailable; original app preserved');
}`;

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Некорректная версия релиза.');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Некорректная версия релиза.');
  return parts;
}
function newer(next, current) {
  const a = versionParts(next), b = versionParts(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function allowedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) throw new Error('Недопустимый адрес обновления.');
  return url.href;
}
async function response(url, fetcher, signal, accept) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const result = await fetcher(allowedURL(url), { redirect: 'manual', signal, headers: { Accept: accept, 'User-Agent': 'Sonat-updater', 'X-GitHub-Api-Version': '2022-11-28' } });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const next = result.headers.get('location');
      await result.body?.cancel();
      if (!next) throw new Error('GitHub не указал адрес загрузки.');
      url = new URL(next, url).href;
      continue;
    }
    if (!result.ok) { await result.body?.cancel(); throw new Error(`GitHub: ошибка ${result.status}. Попробуйте позже.`); }
    return result;
  }
  throw new Error('Слишком много перенаправлений GitHub.');
}
async function json(url, fetcher) {
  const result = await response(url, fetcher, AbortSignal.timeout(30000), 'application/vnd.github+json');
  let size = 0;
  const chunks = [];
  for await (const chunk of result.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Слишком большой ответ GitHub.');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function verifyLinks(directory, root = directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await fs.realpath(file);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Обновление содержит внешнюю ссылку.');
    } else if (entry.isDirectory()) await verifyLinks(file, root);
  }
}

class Updater {
  constructor({ app, fetch: fetcher = globalThis.fetch, run = runFile, platform = process.platform, arch = process.arch }) {
    this.app = app;
    this.fetch = fetcher;
    this.run = run;
    this.platform = platform;
    this.arch = arch;
    this.release = null;
    this.busy = false;
    this.state = { state: 'idle', currentVersion: app.getVersion(), availableVersion: null };
  }
  status() { return { ...this.state }; }
  async exclusive(fn) {
    if (this.busy) throw new Error('Обновление уже выполняется.');
    this.busy = true;
    try { return await fn(); }
    catch (error) { this.state = { ...this.state, state: 'error', error: error.message }; throw error; }
    finally { this.busy = false; }
  }
  check() {
    return this.exclusive(async () => {
      if (this.platform !== 'darwin' || !['arm64', 'x64'].includes(this.arch)) throw new Error('Обновление доступно для установленного Sonat на Mac.');
      this.release = null;
      this.state = { state: 'checking', currentVersion: this.app.getVersion(), availableVersion: null };
      const release = await json(`${API}/releases/latest`, this.fetch);
      if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Некорректный релиз Sonat.');
      const version = release.tag_name.slice(1);
      if (!newer(version, this.app.getVersion())) {
        this.state.state = 'current';
        return this.status();
      }
      // Resolve the tag now, then bind the downloaded bundle to this exact commit.
      const commit = await json(`${API}/commits/${encodeURIComponent(release.tag_name)}`, this.fetch);
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('GitHub не подтвердил исходную версию.');
      const name = `Sonat-${version}-darwin-${this.arch}.zip`;
      const assets = release.assets?.filter(asset => asset.name === name);
      if (assets?.length !== 1) throw new Error('Сборка для этого Mac ещё не опубликована.');
      const asset = assets[0];
      if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE) throw new Error('У релиза нет проверенной контрольной суммы.');
      const url = allowedURL(asset.browser_download_url);
      if (url !== `https://github.com/${REPO}/releases/download/${release.tag_name}/${name}`) throw new Error('Некорректный файл релиза.');
      this.release = Object.freeze({ version, commit: commit.sha, url, digest: asset.digest.slice(7), size: asset.size });
      this.state = { ...this.state, state: 'available', availableVersion: version };
      return this.status();
    });
  }
  install() {
    return this.exclusive(async () => {
      const release = this.release;
      if (!release) throw new Error('Сначала проверьте наличие обновления.');
      this.state = { ...this.state, state: 'downloading', error: undefined };
      const executable = await fs.realpath(this.app.getPath('exe'));
      if (!executable.endsWith('/Contents/MacOS/Electron')) throw new Error('Запустите установленное приложение Sonat.');
      const target = path.resolve(executable, '../../..');
      if (!target.endsWith('.app')) throw new Error('Запустите установленное приложение Sonat.');
      const parent = path.dirname(target);
      const { stdout: currentID } = await this.run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(target, 'Contents/Info.plist')]);
      if (currentID.trim() !== 'com.stepancyberpsy.sonat') throw new Error('Обновлять можно только приложение Sonat.');
      await fs.access(parent, require('node:fs').constants.W_OK);
      const stage = await fs.mkdtemp(path.join(parent, '.sonat-update-'));
      const backupDir = path.join(parent, `.${path.basename(target)}.sonat-backup`);
      const backup = path.join(backupDir, 'previous.app');
      let candidate = false;
      let installed = false;
      let stageCleaned = false;
      try {
        const archive = path.join(stage, 'release.zip');
        const result = await response(release.url, this.fetch, AbortSignal.timeout(10 * 60 * 1000), 'application/octet-stream');
        const hash = createHash('sha256');
        const handle = await fs.open(archive, 'wx', 0o600);
        let bytes = 0;
        try {
          for await (const chunk of result.body) {
            bytes += chunk.length;
            if (bytes > release.size) throw new Error('Размер загрузки не совпадает с релизом.');
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          await handle.sync();
        } finally { await handle.close(); }
        if (bytes !== release.size || hash.digest('hex') !== release.digest) throw new Error('Проверка загрузки не пройдена. Приложение не изменено.');
        this.state.state = 'installing';
        const { stdout } = await this.run('/usr/bin/unzip', ['-Z', '-1', archive], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
        if (!stdout.trim() || stdout.split('\n').filter(Boolean).some(name => !name.startsWith('Sonat.app/') || name.split('/').includes('..') || name.includes('\\'))) throw new Error('Недопустимая структура обновления.');
        const unpacked = path.join(stage, 'unpacked');
        await fs.mkdir(unpacked);
        await this.run('/usr/bin/ditto', ['-x', '-k', archive, unpacked], { timeout: 120000 });
        const bundle = path.join(unpacked, 'Sonat.app');
        if (!(await fs.lstat(bundle)).isDirectory()) throw new Error('Нет приложения в обновлении.');
        await verifyLinks(bundle);
        const marker = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/sonat-release.json'), 'utf8'));
        if (marker.commit !== release.commit || marker.version !== release.version || marker.arch !== this.arch || marker.repository !== REPO) throw new Error('Сборка не соответствует исходной версии релиза.');
        const { stdout: bundleID } = await this.run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
        const { stdout: bundleVersion } = await this.run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
        if (bundleID.trim() !== 'com.stepancyberpsy.sonat' || bundleVersion.trim() !== release.version) throw new Error('Неверная версия приложения.');
        await this.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000 });
        // The candidate and installed app are on the same volume. RENAME_SWAP
        // replaces both names in one filesystem operation, preserving the old app.
        try {
          const previous = JSON.parse(await fs.readFile(path.join(backupDir, 'owner.json'), 'utf8'));
          if (previous.repository !== REPO || previous.target !== target || previous.format !== 1 || (await fs.lstat(backupDir)).isSymbolicLink()) throw new Error('Неизвестная резервная копия: требуется проверка владельца.');
          const entries = await fs.readdir(backupDir);
          if (entries.some(name => !['owner.json', 'previous.app'].includes(name))) throw new Error('В резервной копии есть посторонние файлы.');
          await fs.rm(backupDir, { recursive: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.mkdir(backupDir);
        candidate = true;
        await fs.writeFile(path.join(backupDir, 'owner.json'), JSON.stringify({ format: 1, repository: REPO, target }), { flag: 'wx', mode: 0o600 });
        await fs.rename(bundle, backup);
        candidate = true;
        await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SWAP_SCRIPT, target, backup], { timeout: 30000 });
        installed = true;
        candidate = false;
        await fs.rm(stage, { recursive: true, force: true });
        stageCleaned = true;
        this.state.state = 'restarting';
        this.app.relaunch({ execPath: path.join(target, 'Contents/MacOS/Electron'), args: [] });
        this.app.quit();
        return this.status();
      } catch (error) {
        if (installed) throw new Error(`Обновление установлено в ${target}. Откройте его через Finder: ${error.message}`);
        throw error;
      } finally {
        if (candidate && !installed) await fs.rm(backupDir, { recursive: true, force: true });
        if (!stageCleaned) await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
}
module.exports = { Updater, newer, allowedURL };
