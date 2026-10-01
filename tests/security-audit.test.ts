import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, emptyWorkspace, processDataset, validateRecipe, parseRecipe, exportRecipe, serializeCSV, exportClean, exportRejected, makeBackup, restoreBackup, DEFAULT_EXPORT, LIMITS, type Validation } from '../src/core.ts';

const exact = { ...DEFAULT_EXPORT, safe: false };
const validation = (column: string, patch: Partial<Validation> = {}): Validation => ({ column, required: false, unique: false, type: 'text', min: '', max: '', allowed: [], ...patch });

test('audit: prototype-like CSV headers survive edits, backup, report and exact export', () => {
  const dataset = parseCSV('__proto__,constructor,toString\nraw,value,text');
  const workspace = emptyWorkspace(dataset.headers);
  const edits = Object.create(null);
  Object.defineProperty(edits, '__proto__', { value: '<svg onload=alert(1)>', enumerable: true });
  Object.defineProperty(edits, 'constructor', { value: '=1+1', enumerable: true });
  workspace.edits['2'] = edits;
  const restored = restoreBackup(makeBackup(dataset, workspace));
  const result = processDataset(restored.dataset, restored.workspace);
  assert.deepEqual(result.ready[0].values, ['<svg onload=alert(1)>', '=1+1', 'text']);
  assert.deepEqual(parseCSV(exportClean(dataset, result, exact)).rows[0].values, result.ready[0].values);
  assert.equal(({} as { polluted?: string }).polluted, undefined);
  assert.equal(Object.getPrototypeOf(restored.workspace.edits), null);
  assert.equal(Object.getPrototypeOf(restored.workspace.edits['2']), null);
});

test('audit: recipe rejects prototype keys at every imported schema layer', () => {
  const recipe = emptyWorkspace(['id']).recipe;
  for (const mutate of [
    (value: any) => { Object.defineProperty(value, '__proto__', { value: { polluted: true }, enumerable: true }); },
    (value: any) => { value.rules = [JSON.parse('{"id":"1","kind":"trim","column":null,"enabled":true,"from":"","to":"","__proto__":{"polluted":true}}')]; },
    (value: any) => { value.validations = [{ ...validation('id'), constructor: { prototype: { polluted: true } } }]; },
  ]) {
    const value = structuredClone(recipe); mutate(value);
    assert.throws(() => parseRecipe(JSON.stringify(value)));
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('audit: every formula marker is protected in clean and rejected cells including leading Unicode whitespace', () => {
  const risky = ['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd', '\ncmd', ' \t=cmd', '\u00a0=cmd', '\uFEFF=cmd', '\u2003@cmd'];
  const dataset = parseCSV(serializeCSV(['id', 'payload'], risky.map((v, i) => [String(i), v]), exact));
  const workspace = emptyWorkspace(dataset.headers);
  const result = processDataset(dataset, workspace);
  assert.deepEqual(parseCSV(exportClean(dataset, result, DEFAULT_EXPORT)).rows.map(row => row.values[1]), risky.map(v => "'" + v));
  workspace.excluded['2'] = '=excluded reason';
  const rejected = parseCSV(exportRejected(dataset, processDataset(dataset, workspace), DEFAULT_EXPORT));
  assert.equal(rejected.rows[0].values[1], "'=excluded reason");
  assert.equal(rejected.rows[0].values[4], "'=cmd");
  assert.deepEqual(JSON.parse(rejected.rows[0].values[2]), ['0', '=cmd']);
});

test('audit: exhaustive quoted delimiters, record terminators, Unicode and formula strings round-trip in exact mode', () => {
  const values = ['', '001', '900719925474099312345678901234567890', '\u049a\u0430\u0437\u0430\u049b\u0448\u0430 \u0420\u0443\u0441\u0441\u043a\u0438\u0439', 'a,b;c|d\te', '"quoted"', 'line1\r\nline2', 'bare\rcarriage', '\n', "'=already", '=1+1', '  spaces  '];
  for (const delimiter of [',', ';', '\t', '|'] as const) {
    for (const newline of ['\r\n', '\n'] as const) {
      const csv = serializeCSV(['id', 'value'], values.map((v, i) => [String(i), v]), { ...exact, delimiter, newline });
      assert.deepEqual(parseCSV(csv, 'audit.csv', delimiter).rows.map(row => row.values[1]), values);
    }
  }
});

test('audit: precise signed decimal comparison retains representation and handles 256-character boundaries', () => {
  const digits = '9'.repeat(256);
  const dataset = parseCSV('id,n\n001,+0001.00\n002,-0.000\n003,' + digits + '\n004,' + digits + '9');
  const workspace = emptyWorkspace(dataset.headers);
  workspace.recipe.validations = [validation('n', { type: 'number', min: '-0.000', max: digits })];
  const result = processDataset(dataset, workspace);
  assert.equal(result.ready.length, 3);
  assert.equal(result.rejected[0].issues[0].code, 'type');
  assert.deepEqual(result.ready.map(row => row.values[1]), ['+0001.00', '-0.000', digits]);
});

test('audit: invalid backup edits/exclusions are rejected without mutating data or prototypes', () => {
  const dataset = parseCSV('id\nraw');
  const original = makeBackup(dataset, emptyWorkspace(dataset.headers));
  for (const mutate of [
    (value: any) => { value.workspace.edits = JSON.parse('{"__proto__":{"polluted":true}}'); },
    (value: any) => { value.workspace.edits = { '2': { missing: 'x' } }; },
    (value: any) => { value.workspace.edits = { '2': { id: 12 } }; },
    (value: any) => { value.workspace.excluded = { '3': 'missing record' }; },
    (value: any) => { value.dataset.rows[0].id = 1; },
  ]) {
    const value = JSON.parse(original); mutate(value);
    assert.throws(() => restoreBackup(JSON.stringify(value)));
  }
  assert.equal(dataset.rows[0].values[0], 'raw');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('audit: expansion limit blocks export without changing immutable raw data', () => {
  const dataset = parseCSV('id\n' + Array(1000).fill('x').join('\n'));
  const before = JSON.stringify(dataset);
  const workspace = emptyWorkspace(dataset.headers);
  workspace.recipe.rules = [{ id: 'expand', kind: 'replace', column: 'id', enabled: true, from: 'x', to: 'y'.repeat(10_000) }];
  assert.throws(() => processDataset(dataset, workspace));
  assert.equal(JSON.stringify(dataset), before);
});

test('regression: allowed-value diagnostics remain bounded even for valid large lists', () => {
  const dataset = parseCSV('status\n' + Array(1000).fill('invalid').join('\n'));
  const workspace = emptyWorkspace(dataset.headers);
  workspace.recipe.validations = [validation('status', { allowed: Array.from({ length: 100 }, (_, i) => `${i}:` + 'a'.repeat(125)) })];
  workspace.recipe = parseRecipe(JSON.stringify(workspace.recipe), dataset.headers);
  const result = processDataset(dataset, workspace);
  assert.equal(result.issues.length, 1000);
  assert.ok(result.issues.every(issue => issue.message.length < 500), 'An imported recipe must not multiply its complete allowed list into every issue');
});

test('regression: recipe aggregate limit is enforced when creating a recipe, before self-export becomes non-importable', () => {
  const recipe = emptyWorkspace(['id']).recipe;
  recipe.rules = Array.from({ length: 26 }, (_, i) => ({ id: String(i), kind: 'fill', column: 'id', enabled: true, from: '', to: 'x'.repeat(10_000) }));
  assert.ok(new TextEncoder().encode(JSON.stringify(recipe)).byteLength > 256_000);
  assert.throws(() => validateRecipe(recipe), 'Create and import must enforce the same total recipe byte limit');
});

test('regression: actual recipe export respects its import byte limit near the formatting boundary', () => {
  const recipe = emptyWorkspace(['id']).recipe;
  recipe.validations = [validation('id', { allowed: Array.from({ length: 1000 }, () => 'x'.repeat(245)) })];
  let checked;
  try { checked = validateRecipe(recipe); }
  catch { return; } // Refusing before export is a valid bounded behavior.
  assert.ok(new TextEncoder().encode(JSON.stringify(checked, null, 2)).byteLength > 256_000, 'Fixture exercises a recipe whose pretty representation crosses the cap');
  const exported = exportRecipe(checked);
  assert.ok(new TextEncoder().encode(exported).byteLength <= 256_000);
  assert.deepEqual(parseRecipe(exported), checked, 'A validated recipe must round-trip through the actual JSON exported by the UI');
});

test('regression: safe export refuses a formula-protected duplicate-header collision; exact mode round-trips', () => {
  const dataset = parseCSV(serializeCSV(['=sku', "'=sku"], [['1', '2']], exact));
  const result = processDataset(dataset, emptyWorkspace(dataset.headers));
  assert.throws(() => exportClean(dataset, result, DEFAULT_EXPORT), 'Protected output headers would both become apostrophe-equals-sku');
  assert.deepEqual(parseCSV(exportClean(dataset, result, exact)).headers, dataset.headers);
});

test('regression: generated backups are restorable or refused before an invalid artifact is offered', () => {
  const dataset = parseCSV('value\n' + Array(1000).fill('x'.repeat(1000)).join('\n'));
  const workspace = emptyWorkspace(dataset.headers);
  for (const row of dataset.rows) workspace.edits[String(row.id)] = { value: 'y'.repeat(8000) };
  assert.equal(processDataset(dataset, workspace).ready.length, 1000);
  try {
    const backup = makeBackup(dataset, workspace);
    assert.ok(new TextEncoder().encode(backup).byteLength <= LIMITS.outputBytes, 'makeBackup must not generate a file above the restoreBackup byte limit');
    assert.equal(restoreBackup(backup).dataset.rows.length, 1000);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(String(error), /8|limit|лимит|резерв|backup/i);
  }
});

test('regression: header-length limits agree across parsing, recipes and backup restore', () => {
  for (const csv of [
    'h'.repeat(257) + '\nvalue',
    'h'.repeat(10_001) + '\nvalue',
    Array.from({ length: 50 }, (_, i) => `h${i}:` + 'h'.repeat(7000)).join(',') + '\n' + Array(50).fill('value').join(','),
  ]) {
    let dataset;
    try { dataset = parseCSV(csv); }
    catch { continue; } // Rejecting unsupported headers at import is valid.
    const workspace = emptyWorkspace(dataset.headers);
    assert.deepEqual(parseRecipe(JSON.stringify(validateRecipe(workspace.recipe))).columns, dataset.headers, 'CSV accepted a header set its recipe layer cannot represent');
    assert.deepEqual(restoreBackup(makeBackup(dataset, workspace)).dataset.headers, dataset.headers, 'CSV accepted a header set its backup layer cannot represent');
  }
});
