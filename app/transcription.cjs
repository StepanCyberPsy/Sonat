const fs = require('node:fs/promises');
const path = require('node:path');
const { nextPart, savePart, sessionDir } = require('./recordings.cjs');

async function requestTranscript(wav, name, key, request, timeout) {
  const body = new FormData();
  body.set('model', 'gpt-transcribe');
  body.set('file', new Blob([wav], { type: 'audio/wav' }), name);
  let response;
  try {
    response = await request('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body,
      signal: AbortSignal.timeout(timeout), redirect: 'error'
    });
  } catch { throw new Error('OpenAI не ответил. Проверьте интернет и повторите попытку.'); }
  if (!response.ok) {
    const reasons = { 401: 'Проверьте ключ API.', 403: 'Проверьте права ключа и доступ к модели.', 404: 'Проверьте доступ проекта к модели расшифровки.', 429: 'Проверьте баланс и лимиты API.' };
    throw new Error('OpenAI вернул ошибку ' + response.status + '. ' + (reasons[response.status] || 'Повторите позднее.'));
  }
  const result = await response.json().catch(() => null);
  if (typeof result?.text !== 'string') throw new Error('OpenAI вернул ответ без текста расшифровки.');
  return result.text.trim();
}

// Use the same upload path and model as a recording, with bundled synthetic speech.
async function checkConnection(key, request = fetch) {
  const sample = await fs.readFile(path.join(__dirname, 'connection-test.wav'));
  const text = await requestTranscript(sample, 'connection-test.wav', key, request, 30000);
  if (!text) throw new Error('OpenAI вернул пустую расшифровку тестовой фразы. Повторите проверку.');
}

async function transcribe(folder, id, key, progress, request = fetch) {
  let part = await nextPart(folder, id);
  while (!part.file) {
    progress(part.index, part.total);
    const wav = await fs.readFile(path.join(sessionDir(folder, id), part.name));
    const text = await requestTranscript(wav, part.name, key, request, 180000);
    part = await savePart(folder, id, part.name, text || '[Речь не распознана]');
  }
  return part;
}

module.exports = { transcribe, checkConnection };
