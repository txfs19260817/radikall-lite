import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');
const output = stripTypeScriptTypes(source, { mode: 'strip' });
await writeFile(new URL('../public/app.js', import.meta.url), output);
console.log('Built public/app.js with Node native TypeScript stripping. No bundler.');
