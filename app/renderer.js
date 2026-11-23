'use strict';
const $ = id => document.getElementById(id);
const api = window.sonat;
let prefs = { folder: '', pending: [] };
let phase = 'idle';
let live = null;
let reviewing = null;
let callOffer = null;

function status(text) {
  $('status').textContent = text;
  if ($('settingsPanel').open) $('settingsStatus').textContent = text;
}
const phaseLabels = {
  idle: 'Готов к записи', starting: 'Подключение', recording: 'Идёт запись',
  stopping: 'Сохранение', transcribing: 'Расшифровка', review: 'Запись сохранена',
  settings: 'Настройки', choosing: 'Выбор папки'
};
function message(e) {
  return (e.message || String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
function controls(next) {
  phase = next;
  const idle = phase === 'idle';
  $('stage').textContent = phaseLabels[next] || '';
  $('console').classList.toggle('on', phase === 'recording');
  $('record').disabled = !(idle || phase === 'recording' || phase === 'review');
  $('record').textContent = phase === 'recording' ? 'Остановить запись' : 'Начать запись';
  $('record').classList.toggle('recording', phase === 'recording');
  for (const id of ['modes','folder','apiKey','enableApi','disableApi','editShortcut','clearShortcut','updateApp']) $(id).disabled = !idle;
  for (const b of $('list').querySelectorAll('button')) b.disabled = !idle;
  showCallOffer();
}
async function refresh() {
  prefs = await api.info();
  $('path').textContent = prefs.folder || 'Папка ещё не выбрана';
  $('show').hidden = !prefs.folder;
  $('storageHint').textContent = prefs.folder ? 'Тексты — в этой папке. WAV — в подпапке «Аудио Sonat».' : 'Выберите место на Mac для текстов и аудио.';
  shortcutLabels();
  $('disableApi').hidden = !prefs.automatic;
  $('apiKey').placeholder = prefs.automatic ? 'Сохранённый ключ · введите новый для замены' : 'Ключ проекта';
  $('appVersion').textContent = 'Sonat ' + (prefs.version || '');
  showApiState();
  $('callDetection').checked = prefs.callDetection !== false;
  $('callDetectionStatus').textContent = prefs.callDetectionError || '';
  callOffer = prefs.callOffer || null;
  showCallOffer();
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
$('modes').onchange = () => {
  const mic = mode() === 'mic';
  $('systemLabel').hidden = mic;
  $('sourceHint').textContent = mic ? 'Только микрофон' : 'Микрофон + компьютер';
};
function showCallOffer() {
  $('callOffer').hidden = !callOffer || prefs.callDetection === false;
  $('callOfferLabel').textContent = callOffer?.label || '';
  $('callRecord').dataset.offerId = callOffer?.id || '';
  $('callRecord').disabled = !callOffer || phase !== 'idle' || $('settingsPanel').open;
  $('callSkip').disabled = !callOffer;
  $('callOfferHint').textContent = phase === 'review' ? 'Сначала сохраните текст или нажмите «Продолжить позже».'
    : phase !== 'idle' ? 'Предложение доступно после завершения текущего действия.'
    : $('settingsPanel').open ? 'Закройте настройки, чтобы начать запись.' : '';
}
api.onCallOffer(offer => { callOffer = offer; showCallOffer(); });
api.onCallDetectionError(text => {
  prefs.callDetectionError = text;
  $('callDetectionStatus').textContent = text || '';
});
$('callSkip').onclick = () => guarded(async () => {
  const id = callOffer?.id;
  if (!id) return;
  callOffer = null;
  showCallOffer();
  await api.dismissCall(id);
});
$('callRecord').onclick = () => guarded(() => {
  if (!callOffer || prefs.callDetection === false || phase !== 'idle' || $('settingsPanel').open) return;
  const offerId = callOffer.id;
  document.querySelector('input[name=mode][value=call]').checked = true;
  $('modes').onchange();
  return start({ offerId });
});
$('callDetection').onchange = () => guarded(async () => {
  $('callDetection').disabled = true;
  try { await api.setCallDetection($('callDetection').checked); await refresh(); }
  catch (e) {
    $('callDetection').checked = prefs.callDetection !== false;
    $('callDetectionStatus').textContent = message(e);
  }
  finally { $('callDetection').disabled = false; }
});
let listening = false;
const sides = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];
const symbols = { Command: '⌘', Alt: '⌥', Control: '⌃', Shift: '⇧', Space: 'Пробел' };
function pretty(value) {
  return value.split('+').map(key => {
    const side = /^(Command|Alt|Control|Shift)(Left|Right)$/.exec(key);
    return side ? (side[2] === 'Right' ? 'правый ' : 'левый ') + symbols[side[1]] : (symbols[key] || key);
  }).join(' + ');
}
const heldKeys = new Set();
let captured = '', invalidChord = false;
function resetChord() {
  heldKeys.clear();
  captured = '';
  invalidChord = false;
}
function endCapture() {
  if (!listening) return;
  listening = false;
  resetChord();
  api.shortcutCapture(false).catch(() => {});
  shortcutLabels();
}
function shortcutLabels(feedback = '') {
  const key = prefs.shortcut ? pretty(prefs.shortcut) : '';
  $('keyHint').textContent = key;
  $('editShortcut').textContent = key ? 'Изменить ' + key : 'Назначить сочетание';
  $('editShortcut').hidden = listening;
  $('shortcutEditor').hidden = !listening;
  $('clearShortcut').hidden = listening || !prefs.shortcutWanted;
  $('shortcutHelp').textContent = feedback || (listening ? 'Зажмите нужные клавиши вместе и отпустите. Можно нажать только правые Option и Shift. Esc — отмена.'
    : key ? 'Действует также из Zoom и браузера.' : prefs.shortcutWanted ? 'Сочетание ' + pretty(prefs.shortcutWanted) + ' недоступно. Выберите другое.' : 'Горячая клавиша выключена.');
}
function openSettings() {
  if ($('settingsPanel').open) return;
  $('settingsStatus').textContent = '';
  $('settingsPanel').showModal();
  showCallOffer();
}
$('settingsButton').onclick = openSettings;
api.onSettings(openSettings);
api.onShortcutError(async text => { await refresh(); shortcutLabels(text); status(text); });
$('closeSettings').onclick = () => $('settingsPanel').close();
$('settingsPanel').onclose = () => {
  endCapture();
  $('apiKey').value = '';
  shortcutLabels();
  showCallOffer();
};
$('editShortcut').onclick = async () => {
  resetChord();
  listening = true;
  shortcutLabels();
  $('capturedKeys').textContent = 'Нажмите клавиши…';
  $('capturedKeys').focus();
  try { await api.shortcutCapture(true); }
  catch (e) { endCapture(); shortcutLabels(message(e)); }
};
$('cancelShortcut').onclick = () => { endCapture(); $('editShortcut').focus(); };
window.onblur = endCapture;
async function saveShortcut(value) {
  endCapture();
  controls('settings');
  let feedback;
  try {
    await api.setShortcut(value);
    await refresh();
    feedback = value ? '✓ Сочетание сохранено: ' + pretty(value) : 'Горячая клавиша выключена.';
  } catch (e) { feedback = message(e); }
  finally { controls('idle'); shortcutLabels(feedback); }
}
$('clearShortcut').onclick = () => saveShortcut('');
$('settingsPanel').onkeydown = event => {
  if (!listening) return;
  if (event.key === 'Tab') { endCapture(); return; }
  event.preventDefault();
  if (event.key === 'Escape') { $('cancelShortcut').onclick(); return; }
  if (event.repeat || heldKeys.has(event.code)) return;
  heldKeys.add(event.code);
  const mods = sides.filter(code => heldKeys.has(code));
  const ordinary = [...heldKeys].filter(code => !sides.includes(code));
  const key = ordinary[0]?.replace(/^(Key|Digit)/, '');
  if (ordinary.length) {
    const generic = [];
    if (event.ctrlKey) generic.push('Control');
    if (event.altKey) generic.push('Alt');
    if (event.shiftKey) generic.push('Shift');
    if (event.metaKey) generic.push('Command');
    // Electron registers regular key chords independently of keyboard layout.
    const valid = ordinary.length === 1 && /^(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|20))$/.test(key)
      && generic.some(k => k !== 'Shift');
    if (valid) captured = [...generic, key].join('+');
    else invalidChord = true;
  } else {
    captured = mods.map(code => code.replace('Meta','Command')).join('+');
  }
  $('capturedKeys').textContent = invalidChord ? 'Сочетание недоступно' : pretty(captured);
};
$('settingsPanel').onkeyup = event => {
  if (!listening || !heldKeys.has(event.code)) return;
  event.preventDefault();
  heldKeys.delete(event.code);
  if (heldKeys.size) return;
  if (invalidChord || !captured.includes('+')) {
    resetChord();
    $('capturedKeys').textContent = 'Попробуйте ещё раз';
    shortcutLabels('Нажмите два модификатора вместе либо сочетание с буквой, цифрой, пробелом или F-клавишей.');
    return;
  }
  return saveShortcut(captured);
};
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
  controls('stopping');
  let part;
  try { part = await api.nextPart(id); }
  catch (e) { controls('idle'); throw e; }
  $('answer').value = '';
  present(id, part);
}
function apiState(text, kind = '') {
  $('apiState').textContent = text;
  $('apiState').className = kind;
}
function showApiState() {
  if (!prefs.automatic) return apiState('Авторасшифровка выключена.');
  const check = prefs.apiCheck;
  if (!check) return apiState('Ключ сохранён. Подключение ещё не проверено.');
  const when = new Date(check.time).toLocaleString('ru-RU');
  if (check.ok) apiState('✓ API подключён. Тестовая фраза расшифрована · ' + when, 'success');
  else apiState('Проверка не пройдена · ' + when + '. ' + check.message, 'error');
}
async function setKey(value) {
  controls('settings');
  $('settingsStatus').textContent = '';
  if (value !== null) apiState('Проверяем подключение к OpenAI…');
  try {
    await api.apiKey(value);
    $('apiKey').value = '';
    await refresh();
  } catch (e) {
    apiState((value === '' ? 'Ошибка проверки. ' : value === null ? 'Не удалось отключить ключ. ' : 'Новый ключ не сохранён. ') + message(e), 'error');
  } finally { controls('idle'); }
}
$('enableApi').onclick = () => setKey($('apiKey').value);
$('disableApi').onclick = () => setKey(null);
api.onUpdate(text => { $('updateStatus').textContent = text; });
$('updateApp').onclick = async () => {
  if (phase !== 'idle') return;
  controls('settings');
  $('updateStatus').textContent = 'Проверяем версию…';
  try { $('updateStatus').textContent = await api.updateApp(); }
  catch (e) { $('updateStatus').textContent = message(e); }
  finally { controls('idle'); }
};
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
const wave = $('wave');
const pen = wave.getContext('2d');
const levels = new Float32Array(96);
function drawWave() {
  pen.clearRect(0, 0, wave.width, wave.height);
  const middle = wave.height / 2;
  pen.fillStyle = '#486459';
  pen.fillRect(0, middle, wave.width, 1);
  pen.fillStyle = '#b4dbad';
  for (let i = 0; i < levels.length; i++) {
    const height = Math.round(levels[i] * (middle - 2));
    if (height) pen.fillRect(i * wave.width / levels.length, middle - height, 4, 2 * height);
  }
}
drawWave();
function tick(s) {
  const seconds = Math.floor(s.ctx.currentTime - s.started);
  const two = n => String(n).padStart(2, '0');
  $('time').value = (seconds >= 3600 ? Math.floor(seconds/3600) + ':' : '') + two(Math.floor(seconds/60)%60) + ':' + two(seconds%60);
  let peak = 0;
  for (const { analyser, meter, data } of s.meters) {
    analyser.getFloatTimeDomainData(data);
    meter.value = Math.min(1, Math.max(...data.map(Math.abs)) * 2);
    peak = Math.max(peak, meter.value);
  }
  levels.copyWithin(0, 1);
  levels[levels.length - 1] = peak;
  drawWave();
}
function interrupt(s, why) {
  if (!s.fault) s.fault = why;
  if (live === s && phase === 'recording') guarded(() => stop(s));
}
async function start({ offerId } = {}) {
  if (phase !== 'idle') return;
  if (!prefs.folder) {
    controls('choosing');
    try { await api.folder(); await refresh(); } finally { controls('idle'); }
    if (!prefs.folder) return;
    // A second click supplies a fresh user gesture for the system capture prompt.
    status('Папка выбрана. Нажмите «Начать запись».');
    return;
  }
  const s = { streams: [], meters: [], writes: Promise.resolve(), backlog: 0 };
  live = s;
  controls('starting');
  status('Подключаю звук…');
  const call = offerId ? true : mode() === 'call';
  try {
    // Begin capture in the click's user activation, without awaiting the IPC acknowledgement.
    // A failed/stale acknowledgement is checked before creating any recording on disk.
    const acceptance = offerId ? Promise.resolve(api.acceptCall(offerId)).then(
      accepted => ({ accepted }), error => ({ error })) : null;
    if (call) {
      const system = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 }, systemAudio: 'include' });
      s.streams.push(system);
      if (acceptance) {
        const result = await acceptance;
        if (result.error) throw result.error;
        if (!result.accepted) throw new Error('Звонок уже завершён или предложение больше неактуально.');
        if (callOffer?.id === offerId) { callOffer = null; showCallOffer(); }
      }
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
    levels.fill(0);
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
$('record').onclick = () => guarded(async () => {
  if (phase === 'recording') return stop(live);
  if (phase === 'review') {
    if ($('answer').value.trim()) { status('Сохраните введённый текст или нажмите «Продолжить позже».'); return; }
    reviewing = null;
    $('review').hidden = true;
    controls('idle');
  }
  if (phase === 'idle') await start();
});
guarded(async () => { await refresh(); if (prefs.folder) status('Можно начинать запись.'); });
