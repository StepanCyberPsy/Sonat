# Системные признаки звонка, macOS 14.2+

`call-probe.m` — небольшой локальный helper на Objective-C. Только метаданные Core Audio HAL и окон: он не открывает микрофон/камеру, не создаёт аудиопоток, process tap, снимок экрана или запись. Нет сетевых вызовов, записи файлов, AppleScript, Accessibility и запросов разрешений. Работает без интернета.

Сборка на Mac с Command Line Tools, из корня Sonat:

```sh
xcrun clang -fobjc-arc -O2 -Wall -Wextra -mmacosx-version-min=14.2 \
  -arch arm64 -arch x86_64 native/call-probe.m \
  -framework Foundation -framework AppKit -framework CoreAudio -framework CoreGraphics \
  -o /tmp/SonatCallProbe
/tmp/SonatCallProbe --self-test
/tmp/SonatCallProbe --once
```

Готовая сборка содержит `Sonat.app/Contents/Helpers/SonatCallProbe`. При выпуске на Apple Silicon и Intel команда ниже проверяет экземпляр из пакета приложения. Она запускает встроенные тесты, читает один снимок состояния и получает два последовательных сообщения от монитора.

```sh
node scripts/smoke-call-probe.cjs "$HOME/Applications/Sonat.app"
```

Разрешения macOS и распознавание конкретного звонка проверяются вручную по шагам ниже. [Сценарий проверки](../scripts/smoke-call-probe.cjs) · [Проверки релиза 0.5.2](https://github.com/StepanCyberPsy/Sonat/actions/runs/45218428029)

## Контракт

`--once` выдаёт одну JSON-строку в stdout. `--watch` выдаёт такую же строку сразу и затем примерно раз в три секунды. Каждый snapshot сбрасывает stdout и освобождает временные объекты. Helper завершает работу при закрытии pipe, SIGTERM или смене родительского PID. Ошибки HAL передаются в JSON, не прерывают `--watch` и дают exit 0 у `--once`. Неверные аргументы: stderr и exit 64. `--self-test`: JSON с результатами, exit 0/1; не обращается к HAL, окнам и разрешениям.

```json
{"schemaVersion":1,"status":"ok","observedAt":1795392000000,"processes":[{"objectId":123,"pid":456,"bundleId":"com.google.Chrome.helper","appPid":1234,"appBundleId":"com.google.Chrome","appName":"Google Chrome","attribution":"enclosing-app","inputActive":true,"outputActive":true}],"meetings":[{"appPid":1234,"appBundleId":"com.google.Chrome","service":"google-meet"}],"errors":[]}
```

- `status`: `ok`, `partial` (ошибки отдельных объектов), `error` (не прочитан список HAL), `unsupported` (macOS ниже 14.2). Ошибка наблюдения означает неизвестность. Не превращать её в «звонок завершён». Обрабатывайте `meetings` независимо от ошибки HAL.
- `processes`: активные либо не полностью прочитанные HAL-процессы. `inputActive`/`outputActive` — boolean либо `null` при ошибке чтения; `pid`, bundle-поля и `appPid` также могут быть `null`. Ошибки содержат числовые `objectId`, `property`, `osStatus` и постоянный `code`, без содержимого окон.
- `app*`: внешняя `.app` для вложенного Chromium/Electron helper, либо приложение в цепочке родителей (не более 16 шагов). `attribution`: `enclosing-app`, `process-app`, `parent-app`, `unresolved`. Идентичность не выводится из списка просто открытых браузеров. Для WebKit/XPC с родителем launchd связь с Safari может остаться неизвестной; исходный `bundleId` сохраняется.
- `meetings`: нормализованные `appPid`, `appBundleId`, `service` и необязательная локальная подсказка `topic`. Значения service: `zoom`, `google-meet`, `telemost`, `mts-link`, `teams`, `jitsi`. Из распознанного заголовка комнаты helper может извлечь тему для названия записи. Общие заголовки Zoom и код комнаты Meet темы не дают. Повторы для одного процесса и сервиса удаляются.

Потребитель должен ограничить размер/длину JSON-строк и время без heartbeat, перезапустить helper с задержкой при его сбое и остановить его при завершении приложения. Ни один сигнал не является командой начать запись. У Sonat и его recorder helper есть собственный I/O: исключайте их из классификации звонка.

## Что означают признаки

HAL показывает процесс с активным входным/выходным потоком; это не анализ речи. Объединяйте INPUT и OUTPUT по идентифицированному приложению: у браузера они могут принадлежать разным helper. Любой клиент звонков, включая Телемост и МТС Линк в браузере, доступен через общий HAL-сигнал без перечня брендов. Одновременный INPUT+OUTPUT — признак возможного разговора, но диктофон, воспроизведение и микрофонная проверка тоже могут его дать. Выходной поток без INPUT обычно недостаточен. Выключенный микрофон может оставить входной поток активным или остановить его — это зависит от клиента. Камера не используется и на обнаружение не влияет.

Дополнительный сигнал окон полезен при выключенном INPUT, если заголовок доступен по уже существующему доступу macOS. `CGWindowListCopyWindowInfo` сам не вызывает запрос разрешения. Нет попыток получить новый доступ. Отсутствие заголовка не используется как проверка TCC: состав полей зависит от macOS. Рассматриваются только видимые обычные окна; свёрнутые окна, другие Spaces и фоновые вкладки могут отсутствовать. Контекст комнаты также может быть экраном ожидания или лобби, а не подключённым звонком.

## Шаблоны окон

Встроенный self-test проверяет синтетические примеры ниже, а не реальные версии сервисов. У клиента может быть другой заголовок; в таком случае действует HAL, а окно не распознаётся. Для расширения нужны проверенные обезличенные формы заголовков, не полный дамп окон пользователя.

| Контекст | Принимаемый пример |
| --- | --- |
| Zoom, desktop (`us.zoom.*`) | точные `Zoom Meeting`, `Zoom Webinar`, `Конференция Zoom`, `Вебинар Zoom` |
| Google Meet, браузер | `Meet - abc-defg-hij`, `Google Meet — abc-defg-hij` |
| Телемост, браузер/клиент | `Встреча: Пример — Телемост` (также Конференция/Meeting/Call) |
| МТС Линк, браузер/клиент | `Встреча: Пример — МТС Линк` (также Конференция/Вебинар/Meeting/Webinar/Call) |
| Teams, браузер/клиент | `Meeting: Example | Microsoft Teams` (также Call/Встреча/Звонок/Собрание) |
| Jitsi, браузер | `Example | Jitsi Meet` |
| Zoom, браузер | `Zoom Meeting — Example` |

Браузеры: Safari, Chrome/Canary, Chromium, Edge, Firefox, Brave, Opera, Arc, Vivaldi. Допустим обычный суффикс бренда браузера. Самостоятельные `Zoom Workplace`, `Google Meet`, `Телемост`, `МТС Линк`, `Microsoft Teams` не подтверждают комнату и не принимаются. Кастомные/локализованные заголовки и главные страницы намеренно не угадываются. Совпадающее название произвольной веб-страницы возможно: использовать окно как слабый признак, без автоматической записи.

## Проверка на Mac

1. Собрать helper и запустить `--self-test`: все `checks` должны быть `true`.
2. Без выданных разрешений запустить `--once` и `--watch`: нет диалогов доступа, stdout — корректный JSON, на `--once` exit 0. Отключение сети не меняет работу.
3. При закрытых звонках проверить обычное воспроизведение музыки: OUTPUT допустим, INPUT не должен появляться только из-за helper.
4. Проверить Zoom, Safari Meet и Chrome Meet/Телемост/МТС Линк: INPUT/OUTPUT, отдельно микрофон включён/выключен и камера выключена, наушники, молчание, выход из звонка. Проверить объединение браузерных helper в родительское приложение.
5. Если Sonat уже имеет доступ к системному звуку/экрану, проверить `meetings` на окне комнаты и на главной странице. Доступ отдельно ради этой проверки не запрашивать. Свернуть окно: пустой `meetings` допустим.
6. Закрыть родителя/pipe: `--watch` должен завершиться. Убедиться, что CPU в ожидании не занят циклом, и отсутствуют файлы/сетевые обращения.

## Первичные источники

- [Apple: список HAL process objects](https://developer.apple.com/documentation/coreaudio/kaudiohardwarepropertyprocessobjectlist).
- [Apple: AudioHardwareProcess](https://developer.apple.com/documentation/coreaudio/audiohardwareprocess) — смысл PID, bundle ID и флагов INPUT/OUTPUT. Используется C HAL API, доступный на 14.2; новый объектный Swift API не требуется.
- [Apple: CGWindowListCopyWindowInfo](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:)) — метаданные текущей GUI-сессии, NULL без WindowServer.
- [Apple WWDC19, Advances in macOS Security](https://developer.apple.com/videos/play/wwdc2019/701/) — 16:26–17:05: ограничения заголовков и отсутствие prompt у запроса метаданных окон.
- [Apple DTS о нестабильности наличия полей и проверке разрешений](https://developer.apple.com/forums/thread/839069?answerId=898801022).
