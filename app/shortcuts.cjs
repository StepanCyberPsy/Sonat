const { spawn } = require('node:child_process');
const path = require('node:path');
const DEFAULT_SHORTCUT = 'Control+Alt+R';
const validShortcut = /^(Control\+)?(Alt\+)?(Shift\+)?(Command\+)?(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|20))$/;
// IOKit/hidsystem/IOLLEvent.h: NX_DEVICE*KEYMASK. Physical sides, not
// the aggregate Control/Option/Shift/Command flags in the upper bits.
const MODIFIER_MASKS = Object.freeze({
  ControlLeft: 0x1, ControlRight: 0x2000,
  AltLeft: 0x20, AltRight: 0x40,
  ShiftLeft: 0x2, ShiftRight: 0x4,
  CommandLeft: 0x8, CommandRight: 0x10
});
const ALL_MODIFIERS = Object.values(MODIFIER_MASKS).reduce((a, b) => a | b, 0);
function modifierMask(value) {
  if (typeof value !== 'string') return 0;
  const keys = value.split('+');
  if (keys.length < 2 || new Set(keys).size !== keys.length ||
      keys.some(key => !Object.hasOwn(MODIFIER_MASKS, key))) return 0;
  return keys.reduce((mask, key) => mask | MODIFIER_MASKS[key], 0);
}
function valid(value) {
  return Boolean(modifierMask(value)) || (typeof value === 'string' && value.includes('+') &&
    /(?:Control|Alt|Command)\+/.test(value) && validShortcut.test(value));
}
function normalizeShortcut(value) {
  const mask = modifierMask(value);
  return mask ? Object.keys(MODIFIER_MASKS).filter(key => mask & MODIFIER_MASKS[key]).join('+') : value;
}

// A chord fires on its press edge only. After firing, release all its keys to
// rearm. Releasing an extra modifier, key repeat, and startup with keys held
// must never produce another toggle.
class ModifierChord {
  constructor(value, callback) {
    this.mask = modifierMask(value);
    if (!this.mask) throw new Error('Выберите хотя бы два физических модификатора.');
    this.callback = callback;
    this.previous = null;
    this.armed = false;
  }
  update(flags) {
    const current = flags & ALL_MODIFIERS;
    if (this.previous === null) {
      this.armed = (current & this.mask) === 0;
      this.previous = current;
      return;
    }
    if ((current & this.mask) === 0) this.armed = true;
    const pressed = current & ~this.previous;
    this.previous = current;
    if (this.armed && current === this.mask && (pressed & this.mask)) {
      this.armed = false;
      this.callback();
    }
  }
}

// One long-lived system process, no npm/native dependency and no Xcode.
// Registration waits for the first numeric state, so a launch/bridge failure
// cannot silently replace a working Electron shortcut.
function createMacModifierRegistry({ platform = process.platform, spawnProcess = spawn,
  startupTimeout = 5000, onError = () => {} } = {}) {
  const handlers = new Map();
  let child = null, starting = null, lastFlags = null;
  const registry = {
    error: '',
    isRegistered(value) { return Boolean(child && lastFlags !== null && handlers.has(normalizeShortcut(value))); },
    async register(value, callback) {
      const key = normalizeShortcut(value);
      if (!modifierMask(value)) return false;
      if (handlers.has(key)) {
        if (child) return false;
        handlers.delete(key); // Retry after an unexpected helper exit.
      }
      if (platform !== 'darwin') throw new Error('Физические модификаторы поддерживаются только на macOS.');
      handlers.set(key, new ModifierChord(value, callback));
      try {
        await start();
        handlers.get(key)?.update(lastFlags);
        return true;
      } catch (error) {
        handlers.delete(key);
        stop();
        throw error;
      }
    },
    unregister(value) {
      handlers.delete(normalizeShortcut(value));
      if (!handlers.size) stop();
    },
    destroy() { handlers.clear(); stop(); }
  };
  function stop() {
    const previous = child;
    child = null;
    starting = null;
    lastFlags = null;
    previous?.kill();
  }
  function start() {
    if (starting) return starting;
    registry.error = '';
    starting = new Promise((resolve, reject) => {
      let ready = false, buffer = '';
      const process = spawnProcess('/usr/bin/osascript', ['-l', 'JavaScript',
        path.join(__dirname, 'modifier-monitor.jxa')], { stdio: ['ignore', 'pipe', 'ignore'] });
      child = process;
      const timer = setTimeout(() => fail(), startupTimeout);
      timer.unref?.();
      const fail = () => {
        if (child !== process) return;
        clearTimeout(timer);
        const error = new Error('Не удалось включить физические модификаторы macOS. Попробуйте обычное сочетание с клавишей.');
        registry.error = error.message;
        stop();
        if (!ready) reject(error);
        else onError(error);
      };
      process.on('error', fail);
      process.on('exit', fail);
      process.stdout.on('data', data => {
        if (child !== process) return;
        buffer += data.toString();
        // The helper has a tiny numeric-only protocol. Never keep unbounded output.
        if (buffer.length > 4096) return fail();
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!/^\d{1,16}$/.test(line)) return fail();
          const flags = Number(line);
          if (!Number.isSafeInteger(flags)) return fail();
          lastFlags = flags;
          for (const chord of handlers.values()) chord.update(flags);
          if (!ready) { ready = true; clearTimeout(timer); resolve(); }
        }
      });
    });
    return starting;
  }
  return registry;
}

// Keep the old binding live until its replacement is registered and persisted.
class RecordShortcut {
  constructor(registry, toggle, { modifierRegistry } = {}) {
    this.registry = registry;
    this.modifierRegistry = modifierRegistry;
    this.toggle = toggle;
    this.active = '';
    this.requested = '';
    this.restoreError = '';
  }
  backend(value) {
    if (!modifierMask(value)) return this.registry;
    if (!this.modifierRegistry) throw new Error('Физические модификаторы сейчас недоступны.');
    return this.modifierRegistry;
  }
  restore(value = DEFAULT_SHORTCUT) {
    this.requested = value;
    this.restoreError = '';
    if (!valid(value)) return false;
    const normalized = normalizeShortcut(value);
    const failed = error => { this.restoreError = error.message; return false; };
    try {
      const result = this.backend(value).register(normalized, this.toggle);
      if (result && typeof result.then === 'function') {
        return result.then(ok => { if (ok) this.active = normalized; return ok; }, failed);
      }
      if (result) this.active = normalized;
      return result;
    } catch (error) { return failed(error); }
  }
  async change(value, persist) {
    if (value !== '' && !valid(value)) throw new Error('Выберите клавишу с ⌘, ⌥ или ⌃ либо хотя бы два физических модификатора.');
    value = normalizeShortcut(value);
    const replacement = value && (value !== this.active ||
      this.backend(value).isRegistered?.(value) === false);
    if (replacement && !await this.backend(value).register(value, this.toggle))
      throw new Error('Это сочетание занято. Попробуйте другое.');
    try {
      await persist(value);
    } catch (e) {
      if (replacement) this.backend(value).unregister(value);
      throw e;
    }
    if (this.active && value !== this.active) this.backend(this.active).unregister(this.active);
    this.active = this.requested = value;
  }
  destroy() {
    if (this.active) this.backend(this.active).unregister(this.active);
    this.modifierRegistry?.destroy();
    this.active = '';
  }
}
module.exports = { RecordShortcut, DEFAULT_SHORTCUT, MODIFIER_MASKS, modifierMask,
  normalizeShortcut, ModifierChord, createMacModifierRegistry };
