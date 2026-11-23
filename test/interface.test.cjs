const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const renderer = fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');

async function studio(mode, { systemAllowed = true, automatic = false, start = true, overrides = {} } = {}) {
  const elements = new Map();
  const calls = [];
  const streams = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', dataset: {}, focus() {}, getContext: () => ({clearRect(){},fillRect(){}}), showModal(){this.open=true;}, close(){this.open=false;this.onclose?.();}, classList: { toggle() {} }, replaceChildren() {}, append() {}, querySelectorAll: () => [] });
    return elements.get(id);
  }
  function source(kind) {
    const track = { kind, readyState:'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
    const tracks = [track];
    if (kind === 'desktop') tracks.push({ stop() { this.ended = true; } });
    const s = { getAudioTracks: () => [track], getVideoTracks: () => tracks.slice(1), getTracks: () => tracks };
    streams.push(s);
    return s;
  }
  const node = () => ({ connect(next) { return next; } });
  class Context {
    audioWorklet = { addModule: async file => assert.equal(file,'worklet.js') };
    currentTime = 1;
    destination = node();
    createGain() { return { ...node(), gain: {value:0} }; }
    createMediaStreamSource(s) { calls.push(s.tracks[0].kind); return node(); }
    createAnalyser() { return { getFloatTimeDomainData() {} }; }
    async resume() {}
    async close() {}
  }
  // The worklet itself and PCM persistence are exercised separately with real buffers.
  class Worklet {
    connect() {}
    port = { postMessage: msg => {
      assert.equal(msg, 'stop');
      this.port.onmessage({data:new Uint8Array([1,0,2,0]).buffer});
      this.port.onmessage({data:'stopped'});
    } };
  }
  const listeners = {};
  const api = {
    info: async () => ({ folder:'/test', pending:[], automatic, callDetection: true, callOffer: null, shortcut: 'Control+Alt+R', shortcutWanted: 'Control+Alt+R' }), onProgress() {}, onSettings() {}, onUpdate() {}, onShortcutError(){}, shortcutCapture: async () => {},
    onCallOffer: fn => { listeners.offer = fn; }, onCallDetectionError: fn => { listeners.error = fn; },
    acceptCall: async id => { calls.push('accept-' + id); return true; },
    dismissCall: async id => { calls.push('dismiss-' + id); }, setCallDetection: async () => {},
    start: async value => { calls.push('start-' + value); return 'id'; },
    samples: async (_,bytes) => { assert.equal(bytes.byteLength,4); calls.push('write'); },
    stop: async () => calls.push('stop'), nextPart: async () => { calls.push('prepare'); return { name:'part-000001.wav', index:1, total:1 }; },
    transcribe: async () => { calls.push('transcribe'); return { file:'auto.txt' }; },
    savePart: async (_id, _name, value) => { assert.equal(value, 'Мой текст'); calls.push('save'); return { file:'file.txt' }; }
  };
  Object.assign(api, overrides);
  const devices = {
    async getDisplayMedia() {
      calls.push('display');
      if (!systemAllowed) throw Object.assign(new Error(), {name:'NotAllowedError'});
      return source('desktop');
    },
    async getUserMedia() { calls.push('input'); return source('microphone'); }
  };
  const callRadio = { set checked(value) { if (value) mode = 'call'; } };
  const document = { getElementById: element, querySelector: selector => selector.includes('value=call') ? callRadio : ({value:mode}), createElement: () => element(Symbol()) };
  vm.runInNewContext(renderer,{ document, window:{sonat:api}, navigator:{mediaDevices:devices}, AudioContext:Context,
    MediaStream:class { constructor(tracks) { this.tracks = tracks; } }, AudioWorkletNode:Worklet,
    setTimeout, clearTimeout, setInterval, clearInterval, Uint8Array });
  await new Promise(resolve => setImmediate(resolve));
  if (start) await element('record').onclick();
  return { calls, streams, element, listeners };
}

test('call button requests two inputs and saves tail before preparing a private ChatGPT handoff', async () => {
  const s = await studio('call');
  assert.equal(s.element('record').textContent,'Остановить запись');
  assert.equal(s.streams[0].getVideoTracks()[0].ended,true);
  await s.element('record').onclick();
  assert.deepEqual(s.calls,['display','input','desktop','microphone','start-call','write','stop','prepare']);
  assert.ok(s.streams.every(stream => stream.getAudioTracks()[0].readyState === 'ended'));
  s.element('answer').value = 'Мой текст';
  await s.element('accept').onclick();
  assert.deepEqual(s.calls.slice(-1),['save']);
  assert.match(s.element('status').textContent,/file.txt/);
});

test('dictaphone works without API credits or desktop permission', async () => {
  const s = await studio('mic',{systemAllowed:false});
  await s.element('record').onclick();
  assert.deepEqual(s.calls,['input','microphone','start-mic','write','stop','prepare']);
  assert.match(s.element('status').textContent,/Аудио сохранено/);
});

test('denied system capture leaves the call stopped and explains permission', async () => {
  const s = await studio('call',{systemAllowed:false});
  assert.deepEqual(s.calls,['display']);
  assert.equal(s.element('record').textContent,'Начать запись');
  assert.match(s.element('status').textContent,/Доступ отклонён/);
});

test('opted-in dictaphone submits only after stop and shows finished TXT', async () => {
  const s = await studio('mic', {automatic:true});
  await s.element('record').onclick();
  assert.deepEqual(s.calls, ['input','microphone','start-mic','write','stop','transcribe']);
  assert.match(s.element('status').textContent, /auto.txt/);
});

test('saved legacy key, live progress, success and failed replacement are distinguishable', async () => {
  let apiCheck = null, finish;
  const s = await studio('mic', { start: false, overrides: {
    info: async () => ({ automatic: true, pending: [], apiCheck }),
    apiKey: async value => {
      if (value) throw new Error('Проверьте ключ API.');
      await new Promise(resolve => { finish = () => { apiCheck = {ok:true, time:Date.now()}; resolve(); }; });
    }
  }});
  const el = s.element;
  assert.match(el('apiState').textContent, /ещё не проверено/);
  const pending = el('enableApi').onclick();
  assert.match(el('apiState').textContent, /Проверяем/);
  assert.ok(el('enableApi').disabled);
  finish();
  await pending;
  assert.match(el('apiState').textContent, /✓ API подключён/);
  el('apiKey').value = 'invalid';
  await el('enableApi').onclick();
  assert.match(el('apiState').textContent, /Новый ключ не сохранён.*Проверьте ключ/);
});

test('direct capture commits right Option + right Shift once, after release, in either order', async () => {
  const values = [];
  const s = await studio('mic', { start: false, overrides: {
    info: async () => ({ pending: [], shortcut: values.at(-1), shortcutWanted: values.at(-1) }),
    setShortcut: async value => values.push(value)
  }});
  const el = s.element;
  const panel = el('settingsPanel');
  const event = code => ({code, preventDefault(){}});
  for (const pair of [['ShiftRight','AltRight'], ['AltRight','ShiftRight']]) {
    const count = values.length;
    await el('editShortcut').onclick();
    pair.forEach(k => panel.onkeydown(event(k)));
    panel.onkeydown({...event(pair[1]), repeat:true});
    panel.onkeyup(event(pair[0]));
    assert.equal(values.length, count);
    await panel.onkeyup(event(pair[1]));
    assert.equal(values.length, count + 1);
    assert.equal(values.at(-1), 'AltRight+ShiftRight');
  }
  await el('editShortcut').onclick();
  panel.onkeydown(event('ShiftLeft'));
  panel.onkeydown({...event('Escape'),key:'Escape'});
  await panel.onkeyup(event('ShiftLeft'));
  assert.equal(values.length, 2);
  await el('editShortcut').onclick();
  panel.onkeydown(event('AltLeft'));
  panel.onkeydown({...event('KeyK'), key:'л', altKey:true});
  panel.onkeyup(event('KeyK'));
  await panel.onkeyup(event('AltLeft'));
  assert.equal(values.at(-1), 'Alt+K');
});


test('call offers stay manual, skip once, then start call even when dictaphone was selected', async () => {
  const s = await studio('mic', { start:false });
  s.listeners.offer({id:'first', label:'Google Meet'});
  assert.equal(s.element('callOffer').hidden, false);
  assert.equal(s.element('callOfferLabel').textContent, 'Google Meet');
  assert.equal(s.element('callRecord').dataset.offerId, 'first');
  assert.deepEqual(s.calls, []);
  await s.element('callSkip').onclick();
  assert.equal(s.element('callOffer').hidden, true);
  await s.element('callSkip').onclick();
  assert.deepEqual(s.calls, ['dismiss-first']);
  s.listeners.offer({id:'second', label:'Zoom'});
  const pending = s.element('callRecord').onclick();
  // No IPC await may separate the real click from getDisplayMedia.
  assert.deepEqual(s.calls, ['dismiss-first', 'accept-second', 'display']);
  await pending;
  assert.ok(s.calls.includes('start-call'));
  assert.equal(s.calls.includes('start-mic'), false);
  assert.equal(s.element('sourceHint').textContent, 'Микрофон + компьютер');
  await s.element('record').onclick();
});

test('stale acknowledgement releases capture without starting or stopping any recording', async () => {
  const s = await studio('mic', { start:false, overrides: { acceptCall: async () => false } });
  s.listeners.offer({id:'old', label:'Zoom'});
  await s.element('callRecord').onclick();
  assert.deepEqual(s.calls, ['display']);
  assert.ok(s.streams.every(stream => stream.getAudioTracks()[0].readyState === 'ended'));
  assert.match(s.element('status').textContent, /неактуально/);
});

test('offer clicks while starting or recording never toggle recording off', async () => {
  let accept;
  const s = await studio('mic', { start:false, overrides: { acceptCall: () => new Promise(resolve => { accept = resolve; }) } });
  s.listeners.offer({id:'one', label:'Zoom'});
  const pending = s.element('callRecord').onclick();
  await s.element('callRecord').onclick();
  await s.element('record').onclick();
  assert.deepEqual(s.calls, ['display']);
  accept(true);
  await pending;
  s.listeners.offer({id:'two', label:'Meet'});
  await s.element('callRecord').onclick();
  assert.equal(s.calls.includes('stop'), false);
  assert.equal(s.calls.filter(c => c === 'start-call').length, 1);
  await s.element('record').onclick();
});

test('settings and unfinished review preserve work when an offer is clicked', async () => {
  const s = await studio('mic', {start:false});
  s.listeners.offer({id:'one', label:'Zoom'});
  s.element('settingsButton').onclick();
  await s.element('callRecord').onclick();
  assert.deepEqual(s.calls, []);
  s.element('closeSettings').onclick();
  await s.element('record').onclick();
  await s.element('record').onclick();
  s.element('answer').value = 'Черновик';
  await s.element('callRecord').onclick();
  assert.equal(s.element('answer').value, 'Черновик');
  assert.equal(s.element('review').hidden, false);
  assert.equal(s.calls.includes('start-call'), false);
  assert.match(s.element('callOfferHint').textContent, /Сначала сохраните/);
});

test('call offer preference is on by default, saved explicitly, and reports detection errors', async () => {
  let enabled = true;
  const s = await studio('mic', {start:false, overrides: {
    info: async () => ({ folder:'/test', pending:[], callDetection:enabled, callOffer:{id:'one',label:'Zoom'} }),
    setCallDetection: async value => { enabled = value; }
  }});
  assert.equal(s.element('callDetection').checked, true);
  s.listeners.error('Не удалось проверить звонок.');
  assert.equal(s.element('callDetectionStatus').textContent, 'Не удалось проверить звонок.');
  s.element('callDetection').checked = false;
  await s.element('callDetection').onchange();
  assert.equal(enabled, false);
  assert.equal(s.element('callOffer').hidden, true);
  await s.element('callRecord').onclick();
  assert.deepEqual(s.calls, []);
});


test('choosing the first folder keeps the offer and requires a second real click for capture', async () => {
  let folder = '';
  const s = await studio('mic', {start:false, overrides: {
    info: async () => ({ folder, pending:[], callDetection:true, callOffer:{id:'one',label:'Zoom'} }),
    folder: async () => { folder = '/test'; }
  }});
  await s.element('callRecord').onclick();
  assert.deepEqual(s.calls, []);
  assert.equal(s.element('callOffer').hidden, false);
  await s.element('callRecord').onclick();
  assert.ok(s.calls.includes('start-call'));
  await s.element('record').onclick();
});

test('failed offer acknowledgement cleans up capture; failed preference restores the checkbox', async () => {
  const s = await studio('mic', {start:false, overrides: {
    acceptCall: async () => { throw new Error('Предложение недоступно.'); },
    setCallDetection: async () => { throw new Error('Не удалось сохранить настройку.'); }
  }});
  s.listeners.offer({id:'one',label:'Zoom'});
  await s.element('callRecord').onclick();
  assert.deepEqual(s.calls, ['display']);
  assert.ok(s.streams.every(stream => stream.getAudioTracks()[0].readyState === 'ended'));
  assert.match(s.element('status').textContent, /Предложение недоступно/);
  s.element('callDetection').checked = false;
  await s.element('callDetection').onchange();
  assert.equal(s.element('callDetection').checked, true);
  assert.equal(s.element('callDetection').disabled, false);
  assert.match(s.element('callDetectionStatus').textContent, /Не удалось сохранить/);
});
