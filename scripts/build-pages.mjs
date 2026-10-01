import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..'), target = resolve(root, 'docs'), source = resolve(root, 'dist');
if (dirname(target) !== root || !existsSync(resolve(source, 'index.html'))) throw new Error('Expected a verified build in this project dist/');
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
writeFileSync(resolve(target, '.nojekyll'), '');
console.log('Built static GitHub Pages output in docs/');
