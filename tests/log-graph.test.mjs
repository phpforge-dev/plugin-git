import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('Log graph keeps lanes continuous through merges and branch tips; refs and dates are labelled', async () => {
 const folder = await mkdtemp(join(tmpdir(), 'git-graph-'));
 try {
  const output = join(folder, 'test.mjs');
  await build({stdin: {contents: "export * from './src/git-graph'; export {logDate} from './src/git-log-view'; export {configure} from './src/sdk';", resolveDir: process.cwd()}, outfile: output, bundle: true, format: 'esm'});
  const m = await import(pathToFileURL(output));
  m.configure({tr: s => s, msg: (p, ...a) => p.reduce((v, s, i) => v + s + (a[i] ?? ''), ''), activeLanguage: () => 'pt-BR'});
  // Fixture observed in PhpStorm (G-16): report tip, footer (HEAD), merge, rename | login, initial.
  const commits = [
   {hash: 'report', parents: ['footer']}, {hash: 'footer', parents: ['merge']}, {hash: 'merge', parents: ['rename', 'login']},
   {hash: 'rename', parents: ['initial']}, {hash: 'login', parents: ['initial']}, {hash: 'initial', parents: []},
  ];
  const {rows, width} = m.layoutGraph(commits);
  assert.deepEqual(rows.map(r => r.column), [0, 0, 0, 0, 1, 0]);
  assert.equal(width, 2);
  assert.deepEqual(rows[2].bottom.map(s => [s.from, s.to]), [[0, 0], [0, 1]], 'merge opens a lane for the second parent');
  assert.deepEqual(rows[3].bottom.map(s => [s.from, s.to]), [[0, 0], [1, 1]], 'second lane passes beside the first parent line');
  assert.deepEqual(rows[4].bottom.map(s => [s.from, s.to]), [[0, 0], [1, 0]], 'branch lane converges into the line that already expects the root');
  assert.deepEqual(rows[5].top.map(s => [s.from, s.to]), [[0, 0]]);
  assert.notEqual(rows[4].color, rows[3].color, 'branch lane has its own colour');
  // Two branch tips: the second tip starts a new lane.
  const tips = m.layoutGraph([{hash: 'a', parents: ['c']}, {hash: 'b', parents: ['c']}, {hash: 'c', parents: []}]);
  assert.deepEqual(tips.rows.map(r => r.column), [0, 1, 0]);
  assert.deepEqual([...m.reachable(commits, 'footer')].sort(), ['footer', 'initial', 'login', 'merge', 'rename']);
  assert.deepEqual(m.parseRefs('HEAD -> main, origin/main, tag: v1.1, feature/x, origin/HEAD', new Set(['origin/main'])),
   [{name: 'main', kind: 'head'}, {name: 'origin/main', kind: 'remote'}, {name: 'v1.1', kind: 'tag'}, {name: 'feature/x', kind: 'local'}]);
  const now = new Date(2026, 10, 3, 23, 40);
  assert.equal(m.logDate(new Date(2026, 10, 3, 23, 35).toISOString(), now), '5 minutos atrás');
  assert.match(m.logDate(new Date(2026, 10, 3, 9, 5).toISOString(), now), /^Hoje, 09:05$/);
  assert.match(m.logDate(new Date(2026, 9, 1, 10, 0).toISOString(), now), /^01\/10\/26, 10:00$/);
 } finally { await rm(folder, {recursive: true, force: true}); }
});
