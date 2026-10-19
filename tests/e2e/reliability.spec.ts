import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseCSV, emptyWorkspace, processDataset, exportClean, DEFAULT_EXPORT } from '../../src/core';

const exact = { ...DEFAULT_EXPORT, safe: false };
const fixture = '\uFEFFsku,name,note\r\n0001,"Лампа, белая","строка ""2"""\r\n0002,Көк,"первая\r\nвторая"\r\n0003,,\r\n,"",\r\n0004,"  пробелы  ",last\r\n';
async function activate(locator: Locator) { if (test.info().project.use.hasTouch) await locator.tap(); else await locator.click(); }
async function settled(page: Page) { await expect(page.locator('.stats')).toHaveAttribute('aria-busy', 'false'); }
async function upload(page: Page, text: string, name = 'accepted.csv') {
  await page.locator('input[type=file]').nth(0).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await expect(page.locator('.dataset-name strong')).toHaveText(name); await settled(page);
}
async function download(page: Page, name: string) {
  const pending = page.waitForEvent('download'); await activate(page.getByRole('button', { name, exact: false }));
  const file = await pending; return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}
async function backup(page: Page) { return JSON.parse((await download(page, 'Резервная копия')).text); }
async function edit(page: Page, value: string) {
  await activate(page.getByRole('button', { name: 'Открыть запись 2', exact: true }));
  await page.getByLabel('Ячейка', { exact: true }).selectOption({ label: 'name' });
  await page.getByLabel('Новое значение', { exact: true }).fill(value);
  await activate(page.getByRole('button', { name: 'Сохранить ячейку', exact: true })); await settled(page);
}
async function timingHarness(page: Page) {
  await page.addInitScript(() => {
    const control = { delay: '', delivered: 0, reads: [] as string[], requests: [] as string[] };
    Object.defineProperty(window, 'rowlineQA', { value: control });
    const Native = window.Worker, setter = Object.getOwnPropertyDescriptor(Native.prototype, 'onmessage')!.set!;
    window.Worker = class extends Native {
      operations = new Map<number, string>();
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        Object.defineProperty(this, 'onmessage', { set: handler => setter.call(this, (event: MessageEvent) => {
          const deliver = () => { control.delivered++; handler(event); };
          if (this.operations.get(event.data.id) === control.delay) setTimeout(deliver, 700); else deliver();
        }) });
      }
      postMessage(message: any, options?: any) { this.operations.set(message.id, message.operation); control.requests.push(message.operation); super.postMessage(message, options); }
    };
    const arrayBuffer = File.prototype.arrayBuffer, text = File.prototype.text;
    File.prototype.arrayBuffer = async function () { control.reads.push(this.name); const result = await arrayBuffer.call(this); if (this.name.startsWith('slow')) await new Promise(r => setTimeout(r, 700)); return result; };
    File.prototype.text = async function () { control.reads.push(this.name); const result = await text.call(this); if (this.name.startsWith('slow')) await new Promise(r => setTimeout(r, 700)); return result; };
  });
}

test('duplicate decisions affect only validated participants; repeated undo/redo and rejected export preserve malformed originals', async ({ page }) => {
  await page.goto('./'); await upload(page, 'sku,name\nA,keep\nA,drop\nA,broken,EXTRA');
  await activate(page.locator('thead button').filter({ hasText: /^sku$/ }));
  await page.getByLabel('Уникальное значение').check(); await activate(page.getByRole('button', { name: 'Применить проверку' })); await settled(page);
  await activate(page.getByRole('button', { name: 'Открыть запись 2', exact: true })); await activate(page.getByRole('button', { name: 'Оставить эту запись', exact: true }));
  await expect(page.getByRole('dialog')).toContainText('№3'); await expect(page.getByRole('dialog')).not.toContainText('№4');
  await page.screenshot({ path: `qa-local/${test.info().project.name}-reliable-duplicates.png`, fullPage: true });
  await activate(page.getByRole('button', { name: 'Подтвердить выбор' })); await settled(page);
  for (let i = 0; i < 2; i++) {
    await activate(page.getByRole('button', { name: 'Отменить действие', exact: true })); await settled(page); await expect(page.locator('.stat.ready strong')).toHaveText('0');
    await activate(page.getByRole('button', { name: 'Повторить действие', exact: true })); await settled(page); await expect(page.locator('.stat.ready strong')).toHaveText('1');
  }
  await activate(page.getByRole('button', { name: 'Открыть запись 4', exact: true })); await expect(page.locator('.row-inspector-heading')).toContainText('Есть ошибки');
  await activate(page.getByRole('button', { name: /^Экспорт/ }));
  const rejected = parseCSV((await download(page, 'Отклонённые строки')).text);
  expect(rejected.rows).toHaveLength(2); expect(JSON.parse(rejected.rows[1].values[2])).toEqual(['A', 'broken', 'EXTRA']);
  expect(rejected.rows[1].values[1]).not.toContain('Дубликат'); expect(rejected.rows[0].values[1]).toContain('Дубликат');
});

for (const phase of ['parse', 'process']) test(`Escape cancels pending ${phase} without losing edits, persistence or history`, async ({ page }) => {
  await timingHarness(page); await page.goto('./'); await upload(page, 'sku,name\n001,original'); await edit(page, 'accepted edit');
  await page.getByLabel('Сохранять эту работу на устройстве').check(); const before = await backup(page);
  const persisted = await page.evaluate(() => localStorage.getItem('rowline-workspace-v1'));
  await activate(page.getByRole('button', { name: 'Новый файл', exact: true })); await page.getByLabel('CSV с заголовками в первой записи').fill('newid,value\n999,replacement');
  await page.evaluate(phase => { (window as any).rowlineQA.delay = phase; }, phase);
  await activate(page.getByRole('button', { name: 'Загрузить текст' })); await expect(page.locator('.stats')).toHaveAttribute('aria-busy', 'true');
  // Wait until the delayed process has actually been posted, when testing stage 2.
  if (phase === 'process') await page.waitForFunction(() => (window as any).rowlineQA.requests.at(-1) === 'process');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.waitForTimeout(900); await settled(page);
  expect(await backup(page)).toEqual(before); expect(await page.evaluate(() => localStorage.getItem('rowline-workspace-v1'))).toBe(persisted);
  await page.screenshot({ path: `qa-local/${test.info().project.name}-cancel-${phase}.png`, fullPage: true });
  await activate(page.getByRole('button', { name: 'Отменить действие', exact: true })); await settled(page); await expect(page.getByLabel('Новое значение', { exact: true })).toHaveValue('original');
  await activate(page.getByRole('button', { name: 'Повторить действие', exact: true })); await settled(page); await expect(page.getByLabel('Новое значение', { exact: true })).toHaveValue('accepted edit');
});

test('overlapping file reads accept the latest selection; stale success/error cannot replace it', async ({ page }) => {
  await timingHarness(page); await page.goto('./');
  await page.locator('input[type=file]').nth(0).setInputFiles({ name: 'slow-first.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,name\nold,stale') });
  await upload(page, 'sku,name\nnew,current', 'latest.csv'); await page.waitForTimeout(900);
  await expect(page.locator('.dataset-name strong')).toHaveText('latest.csv'); await expect(page.getByRole('button', { name: 'Запись 2, sku: new', exact: true })).toBeVisible();
  await page.locator('input[type=file]').nth(0).setInputFiles({ name: 'slow-invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('id,id\n1,2') });
  await upload(page, 'sku,name\nlast,survives', 'final.csv'); await page.waitForTimeout(900); await settled(page);
  await expect(page.locator('.dataset-name strong')).toHaveText('final.csv'); await expect(page.locator('.alert.error')).toHaveCount(0);
  expect((await backup(page)).dataset.rows[0].values).toEqual(['last', 'survives']);
});

test('closing import cancels file/backup reads; subsequent reimport is accepted', async ({ page }) => {
  await timingHarness(page); await page.goto('./'); await upload(page, 'sku,name\n001,accepted'); const before = await backup(page);
  for (const kind of ['csv', 'backup']) {
    await activate(page.getByRole('button', { name: 'Новый файл', exact: true }));
    await page.locator('input[type=file]').nth(kind === 'csv' ? 0 : 2).setInputFiles({ name: `slow-${kind}.${kind === 'csv' ? 'csv' : 'json'}`, mimeType: 'text/plain', buffer: Buffer.from(kind === 'csv' ? 'sku,name\n999,replacement' : JSON.stringify({ ...before, dataset: { ...before.dataset, name: 'replacement.csv' } })) });
    await expect(page.locator('.stats')).toHaveAttribute('aria-busy', 'true'); await activate(page.getByRole('button', { name: 'Закрыть окно', exact: true }));
    await page.waitForTimeout(900); await settled(page); expect(await backup(page)).toEqual(before);
  }
  await upload(page, fixture, 'reimport.csv'); await expect(page.locator('.stat.total strong')).toHaveText('5');
});

test('failed CSV/recipe/backup preparation preserves accepted data and undo; valid recipe can be undone and redone repeatedly', async ({ page }) => {
  await page.goto('./'); await upload(page, 'sku,name\n001,  original  '); await edit(page, 'accepted edit');
  await page.getByLabel('Сохранять эту работу на устройстве').check(); const before = await backup(page);
  for (const text of ['id,id\n1,2', 'id,name\n1,"unterminated', 'id,\n1,2', '', '\u0000bad']) {
    await page.locator('input[type=file]').nth(0).setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(text) }); await settled(page);
    await expect(page.locator('.alert.error')).toBeVisible(); expect(await backup(page)).toEqual(before);
  }
  const w = emptyWorkspace(['sku', 'name']); w.recipe.rules = [{ id: 'fill', kind: 'fill', column: 'name', enabled: true, from: '', to: 'x'.repeat(10000) }];
  const d = parseCSV('sku,name\n' + Array.from({ length: 900 }, (_, i) => `${i},`).join('\n'), 'expansion.csv');
  const invalidBackup = { format: 'rowline-workspace', version: 1, dataset: d, workspace: w };
  await page.locator('input[type=file]').nth(2).setInputFiles({ name: 'oversized-result.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidBackup)) }); await settled(page);
  await expect(page.locator('.alert.error')).toContainText('8 МБ'); expect(await backup(page)).toEqual(before);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('rowline-workspace-v1')))!)).toEqual(before);
  const good = emptyWorkspace(['sku', 'name']).recipe; good.rules = [{ id: 'upper', kind: 'upper', column: 'name', enabled: true, from: '', to: '' }];
  // Manual edit remains final. Remove it, then exercise the prepared recipe result through undo/redo.
  await activate(page.getByRole('button', { name: 'Убрать ручную правку ячейки', exact: true })); await settled(page);
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(good)) }); await settled(page);
  for (let i = 0; i < 2; i++) {
    await expect(page.getByLabel('Новое значение', { exact: true })).toHaveValue('  ORIGINAL  ');
    await activate(page.getByRole('button', { name: 'Отменить действие', exact: true })); await settled(page); await expect(page.getByLabel('Новое значение', { exact: true })).toHaveValue('  original  ');
    await activate(page.getByRole('button', { name: 'Повторить действие', exact: true })); await settled(page);
  }
});

test('BOM, commas, escaped quotes, multiline and empty fields survive UI export/reimport for every delimiter', async ({ page }) => {
  const errors: string[] = [], sends: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { if (['POST', 'PUT', 'PATCH'].includes(req.method())) sends.push(req.url()); });
  await page.goto('./'); await upload(page, fixture, 'quoting.csv'); const expected = parseCSV(fixture);
  await expect(page.locator('.stat.total strong')).toHaveText('5'); await activate(page.getByRole('button', { name: /^Экспорт/ })); await page.getByLabel('Защищать от формул').uncheck();
  for (const delimiter of [',', ';', '\t', '|'] as const) {
    await page.getByLabel('Разделитель экспорта', { exact: true }).selectOption(delimiter);
    const exported = await download(page, 'Очищенный CSV'); expect(exported.text.charCodeAt(0)).toBe(0xfeff);
    expect(parseCSV(exported.text, 'roundtrip.csv', delimiter).rows.map(r => r.values)).toEqual(expected.rows.map(r => r.values));
    expect(exported.text).toBe(exportClean(expected, processDataset(expected, emptyWorkspace(expected.headers)), { ...exact, delimiter }));
  }
  await page.screenshot({ path: `qa-local/${test.info().project.name}-reliable-export.png`, fullPage: true });
  await page.keyboard.press('Escape'); await upload(page, fixture, 'same-again.csv'); await upload(page, fixture, 'same-again.csv');
  expect((await backup(page)).dataset.rows.map((r: any) => r.values)).toEqual(expected.rows.map(r => r.values)); expect(errors).toEqual([]); expect(sends).toEqual([]);
});

test('a recipe whose output exceeds the budget leaves accepted data, rules and persistence intact', async ({ page }) => {
  await page.goto('./'); await upload(page, 'sku,name\n' + Array.from({ length: 900 }, (_, i) => `${i},`).join('\n'));
  await page.getByLabel('Сохранять эту работу на устройстве').check(); const before = await backup(page);
  const recipe = emptyWorkspace(['sku', 'name']).recipe;
  recipe.rules = [{ id: 'large-fill', kind: 'fill', column: 'name', enabled: true, from: '', to: 'x'.repeat(10000) }];
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'expansion.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(recipe)) }); await settled(page);
  await expect(page.locator('.alert.error')).toContainText('8 МБ'); expect(await backup(page)).toEqual(before);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('rowline-workspace-v1')))!)).toEqual(before);
  await expect(page.locator('.rule-card')).toHaveCount(0); await expect(page.locator('.stat.ready strong')).toHaveText('900');
  await expect(page.getByRole('button', { name: /^Экспорт/ })).toBeEnabled();
});

test('keyboard Enter/Escape preserves modal focus and Ctrl+Z/Ctrl+Shift+Z recomputes the right workspace', async ({ page }) => {
  await page.goto('./'); await upload(page, 'sku,name\n001,original'); await edit(page, 'keyboard edit');
  await page.getByRole('button', { name: 'Отменить действие', exact: true }).focus(); await page.keyboard.press('Control+z'); await settled(page);
  await expect(page.getByLabel('Новое значение', { exact: true })).toHaveValue('original');
  await page.keyboard.press('Control+Shift+z'); await settled(page); await expect(page.getByLabel('Новое значение', { exact: true })).toHaveValue('keyboard edit');
  const opener = page.getByRole('button', { name: 'Новый файл', exact: true }); await opener.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible(); await page.getByLabel('CSV с заголовками в первой записи').fill('sku,name\n999,unsubmitted');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(opener).toBeFocused();
  expect((await backup(page)).workspace.edits['2'].name).toBe('keyboard edit');
});

test('storage removal refusal stays visible after a successful replacement and data remains downloadable', async ({ page }) => {
  await page.goto('./'); await upload(page, 'sku,name\n001,old'); await page.getByLabel('Сохранять эту работу на устройстве').check();
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('rowline-workspace-v1'))).toBe(true);
  await page.evaluate(() => { Storage.prototype.removeItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  await upload(page, 'sku,name\n002,current', 'replacement.csv');
  await expect(page.locator('.alert.error')).toContainText('Браузер запретил удалить');
  expect((await backup(page)).dataset.rows[0].values).toEqual(['002', 'current']);
  await activate(page.getByRole('button', { name: /^Экспорт/ }));
  expect(parseCSV((await download(page, 'Очищенный CSV')).text).rows[0].values).toEqual(['002', 'current']);
});
