const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('audio worklet preserves ordering and flushes last partial block before stop acknowledgement', () => {
  let Processor;
  const messages = [];
  const port = { postMessage: value => messages.push(value) };
  const context = { AudioWorkletProcessor: class { constructor(){ this.port = port; } },
    registerProcessor: (name, ctor) => { assert.equal(name,'pcm-recorder'); Processor = ctor; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/worklet.js'),'utf8'), context);
  const processor = new Processor();
  const samples = Float32Array.from({length:130},(_,i)=>Math.sin(i/3));
  for(let i=0;i<100;i++) processor.process([[samples]]);
  port.onmessage({data:'stop'});
  assert.equal(messages.pop(),'stopped');
  const result = messages.flatMap(msg => Array.from(new Int16Array(msg)));
  assert.equal(result.length,13000);
  result.forEach((value,i) => assert.equal(value,Math.round(samples[i%130]*32767)));
  assert.equal(processor.process([[samples]]),false);
});
