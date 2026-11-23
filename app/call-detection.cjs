const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

const CLIENTS = [
  [/\bzoom(?:\.us| workplace| meetings)?\b|^us\.zoom\./i, 'Zoom'],
  [/telemost|телемост/i, 'Яндекс Телемост'],
  [/mts[ ._-]*(?:link|линк)|мтс[ ._-]*линк|webinar\.ru|ru\.webinar/i, 'МТС Линк'],
  [/microsoft\.teams|microsoft teams/i, 'Microsoft Teams'],
  [/webex/i, 'Webex'], [/com\.apple\.facetime|^facetime$/i, 'FaceTime']
];
const BROWSER = /chrome|chromium|safari|firefox|brave|edg(?:e|emac)|vivaldi|opera|yandex[-.]browser|yandex browser|яндекс.{0,3}браузер|company\.thebrowser|duckduckgo/i;
const SERVICES = { zoom: 'Zoom', 'google-meet': 'Google Meet', telemost: 'Яндекс Телемост',
  'mts-link': 'МТС Линк', teams: 'Microsoft Teams', jitsi: 'Jitsi Meet' };
const IGNORE = /com\.stepancyberpsy\.sonat|^sonat\b|coreaudiod|voice.?memos|quicktime|audacity|garageband|logic pro|obsproject|screenflow|voicetrigger|dictation|com\.apple\.siri|zoom\.h[0-9]/i;
function sources(snapshot) {
  const signals = new Map();
  const keyOf = p => (p.appBundleId || p.bundleId || String(p.appPid || p.pid || '')).toLowerCase();
  for (const p of snapshot.processes || []) {
    const key = keyOf(p);
    const name = p.appName || '';
    if (!key || (!p.appName && !p.appBundleId && !p.bundleId) || IGNORE.test(key) || IGNORE.test(name)) continue;
    const client = CLIENTS.find(([re]) => re.test(key) || re.test(name));
    const browser = BROWSER.test(key) || BROWSER.test(name) || key.startsWith('com.apple.webkit.');
    let group = signals.get(key);
    if (!group) {
      group = { input: false, output: false, client, browser, label: client?.[1] || name || 'Приложение' };
      signals.set(key, group);
    }
    group.input ||= p.inputActive === true;
    group.output ||= p.outputActive === true;
  }
  const result = new Map();
  for (const [key, g] of signals) {
    // Browsers can keep their output device closed while the other party is silent.
    // Unknown apps need both input and output to avoid prompting for every recorder.
    if ((g.input && (g.output || g.browser || g.client)) || (g.client && g.output))
      result.set(key, g.label);
  }
  for (const p of snapshot.meetings || []) {
    const key = keyOf(p);
    if (key && p.service && !IGNORE.test(key)) result.set(key, SERVICES[p.service] || p.service);
  }
  return result;
}

class CallOffers {
  constructor(onChange, now = Date.now) {
    this.onChange = onChange;
    this.now = now;
    this.sessions = new Map();
    this.offer = null;
  }
  clear() {
    this.sessions.clear();
    this.hide();
  }
  hide() {
    if (!this.offer) return;
    this.offer = null;
    this.onChange(null);
  }
  consume(id) {
    if (!this.offer || id !== this.offer.id) return false;
    const session = this.sessions.get(this.offer.key);
    const current = session && this.now() - session.last < 10000;
    this.hide();
    return Boolean(current);
  }
  update(snapshot, recording) {
    const now = this.now();
    const active = sources(snapshot);
    for (const [key, session] of this.sessions) {
      if (now - session.last >= 20000) {
        this.sessions.delete(key);
        if (this.offer?.key === key) this.hide();
      } else if (!active.has(key) && !session.offered) {
        this.sessions.delete(key);
      }
    }
    for (const [key, label] of active) {
      const session = this.sessions.get(key) || { since: now, offered: false };
      session.last = now;
      session.label = label;
      if (recording) session.offered = true;
      this.sessions.set(key, session);
    }
    if (this.offer && (recording || !this.sessions.has(this.offer.key) ||
        now - this.sessions.get(this.offer.key).last >= 10000)) this.hide();
    if (recording || this.offer) return;
    for (const [key, session] of this.sessions) {
      if (!active.has(key) || session.offered || now - session.since < 3000) continue;
      session.offered = true;
      this.offer = { key, id: randomUUID(), label: session.label };
      this.onChange({ id: this.offer.id, label: this.offer.label });
      break;
    }
  }
}

function watchCalls(executable, onSnapshot, onError) {
  let child, retry, stopped = false;
  function launch() {
    if (stopped) return;
    child = spawn(executable, ['--watch'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (stopped || process !== child) return;
      try {
        const snapshot = JSON.parse(line);
        if (snapshot.schemaVersion !== 1 || !['ok','partial','error'].includes(snapshot.status))
          throw Error('unavailable');
        onSnapshot(snapshot);
      } catch { onError('macOS не предоставила сведения для обнаружения звонков.'); }
    });
    const lost = () => {
      if (stopped || process !== child) return;
      child = null;
      lines.close();
      onError('Служба обнаружения звонков недоступна. Sonat повторит попытку.');
      retry = setTimeout(launch, 30000);
      retry.unref();
    };
    process.once('error', lost);
    process.once('close', lost);
  }
  launch();
  return () => { stopped = true; clearTimeout(retry); child?.kill(); };
}
module.exports = { sources, CallOffers, watchCalls };
