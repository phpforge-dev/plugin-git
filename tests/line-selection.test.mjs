import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('hunk parsing maps +/- lines to editor lines and selections to the native payload', async () => {
 const folder = await mkdtemp(join(tmpdir(), 'git-lines-'));
 try {
  const output = join(folder, 'test.mjs');
  await build({stdin: {contents: "export {parseHunk,selectionPayload,countLabel} from './src/git-line-selection'; export {configure} from './src/sdk';", resolveDir: process.cwd()}, outfile: output, bundle: true, format: 'esm'});
  const m = await import(pathToFileURL(output));
  m.configure({tr: s => s, msg: (p, ...a) => p.reduce((v, s, i) => v + s + (a[i] ?? ''), '')});
  const hunk = m.parseHunk(0, '@@ -2 +2,2 @@\n-two\n+TWO\n+three\n');
  assert.deepEqual(hunk.lines, [{kind: '-', text: 'two', line: 2}, {kind: '+', text: 'TWO', line: 2}, {kind: '+', text: 'three', line: 3}]);
  const insertion = m.parseHunk(1, '@@ -9,0 +10,2 @@\n+a\n+b\n\\ No newline at end of file\n');
  assert.deepEqual([insertion.oldCount, insertion.newStart, insertion.lines.map(l => l.line)], [0, 10, [10, 11]]);
  const payload = m.selectionPayload([hunk, insertion], new Map([[0, new Set([2, 1])], [1, new Set([0, 1])]]));
  assert.deepEqual(payload, {0: [1, 2], 1: true}, 'whole hunk becomes true, partial keeps sorted indexes');
  assert.deepEqual(m.selectionPayload([hunk], new Map([[0, new Set()]])), {});
  assert.equal(m.countLabel(1, 0, false), '1 diferença, 0 incluídas');
  assert.equal(m.countLabel(2, 1, true), '2 diferenças, 1 para retirar');
  assert.equal(m.countLabel(3, -1, false), '3 diferenças');
  assert.throws(() => m.parseHunk(0, 'garbage'));
 } finally { await rm(folder, {recursive: true, force: true}); }
});
