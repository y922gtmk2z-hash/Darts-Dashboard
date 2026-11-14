// Guards the offline cache list: every JS/CSS file must be pre-cached by sw.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

test('service worker pre-caches every page, script and stylesheet', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const files = [...walk(join(root, 'js')), ...walk(join(root, 'css'))].map((p) => `./${relative(root, p)}`);
  files.push('./index.html', './admin.html');
  for (const f of files) assert.ok(sw.includes(`'${f}'`), `${f} missing from sw.js ASSETS`);
});
