// docs/sw.js のキャッシュ対象一覧（FILES）とバージョン（VERSION）を docs/ の中身から更新する。
// docs/ のファイルを追加・変更したら実行してコミットする。
//
//     node tools/update-sw.mjs          # 更新する
//     node tools/update-sw.mjs --check  # 更新が必要なら終了コード 1（CI・確認用）

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const SW = join(DOCS, 'sw.js');
const EXCLUDE = new Set(['sw.js']);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(DOCS)
  .map((p) => relative(DOCS, p).split(sep).join('/'))
  .filter((p) => !EXCLUDE.has(p))
  .sort();

const hash = createHash('sha256');
for (const f of files) {
  hash.update(f + '\0');
  hash.update(readFileSync(join(DOCS, f)));
}
const version = hash.digest('hex').slice(0, 10);

// index.html はスコープの URL（./）でも引けるように両方入れる
const list = ['./', ...files];
const block = [
  '// <precache>',
  `const VERSION = '${version}';`,
  'const FILES = [',
  ...list.map((f) => `  '${f}',`),
  '];',
  '// </precache>',
].join('\n');

const src = readFileSync(SW, 'utf8');
const next = src.replace(/\/\/ <precache>[\s\S]*?\/\/ <\/precache>/, block);
if (next === src) {
  console.log(`sw.js is up to date (version ${version}, ${list.length} entries)`);
} else if (process.argv.includes('--check')) {
  console.error('sw.js is out of date. Run: node tools/update-sw.mjs');
  process.exit(1);
} else {
  writeFileSync(SW, next);
  console.log(`updated sw.js (version ${version}, ${list.length} entries)`);
}
