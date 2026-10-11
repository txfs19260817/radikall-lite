import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
for (const name of ['app', 'niconico']) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  await writeFile(new URL(`../public/${name}.js`, import.meta.url), stripTypeScriptTypes(source, { mode: 'strip' }));
}
console.log('Built browser modules with Node native TypeScript stripping. No bundler.');
