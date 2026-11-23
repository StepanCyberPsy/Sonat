const test = require('node:test');
const assert = require('node:assert/strict');
const { RecordShortcut, DEFAULT_SHORTCUT } = require('../app/shortcuts.cjs');

function registry() {
  const handlers = new Map();
  return {
    handlers,
    register(key, callback) {
      if (handlers.has(key)) return false;
      handlers.set(key, callback);
      return true;
    },
    unregister(key) { handlers.delete(key); }
  };
}

test('default toggles, changes persist across restarts and can be disabled', async () => {
  const os = registry();
  let count = 0, preference;
  const shortcuts = new RecordShortcut(os, () => count++);
  const persist = async key => { preference = key; };
  shortcuts.restore();
  os.handlers.get(DEFAULT_SHORTCUT)();
  os.handlers.get(DEFAULT_SHORTCUT)();
  assert.equal(count, 2);
  await shortcuts.change('Shift+Command+K', persist);
  assert.deepEqual([...os.handlers.keys()], ['Shift+Command+K']);
  const restart = new RecordShortcut(registry(), () => {});
  restart.restore(preference);
  assert.equal(restart.active, 'Shift+Command+K');
  await restart.change('', persist);
  assert.equal(restart.registry.handlers.size, 0);
  const off = new RecordShortcut(registry(), () => {});
  off.restore(preference);
  assert.equal(off.active, '');
});

test('conflicting, invalid or unsaved replacement keeps previous binding', async () => {
  const os = registry();
  os.register('Command+K', () => {});
  const shortcuts = new RecordShortcut(os, () => {});
  shortcuts.restore();
  await assert.rejects(shortcuts.change('Command+K', assert.fail), /занято/);
  await assert.rejects(shortcuts.change('R', assert.fail), /Выберите/);
  await assert.rejects(shortcuts.change('Alt+K', async () => { throw Error('disk'); }), /disk/);
  assert.equal(shortcuts.active, DEFAULT_SHORTCUT);
  assert.deepEqual([...os.handlers.keys()], ['Command+K', DEFAULT_SHORTCUT]);
  const busy = new RecordShortcut(os, () => {});
  busy.restore();
  assert.equal(busy.active, '');
  assert.equal(busy.requested, DEFAULT_SHORTCUT);
});
