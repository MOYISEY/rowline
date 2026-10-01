import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, emptyWorkspace, processDataset, applyRule, validDate, parseRecipe, validateRecipe, serializeCSV, exportClean, exportRejected, createReport, makeBackup, restoreBackup, DEFAULT_EXPORT, DEMO, demoWorkspace, LIMITS, type Rule, type RuleKind, type Validation } from '../src/core.ts';
const rule = (kind: RuleKind, column: string | null = null, from = '', to = ''): Rule => ({ id: `${kind}-${Math.random()}`, kind, column, enabled: true, from, to });
const validation = (column: string, other: Partial<Validation> = {}): Validation => ({ column, required: false, unique: false, type: 'text', min: '', max: '', allowed: [], ...other });
const exact = { ...DEFAULT_EXPORT, safe: false };

test('UTF-8 BOM, Cyrillic/Kazakh, huge identifiers and leading zeros remain strings', () => {
 const d = parseCSV('\uFEFFsku,name\r\n0001,Көк\r\n90071992547409931234,Әлем\r\n');
 assert.deepEqual(d.headers, ['sku','name']); assert.equal(d.rows.length, 2); assert.equal(d.rows[0].values[0], '0001'); assert.equal(d.rows[1].values[0], '90071992547409931234');
});
test('quoted commas, escaped quotes, CRLF and multiline fields', () => {
 const d = parseCSV('id,name,note\r\n001,"Лампа, белая","строка 1\r\nстрока ""2"""\r\n');
 assert.deepEqual(d.rows[0].values, ['001','Лампа, белая','строка 1\r\nстрока "2"']); assert.equal(d.rows[0].id, 2);
 assert.deepEqual(parseCSV(exportClean(d, processDataset(d, emptyWorkspace(d.headers)), exact)).rows[0].values, d.rows[0].values);
});
test('delimiter detection and explicit override for supported separators', () => {
 for (const sep of [',', ';', '\t', '|'] as const) { const d = parseCSV(`sku${sep}name\n01${sep}Көк\n`); assert.equal(d.delimiter, sep); assert.deepEqual(d.rows[0].values,['01','Көк']); }
 assert.deepEqual(parseCSV('col\nfoo;bar', 'single.csv', ',').rows[0].values,['foo;bar']);
});
test('empty input, blank/duplicate headers, malformed quotes and binary data fail explicitly', () => {
 for (const input of ['', ' \n', 'id,id\n1,2', 'id,\n1,2', 'id,name\n1,"unterminated', 'id,name\n1,"a"bad', '\0id\0']) assert.throws(() => parseCSV(input));
});
test('header-only and intentional blank records; no silent empty-row drop', () => {
 assert.equal(parseCSV('id,name\r\n').rows.length, 0); assert.equal(parseCSV('id\n').rows.length, 0);
 const d = parseCSV('id,name\n1,x\n\n\n'); assert.equal(d.rows.length, 3); assert.equal(d.rows[1].values[0], ''); assert.equal(d.rows[1].structural.length, 1);
 const one = parseCSV('id\n""'); assert.equal(one.rows.length,1); assert.equal(one.rows[0].values[0],'');
});
test('inconsistent widths retained completely and routed to rejected with original JSON', () => {
 const d = parseCSV('id,name\n1,a,EXTRA\n2\n3,b'); const w = emptyWorkspace(d.headers), r = processDataset(d,w);
 assert.equal(r.ready.length,1); assert.equal(r.rejected.length,2); assert.equal(r.ready.length+r.rejected.length,3);
 const reject = parseCSV(exportRejected(d,r,exact)); assert.deepEqual(JSON.parse(reject.rows[0].values[2]),['1','a','EXTRA']); assert.equal(reject.rows[0].values[0],'2');
});
test('ordered, toggleable transforms; exact replacement and whitespace; raw stays immutable', () => {
 const d = parseCSV('id,name\n001,  Көк    әлем  \n002,\n003, '); const before = JSON.stringify(d);
 const w = emptyWorkspace(d.headers); w.recipe.rules = [rule('trim'), rule('space','name'), rule('upper','name'), rule('replace','name','КӨК ӘЛЕМ','hello'), rule('fill','name','','blank')];
 let r = processDataset(d,w); assert.deepEqual(r.rows[0].values,['001','hello']); assert.equal(r.rows[1].values[1],'blank'); assert.equal(JSON.stringify(d),before);
 w.recipe.rules[3].enabled=false; r=processDataset(d,w); assert.equal(r.rows[0].values[1],'КӨК ӘЛЕМ');
 assert.equal(applyRule('ab',rule('replace',null,'a','z')),'ab'); assert.equal(applyRule('HELLO',rule('lower')),'hello');
});
test('remove empty rows means accounted-for exclusion, and manual edits are final', () => {
 const d=parseCSV('id,name\n, \n1, a '),w=emptyWorkspace(d.headers); w.recipe.rules=[rule('trim'),rule('empty')]; w.edits['3']={name:'  manual  '};
 const r=processDataset(d,w); assert.equal(r.rejected[0].id,2); assert.match(r.rejected[0].reasons[0],/пустые/); assert.equal(r.ready[0].values[1],'  manual  ');
});
test('required, exact uniqueness and explicit duplicate exclusion', () => {
 const d=parseCSV('sku\n001\n001\n""\n002'),w=emptyWorkspace(d.headers); w.recipe.validations=[validation('sku',{required:true,unique:true})];
 let r=processDataset(d,w); assert.equal(r.duplicateRows,2); assert.equal(r.issues.length,3);
 w.excluded['3']='Дубликат: оставлена №2'; r=processDataset(d,w); assert.equal(r.duplicateRows,0); assert.equal(r.ready.length,2); assert.equal(r.rejected.length,2);
});
test('integer validation and precise decimal ranges beyond Number.MAX_SAFE_INTEGER', () => {
 const d=parseCSV('stock\n90071992547409931234\n90071992547409931235\n1.5\n-1\nмного'),w=emptyWorkspace(d.headers);
 w.recipe.validations=[validation('stock',{type:'integer',min:'0',max:'90071992547409931234'})]; const r=processDataset(d,w);
 assert.equal(r.ready.length,1); assert.equal(r.rejected.length,4); assert.equal(r.rows[1].issues[0].code,'range');
 const d2=parseCSV('n\n0.100000000000000000001\n0.100000000000000000002'); const w2=emptyWorkspace(d2.headers);w2.recipe.validations=[validation('n',{type:'number',max:'0.100000000000000000001'})]; assert.equal(processDataset(d2,w2).ready.length,1);
});
test('ISO dates, allowed values and basic email syntax are explicit; optional blank allowed', () => {
 assert.equal(validDate('2024-02-29'),true); for(const date of ['2025-02-29','2026-04-31','2026-13-01','01/02/2026','0000-01-01']) assert.equal(validDate(date),false);
 const d=parseCSV('date,status,email\n2024-02-29,active,hello@example.test\n2025-02-29,ACTIVE,hello@\n,,'); const w=emptyWorkspace(d.headers);w.recipe.validations=[validation('date',{type:'date'}),validation('status',{allowed:['active','draft']}),validation('email',{type:'email'})];
 const r=processDataset(d,w);assert.equal(r.issues.length,3);assert.equal(r.ready.length,2);assert.equal(r.rows[0].values[0],'2024-02-29');
});
test('formula injection protection includes headers, whitespace markers, tabs, CR/LF; can be disabled for exact import', () => {
 const vals=['=1+1',' +1','-2','@SUM(A1)','\tfoo','\rfoo','\nfoo','normal']; const csv=serializeCSV(['=HEADER'], vals.map(v=>[v]), DEFAULT_EXPORT); const d=parseCSV(csv);
 assert.equal(d.headers[0],"'=HEADER"); vals.forEach((v,i)=>assert.equal(d.rows[i].values[0],i<7 ? "'"+v : v));
 assert.deepEqual(parseCSV(serializeCSV(['id'],vals.map(v=>[v]),exact)).rows.map(r=>r.values[0]),vals);
});
test('export delimiters, BOM, escaping and clean re-import round trip exact expected values', () => {
 const d=parseCSV(DEMO),w=demoWorkspace(d.headers); w.recipe.rules=[rule('trim'),rule('space','name'),rule('lower','status')];w.excluded['4']='duplicate';w.edits['5']={stock:'3'};w.edits['6']={sku:'00127'};w.edits['7']={stock:'9'};
 const r=processDataset(d,w);assert.equal(r.ready.length,11);assert.equal(r.rejected.length,1);
 for(const delimiter of [',',';','\t','|'] as const){const csv=exportClean(d,r,{...exact,delimiter});assert.equal(csv.charCodeAt(0),0xfeff);const re=parseCSV(csv,'roundtrip.csv',delimiter);assert.deepEqual(re.rows.map(r=>r.values),r.ready.map(r=>r.values));}
 const report=createReport(d,w,r,DEFAULT_EXPORT);assert.equal(report.summary.ready+report.summary.rejected,d.rows.length);assert.equal(report.rejected[0].record,4);
});
test('recipe schema, JSON, unknown actions/keys, malformed constraints and column mismatch rejected without eval', () => {
 const r=emptyWorkspace(['sku','stock']).recipe;r.rules=[rule('trim')];r.validations=[validation('stock',{type:'integer',min:'0'})];
 assert.deepEqual(parseRecipe(JSON.stringify(r),['stock','sku','extra']),r);
 assert.throws(()=>parseRecipe('not json'));assert.throws(()=>parseRecipe(JSON.stringify(r),['sku']),/stock/);
 for(const bad of [{...r,version:2},{...r,eval:'alert(1)'},{...r,rules:[{...r.rules[0],kind:'eval'}]},{...r,validations:[validation('stock',{type:'integer',min:'x'})]},{...r,validations:[validation('stock',{type:'integer',min:'10',max:'1'})]}])assert.throws(()=>validateRecipe(bad));
 assert.throws(()=>parseRecipe('{"__proto__":{"polluted":true}}'));assert.equal(({} as {polluted?:boolean}).polluted,undefined);
});
test('backup restore preserves raw strings, extra cells, blank last record and rejects corrupt IDs/edits/prototype keys', () => {
 const d=parseCSV('sku,name\n1,a,b\n2,c\n,');const w=emptyWorkspace(d.headers);w.recipe.rules=[rule('trim')];w.edits['3']={name:'manual'};w.excluded['2']='width';
 const restored=restoreBackup(makeBackup(d,w));assert.deepEqual(restored.dataset.rows,d.rows);assert.deepEqual(processDataset(restored.dataset,restored.workspace),processDataset(d,w));
 const bad=JSON.parse(makeBackup(d,w));bad.workspace.edits['999']={name:'x'};assert.throws(()=>restoreBackup(JSON.stringify(bad)));
 const malicious=JSON.parse(makeBackup(d,w));malicious.workspace.excluded=JSON.parse('{"__proto__":"bad"}');assert.throws(()=>restoreBackup(JSON.stringify(malicious)));
 const single=parseCSV('id\n""'),singleWork=emptyWorkspace(single.headers);assert.deepEqual(restoreBackup(makeBackup(single,singleWork)).dataset.rows,single.rows);assert.deepEqual(parseCSV(exportClean(single,processDataset(single,singleWork),exact)).rows,single.rows);
});
test('10000 records performance, worst-case duplicates bounded, 10001 rejected; limits honest', () => {
 const csv='sku,stock,name\n'+Array.from({length:10000},(_,i)=>`${String(i).padStart(8,'0')},${i},Товар ${i}`).join('\n');const start=performance.now(),d=parseCSV(csv),w=emptyWorkspace(d.headers);w.recipe.rules=[rule('trim')];w.recipe.validations=[validation('sku',{unique:true}),validation('stock',{type:'integer',min:'0'})];const r=processDataset(d,w);assert.equal(r.ready.length,10000);const ms=Math.round(performance.now()-start);
 console.log(`PERFORMANCE: parse + trim + unique + integer/range, 10000 rows, ${new TextEncoder().encode(csv).byteLength} bytes: ${ms} ms (Node ${process.version})`);
 assert.throws(()=>parseCSV(csv+'\nextra,1,x'));assert.throws(()=>parseCSV('x\n'+'a'.repeat(LIMITS.bytes)));
 const allSame=parseCSV('sku\n'+Array(10000).fill('same').join('\n')),w2=emptyWorkspace(allSame.headers);w2.recipe.validations=[validation('sku',{unique:true})];const duplicated=processDataset(allSame,w2);assert.equal(duplicated.duplicateRows,10000);assert.ok(duplicated.issues[0].message.length<200);
});
