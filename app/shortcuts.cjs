const DEFAULT_SHORTCUT = 'Control+Alt+R';
const validShortcut = /^(Control\+)?(Alt\+)?(Shift\+)?(Command\+)?(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|20))$/;

function valid(value) {
  return typeof value === 'string' && value.includes('+') &&
    /(?:Control|Alt|Command)\+/.test(value) && validShortcut.test(value);
}

// Keep the old binding live until its replacement is registered and persisted.
class RecordShortcut {
  constructor(registry, toggle) {
    this.registry = registry;
    this.toggle = toggle;
    this.active = '';
    this.requested = '';
  }
  restore(value = DEFAULT_SHORTCUT) {
    this.requested = value;
    if (valid(value) && this.registry.register(value, this.toggle)) this.active = value;
  }
  async change(value, persist) {
    if (value !== '' && !valid(value)) throw new Error('Выберите клавишу вместе с ⌘, ⌥ или ⌃.');
    if (value && value !== this.active && !this.registry.register(value, this.toggle))
      throw new Error('Это сочетание занято. Попробуйте другое.');
    try {
      await persist(value);
    } catch (e) {
      if (value && value !== this.active) this.registry.unregister(value);
      throw e;
    }
    if (this.active && value !== this.active) this.registry.unregister(this.active);
    this.active = this.requested = value;
  }
}
module.exports = { RecordShortcut, DEFAULT_SHORTCUT };
