// Share one release lookup between Settings, both native menus and the timer.
function createUpdateMenu({ updater, redraw, install, report }) {
  let checking, availableVersion, installing = false;
  function check() {
    if (checking) return checking;
    checking = updater.check().then(status => {
      availableVersion = status.availableVersion;
      return status;
    }).finally(() => { checking = null; redraw(); });
    redraw();
    return checking;
  }
  async function update() {
    installing = true;
    redraw();
    try {
      const state = await check();
      if (state.state === 'current') return 'Установлена последняя версия Sonat ' + state.currentVersion + '.';
      await install(state.availableVersion);
      return 'Обновление установлено. Перезапускаем Sonat…';
    } finally { installing = false; redraw(); }
  }
  function item(startUpdate) {
    if (installing) return { label: 'Обновляем Sonat…', enabled: false };
    if (checking) return { label: 'Проверяем обновления…', enabled: false };
    if (availableVersion) return { label: 'Доступно обновление ' + availableVersion + ' — установить', click: () => startUpdate().then(report, e => report(e.message)) };
    return { label: 'Проверить обновления…', click: async () => {
      try {
        const state = await check();
        if (state.state === 'current') report('Установлена последняя версия Sonat ' + state.currentVersion + '.');
        else report('Доступно обновление ' + state.availableVersion + '. Выберите его в меню Sonat для установки.');
      } catch (e) { report(e.message); }
    } };
  }
  function refresh() {
    if (!installing) check().catch(() => {});
  }
  return { refresh, update, item };
}
module.exports = { createUpdateMenu };
