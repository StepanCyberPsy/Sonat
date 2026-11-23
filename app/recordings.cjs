const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RATE = 16000;
const PART_BYTES = RATE * 2 * 60 * 4;
const archive = 'Аудио Sonat';
const partPattern = /^part-\d{6}\.wav$/;
const sessionPattern = /^Sonat \d{4}-\d\d-\d\d \d\d-\d\d-\d\d (Звонок|Диктофон) [a-f0-9]{8}$/;

function header(bytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(bytes + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

async function writeAll(file, buffer, at) {
  let n = 0;
  while (n < buffer.length) {
    const result = await file.write(buffer, n, buffer.length - n, at + n);
    if (!result.bytesWritten) throw new Error('Диск перестал принимать данные.');
    n += result.bytesWritten;
  }
}

function sessionDir(folder, id) {
  if (!sessionPattern.test(id)) throw new Error('Неизвестная запись.');
  return path.join(folder, archive, id);
}

class Recording {
  static async create(folder, mode) {
    const now = new Date();
    const digits = n => String(n).padStart(2, '0');
    const date = [now.getFullYear(), digits(now.getMonth()+1), digits(now.getDate())].join('-');
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(digits).join('-');
    const id = ['Sonat', date, time, mode === 'call' ? 'Звонок' : 'Диктофон', randomUUID().slice(0,8)].join(' ');
    await fs.mkdir(path.join(folder, archive), { recursive: true, mode: 0o700 });
    const dir = sessionDir(folder, id);
    await fs.mkdir(dir, { mode: 0o700 });
    return Object.assign(new Recording(), { id, dir, index: 0, file: null, size: 0 });
  }

  // The caller serializes writes and finish in capture order.
  async append(buffer) {
    if (buffer.length % 2) throw new Error('Неполный отсчёт звука.');
    while (buffer.length) {
      if (!this.file) {
        const name = 'part-' + String(++this.index).padStart(6, '0') + '.wav';
        this.file = await fs.open(path.join(this.dir, name), 'wx', 0o600);
        this.size = 0;
        await writeAll(this.file, header(0), 0);
      }
      const take = Math.min(PART_BYTES - this.size, buffer.length);
      await writeAll(this.file, buffer.subarray(0, take), 44 + this.size);
      this.size += take;
      buffer = buffer.subarray(take);
      if (this.size === PART_BYTES) await this.finish();
    }
  }

  async finish() {
    const file = this.file;
    this.file = null;
    if (!file) return;
    try {
      await writeAll(file, header(this.size), 0);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function pending(folder) {
  const root = path.join(folder, archive);
  if (!await exists(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !sessionPattern.test(entry.name)) continue;
    const dir = sessionDir(folder, entry.name);
    if (await exists(path.join(dir, 'finished.json'))) continue;
    if ((await fs.readdir(dir)).some(name => partPattern.test(name))) result.push(entry.name);
  }
  return result.sort().reverse();
}

async function saveJSON(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
}

// Return the next WAV for the user, or publish the TXT once every part is saved.
async function nextPart(folder, id) {
  const dir = sessionDir(folder, id);
  const marker = path.join(dir, 'finished.json');
  if (await exists(marker)) return JSON.parse(await fs.readFile(marker, 'utf8'));
  const files = (await fs.readdir(dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && partPattern.test(entry.name))
    .map(entry => entry.name).sort();
  const paragraphs = [];
  let hasAudio = false;
  for (const [index, name] of files.entries()) {
    const wav = path.join(dir, name);
    const bytes = Math.floor(((await fs.stat(wav)).size - 44) / 2) * 2;
    if (bytes <= 0) continue;
    if (bytes > PART_BYTES) throw new Error('Повреждён звуковой файл ' + name);
    hasAudio = true;
    const cache = wav + '.json';
    if (await exists(cache)) {
      const { text } = JSON.parse(await fs.readFile(cache, 'utf8'));
      if (text.trim()) paragraphs.push(text.trim());
      continue;
    }
    // Repair the last header if recording was interrupted before finish().
    const f = await fs.open(wav, 'r+');
    try {
      const actual = Buffer.alloc(44);
      await f.read(actual, 0, 44, 0);
      const expected = header(bytes);
      if (!actual.equals(expected)) await writeAll(f, expected, 0);
    } finally { await f.close(); }
    return { name, index: index + 1, total: files.length };
  }
  if (!hasAudio) throw new Error('Запись пустая. Проверьте микрофон и разрешения.');
  const transcript = (paragraphs.join('\n\n') || '[Речь не распознана]') + '\n';
  // A prior run may have published the TXT just before it was interrupted.
  const staged = path.join(dir, 'transcript.tmp');
  await fs.writeFile(staged, transcript, { mode: 0o600 });
  for (let copy = 0; ; copy++) {
    const file = id + (copy ? ' (' + copy + ')' : '') + '.txt';
    const target = path.join(folder, file);
    try {
      await fs.copyFile(staged, target, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await fs.readFile(target, 'utf8') !== transcript) continue;
    }
    await saveJSON(marker, { file });
    await fs.unlink(staged);
    return { file };
  }
}

async function savePart(folder, id, name, text) {
  if (!partPattern.test(name) || typeof text !== 'string' || !text.trim())
    throw new Error('Вставьте текст для выбранной части.');
  const current = await nextPart(folder, id);
  if (current.file) return current;
  if (name !== current.name) throw new Error('Откройте текущую часть записи.');
  const cache = path.join(sessionDir(folder, id), name + '.json');
  await saveJSON(cache, { text: text.trim() });
  return nextPart(folder, id);
}
module.exports = { Recording, pending, nextPart, savePart, sessionDir, saveJSON, PART_BYTES, RATE };
