const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Recording, nextPart, pending, savePart, PART_BYTES, RATE } = require('../app/recordings.cjs');

async function session(t, mode = 'mic') {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sonat-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return { folder, r: await Recording.create(folder, mode) };
}

test('long call, ordered PCM, bounded WAV parts, resume and UTF-8 publication', async t => {
  const { folder, r } = await session(t, 'call');
  const pcm = Buffer.alloc(PART_BYTES + 3210);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(15000*Math.sin(i/24)), i);
  for (let i = 0; i < pcm.length; i += 8192) await r.append(pcm.subarray(i,i+8192));
  await r.finish();
  assert.deepEqual(await pending(folder), [r.id]);
  const verify = (data, offset) => {
    assert.equal(data.toString('ascii',0,4), 'RIFF');
    assert.equal(data.readUInt32LE(24), RATE);
    assert.equal(data.readUInt32LE(40), data.length-44);
    assert.deepEqual(data.subarray(44), pcm.subarray(offset, offset + data.length-44));
  };
  const first = await nextPart(folder, r.id);
  assert.deepEqual(first, { name:'part-000001.wav', index:1, total:2 });
  verify(await fs.readFile(path.join(r.dir, first.name)), 0);
  const second = await savePart(folder, r.id, first.name, 'Слышно меня?');
  assert.deepEqual(await nextPart(folder, r.id), second);
  await assert.rejects(savePart(folder, r.id, first.name, 'Повтор'), /текущую/);
  verify(await fs.readFile(path.join(r.dir, second.name)), PART_BYTES);
  assert.equal((await fs.readdir(folder)).filter(x => x.endsWith('.txt')).length, 0);
  const { file } = await savePart(folder, r.id, second.name, 'Да, слышно.');
  assert.equal(await fs.readFile(path.join(folder,file),'utf8'), 'Слышно меня?\n\nДа, слышно.\n');
  assert.deepEqual(await pending(folder), []);
  assert.deepEqual(await nextPart(folder, r.id), { file });
});

test('interrupted WAV header repaired, previous TXT preserved', async t => {
  const { folder, r } = await session(t);
  await r.append(Buffer.alloc(4800)); await r.file.close(); // simulate abrupt exit
  const collision = path.join(folder,r.id + '.txt');
  await fs.writeFile(collision,'Мои заметки');
  const part = await nextPart(folder, r.id);
  const { file } = await savePart(folder, r.id, part.name, 'Проверка');
  assert.notEqual(file,r.id + '.txt');
  assert.equal(await fs.readFile(collision,'utf8'),'Мои заметки');
  const wav = await fs.readFile(path.join(r.dir,'part-000001.wav'));
  assert.equal(wav.readUInt32LE(40),4800);
});

test('empty, unsafe and malformed sessions', async t => {
  const { folder, r } = await session(t);
  await assert.rejects(r.append(Buffer.alloc(3)),/отсчёт/);
  await r.finish();
  await assert.rejects(nextPart(folder,r.id),/пустая/);
  await assert.rejects(nextPart(folder,'../../'),/Неизвестная/);
  assert.deepEqual(await pending(folder),[]);
});

test('empty pasted text does not complete the part', async t => {
  const { folder, r } = await session(t);
  await r.append(Buffer.alloc(800)); await r.finish();
  const part = await nextPart(folder, r.id);
  await assert.rejects(savePart(folder, r.id, part.name, '   '), /Вставьте/);
  assert.deepEqual(await nextPart(folder, r.id), part);
});
