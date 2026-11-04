import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('changelists group changes, translate the default list and drive the Move dialog', async () => {
 const folder = await mkdtemp(join(tmpdir(), 'git-changelists-'));
 try {
  const output = join(folder, 'test.mjs');
  await build({stdin: {contents: "export * from './src/git-changelists'; export {configure} from './src/sdk';", resolveDir: process.cwd()}, outfile: output, bundle: true, format: 'esm'});
  const m = await import(pathToFileURL(output));
  const w = new Window(); globalThis.document = w.document; globalThis.Option = function (t, v) { const o = document.createElement('option'); o.text = t; o.value = v; return o; };
  w.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
  m.configure({tr: s => s});
  const lists = [{id: 'default', name: 'Changes', comment: '', active: false, files: ['a.php']}, {id: 'r', name: 'Refactor', comment: 'wip', active: true, files: ['b.php']}];
  const grouped = m.groupByChangelist(lists, [{path: 'a.php'}, {path: 'b.php'}, {path: 'late.php'}]);
  assert.deepEqual(grouped.map(g => [g.list.id, g.changes.map(c => c.path)]), [['default', ['a.php']], ['r', ['b.php', 'late.php']]], 'unassigned file goes to the active list');
  assert.equal(m.listLabel(lists[0]), 'Alterações');
  assert.equal(m.findList(lists, 'changes')?.id, 'default');
  assert.equal(m.findList(lists, 'Alterações')?.id, 'default');
  const pending = m.changelistDialog({title: 'Mover para outra changelist', lists, name: 'Alterações', choose: true});
  const dialog = document.querySelector('.git-changelist-dialog');
  assert.deepEqual([...dialog.querySelectorAll('label span')].map(s => s.textContent), ['Nome:', 'Comentário:', 'Tornar ativa']);
  assert.deepEqual([...dialog.querySelectorAll('datalist option')].map(o => o.value), ['Alterações', 'Refactor']);
  const name = dialog.querySelector('input[name=name]'); const ok = dialog.querySelector('button[value=ok]');
  name.value = ''; name.dispatchEvent(new w.Event('input')); assert.equal(ok.disabled, true, 'OK needs a name');
  name.value = 'Docs'; name.dispatchEvent(new w.Event('input')); dialog.querySelector('input[name=active]').checked = true;
  dialog.querySelector('form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  dialog.dispatchEvent(new w.Event('close'));
  assert.deepEqual(await pending, {name: 'Docs', comment: '', setActive: true});
 } finally { await rm(folder, {recursive: true, force: true}); }
});
