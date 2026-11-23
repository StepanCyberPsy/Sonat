const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, session, shell, safeStorage, clipboard, globalShortcut, Menu, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { Recording, pending, nextPart, savePart, sessionDir, saveJSON } = require('./recordings.cjs');

const { transcribe, checkConnection } = require('./transcription.cjs');

const { RecordShortcut } = require('./shortcuts.cjs');

app.setName('Sonat');
protocol.registerSchemesAsPrivileged([{ scheme: 'sonat', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const page = 'sonat://studio/index.html';
let win, settingsFile, active, operation = '', writeError;
let settings = {};
let writeQueue = Promise.resolve();

function trusted(event) {
  return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === page;
}
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!trusted(event)) throw new Error('Неизвестное окно.');
    return fn(...args);
  });
}
function idle() {
  if (active || operation) throw new Error('Сначала завершите текущую операцию.');
}
async function exclusive(name, fn) {
  idle();
  operation = name;
  try { return await fn(); } finally { operation = ''; }
}
async function configure(values) {
  const next = { ...settings, ...values };
  await saveJSON(settingsFile, next);
  settings = next;
}
async function finish() {
  if (!active) return;
  const current = active;
  operation = 'finish';
  try {
    await writeQueue;
    await current.finish();
    if (writeError) throw writeError;
    return current.id;
  } finally {
    active = null;
    operation = '';
  }
}

async function setup() {
  const userData = app.getPath('userData');
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  settingsFile = path.join(userData, 'settings.json');
  try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  let lastShortcutAt = 0;
  function toggleFromKeyboard() {
    const now = Date.now();
    const previous = lastShortcutAt;
    lastShortcutAt = now;
    if (now - previous < 800 || operation || !win || win.isDestroyed()) return;
    const contents = win.webContents;
    if (contents.getURL() !== page || contents.isLoadingMainFrame()) return;
    // Display capture needs a focused document and a real initiating user action.
    // An OS-registered keypress is the gesture for this fixed local button.
    function press() {
      if (win.isDestroyed() || contents.getURL() !== page) return;
      contents.executeJavaScript("if (!document.querySelector('dialog[open]')) document.getElementById('record').click()", true)
        .catch(() => {});
    }
    if (active || win.isFocused()) { press(); return; }
    const onFocus = () => {
      clearTimeout(expiry);
      contents.focus();
      press();
    };
    const expiry = setTimeout(() => win.removeListener('focus', onFocus), 750);
    win.once('focus', onFocus);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  const shortcut = new RecordShortcut(globalShortcut, toggleFromKeyboard);
  handle('set-shortcut', value => exclusive('shortcut', () => shortcut.change(value,
    key => configure({ shortcut: key }))));
  handle('info', async () => ({
    shortcut: shortcut.active, shortcutWanted: shortcut.requested,
    folder: settings.folder || '', automatic: Boolean(settings.apiKey), apiCheck: settings.apiCheck || null,
    pending: settings.folder ? await pending(settings.folder) : []
  }));
  handle('folder', () => exclusive('folder', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Папка для расшифровок' });
    if (!result.canceled) await configure({ folder: result.filePaths[0] });
  }));
  handle('show-folder', async () => {
    if (settings.folder) {
      const error = await shell.openPath(settings.folder);
      if (error) throw new Error(error);
    }
  });
  handle('start', mode => exclusive('start', async () => {
    if (!settings.folder) throw new Error('Выберите папку для расшифровок.');
    if (!['call', 'mic'].includes(mode)) throw new Error('Выберите режим записи.');
    active = await Recording.create(settings.folder, mode);
    writeError = null;
    writeQueue = Promise.resolve();
    return active.id;
  }));
  handle('samples', (id, samples) => {
    if (active?.id !== id || operation || !(samples instanceof Uint8Array) || samples.length > 65536)
      throw new Error('Некорректный блок записи.');
    const recording = active;
    const next = writeQueue.then(() => {
      if (writeError) throw writeError;
      return recording.append(Buffer.from(samples));
    });
    writeQueue = next.catch(e => { writeError = e; });
    return next;
  });
  handle('stop', id => {
    if (active?.id !== id || operation) throw new Error('Запись уже остановлена.');
    return finish();
  });
  async function savedKey() {
    if (!settings.apiKey) throw new Error('Добавьте ключ API.');
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(settings.apiKey, 'base64'));
    return result;
  }
  handle('check-api', () => exclusive('settings', async () => {
    const key = await savedKey();
    let result;
    try {
      await checkConnection(key);
      result = { ok: true };
    } catch (e) {
      result = { ok: false, message: e.message };
    }
    await configure({ apiCheck: { ...result, time: Date.now() } });
  }));
  handle('api-key', value => exclusive('settings', async () => {
    if (value === null) return configure({ apiKey: null, apiCheck: null });
    if (typeof value !== 'string' || !value.trim()) throw new Error('Введите ключ проекта OpenAI.');
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Системное шифрование ключа недоступно.');
    const encrypted = await safeStorage.encryptStringAsync(value.trim());
    await checkConnection(value.trim());
    await configure({ apiKey: encrypted.toString('base64'), apiCheck: { ok: true, time: Date.now() } });
  }));
  handle('transcribe', id => exclusive('transcribe', async () => {
    const key = await savedKey();
    return transcribe(settings.folder, id, key, (i, n) => {
      if (!win.isDestroyed()) win.webContents.send('progress', i, n);
    });
  }));
  handle('next-part', id => exclusive('prepare', () => nextPart(settings.folder, id)));
  handle('save-part', (id, name, text) => exclusive('save', () => savePart(settings.folder, id, name, text)));
  handle('reveal-part', id => exclusive('reveal', async () => {
    const part = await nextPart(settings.folder, id);
    if (part.name) shell.showItemInFolder(path.join(sessionDir(settings.folder, id), part.name));
  }));
  handle('open-chat', () => shell.openExternal('https://chatgpt.com/'));
  handle('copy-prompt', () => clipboard.writeText('Расшифруй прикреплённую аудиозапись дословно на языке разговора. Разделяй реплики абзацами. Неразборчивые места отмечай [неразборчиво]. Верни только расшифровку.'));

  const assets = new Set(['/index.html', '/style.css', '/renderer.js', '/worklet.js', '/sonat.png']);
  protocol.handle('sonat', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'studio' || !assets.has(url.pathname)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, url.pathname.slice(1))).href);
  });
  win = new BrowserWindow({
    width: 720, height: 800, minWidth: 500, minHeight: 560, title: 'Sonat',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  shortcut.restore(settings.shortcut);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Sonat', submenu: [{ role: 'about', label: 'О Sonat' }, { type: 'separator' }, { label: 'Настройки…', accelerator: 'Command+,', click: () => { win.show(); win.webContents.send('settings'); } }, { type: 'separator' }, { role: 'hide', label: 'Скрыть Sonat' }, { role: 'quit', label: 'Завершить Sonat' }] },
    { label: 'Правка', submenu: [{ role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Скопировать' }, { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
    { label: 'Окно', submenu: [{ role: 'minimize', label: 'Свернуть' }, { role: 'zoom', label: 'Увеличить' }] }
  ]));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== win.webContents.mainFrame || request.frame.url !== page || !request.audioRequested) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback(sources.length ? { video: sources[0], audio: 'loopback' } : {});
    } catch { callback({}); }
  });
  win.on('close', event => {
    if (active || operation) {
      event.preventDefault();
      dialog.showMessageBoxSync(win, { message: active ? 'Сначала остановите запись.' : 'Дождитесь завершения операции.' });
    }
  });
  win.webContents.on('render-process-gone', async () => {
    if (active && operation !== 'finish') await finish().catch(() => {});
    if (!win.isDestroyed()) win.reload();
  });
  await win.loadURL(page);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.restore(); win.show(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(setup).catch(e => { dialog.showErrorBox('Sonat', e.message); app.quit(); });
}
