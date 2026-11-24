const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sources, CallOffers } = require('../app/call-detection.cjs');
const source = (appBundleId, appName, inputActive, outputActive) => ({ appBundleId, appName, inputActive, outputActive });
const chromium = source('com.google.Chrome', 'Google Chrome', true, false);
const zoom = source('us.zoom.xos', 'zoom.us', false, true);
const snapshot = (...processes) => ({ processes, meetings: [] });
test('camera-free native, browser and generic meeting signals', () => {
  const input = snapshot(zoom, chromium, source('ru.yandex.telemost','Телемост',true,false),
    source('ru.webinar.desktop','МТС Линк',true,false),
    source('org.example.client','Другой клиент',true,false),
    source('org.example.client','Другой клиент',false,true));
  assert.deepEqual([...sources(input).values()], ['Zoom','Google Chrome','Яндекс Телемост','МТС Линк','Другой клиент']);
  input.meetings = [{ appBundleId:'com.google.Chrome', service:'google-meet' }];
  assert.equal(sources(input).get('com.google.chrome'), 'Google Meet');
  assert.equal(sources({processes:[],meetings:input.meetings}).get('com.google.chrome'), 'Google Meet');
});
test('ordinary browser playback, devices without identity and Sonat itself do not prompt', () => {
  assert.equal(sources(snapshot({...chromium,inputActive:false,outputActive:true}, source('','',true,true),
    source('com.stepancyberpsy.sonat','Sonat',true,true),source('org.example.editor','Editor',true,false))).size, 0);
});
test('confirm or skip only the current sustained session and rearm after call ends', () => {
  let t = 0;
  const events = [];
  const state = new CallOffers(value => events.push(value), () => t);
  const tick = (time, s, recording = false) => { t = time; state.update(s,recording); };
  tick(0,snapshot(zoom)); tick(1000,snapshot(zoom));
  assert.equal(events.length,0);
  tick(3500,snapshot(zoom));
  assert.equal(events[0].label,'Zoom');
  assert.equal(state.consume('old'),false);
  assert.equal(state.consume(events[0].id),true);
  tick(7000,snapshot(zoom)); tick(11000,snapshot()); tick(14000,snapshot(zoom));
  assert.deepEqual(events.slice(1),[null]);
  tick(36000,snapshot()); tick(39000,snapshot(zoom)); tick(42000,snapshot(zoom));
  assert.notEqual(events.at(-1).id, events[0].id);
  tick(45000,snapshot(zoom),true);
  assert.equal(events.at(-1),null);
  tick(50000,snapshot(zoom));
  assert.equal(state.offer,null);
});
test('a stale click or a long Mac sleep cannot accept a previous call', () => {
  let t=0;
  const state=new CallOffers(()=>{},()=>t);
  const s=snapshot(chromium);
  state.update(s); t=3100; state.update(s);
  const old=state.offer.id;
  t=14500;
  assert.equal(state.consume(old),false);
  t=90000; state.update(s);
  assert.equal(state.offer,null);
  t=93200; state.update(s);
  assert.notEqual(state.offer.id,old);
  state.clear(); assert.equal(state.consume(old),false);
});

test('end follows the bound call, requires healthy consecutive absences, survives mute and sleep', () => {
  const {RecordedCall} = require('../app/call-detection.cjs');
  const call = new RecordedCall('record', 'us.zoom.xos');
  const tick = (time, processes, meetings = [], status = 'ok') => call.observe({processes, meetings, status}, time);
  const meeting = {appBundleId:'us.zoom.xos', service:'zoom', topic:'Планирование'};
  assert.equal(tick(0, [zoom], [meeting]), false);
  assert.equal(call.title, 'Планирование');
  for (const t of [3000,6000,9000,12000,15000,18000]) assert.equal(tick(t, [], [meeting]), false);
  assert.equal(tick(21000, []), false);
  assert.equal(tick(24000, [], [], 'partial'), false);
  assert.equal(tick(90000, []), false);
  for (const t of [93000,96000,99000,102000,105000]) assert.equal(tick(t,[chromium]), false);
  assert.equal(tick(108000,[chromium]), true);
});

test('unrecognized and window-only calls do not end on missing audio', () => {
  const { RecordedCall } = require('../app/call-detection.cjs');
  const call = new RecordedCall('record');
  call.observe({ status:'ok', processes:[zoom,chromium] },0);
  assert.equal(call.key,'');
  call.observe({ status:'ok', meetings:[{appBundleId:'us.zoom.xos',service:'zoom'}] },3000);
  for (let t=6000;t<45000;t+=3000) assert.equal(call.observe({status:'ok', processes:[], meetings:[]},t), false);
});
