# Rowline — verification record

Проверки проводились на искусственных данных в Windows, Node.js v24.15.0. Это измерения данной среды, не обещание одинаковой скорости на каждом устройстве.

## Проверенные сценарии

- **29/29 unit + independent security regression tests**, включая quoted multiline/BOM/CRLF/Unicode, leading-zero и huge IDs, неоднозначный CSV, ширину строк, точные диапазоны, правила, CSV/JSON exports, recipes/backups, прототипные имена колонок и безопасные формулы.
- Production build: TypeScript strict + Vite успешно собирают статический сайт и worker. Нет backend, runtime API, telemetry или внешних шрифтов.
- Успешный отдельный `npm audit --json`: **0 известных уязвимостей**. Повтор независимого аудитора не завершился из-за сетевой недоступности; это отдельно указано в его отчёте.
- Фактический инвентарный acceptance flow: 12 исходных записей → trim/whitespace/lower status → осознанный выбор дубликата №2, исключение №4 → исправление stock/SKU → **11 clean + 1 rejected**. Номера, исходные значения и причины проверены в скачанных файлах. Clean CSV повторно импортируется с ожидаемыми значениями, leading-zero SKU и большим ID.
- Opt-in recovery и JSON backup restore сохраняют данные/правки; без opt-in исходный набор не попадает в localStorage. Storage failure оставляет работу в памяти и выключает сохранение с сообщением.
- XSS payload выводится как текст; CSV formula safe mode включён по умолчанию и явно отключается. Коллизия защищённых заголовков блокирует очищенный экспорт с объяснением.

## Независимые ревью

[Code/security audit](QA-SECURITY.md): отдельный агент прочитал исходники и написал 13 adversarial/regression tests. Пять найденных дефектов artifact integrity/availability исправлены владельцем проекта и повторно проверены аудитором: bounded diagnostics, одинаковый aggregate recipe budget, protected-header collisions, восстанавливаемые backups, одинаковые header limits.

[UX/accessibility/performance audit](QA-UX.md): отдельный агент проверял реальные браузерные состояния и полный workflow. Исправлены mobile Help name, focusable preview scroll region, возврат фокуса после Escape, объявление выбранного inspector и отображение structural issues без заранее заданных validations. Массовая вставка обходит медленный native text insertion через стандартное событие paste, сохраняя выделение и предел размера.

## Измерения

| Сценарий | Измерение |
| --- | --- |
| Node: parsing + trim + unique + integer/min, 10 000×3, 297 794 bytes | 116–152 ms в контрольных запусках; финальный run 131 ms |
| Независимый Chromium: file import + worker + render, 10 000×3 | 486 ms |
| Независимый Chromium: 10 000×50, 500 000 cells, 1.06 MB | import 2 952 ms; preview 2 706 ms; apply 2 323 ms; filter 203 ms; export 803 ms |
| Максимальный main-thread long task в независимом dense benchmark | 260 ms |
| DOM таблица при 10 000 записей | 20 records/page |

Число проверок/данные влияют на скорость. После правил действует предел 8 МБ очищенных значений; admission limits не означают unlimited support. Рецепт JSON до 256 КБ, backup до 8 МБ; oversized artifacts не выдаются как рабочие.

## Воспроизведение

```sh
npm ci
npm run check
npx playwright install chromium firefox webkit
npm run test:e2e
```

Тестовый Playwright и его driver закреплены на **1.60.0** с browser revisions Chromium 1223 / Firefox 1522 / WebKit 2287. В restricted execution Firefox не мог создать страницу до загрузки приложения. Независимый повтор того же теста с разрешённым запуском изолированного headless browser подтвердил работоспособность Firefox; системные security settings и пользовательские профили не менялись.

Desktop viewport 1440×1000; mobile viewport 390×844. Chromium/WebKit mobile используют touch/mobile emulation; Firefox — узкий viewport и touch. **WebKit не называется Safari, эмуляция не называется физическим телефоном.**

Локальные machine-readable results, screenshots и traces — в ignored `qa-local/` и `test-results/`. В репозитории опубликованы реальные screenshots с явно искусственным демо, без пользовательских наборов данных. CI использует те же unit/build/E2E команды, только синтетические данные.

## Финальный production-прогон

Локальная production-сборка: **66 passed, 0 failed, 0 skipped**, 4.1 минуты. Каждый из шести профилей прошёл все 11 сценариев: Chromium, Firefox и WebKit при desktop и mobile viewport. Проверены реальные downloads и реимпорт, два разных пути ввода 10 000 записей (файл и paste event), повреждённые данные, recipes/backups, добровольное хранение и его отказ, XSS/formula protection и accessibility.

Machine-readable local evidence: `qa-local/local-final-results.json` (ignored, синтетические данные). Финальные результаты live-проверки добавляются после публикации и фактического прогона.
