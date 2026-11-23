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
        byId('editShortcut').click();
        byId('shortcutKey').value = 'K';
        byId('modControl').checked = true;
        byId('modAlt').checked = true;
        byId('modShift').checked = true;
        await byId('applyShortcut').onclick();
        return [byId('keyHint').textContent, byId('shortcutHelp').textContent];
      })()` } }));
    const answer = await response;
    assert.deepEqual(answer.result?.result?.value, ['⌃⌥⇧K', '✓ Сочетание сохранено: ⌃⌥⇧K']);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.equal(settings.shortcut, 'Control+Alt+Shift+K');
  } finally { socket.close(); }
}
if (process.argv[2]) main().catch(e => { console.error(e); process.exitCode = 1; });
