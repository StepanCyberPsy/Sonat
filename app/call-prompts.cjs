const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { CallOffers, watchCalls } = require('./call-detection.cjs');

function setupCallPrompts({ win, page, handle, isBusy, isRecording, enabled, saveEnabled }) {
  let popup = null, stopWatching = null, errorText = '';
  const send = (channel, value) => {
    if (!win.isDestroyed() && win.webContents.getURL() === page) win.webContents.send(channel, value);
  };
  const setError = text => {
    if (text === errorText) return;
    errorText = text;
    send('call-detection-error', text);
  };
  function closePopup() {
    if (popup && !popup.isDestroyed()) popup.destroy();
    popup = null;
  }
  const offers = new CallOffers(offer => {
    closePopup();
    send('call-offer', offer);
    if (!offer || win.isDestroyed() || win.isFocused()) return;
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(334, workArea.width);
    const panel = new BrowserWindow({
      width, height: 125, x: workArea.x + workArea.width - width - 14, y: workArea.y + 14,
      type: 'panel', frame: false, show: false, resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      title: 'Sonat', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, 'call-popup-preload.cjs') }
    });
    popup = panel;
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    panel.setAlwaysOnTop(true, 'floating');
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', event => event.preventDefault());
    panel.once('ready-to-show', () => {
      if (panel === popup && offers.offer?.id === offer.id && !win.isFocused()) panel.showInactive();
    });
    const url = new URL('sonat://studio/call-popup.html');
    url.searchParams.set('id', offer.id);
    url.searchParams.set('service', offer.label);
    panel.loadURL(url.href).catch(() => { if (panel === popup) closePopup(); });
  });
  function choose(event, id, record) {
    if (!popup || popup.isDestroyed() || event.sender !== popup.webContents ||
        event.senderFrame !== popup.webContents.mainFrame || id !== offers.offer?.id) return;
    if (!record) { offers.consume(id); return; }
    closePopup();
    if (win.isDestroyed() || win.webContents.getURL() !== page) return;
    const click = () => {
      if (win.isDestroyed() || id !== offers.offer?.id || isBusy()) return;
      win.webContents.focus();
      win.webContents.executeJavaScript(
        `{ const b = document.getElementById('callRecord'); if (b?.dataset.offerId === ${JSON.stringify(id)} && !b.disabled) b.click(); }`,
        true).catch(() => {});
    };
    if (win.isMinimized()) win.restore();
    if (win.isFocused()) { click(); return; }
    // Display capture must originate from a user gesture in the focused recording window.
    const expire = setTimeout(() => win.removeListener('focus', focus), 2000);
    function focus() { clearTimeout(expire); setImmediate(click); }
    win.once('focus', focus);
    win.show();
    win.focus();
  }
  ipcMain.on('call-popup-choice', choose);
  win.on('focus', closePopup);
  function start() {
    if (stopWatching || !enabled()) return;
    const exe = path.resolve(process.resourcesPath, '../Helpers/SonatCallProbe');
    stopWatching = watchCalls(exe, sample => {
      setError(sample.status === 'error' ? 'macOS не предоставила сведения об аудиоустройствах.' : '');
      offers.update(sample, isRecording());
    }, text => { setError(text); offers.hide(); });
  }
  function stop() {
    stopWatching?.();
    stopWatching = null;
    offers.clear();
    setError('');
    closePopup();
  }
  handle('set-call-detection', async value => {
    if (typeof value !== 'boolean') throw new Error('Некорректная настройка.');
    await saveEnabled(value);
    if (value) start(); else stop();
  });
  handle('dismiss-call', id => offers.consume(id));
  handle('accept-call', id => enabled() && !isBusy() && offers.consume(id));
  start();
  return {
    info: () => ({ callDetection: enabled(), callDetectionError: errorText,
      callOffer: offers.offer ? { id: offers.offer.id, label: offers.offer.label } : null }),
    suppress: () => offers.hide(),
    destroy() { stop(); ipcMain.removeListener('call-popup-choice', choose); win.removeListener('focus', closePopup); }
  };
}
module.exports = { setupCallPrompts };
