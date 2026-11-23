const fs = require('node:fs/promises');
const path = require('node:path');
const { nextPart, savePart, sessionDir } = require('./recordings.cjs');

async function transcribe(folder, id, key, progress, request = fetch) {
  let part = await nextPart(folder, id);
  while (!part.file) {
    progress(part.index, part.total);
    const wav = await fs.readFile(path.join(sessionDir(folder, id), part.name));
    const body = new FormData();
    body.set('model', 'gpt-transcribe');
    body.set('file', new Blob([wav], { type: 'audio/wav' }), part.name);
    let response;
    try {
      response = await request('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key }, body,
        signal: AbortSignal.timeout(180000), redirect: 'error'
      });
    } catch { throw new Error('OpenAI не ответил. Проверьте интернет и повторите расшифровку.'); }
    if (!response.ok) {
      const reasons = { 401: 'Проверьте ключ API.', 403: 'Проверьте права ключа и доступ к модели.', 429: 'Проверьте баланс и лимиты API.' };
      throw new Error('OpenAI вернул ошибку ' + response.status + '. ' + (reasons[response.status] || 'Повторите позднее.'));
    }
    const result = await response.json();
    if (typeof result.text !== 'string') throw new Error('OpenAI вернул ответ без текста расшифровки.');
    part = await savePart(folder, id, part.name, result.text.trim() || '[Речь не распознана]');
  }
  return part;
}

module.exports = { transcribe };
