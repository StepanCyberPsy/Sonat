'use strict';
const $ = id => document.getElementById(id);
const api = window.sonat;
let prefs = { folder: '', pending: [] };
let phase = 'idle';
let live = null;
let reviewing = null;

function status(text) { $('status').textContent = text; }
function message(e) {
  return (e.message || String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
function controls(next) {
  phase = next;
  const idle = phase === 'idle';
  $('record').disabled = !(idle || phase === 'recording');
  $('record').textContent = phase === 'recording' ? 'Остановить запись' : 'Начать запись';
  $('record').classList.toggle('recording', phase === 'recording');
  for (const id of ['modes','folder','apiKey','enableApi','disableApi']) $(id).disabled = !idle;
  for (const b of $('list').querySelectorAll('button')) b.disabled = !idle;
}
async function refresh() {
  prefs = await api.info();
  $('path').textContent = prefs.folder || 'Папка ещё не выбрана';
  $('show').hidden = !prefs.folder;
  $('disableApi').hidden = !prefs.automatic;
  $('apiState').textContent = prefs.automatic ? 'Включена. Текст сохранится автоматически.' : 'Выключена. Доступна ручная расшифровка в чате.';
  $('list').replaceChildren();
  for (const id of prefs.pending) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = 'Расшифровать';
    button.onclick = () => guarded(() => review(id));
    li.append(id.replace(/^Sonat /, '').slice(0,-9), button);
    $('list').append(li);
  }
  $('queue').hidden = !prefs.pending.length;
  controls(phase);
}
async function guarded(fn) {
  try { await fn(); }
  catch (e) { status(message(e)); }
}
function mode() { return document.querySelector('input[name=mode]:checked').value; }
$('modes').onchange = () => { $('systemLabel').hidden = mode() === 'mic'; };
$('folder').onclick = () => guarded(async () => { await api.folder(); await refresh(); if (prefs.folder) status('Можно начинать запись.'); });
$('show').onclick = () => guarded(() => api.showFolder());
function present(id, part) {
  if (part.file) {
    reviewing = null;
    $('review').hidden = true;
    controls('idle');
    status('Текст сохранён в выбранной папке · ' + part.file);
    return;
  }
  reviewing = { id, name: part.name };
  $('review').hidden = false;
  $('partTitle').textContent = 'Расшифровка · часть ' + part.index + ' из ' + part.total;
  $('partInfo').textContent = id + ' · ' + part.name;
  controls('review');
  status('Аудио сохранено. Откройте ChatGPT для расшифровки.');
}
async function review(id) {
  if (prefs.automatic) {
    controls('transcribing');
    status('Подготовка записи к отправке в OpenAI…');
    try { present(id, await api.transcribe(id)); }
    finally { controls('idle'); await refresh(); }
    return;
  }
  const part = await api.nextPart(id);
  $('answer').value = '';
  present(id, part);
}
async function setKey(value) {
  controls('settings');
  try {
    await api.apiKey(value);
    $('apiKey').value = '';
    await refresh();
    status(value === null ? 'Выбран ручной режим.' : 'Авторасшифровка включена.');
  } finally { controls('idle'); }
}
$('enableApi').onclick = () => guarded(() => setKey($('apiKey').value));
$('disableApi').onclick = () => guarded(() => setKey(null));
api.onProgress((i, n) => status('Расшифровка в OpenAI · часть ' + i + ' из ' + n));
$('reveal').onclick = () => guarded(() => api.revealPart(reviewing.id));
$('chat').onclick = () => guarded(() => api.openChat());
$('prompt').onclick = () => guarded(async () => {
  await api.copyPrompt();
  status('Запрос скопирован. Вставьте его в ChatGPT вместе с WAV.');
});
$('accept').onclick = () => guarded(async () => {
  if (!reviewing || $('accept').disabled) return;
  const { id, name } = reviewing;
  $('accept').disabled = $('later').disabled = true;
  try {
    const next = await api.savePart(id, name, $('answer').value);
    $('answer').value = '';
    present(id, next);
    await refresh();
  } finally { $('accept').disabled = $('later').disabled = false; }
});
$('later').onclick = () => {
  if ($('answer').value.trim() && !window.confirm('Оставить эту часть без сохранения введённого текста?')) return;
  reviewing = null;
  $('review').hidden = true;
  controls('idle');
  status('Запись доступна в списке ожидающих расшифровки.');
};
function release(s) {
  clearInterval(s.timer);
  for (const stream of s.streams) for (const track of stream.getTracks()) track.stop();
  if (s.ctx) return s.ctx.close();
}
function monitor(s, stream, meter, gain) {
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') throw new Error('Нет звука. Проверьте разрешения на микрофон и системный звук.');
  track.addEventListener('ended', () => interrupt(s, 'Источник звука отключился.'), { once: true });
  const source = s.ctx.createMediaStreamSource(new MediaStream([track]));
  const volume = s.ctx.createGain();
  volume.gain.value = gain;
  source.connect(volume).connect(s.node);
  const analyser = s.ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  s.meters.push({ analyser, meter, data: new Float32Array(analyser.fftSize) });
}
function tick(s) {
  const seconds = Math.floor(s.ctx.currentTime - s.started);
  const two = n => String(n).padStart(2, '0');
  $('time').value = (seconds >= 3600 ? Math.floor(seconds/3600) + ':' : '') + two(Math.floor(seconds/60)%60) + ':' + two(seconds%60);
  for (const { analyser, meter, data } of s.meters) {
    analyser.getFloatTimeDomainData(data);
    meter.value = Math.min(1, Math.max(...data.map(Math.abs)) * 2);
  }
}
function interrupt(s, why) {
  if (!s.fault) s.fault = why;
  if (live === s && phase === 'recording') guarded(() => stop(s));
}
async function start() {
  if (!prefs.folder) {
    await api.folder(); await refresh();
    if (!prefs.folder) return;
    // A second click supplies a fresh user gesture for the system capture prompt.
    status('Папка выбрана. Нажмите «Начать запись».');
    return;
  }
  const s = { streams: [], meters: [], writes: Promise.resolve(), backlog: 0 };
  live = s;
  controls('starting');
  status('Подключаю звук…');
  const call = mode() === 'call';
  try {
    if (call) {
      const system = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 }, systemAudio: 'include' });
      s.streams.push(system);
      if (system.getAudioTracks()[0]?.readyState !== 'live') throw new Error('Включите для Sonat запись системного звука в настройках macOS.');
      for (const t of system.getVideoTracks()) t.stop();
    }
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: call, noiseSuppression: true } });
    s.streams.push(mic);
    s.ctx = new AudioContext({ sampleRate: 16000 });
    await s.ctx.audioWorklet.addModule('worklet.js');
    s.node = new AudioWorkletNode(s.ctx, 'pcm-recorder', { channelCount: 1, channelCountMode: 'explicit' });
    // The processor has a silent output. Keeping it connected drives the clock without monitoring to speakers.
    s.node.connect(s.ctx.destination);
    if (call) monitor(s, s.streams[0], $('system'), 0.5);
    monitor(s, mic, $('mic'), call ? 0.5 : 1);
    s.id = await api.start(call ? 'call' : 'mic');
    s.stopped = new Promise(resolve => { s.flushed = resolve; });
    s.node.port.onmessage = ({ data }) => {
      if (data === 'stopped') return s.flushed();
      if (s.diskFailed) return;
      s.backlog++;
      s.writes = s.writes.then(async () => {
        if (!s.diskFailed) await api.samples(s.id, new Uint8Array(data));
      }).catch(e => {
        s.diskFailed = true;
        interrupt(s, message(e));
      }).finally(() => { s.backlog--; });
      if (s.backlog > 24) interrupt(s, 'Диск не успевает сохранять звук.');
    };
    await s.ctx.resume();
    if (s.fault || s.streams.some(stream => stream.getAudioTracks()[0]?.readyState !== 'live'))
      throw new Error(s.fault || 'Источник звука отключился.');
    s.started = s.ctx.currentTime;
    tick(s);
    s.timer = setInterval(() => tick(s), 150);
    s.node.onprocessorerror = () => { s.flushed(); interrupt(s, 'Обработка звука прервана.'); };
    controls('recording');
    status(call ? 'Записываются микрофон и звук компьютера.' : 'Записывается микрофон.');
  } catch (e) {
    await release(s);
    if (s.id) { await s.writes; await api.stop(s.id); }
    live = null;
    controls('idle');
    if (e.name === 'NotAllowedError') throw new Error('Доступ отклонён. Разрешите Sonat микрофон и, для звонка, запись экрана и системного звука в настройках конфиденциальности macOS.');
    throw e;
  }
}
async function stop(s) {
  controls('stopping');
  status('Сохраняю аудио…');
  try {
    s.node.port.postMessage('stop');
    let timeout;
    try {
      await Promise.race([s.stopped, new Promise(resolve => {
        timeout = setTimeout(() => { s.fault ||= 'Аудиоустройство перестало отвечать.'; resolve(); }, 3000);
      })]);
    } finally { clearTimeout(timeout); }
    await release(s);
    await s.writes;
    await api.stop(s.id);
  } finally {
    live = null;
    $('mic').value = $('system').value = 0;
    controls('idle');
    await refresh();
  }
  if (s.fault) { status(s.fault + ' Доступная часть записи сохранена.'); return; }
  await review(s.id);
}
$('record').onclick = () => guarded(() => phase === 'recording' ? stop(live) : start());
guarded(async () => { await refresh(); if (prefs.folder) status('Можно начинать запись.'); });
