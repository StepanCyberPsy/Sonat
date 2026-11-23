// Run against the isolated app instance opened by the macOS installer workflow.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
async function main() {
  const [, , port, settingsPath] = process.argv;
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = targets.find(target => target.url === 'sonat://studio/index.html');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  try {
    const response = new Promise(resolve => { socket.onmessage = event => resolve(JSON.parse(event.data)); });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const byId = id => document.getElementById(id);
        byId('settingsButton').click();
        await byId('editShortcut').onclick();
        const panel = byId('settingsPanel');
        const send = (code, down) => panel.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
          {code, key: code.startsWith('Alt') ? 'Alt' : 'Shift', location: 2, bubbles: true, cancelable: true}));
        send('AltRight',true); send('ShiftRight',true); send('ShiftRight',false); send('AltRight',false);
        for (let i = 0; i < 100 && !byId('shortcutHelp').textContent.startsWith('✓'); i++) {
          await new Promise(resolve => setTimeout(resolve,100));
        }
        return [byId('keyHint').textContent, byId('shortcutHelp').textContent];
      })()` } }));
    const answer = await response;
    assert.deepEqual(answer.result?.result?.value, ['правый ⌥ + правый ⇧', '✓ Сочетание сохранено: правый ⌥ + правый ⇧']);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(settings.shortcut, 'AltRight+ShiftRight');
  } finally { socket.close(); }
}
if (process.argv[2]) main().catch(e => { console.error(e); process.exitCode = 1; });
