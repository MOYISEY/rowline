import Papa from 'papaparse';

export const LIMITS = { bytes: 2 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, rows: 10_000, columns: 100, cells: 500_000, rules: 100 } as const;
export type Delimiter = '' | ',' | ';' | '\t' | '|';
export type SourceRow = { id: number; values: string[]; structural: string[] };
export type Dataset = { name: string; headers: string[]; rows: SourceRow[]; delimiter: string; bytes: number };
export type RuleKind = 'trim' | 'space' | 'upper' | 'lower' | 'replace' | 'fill' | 'empty';
export type Rule = { id: string; kind: RuleKind; column: string | null; enabled: boolean; from: string; to: string };
export type Validation = { column: string; required: boolean; unique: boolean; type: 'text' | 'integer' | 'number' | 'date' | 'email'; min: string; max: string; allowed: string[] };
export type Recipe = { format: 'rowline-recipe'; version: 1; columns: string[]; rules: Rule[]; validations: Validation[] };
export type Workspace = { recipe: Recipe; edits: Record<string, Record<string, string>>; excluded: Record<string, string> };
export type Issue = { id: string; rowId: number; column: number | null; code: string; message: string; severity: 'error' };
export type ProcessedRow = { id: number; raw: string[]; values: string[]; excluded: boolean; reasons: string[]; issues: Issue[]; changedColumns: number[] };
export type Result = { rows: ProcessedRow[]; issues: Issue[]; ready: ProcessedRow[]; rejected: ProcessedRow[]; changedCells: number; changedRows: number; duplicateRows: number };
export type ExportOptions = { delimiter: ',' | ';' | '\t' | '|'; bom: boolean; safe: boolean; newline: '\r\n' | '\n' };
export const DEFAULT_EXPORT: ExportOptions = { delimiter: ';', bom: true, safe: true, newline: '\r\n' };

export function parseCSV(text: string, name = 'вставка.csv', delimiter: Delimiter = ''): Dataset {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > LIMITS.bytes) throw new Error('Файл больше 2 МБ. Разделите его на несколько CSV.');
  if (text.includes('\u0000')) throw new Error('Обнаружены нулевые байты. Поддерживается текстовый CSV в UTF-8 или Windows-1251, не Excel XLSX / UTF-16.');
  if (!text.replace(/^\uFEFF/, '').trim()) throw new Error('CSV пуст. Нужна строка заголовков.');
  const cleanText = text.replace(/^\uFEFF/, '');
  // Detection skips blank records only in its short probe. Actual parsing below
  // preserves them; a trailing newline must not spoil small-file detection.
  const detected = delimiter || Papa.parse<string[]>(cleanText, { preview: 20, skipEmptyLines: true, delimitersToGuess: [',', ';', '\t', '|'] }).meta.delimiter || ',';
  const parsed = Papa.parse<string[]>(cleanText, {
    header: false, delimiter: detected, skipEmptyLines: false, dynamicTyping: false,
  });
  const fatal = parsed.errors.filter(e => e.code !== 'UndetectableDelimiter');
  if (fatal.length) throw new Error(`Неоднозначный CSV: ${fatal[0].message}. Проверьте закрывающие кавычки. Импорт отменён, текущие данные сохранены.`);
  const records = parsed.data;
  // Papa includes a synthetic empty record after the final line terminator.
  // Remove exactly that record; preserve every intentional blank record before it.
  if (/(?:\r\n|\r|\n)$/.test(text) && records.at(-1)?.length === 1 && records.at(-1)?.[0] === '') records.pop();
  const headers = records[0];
  if (!headers?.length || headers.some(h => !h.trim())) throw new Error('У каждой колонки должно быть непустое имя. Исправьте заголовок CSV и повторите импорт.');
  if (headers.some(h => h.length > 256)) throw new Error('Имя колонки длиннее 256 символов. Сократите заголовок CSV и повторите импорт.');
  if (new Set(headers).size !== headers.length) throw new Error('Повторяющиеся имена колонок. Дайте каждой колонке уникальное имя в CSV; данные не были объединены.');
  if (headers.length > LIMITS.columns || records.length - 1 > LIMITS.rows || (records.length - 1) * headers.length > LIMITS.cells) throw new Error('Лимит: 10 000 строк, 100 колонок и 500 000 ячеек. Разделите CSV.');
  if (records.reduce((n, r) => n + r.length, 0) > LIMITS.cells + LIMITS.columns) throw new Error('В файле больше 500 000 ячеек. Разделите CSV.');
  return {
    name, headers, delimiter: parsed.meta.delimiter || delimiter || ',', bytes,
    rows: records.slice(1).map((values, i) => ({ id: i + 2, values, structural: values.length === headers.length ? [] : [`Ячеек: ${values.length}, ожидается: ${headers.length}. Исправьте CSV: такая строка не попадёт в очищенный файл.`] })),
  };
}

export function emptyWorkspace(headers: string[]): Workspace {
  return { recipe: { format: 'rowline-recipe', version: 1, columns: [...headers], rules: [], validations: [] }, edits: {}, excluded: {} };
}
export function applyRule(value: string, rule: Rule): string {
  switch (rule.kind) {
    case 'trim': return value.trim();
    case 'space': return value.replace(/\s+/gu, ' ');
    case 'upper': return value.toLocaleUpperCase('ru');
    case 'lower': return value.toLocaleLowerCase('ru');
    case 'replace': return value === rule.from ? rule.to : value;
    case 'fill': return value.trim() === '' ? rule.to : value;
    default: return value;
  }
}

function decimal(value: string): { n: bigint; scale: number } | null {
  if (value.length > 256 || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [whole, frac = ''] = unsigned.split('.');
  return { n: BigInt(whole + frac) * (negative ? -1n : 1n), scale: frac.length };
}
function compareDecimal(a: string, b: string): number {
  const x = decimal(a)!, y = decimal(b)!;
  const scale = Math.max(x.scale, y.scale);
  const left = x.n * 10n ** BigInt(scale - x.scale), right = y.n * 10n ** BigInt(scale - y.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function processDataset(dataset: Dataset, workspace: Workspace): Result {
  const headers = dataset.headers;
  let transformedBytes = 0;
  const encoder = new TextEncoder();
  const rows: ProcessedRow[] = dataset.rows.map(source => {
    const values = [...source.values];
    const reasons: string[] = [];
    for (const rule of workspace.recipe.rules) {
      if (!rule.enabled) continue;
      if (rule.kind === 'empty') {
        if (values.every(v => v.trim() === '')) reasons.push('Правило: убрать пустые строки');
        continue;
      }
      const col = rule.column === null ? -1 : headers.indexOf(rule.column);
      for (let i = 0; i < values.length; i++) {
        if (i < headers.length && (rule.column === null || i === col)) values[i] = applyRule(values[i], rule);
      }
    }
    const edits = workspace.edits[String(source.id)] || {};
    for (const [column, value] of Object.entries(edits)) {
      const col = headers.indexOf(column);
      if (col >= 0 && col < values.length) values[col] = value;
    }
    if (workspace.excluded[String(source.id)]) reasons.push(workspace.excluded[String(source.id)]);
    transformedBytes += values.reduce((n, v) => n + encoder.encode(v).byteLength, 0);
    if (transformedBytes > LIMITS.outputBytes) throw new Error('Очищенные значения превышают 8 МБ. Укоротите правило или ручную правку, отключите правило либо отмените действие. Экспорт заблокирован; показан предыдущий результат.');
    const issues: Issue[] = source.structural.map((message, i) => ({ id: `${source.id}-structure-${i}`, rowId: source.id, column: null, code: 'structure', message, severity: 'error' }));
    return { id: source.id, raw: source.values, values, excluded: reasons.length > 0, reasons, issues, changedColumns: values.flatMap((v, i) => v !== source.values[i] ? [i] : []) };
  });
  for (const validation of workspace.recipe.validations) {
    const col = headers.indexOf(validation.column);
    if (col < 0) continue;
    const seen = new Map<string, ProcessedRow[]>();
    const allowed = new Set(validation.allowed);
    const allowedSummary = validation.allowed.slice(0, 8).map(v => v.length > 40 ? v.slice(0, 40) + '…' : v).join(', ') + (validation.allowed.length > 8 ? ` и ещё ${validation.allowed.length - 8}` : '');
    const add = (row: ProcessedRow, code: string, message: string) => row.issues.push({ id: `${row.id}-${col}-${code}`, rowId: row.id, column: col, code, message, severity: 'error' });
    for (const row of rows) {
      if (row.excluded || row.values.length !== headers.length) continue;
      const value = row.values[col];
      const blank = value.trim() === '';
      if (validation.required && blank) add(row, 'required', 'Обязательное значение отсутствует');
      if (blank) continue;
      if (validation.unique) { const group = seen.get(value); if (group) group.push(row); else seen.set(value, [row]); }
      if (validation.type === 'integer' || validation.type === 'number') {
        const numeric = decimal(value);
        if (!numeric || (validation.type === 'integer' && !/^[+-]?\d+$/.test(value))) add(row, 'type', validation.type === 'integer' ? 'Ожидается целое число (до 256 символов), без пробелов' : 'Ожидается десятичное число с точкой (до 256 символов)');
        else if ((validation.min !== '' && compareDecimal(value, validation.min) < 0) || (validation.max !== '' && compareDecimal(value, validation.max) > 0)) add(row, 'range', `Вне диапазона ${validation.min || '−∞'} … ${validation.max || '+∞'}`);
      } else if (validation.type === 'date' && !validDate(value)) add(row, 'type', 'Ожидается существующая дата YYYY-MM-DD');
      else if (validation.type === 'email' && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) add(row, 'type', 'Неверный синтаксис email');
      if (allowed.size && !allowed.has(value)) add(row, 'allowed', `Допустимо: ${allowedSummary}`);
    }
    for (const group of seen.values()) if (group.length > 1) {
      const message = `Повторяется в записях ${group.slice(0, 12).map(r => r.id).join(', ')}${group.length > 12 ? ` и ещё ${group.length - 12} (${group.length} всего)` : ''}`;
      for (const row of group) add(row, 'unique', message);
    }
  }
  const issues = rows.filter(r => !r.excluded).flatMap(r => r.issues);
  const ready = rows.filter(r => !r.excluded && r.issues.length === 0);
  const rejected = rows.filter(r => r.excluded || r.issues.length > 0);
  return { rows, issues, ready, rejected, changedCells: rows.reduce((n, r) => n + r.changedColumns.length, 0), changedRows: rows.filter(r => r.changedColumns.length).length, duplicateRows: rows.filter(r => !r.excluded && r.issues.some(i => i.code === 'unique')).length };
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function only(obj: Record<string, unknown>, keys: string[]) { if (Object.keys(obj).some(k => !keys.includes(k))) throw new Error('Рецепт содержит неизвестные поля.'); }
function string(value: unknown, max = 10_000): value is string { return typeof value === 'string' && value.length <= max; }
export function validateRecipe(input: unknown, headers?: string[]): Recipe {
  if (!object(input)) throw new Error('Рецепт должен быть JSON-объектом Rowline.');
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 256_000) throw new Error('Рецепт больше 256 КБ. Удалите правила или сократите их значения.');
  only(input, ['format', 'version', 'columns', 'rules', 'validations']);
  if (input.format !== 'rowline-recipe' || input.version !== 1) throw new Error('Поддерживается только рецепт Rowline версии 1.');
  if (!Array.isArray(input.columns) || !input.columns.length || input.columns.length > LIMITS.columns || !input.columns.every(c => string(c, 256) && c.trim()) || new Set(input.columns).size !== input.columns.length) throw new Error('Неверный список колонок рецепта (имя до 256 символов).');
  const columns = input.columns as string[];
  if (headers) {
    const missing = columns.filter(c => !headers.includes(c));
    if (missing.length) throw new Error(`В CSV нет колонок рецепта: ${missing.join(', ')}. Рецепт не применён. Имена сравниваются точно.`);
  }
  if (!Array.isArray(input.rules) || input.rules.length > LIMITS.rules || !Array.isArray(input.validations) || input.validations.length > LIMITS.columns) throw new Error('Слишком много правил или проверок.');
  const ids = new Set<string>();
  for (const r of input.rules) {
    if (!object(r)) throw new Error('Неверное правило.');
    only(r, ['id', 'kind', 'column', 'enabled', 'from', 'to']);
    if (!string(r.id, 100) || !r.id || ids.has(r.id) || !['trim', 'space', 'upper', 'lower', 'replace', 'fill', 'empty'].includes(String(r.kind)) || !(r.column === null || (string(r.column) && columns.includes(r.column))) || typeof r.enabled !== 'boolean' || !string(r.from) || !string(r.to)) throw new Error('Недопустимое правило очистки.');
    if (r.kind === 'empty' && r.column !== null) throw new Error('Удаление пустых строк применяется ко всей таблице.');
    ids.add(r.id);
  }
  const checked = new Set<string>();
  for (const v of input.validations) {
    if (!object(v)) throw new Error('Неверная проверка.');
    only(v, ['column', 'required', 'unique', 'type', 'min', 'max', 'allowed']);
    if (!string(v.column) || !columns.includes(v.column) || checked.has(v.column) || typeof v.required !== 'boolean' || typeof v.unique !== 'boolean' || !['text', 'integer', 'number', 'date', 'email'].includes(String(v.type)) || !string(v.min, 256) || !string(v.max, 256) || !Array.isArray(v.allowed) || v.allowed.length > 1000 || !v.allowed.every(a => string(a))) throw new Error('Недопустимая проверка колонки.');
    const min = v.min as string, max = v.max as string;
    if ((min && !decimal(min)) || (max && !decimal(max)) || (min && max && compareDecimal(min, max) > 0)) throw new Error('Неверный диапазон: числа с точкой, минимум не больше максимума.');
    if (v.type === 'integer' && ((min && !/^[+-]?\d+$/.test(min)) || (max && !/^[+-]?\d+$/.test(max)))) throw new Error('Границы целого числа должны быть целыми.');
    if (!['integer', 'number'].includes(String(v.type)) && (min || max)) throw new Error('Диапазон применим только к числам.');
    checked.add(v.column);
  }
  // Rebuild from JSON after validation; no executable expressions or inherited keys.
  return JSON.parse(JSON.stringify(input)) as Recipe;
}
export function parseRecipe(text: string, headers?: string[]): Recipe {
  if (new TextEncoder().encode(text).byteLength > 256_000) throw new Error('Рецепт больше 256 КБ.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Рецепт не является корректным JSON.'); }
  return validateRecipe(value, headers);
}
export function exportRecipe(recipe: Recipe): string { return JSON.stringify(validateRecipe(recipe)); }

// Includes whitespace before a formula marker. Safe mode deliberately changes
// risky text by prefixing an apostrophe, including header cells.
export const FORMULA = /^(?:[\s\uFEFF]*[=+\-@]|[\t\r\n])/u;
export function formulaCount(headers: string[], rows: string[][]): number { return [...headers, ...rows.flat()].filter(v => FORMULA.test(v)).length; }
export function exportHeaderCollision(headers: string[], safe: boolean): boolean {
  const protectedHeaders = headers.map(h => safe && FORMULA.test(h) ? "'" + h : h);
  return new Set(protectedHeaders).size !== headers.length;
}
export function serializeCSV(headers: string[], rows: string[][], options: ExportOptions): string {
  if (exportHeaderCollision(headers, options.safe)) throw new Error('Защита формул создаёт одинаковые заголовки CSV. Исправьте имена в исходном файле либо явно отключите защиту для доверенного импорта. Очищенный экспорт не создан.');
  // Quote all cells, including an empty final single-column record. Otherwise
  // it is indistinguishable from a final newline and cannot round-trip.
  const result = Papa.unparse([headers, ...rows], { delimiter: options.delimiter, newline: options.newline, quotes: true, escapeFormulae: options.safe ? FORMULA : false });
  return (options.bom ? '\uFEFF' : '') + result;
}
export function exportClean(dataset: Dataset, result: Result, options: ExportOptions): string { return serializeCSV(dataset.headers, result.ready.map(r => r.values), options); }
export function exportRejected(dataset: Dataset, result: Result, options: ExportOptions): string {
  return serializeCSV(['rowline_record', 'rowline_reasons', 'rowline_original_json', ...dataset.headers.map(h => `cleaned:${h}`)], result.rejected.map(r => [String(r.id), [...r.reasons, ...r.issues.map(i => `${i.column === null ? 'CSV' : dataset.headers[i.column]}: ${i.message}`)].join(' | '), JSON.stringify(r.raw), ...dataset.headers.map((_, c) => r.values[c] ?? '')]), options);
}
export function createReport(dataset: Dataset, workspace: Workspace, result: Result, options: ExportOptions) {
  return { format: 'rowline-report', version: 1, createdAt: new Date().toISOString(), source: { name: dataset.name, records: dataset.rows.length, columns: dataset.headers, recordNumbering: 'Logical CSV records including header as 1; multiline cells count as one record.' }, summary: { ready: result.ready.length, rejected: result.rejected.length, issues: result.issues.length, changedCells: result.changedCells, duplicateRows: result.duplicateRows }, export: { ...options, formulaProtectedCells: options.safe ? formulaCount(dataset.headers, result.ready.map(r => r.values)) : 0 }, recipe: workspace.recipe, manualEdits: Object.entries(workspace.edits).flatMap(([row, edits]) => Object.keys(edits).map(column => ({ record: Number(row), column }))), rejected: result.rejected.map(r => ({ record: r.id, reasons: [...r.reasons, ...r.issues.map(i => i.message)], issues: r.issues })), changes: result.rows.filter(r => r.changedColumns.length).map(r => ({ record: r.id, columns: r.changedColumns.map(c => dataset.headers[c]) })) };
}

export function makeBackup(dataset: Dataset, workspace: Workspace): string {
  const text = JSON.stringify({ format: 'rowline-workspace', version: 1, dataset, workspace });
  if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) throw new Error('Резервная копия превышает 8 МБ из-за исходника и правок. Сократите правки либо скачайте очищенный CSV и отчёт. Работа остаётся в этой вкладке.');
  return text;
}
export function restoreBackup(text: string): { dataset: Dataset; workspace: Workspace } {
  if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) throw new Error('Резервная копия больше 8 МБ.');
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('Неверный JSON резервной копии.'); }
  if (!object(input) || input.format !== 'rowline-workspace' || input.version !== 1 || !object(input.dataset) || !object(input.workspace)) throw new Error('Неверный формат резервной копии Rowline.');
  const d = input.dataset, w = input.workspace;
  if (!string(d.name, 500) || !Array.isArray(d.headers) || !d.headers.every(h => string(h, 256)) || !Array.isArray(d.rows) || d.rows.length > LIMITS.rows || ![',', ';', '\t', '|'].includes(String(d.delimiter))) throw new Error('Неверные данные резервной копии.');
  const dataRows = d.rows as unknown[];
  if (!dataRows.every((r, i) => object(r) && r.id === i + 2 && Array.isArray(r.values) && r.values.every(v => string(v, LIMITS.bytes)))) throw new Error('Неверные строки резервной копии.');
  const values = dataRows.map(r => (r as { values: string[] }).values);
  const headers = d.headers as string[];
  if (!headers.length || headers.length > LIMITS.columns || headers.some(h => !h.trim()) || new Set(headers).size !== headers.length || values.length * headers.length > LIMITS.cells || values.reduce((n, r) => n + r.length, 0) > LIMITS.cells) throw new Error('Резервная копия превышает лимиты таблицы или содержит неверные заголовки.');
  const rawBytes = [...headers, ...values.flat()].reduce((n, v) => n + new TextEncoder().encode(v).byteLength, 0);
  if (rawBytes > LIMITS.bytes) throw new Error('Исходные значения резервной копии превышают 2 МБ.');
  // Validate records directly. Reserializing with additional quoting can make a
  // valid 2 MB source larger than the input limit; it also risks empty records.
  const dataset: Dataset = { name: d.name, headers, delimiter: d.delimiter as string, bytes: typeof d.bytes === 'number' && Number.isFinite(d.bytes) && d.bytes >= 0 && d.bytes <= LIMITS.bytes ? d.bytes : rawBytes, rows: values.map((values, i) => ({ id: i + 2, values, structural: values.length === headers.length ? [] : [`Ячеек: ${values.length}, ожидается: ${headers.length}. Исправьте CSV: такая строка не попадёт в очищенный файл.`] })) };
  const recipe = validateRecipe(w.recipe, dataset.headers);
  if (!object(w.edits) || !object(w.excluded)) throw new Error('Неверные ручные изменения.');
  const edits: Workspace['edits'] = Object.create(null), excluded: Workspace['excluded'] = Object.create(null);
  const rowIds = new Set(dataset.rows.map(r => String(r.id)));
  for (const [id, rowEdits] of Object.entries(w.edits)) {
    if (!rowIds.has(id) || !object(rowEdits)) throw new Error('Правки ссылаются на отсутствующую строку.');
    edits[id] = Object.create(null);
    for (const [col, value] of Object.entries(rowEdits)) {
      if (!dataset.headers.includes(col) || !string(value, 10_000)) throw new Error('Неверная правка ячейки (до 10 000 символов).');
      edits[id][col] = value;
    }
  }
  for (const [id, reason] of Object.entries(w.excluded)) {
    if (!rowIds.has(id) || !string(reason, 1000) || !reason.trim()) throw new Error('Неверная причина исключения.');
    excluded[id] = reason;
  }
  return { dataset, workspace: { recipe, edits, excluded } };
}

export const DEMO = 'sku,name,stock,status,email,updated_at\r\n00124,  Настольная лампа  ,12,active,lamp@example.test,2026-09-28\r\n00125,Подставка для ноутбука,8,active,stand@example.test,2026-09-29\r\n00124,Настольная лампа,12,active,lamp@example.test,2026-09-28\r\n00126,"Блокнот, в точку",-3,active,notes@example.test,2026-09-30\r\n,Органайзер,6,active,organizer@example.test,2026-09-30\r\n00128,Кабель USB-C,много,active,cable@example.test,2026-09-30\r\n00129,Термокружка,4,ACTIVE,cup@example.test,2026-09-30\r\n00130,  Чехол    для планшета ,7,draft,case@example.test,2026-09-30\r\n00131,Сумка,2,archived,bag@example.test,2026-09-30\r\n00132,"Набор стикеров\nКөк / синий",10,active,stickers@example.test,2026-09-30\r\n90071992547409931234,Держатель телефона,5,active,holder@example.test,2026-09-30\r\n00134,Коврик для мыши,0,active,mat@example.test,2026-09-30\r\n';
export function demoWorkspace(headers: string[]): Workspace {
  const w = emptyWorkspace(headers);
  w.recipe.validations = [
    { column: 'sku', required: true, unique: true, type: 'text', min: '', max: '', allowed: [] },
    { column: 'stock', required: true, unique: false, type: 'integer', min: '0', max: '', allowed: [] },
    { column: 'status', required: true, unique: false, type: 'text', min: '', max: '', allowed: ['active', 'draft', 'archived'] },
  ];
  return w;
}
