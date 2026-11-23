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

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ModifierChord, modifierMask, normalizeShortcut, createMacModifierRegistry } = require('../app/shortcuts.cjs');

function fakeMonitor() {
  const children = [];
  return {
    children,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    }
  };
}

test('physical sides are strict, canonical and validate persisted strings', () => {
  assert.equal(modifierMask('AltRight+ShiftRight'), 0x44);
  assert.equal(normalizeShortcut('ShiftRight+AltRight'), 'AltRight+ShiftRight');
  for (const invalid of ['AltRight', 'AltRight+AltRight', 'AltRight+Shift', 'AltRight+R', null])
    assert.equal(modifierMask(invalid), 0);
  assert.equal(normalizeShortcut('Control+Alt+R'), DEFAULT_SHORTCUT);
});

test('one press toggles once, release and wrong sides cannot toggle', () => {
  let count = 0;
  const chord = new ModifierChord('AltRight+ShiftRight', () => count++);
  for (const flags of [0, 0x20, 0x24, 0, 0x40, 0x44, 0x44, 0x40, 0x44, 0x4, 0]) chord.update(flags);
  assert.equal(count, 1);
  // Caps lock and aggregate modifier bits do not change physical side matching.
  chord.update(0x10000 | 0x44);
  assert.equal(count, 2);
  chord.update(0);
  chord.update(0x45); // extra ControlLeft
  chord.update(0x44); // releasing it must not toggle
  assert.equal(count, 2);
  chord.update(0);
  chord.update(0x44);
  assert.equal(count, 3);
});

test('starting while chord is held requires a complete release', () => {
  let count = 0;
  const chord = new ModifierChord('AltRight+ShiftRight', () => count++);
  [0x44, 0x40, 0x44, 0, 0x44].forEach(flags => chord.update(flags));
  assert.equal(count, 1);
});

test('monitor numeric protocol, registration readiness and process cleanup', async () => {
  const fake = fakeMonitor();
  const monitor = createMacModifierRegistry({ platform: 'darwin', spawnProcess: fake.spawnProcess });
  let count = 0;
  const pending = monitor.register('AltRight+ShiftRight', () => count++);
  fake.children[0].stdout.write('0\n');
  assert.equal(await pending, true);
  fake.children[0].stdout.write('6');
  fake.children[0].stdout.write('8\n68\n64\n0\n68\n');
  assert.equal(count, 2);
  monitor.unregister('ShiftRight+AltRight');
  assert.equal(fake.children[0].killed, true);
});

test('physical shortcut saves, restores, rolls back failed save, and disables', async () => {
  const fake = fakeMonitor();
  const options = { platform: 'darwin', spawnProcess: fake.spawnProcess };
  const monitor = createMacModifierRegistry(options);
  const os = registry();
  const shortcuts = new RecordShortcut(os, () => {}, { modifierRegistry: monitor });
  shortcuts.restore();
  const failed = shortcuts.change('AltRight+ShiftRight', async () => { throw Error('disk'); });
  fake.children[0].stdout.write('0\n');
  await assert.rejects(failed, /disk/);
  assert.equal(shortcuts.active, DEFAULT_SHORTCUT);
  assert.ok(os.handlers.has(DEFAULT_SHORTCUT));
  let saved;
  const changing = shortcuts.change('ShiftRight+AltRight', async value => { saved = value; });
  fake.children[1].stdout.write('0\n');
  await changing;
  assert.equal(saved, 'AltRight+ShiftRight');
  assert.equal(os.handlers.size, 0);
  shortcuts.destroy();
  const restored = new RecordShortcut(os, () => {}, { modifierRegistry: createMacModifierRegistry(options) });
  const restoring = restored.restore(saved);
  fake.children[2].stdout.write('0\n');
  assert.equal(await restoring, true);
  assert.equal(restored.active, saved);
  await restored.change('', async value => { saved = value; });
  assert.equal(saved, '');
  assert.equal(fake.children[2].killed, true);
});

test('monitor failure preserves previous shortcut and restore never crashes app', async () => {
  const fake = fakeMonitor();
  const options = { platform: 'darwin', spawnProcess: fake.spawnProcess };
  const shortcuts = new RecordShortcut(registry(), () => {}, { modifierRegistry: createMacModifierRegistry(options) });
  shortcuts.restore();
  const pending = shortcuts.change('AltRight+ShiftRight', assert.fail);
  fake.children[0].emit('error', Error('no osascript'));
  await assert.rejects(pending, /Не удалось/);
  assert.equal(shortcuts.active, DEFAULT_SHORTCUT);
  assert.ok(shortcuts.registry.handlers.has(DEFAULT_SHORTCUT));
  const unavailable = new RecordShortcut(registry(), () => {}, {
    modifierRegistry: createMacModifierRegistry({ platform: 'linux' })
  });
  assert.equal(await unavailable.restore('AltRight+ShiftRight'), false);
  assert.equal(unavailable.requested, 'AltRight+ShiftRight');
  assert.equal(unavailable.active, '');
  assert.match(unavailable.restoreError, /macOS/);
});

test('runtime failure is reported and a fresh monitor can retry', async () => {
  const fake = fakeMonitor();
  let error;
  const monitor = createMacModifierRegistry({ platform: 'darwin', spawnProcess: fake.spawnProcess,
    onError: value => { error = value; } });
  const pending = monitor.register('AltRight+ShiftRight', () => {});
  fake.children[0].stdout.write('0\n');
  await pending;
  fake.children[0].emit('exit', 1);
  assert.match(error.message, /Не удалось/);
  monitor.unregister('AltRight+ShiftRight');
  const retry = monitor.register('AltRight+ShiftRight', () => {});
  fake.children[1].stdout.write('0\n');
  assert.equal(await retry, true);
  monitor.destroy();
});

test('modifier preference survives a real JSON settings file round trip', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonat-shortcut-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'settings.json');
  const fake = fakeMonitor();
  const make = () => new RecordShortcut(registry(), () => {}, {
    modifierRegistry: createMacModifierRegistry({ platform: 'darwin', spawnProcess: fake.spawnProcess })
  });
  const first = make();
  const change = first.change('AltRight+ShiftRight', value => fs.writeFile(file, JSON.stringify({ shortcut: value })));
  fake.children[0].stdout.write('0\n');
  await change;
  first.destroy();
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(settings, { shortcut: 'AltRight+ShiftRight' });
  const second = make();
  const restore = second.restore(settings.shortcut);
  fake.children[1].stdout.write('0\n');
  await restore;
  assert.equal(second.active, settings.shortcut);
  second.destroy();
});

test('same shortcut can be applied again after helper unexpectedly exits', async () => {
  const fake = fakeMonitor();
  const shortcuts = new RecordShortcut(registry(), () => {}, {
    modifierRegistry: createMacModifierRegistry({ platform: 'darwin', spawnProcess: fake.spawnProcess })
  });
  const restore = shortcuts.restore('AltRight+ShiftRight');
  fake.children[0].stdout.write('0\n');
  await restore;
  fake.children[0].emit('exit', 1);
  const retry = shortcuts.change('AltRight+ShiftRight', async () => {});
  fake.children[1].stdout.write('0\n');
  await retry;
  assert.equal(shortcuts.active, 'AltRight+ShiftRight');
  assert.equal(shortcuts.modifierRegistry.isRegistered(shortcuts.active), true);
  shortcuts.destroy();
});
