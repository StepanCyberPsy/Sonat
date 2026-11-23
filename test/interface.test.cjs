const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const renderer = fs.readFileSync(path.join(__dirname,'../app/renderer.js'),'utf8');

async function studio(mode, { systemAllowed = true, automatic = false } = {}) {
  const elements = new Map();
  const calls = [];
  const streams = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', getContext: () => ({clearRect(){},fillRect(){}}), showModal(){this.open=true;}, close(){this.open=false;this.onclose?.();}, classList: { toggle() {} }, replaceChildren() {}, append() {}, querySelectorAll: () => [] });
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
  const api = {
    info: async () => ({ folder:'/test', pending:[], automatic, shortcut: 'Control+Alt+R', shortcutWanted: 'Control+Alt+R' }), onProgress() {}, onSettings() {},
    start: async value => { calls.push('start-' + value); return 'id'; },
    samples: async (_,bytes) => { assert.equal(bytes.byteLength,4); calls.push('write'); },
    stop: async () => calls.push('stop'), nextPart: async () => { calls.push('prepare'); return { name:'part-000001.wav', index:1, total:1 }; },
    transcribe: async () => { calls.push('transcribe'); return { file:'auto.txt' }; },
    savePart: async (_id, _name, value) => { assert.equal(value, 'Мой текст'); calls.push('save'); return { file:'file.txt' }; }
  };
  const devices = {
    async getDisplayMedia() {
      calls.push('display');
      if (!systemAllowed) throw Object.assign(new Error(), {name:'NotAllowedError'});
      return source('desktop');
    },
    async getUserMedia() { calls.push('input'); return source('microphone'); }
  };
  const document = { getElementById: element, querySelector: () => ({value:mode}), createElement: () => element(Symbol()) };
  vm.runInNewContext(renderer,{ document, window:{sonat:api}, navigator:{mediaDevices:devices}, AudioContext:Context,
    MediaStream:class { constructor(tracks) { this.tracks = tracks; } }, AudioWorkletNode:Worklet,
    setTimeout, clearTimeout, setInterval, clearInterval, Uint8Array });
  await new Promise(resolve => setImmediate(resolve));
  await element('record').onclick();
  return { calls, streams, element };
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
