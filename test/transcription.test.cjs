const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Recording, PART_BYTES } = require('../app/recordings.cjs');
const { transcribe } = require('../app/transcription.cjs');

test('automatic upload resumes after quota error and publishes one TXT', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sonat-api-'));
  t.after(() => fs.rm(folder, {recursive:true, force:true}));
  const r = await Recording.create(folder, 'mic');
  await r.append(Buffer.alloc(PART_BYTES + 100));
  await r.finish();
  const parts = [];
  let quota = false;
  const request = async (url, opt) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(opt.headers.Authorization, 'Bearer test');
    assert.equal(opt.body.get('model'), 'gpt-transcribe');
    const wav = opt.body.get('file');
    const bytes = Buffer.from(await wav.arrayBuffer());
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
    parts.push(wav.name);
    if (wav.name === 'part-000001.wav') return Response.json({text:'Начало'});
    return quota ? Response.json({text:'Конец'}) : new Response(null, {status:429});
  };
  const run = () => transcribe(folder, r.id, 'test', () => {}, request);
  await assert.rejects(run(), /баланс/);
  quota = true;
  const { file } = await run();
  assert.deepEqual(await run(), { file });
  assert.deepEqual(parts, ['part-000001.wav','part-000002.wav','part-000002.wav']);
  assert.equal(await fs.readFile(path.join(folder,file),'utf8'), 'Начало\n\nКонец\n');
});

test('connection check submits bundled speech to the transcription endpoint and requires a transcript', async () => {
  const { checkConnection } = require('../app/transcription.cjs');
  const check = response => checkConnection('mock', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(options.body.get('model'), 'gpt-transcribe');
    const file = options.body.get('file');
    assert.equal(file.name, 'connection-test.wav');
    const wav = Buffer.from(await file.arrayBuffer());
    assert.equal(wav.subarray(0,4).toString(), 'RIFF');
    assert.ok(wav.subarray(44).some(x => x !== 0));
    return response;
  });
  await check(Response.json({text:'Connection test.'}));
  await assert.rejects(check(Response.json({text:'  '})), /пустую/);
  await assert.rejects(check(new Response(null,{status:401})), /401/);
  await assert.rejects(check(new Response(null,{status:429})), /баланс/);
});
