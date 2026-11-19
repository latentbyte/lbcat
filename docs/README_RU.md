<p align="right">
<a href="./README_zh-CN.md">中文</a> <a href="../README.md">English</a> <a href="./README_zh-TW.md">繁體中文</a> <a href="./README_ja.md">日本語</a> <a href="./README_RU.md">Русский</a>
</p>

<h1 align="center">
<img src="../src/assets/logo.png"/><br/>
LBcat
</h1>

<p align="center">Управление браузером для кодинг-агентов, командная строка для ваших вкладок и цикл разработки пользовательских скриптов из редактора прямо в браузер.</p>

LBcat это расширение для браузера плюс небольшая локальная утилита `bctl`. Она решает три задачи в браузере, которым вы уже пользуетесь, с вашими авторизациями:

- **Управление браузером для агентов.** Claude Code, Codex или любой инструмент, который умеет запускать команды оболочки, использует `bctl`, чтобы открывать вкладки, читать страницы, кликать, вводить текст и делать скриншоты в одном выделенном для него окне. Остальные ваши вкладки ему недоступны.
- **Командная строка для вкладок.** `bctl human tabs` показывает, фокусирует и закрывает вкладки во всех окнах, в виде обычного текста или JSON, для скриптов, лаунчеров и переключателей вкладок.
- **Пользовательские скрипты с диска.** Пишите скрипты на TypeScript или обычном JavaScript, собирайте их в `.user.js`, а `bctl script watch` устанавливает каждую сборку в браузер сразу после сохранения. Без копирования и диалога установки. Обновления приходят так же.

LBcat это форк [ScriptCat](https://github.com/scriptscat/scriptcat), поэтому он остаётся полноценным менеджером пользовательских скриптов, совместимым с Tampermonkey. Для всех трёх задач нужен нативный мост между локальной программой и расширением. В исходном ScriptCat его нет, поэтому мы добавили его и выпускаем собственную подписанную сборку.

Статус: бесплатно и с открытым исходным кодом. Проверено на macOS. На Linux должно работать: инструменты собираются и устанавливаются из исходников, но мы ещё не тестировали их на Linux, а уведомления на рабочем столе пока только для macOS. Windows пока не поддерживается.

## Зачем это нужно

- **Ваш настоящий браузер.** Без отдельного профиля и повторного входа. Агент видит сайты так же, как вы.
- **Ограниченное окно агента.** Вы выбираете одно окно для агентов. Команды никогда не переключаются на ваше личное окно, а личная вкладка доступна только тогда, когда вы выдали доступ именно к ней.
- **Сессии задач и аренда вкладок.** У каждой задачи своя сессия, и ей принадлежат вкладки, которые она открыла, поэтому несколько агентов могут работать в одном браузере, не мешая друг другу. Задачу можно приостановить, а вкладку забрать обратно в любой момент.
- **Настоящий цикл разработки скриптов.** `bctl script push` сопоставляет установленные скрипты по `@name` и `@namespace`, так что каждая отправка обновляет установленную копию на месте. `push-all` устанавливает целую папку в один браузер или во все.
- **Не только Chromium, но и Firefox и Zen.** Определяются Chrome, Brave, Edge, Vivaldi, Firefox, Zen и другие форки.
- **Сделано для агентов.** По умолчанию вывод компактный текст, по запросу JSON, чтобы расходовать меньше токенов.
- **Только локально.** CLI общается с расширением через сокет Unix и Native Messaging. Ничего не отправляется на сервер.

Это выбор цели команд и владение задачами, а не песочница. Cookie и состояние сайтов общие с вашим профилем, поэтому давайте доступ только тем агентам, которым доверяете.

## Установка

Нужны две части: расширение и локальные инструменты.

### 1. Расширение

- **Firefox и Zen:** установите [LBcat из Firefox Add-ons](https://addons.mozilla.org/firefox/addon/lbcat/).
- **Chrome и другие браузеры на Chromium:** страница в Chrome Web Store готовится. Пока соберите расширение и загрузите `dist/ext/chrome` как распакованное:

  ```sh
pnpm install
pnpm run build
```

### 2. CLI, демон и нативный хост

На macOS:

```sh
brew install latentbyte/tap/lbcat
browser-control install
```

Первая команда устанавливает `browser-control` (он же `bctl`), `browser-control-daemon` и `lbcat-shim`. Вторая регистрирует хост Native Messaging для каждого найденного браузера. После этого перезапустите браузер.

Браузеры на Chromium доверяют идентификатору LBcat в Chrome Web Store. Для распакованной сборки передайте её идентификатор из `chrome://extensions`: `browser-control install --extension-id <id>`.

На Linux или для сборки из исходников на macOS нужны Go 1.25 или новее и [just](https://github.com/casey/just). Команды ниже положат инструменты в `~/.local/bin` (добавьте его в `PATH`) и зарегистрируют хост Native Messaging:

```sh
git clone https://github.com/latentbyte/lbcat
cd lbcat
just browser-control-install
brew install terminal-notifier   # macOS only
```

## Быстрый старт

```sh
bctl browsers
bctl --browser zen agent-window create
bctl --browser zen session begin --label "demo"
bctl --session zen:ab12cd34 tabs create https://example.com --active=false
bctl --session zen:ab12cd34 page content <tab-id>
bctl --session zen:ab12cd34 page screenshot <tab-id> --output /tmp/page.png
bctl --session zen:ab12cd34 session end --close-tabs
```

Полный справочник команд: [backend/browser-control/README.md](../backend/browser-control/README.md).

## Использование из агента

Скопируйте [backend/browser-control/skills/browser-control](../backend/browser-control/skills/browser-control) в каталог skills вашего агента, например `~/.claude/skills/browser-control`. Этот skill учит агента порядку работы с сессиями, условиям остановки и тому, как запросить у вас доступ.

Программы на Go могут использовать SDK из `backend/browser-control/pkg/browsercontrol`.

## Пользовательские скрипты

Всё, что умеет ScriptCat, по-прежнему работает: скрипты, совместимые с Tampermonkey, фоновые и запускаемые по расписанию скрипты, облачная синхронизация и встроенный редактор. О том, как писать скрипты, читайте в [документации ScriptCat](https://docs.scriptcat.org/).

Чтобы разрабатывать скрипты на диске, а не во встроенном редакторе, направьте вывод сборки в папку и следите за ней:

```sh
bctl script watch ~/my-scripts
bctl script push dist/my-script.user.js
bctl script push-all ~/my-scripts --all-browsers
```

## Разработка

См. [DEVELOP.md](./DEVELOP.md) и [ARCHITECTURE.md](./ARCHITECTURE.md). Основные команды:

```sh
just check
just test
just browser-control-test
```

## Лицензия и благодарности

Расширение распространяется по лицензии [GPLv3](../LICENSE), как и ScriptCat, на котором оно основано. Спасибо авторам и участникам ScriptCat за движок пользовательских скриптов.

Go CLI, демон и SDK в `backend/browser-control/` это оригинальная работа под лицензией [Apache-2.0](../backend/browser-control/LICENSE).
