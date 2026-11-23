const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateMenu } = require('../app/update-menu.cjs');

test('background discovery lists the version and installation needs a click', async () => {
  const reports = [], installed = [];
  let finishCheck, checks = 0;
  const menu = createUpdateMenu({
    updater: { check() { checks++; return new Promise(resolve => { finishCheck = resolve; }); } },
    install: async version => installed.push(version),
    report: message => reports.push(message), redraw() {}
  });
  const state = { state: 'available', availableVersion: '0.6.0' };
  const manualCheck = menu.item().click();
  menu.refresh();
  assert.equal(checks, 1);
  assert.equal(menu.item().enabled, false);
  finishCheck(state);
  await manualCheck;
  assert.match(reports[0], /0\.6\.0/);
  assert.deepEqual(installed, []);
  const action = menu.item(menu.update);
  assert.match(action.label, /Доступно обновление 0\.6\.0/);
  const installation = action.click();
  menu.refresh();
  assert.equal(checks, 2);
  finishCheck(state);
  await installation;
  assert.deepEqual(installed, ['0.6.0']);
});

test('latest release and connection errors leave a working retry action', async () => {
  let fail = true;
  const reports = [];
  const menu = createUpdateMenu({
    updater: { async check() {
      if (fail) throw Error('Нет связи');
      return { state: 'current', currentVersion: '0.5.1', availableVersion: null };
    } }, redraw() {}, install: assert.fail, report: message => reports.push(message)
  });
  await menu.item().click();
  fail = false;
  await menu.item().click();
  assert.match(menu.item().label, /Проверить/);
  assert.deepEqual(reports, ['Нет связи', 'Установлена последняя версия Sonat 0.5.1.']);
});
