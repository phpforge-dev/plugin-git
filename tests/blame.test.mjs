import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

async function load(entry) {
 const folder = await mkdtemp(join(tmpdir(), 'git-blame-'));
 const output = join(folder, 'test.mjs');
 await build({stdin: {contents: entry, resolveDir: process.cwd()}, outfile: output, bundle: true, format: 'esm'});
 return {module: await import(pathToFileURL(output)), cleanup: () => rm(folder, {recursive: true, force: true})};
}
const day = (y, m, d, h = 10) => new Date(y, m - 1, d, h).getTime() / 1000;
const result = {path: 'User.php', revision: null, lines: [
 {hash: 'a'.repeat(40), original: 1}, {hash: 'a'.repeat(40), original: 2}, {hash: 'b'.repeat(40), original: 3}, {hash: '0'.repeat(40), original: 4},
], commits: {
 ['a'.repeat(40)]: {hash: 'a'.repeat(40), author: 'Ana Maria Fixture', email: 'ana@example.invalid', authorTime: day(2026, 10, 1), commitTime: day(2026, 10, 2), summary: 'Initial', message: 'Initial\n\nBody', uncommitted: false},
 ['b'.repeat(40)]: {hash: 'b'.repeat(40), author: 'Bruno Dev', email: 'bruno@example.invalid', authorTime: day(2026, 11, 3), summary: 'Today', message: 'Today', previous: {hash: 'a'.repeat(40), path: 'User.php'}, uncommitted: false},
 ['0'.repeat(40)]: {hash: '0'.repeat(40), uncommitted: true},
}};

test('annotation text follows the PhpStorm defaults: date and last name, blank for uncommitted lines', async () => {
 const {module, cleanup} = await load("export {annotationColumns,authorLabel,dateLabel,ageLevels,blameSettings} from './src/git-blame'; export {configure} from './src/sdk';");
 try {
  globalThis.localStorage = new Window().localStorage;
  module.configure({tr: s => s, activeLanguage: () => 'pt-BR'});
  const settings = module.blameSettings();
  assert.deepEqual({date: settings.date, author: settings.author, names: settings.names, ignoreWhitespace: settings.ignoreWhitespace}, {date: true, author: true, names: 'last', ignoreWhitespace: true});
  const now = new Date(2026, 10, 3, 12);
  const rows = module.annotationColumns(result, settings, now);
  const nbsp = ' ';
  assert.equal(rows.length, 4);
  assert.ok(rows[0].startsWith('01/10/26' + nbsp + 'Fixture'), rows[0]);
  assert.ok(rows[2].startsWith('Hoje'), rows[2]);
  assert.equal(new Set(rows.map(r => r.length)).size, 1, 'fixed width column');
  assert.equal(rows[3].replaceAll(nbsp, ''), '', 'uncommitted line is blank');
  assert.equal(module.authorLabel(result.commits['a'.repeat(40)], 'initials'), 'AMF');
  assert.equal(module.authorLabel(result.commits['a'.repeat(40)], 'first'), 'Ana');
  assert.equal(module.authorLabel(result.commits['a'.repeat(40)], 'email'), 'ana@example.invalid');
  assert.equal(module.dateLabel(day(2026, 11, 2), now), 'Ontem');
  const numbered = module.annotationColumns(result, {...settings, date: false, author: false, number: true, revision: true}, now);
  assert.ok(numbered[0].startsWith('aaaaaaaa' + nbsp + '1'), numbered[0]);
  assert.ok(numbered[2].startsWith('bbbbbbbb' + nbsp + '2'));
  const ages = module.ageLevels(result);
  assert.equal(ages.get('b'.repeat(40)), 0, 'newest commit gets the strongest color');
  assert.ok(ages.get('a'.repeat(40)) > 0);
  assert.equal(ages.has('0'.repeat(40)), false);
 } finally { await cleanup(); }
});

test('gutter annotator: context menu, popup, open in Log, options refetch and close restores line numbers', async () => {
 const {module, cleanup} = await load("export {blameAnnotator} from './src/git-blame'; export {configure} from './src/sdk';");
 const w = new Window();
 for (const key of ['window', 'document', 'localStorage', 'navigator', 'CustomEvent', 'Element', 'MouseEvent', 'KeyboardEvent']) Object.defineProperty(globalThis, key, {value: w[key], configurable: true, writable: true});
 globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
 try {
  document.body.innerHTML = '<div id="editor"><div class="margin"><div class="line-numbers" id="ln">1</div></div><div class="view-lines" id="code"></div></div>';
  const container = document.getElementById('editor');
  const options = []; const sets = []; let raw = {lineNumbers: 'on'}; let line = 1;
  const decorations = () => ({set: v => sets.push(v), clear: () => sets.push([])});
  const editor = {getContainerDomNode: () => container, createDecorationsCollection: decorations, updateOptions: o => { options.push(o); raw = {...raw, ...o}; }, getRawOptions: () => raw,
   getOption: id => id === 'fontInfo' ? {typicalHalfwidthCharacterWidth: 7} : 3, getModel: () => ({getLineCount: () => 4}), getTargetAtClientPoint: () => ({position: {lineNumber: line}})};
  const monaco = {Range: class { constructor(...a) { this.a = a; } }, editor: {EditorOption: {lineNumbersMinChars: 'minChars', fontInfo: 'fontInfo'}}};
  module.configure({tr: s => s, msg: (p, ...a) => p.reduce((v, s, i) => v + s + (a[i] ?? ''), ''), html: s => s, own: () => {}, monaco, activeLanguage: () => 'pt-BR'});
  const fetches = []; const statuses = []; const revisions = []; let closed = 0;
  const annotator = module.blameAnnotator(editor, {path: () => 'User.php', status: s => statuses.push(s), fetch: async s => { fetches.push(s); return result; },
   annotateRevision: (p, r) => revisions.push([p, r]), closed: () => closed++});
  // Clique direito na coluna sem anotações → "Anotar com Git Blame".
  const ln = document.getElementById('ln');
  ln.dispatchEvent(new w.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 10, clientY: 10}));
  const item = [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.includes('Anotar com Git Blame'));
  assert.ok(item, 'gutter menu offers Annotate with Git Blame');
  item.click(); await new Promise(r => setTimeout(r, 0));
  assert.equal(annotator.active, true);
  assert.equal(fetches[0].ignoreWhitespace, true);
  const numbers = options.at(-1).lineNumbers;
  assert.equal(typeof numbers, 'function');
  assert.match(numbers(1), /^01\/10\/26 Fixture/);
  assert.match(numbers(4), /4$/);
  assert.ok(container.classList.contains('git-blame-on'));
  assert.ok(sets.at(-1).some(d => d.options.lineNumberClassName === 'git-blame-age-0'));
  // Clique na anotação abre o commit no Log.
  const shown = []; document.addEventListener('ide-git-show-commit', e => shown.push(e.detail));
  line = 3; ln.dispatchEvent(new w.MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0}));
  assert.deepEqual(shown, [{hash: 'b'.repeat(40), path: undefined}]);
  // Menu da anotação com os itens observados.
  ln.dispatchEvent(new w.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 10, clientY: 10}));
  const labels = [...document.querySelectorAll('.git-menu:last-of-type .git-menu-item .git-menu-label')].map(n => n.textContent);
  assert.deepEqual(labels, ['Fechar anotações', 'Mostrar diff', 'Exibir', 'Copiar número da revisão', 'Anotar revisão', 'Anotar revisão anterior', 'Mostrar no histórico do arquivo', 'Opções']);
  [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.includes('Anotar revisão anterior')).click();
  assert.deepEqual(revisions, [['User.php', 'a'.repeat(40)]]);
  // Opções → Ignorar espaços refaz o blame sem -w.
  ln.dispatchEvent(new w.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 10, clientY: 10}));
  [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.includes('Opções')).click();
  [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.includes('Ignorar espaços')).click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(fetches.at(-1).ignoreWhitespace, false);
  // Exibir → Revisão mostra o hash curto sem novo blame.
  const count = fetches.length;
  ln.dispatchEvent(new w.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 10, clientY: 10}));
  [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.includes('Exibir')).click();
  [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.trim().startsWith('Revisão')).click();
  assert.equal(fetches.length, count);
  assert.match(options.at(-1).lineNumbers(3), /^bbbbbbbb/);
  // Fechar anotações restaura os números de linha do host.
  ln.dispatchEvent(new w.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 10, clientY: 10}));
  [...document.querySelectorAll('.git-menu-item')].find(b => b.textContent.includes('Fechar anotações')).click();
  assert.equal(annotator.active, false); assert.equal(closed, 1);
  assert.equal(options.at(-1).lineNumbers, 'on');
  assert.ok(!container.classList.contains('git-blame-on'));
  annotator.dispose();
 } finally { localStorage.clear(); await cleanup(); }
});
