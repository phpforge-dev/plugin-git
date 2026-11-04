import {tr, msg, monaco, own, activeLanguage} from './sdk';
import {showMenu, closeMenus, type MenuEntry} from './git-menu';

/** Annotate with Git Blame (PhpStorm 2026.1.4, capturas G-04..G-09): coluna à esquerda dos números com
 *  data e autor (sobrenome), cor por idade do commit, popup ao passar o mouse, clique abre o commit no Log
 *  e menu com Close Annotations, Show Diff, View, Copy Revision Number, Annotate (Previous) Revision,
 *  Show in File History e Options. Desenho e código próprios. */
export type BlameCommit = {hash: string; author?: string; email?: string; authorTime?: number; commitTime?: number; summary?: string; message?: string;
  previous?: {hash: string; path: string}; path?: string; uncommitted: boolean};
export type BlameResult = {path: string; revision: string | null; content?: string | null; lines: {hash: string; original: number}[]; commits: Record<string, BlameCommit>};
type Names = 'initials' | 'last' | 'first' | 'full' | 'email';
type Settings = {revision: boolean; date: boolean; author: boolean; number: boolean; names: Names; ignoreWhitespace: boolean; movesWithin: boolean; movesAcross: boolean; commitTimestamp: boolean};

const KEY = 'phpforge.git.blame';
// Padrões observados: Date e Author marcados, Names = Last Name, Options → Ignore Whitespaces marcado.
const defaults: Settings = {revision: false, date: true, author: true, number: false, names: 'last', ignoreWhitespace: true, movesWithin: false, movesAcross: false, commitTimestamp: false};
export function blameSettings(): Settings {
  try { return {...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}')}; } catch { return {...defaults}; }
}
function saveSettings(value: Settings) { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch {} }
const listeners = new Set<() => void>();

const nbsp = ' ';
export function authorLabel(commit: BlameCommit, names: Names): string {
  const full = (commit.author ?? '').trim(); const parts = full.split(/\s+/).filter(Boolean);
  if (names === 'email') return commit.email ?? '';
  if (names === 'full') return full;
  if (names === 'first') return parts[0] ?? '';
  if (names === 'initials') return parts.map(p => p[0]!.toUpperCase()).join('');
  return parts.at(-1) ?? '';
}
function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
export function dateLabel(seconds: number, now = new Date()): string {
  const date = new Date(seconds * 1000); const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days === 0) return tr('Hoje');
  if (days === 1) return tr('Ontem');
  return date.toLocaleDateString(activeLanguage?.() || undefined, {day: '2-digit', month: '2-digit', year: '2-digit'});
}
const when = (commit: BlameCommit, settings: Settings) => (settings.commitTimestamp ? commit.commitTime : commit.authorTime) ?? 0;

/** Texto de cada linha (vazio para linhas ainda não commitadas), colunas alinhadas como no PhpStorm. */
export function annotationColumns(result: BlameResult, settings: Settings, now = new Date()): string[] {
  const commits = Object.values(result.commits).filter(c => !c.uncommitted).sort((a, b) => when(a, settings) - when(b, settings));
  const numbers = new Map(commits.map((c, i) => [c.hash, String(i + 1)]));
  const cells = result.lines.map(line => {
    const commit = result.commits[line.hash];
    if (!commit || commit.uncommitted) return null;
    const cells: string[] = [];
    if (settings.revision) cells.push(commit.hash.slice(0, 8));
    if (settings.date) cells.push(dateLabel(when(commit, settings), now));
    if (settings.author) cells.push(authorLabel(commit, settings.names));
    if (settings.number) cells.push(numbers.get(commit.hash)!);
    return cells;
  });
  const widths: number[] = [];
  for (const row of cells) row?.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  const total = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1);
  return cells.map(row => row ? row.map((cell, i) => cell.padEnd(widths[i]!, nbsp)).join(nbsp) : nbsp.repeat(total));
}

/** Idade relativa: 0 = commit mais recente do arquivo (cor mais forte) … 4 = mais antigos. */
export function ageLevels(result: BlameResult): Map<string, number> {
  const commits = Object.values(result.commits).filter(c => !c.uncommitted).sort((a, b) => (b.authorTime ?? 0) - (a.authorTime ?? 0));
  return new Map(commits.map((c, i) => [c.hash, commits.length <= 1 ? 0 : Math.min(4, Math.floor((i * 5) / commits.length))]));
}

type Hooks = {fetch(settings: Settings): Promise<BlameResult>; path(): string | undefined; status(text: string): void; annotateRevision(path: string, revision: string): void; closed?(): void};

/** Anotação de um editor Monaco. A coluna é desenhada na área de números de linha (que o host já põe à
 *  esquerda do gutter), com largura fixa em caracteres; o fundo por commit vem de decorações. */
export function blameAnnotator(editor: monaco.editor.IStandaloneCodeEditor, hooks: Hooks) {
  const container = (editor.getContainerDomNode?.() ?? editor.getDomNode()) as HTMLElement;
  let result: BlameResult | undefined; let texts: string[] = []; let active = false; let epoch = 0;
  let saved: {lineNumbers: unknown; lineNumbersMinChars: number} | undefined;
  const decorations = editor.createDecorationsCollection(); const hover = editor.createDecorationsCollection();
  let popup: HTMLElement | undefined; let hoverTimer: ReturnType<typeof setTimeout> | undefined; let hoverLine = 0;
  const hidePopup = () => { clearTimeout(hoverTimer); popup?.remove(); popup = undefined; hover.clear(); hoverLine = 0; };
  const commitAt = (line: number) => { const entry = result?.lines[line - 1]; const commit = entry && result!.commits[entry.hash]; return commit && !commit.uncommitted ? commit : undefined; };

  function paint() {
    if (!active || !result) return;
    const settings = blameSettings(); texts = annotationColumns(result, settings);
    const width = texts[0]?.length ?? 0; const model = editor.getModel(); const digits = String(Math.max(1, model?.getLineCount() ?? 1)).length;
    if (!saved) saved = {lineNumbers: editor.getRawOptions().lineNumbers ?? 'on', lineNumbersMinChars: editor.getOption(monaco.editor.EditorOption.lineNumbersMinChars)};
    editor.updateOptions({lineNumbers: (n: number) => (texts[n - 1] ?? nbsp.repeat(width)) + nbsp + nbsp + String(n).padStart(digits, nbsp), lineNumbersMinChars: width + 2 + Math.max(digits, saved.lineNumbersMinChars)});
    const char = editor.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
    container.style.setProperty('--git-blame-width', Math.ceil((width + 1) * char) + 'px');
    container.classList.add('git-blame-on');
    const ages = ageLevels(result);
    decorations.set(result.lines.flatMap((line, i) => { const age = ages.get(line.hash); return age === undefined ? [] : [{range: new monaco.Range(i + 1, 1, i + 1, 1), options: {lineNumberClassName: `git-blame-age-${age}`}}]; }));
  }
  async function load() {
    const token = ++epoch;
    try {
      const value = await hooks.fetch(blameSettings());
      if (token !== epoch || !active) return;
      result = value; paint();
    } catch (error) {
      if (token !== epoch) return;
      close(); hooks.status(`Git: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function open() { if (!hooks.path()) return; active = true; container.classList.add('git-blame-loading'); await load(); container.classList.remove('git-blame-loading'); if (active) hooks.status(tr('Anotações Git ativas. Clique com o botão direito na coluna para opções.')); }
  function close() {
    epoch++; active = false; result = undefined; texts = []; hidePopup(); decorations.clear();
    container.classList.remove('git-blame-on'); container.style.removeProperty('--git-blame-width');
    if (saved) { editor.updateOptions({lineNumbers: saved.lineNumbers as monaco.editor.LineNumbersType, lineNumbersMinChars: saved.lineNumbersMinChars}); saved = undefined; }
  }
  const lineAt = (event: MouseEvent) => editor.getTargetAtClientPoint?.(event.clientX, event.clientY)?.position?.lineNumber ?? 0;
  const inColumn = (event: MouseEvent) => active && event.target instanceof Element && !!event.target.closest('.line-numbers');

  function showPopup(line: number, x: number, y: number) {
    const commit = commitAt(line); if (!commit) return;
    hidePopup(); hoverLine = line;
    hover.set(result!.lines.flatMap((entry, i) => entry.hash === commit.hash ? [{range: new monaco.Range(i + 1, 1, i + 1, 1), options: {isWholeLine: true, className: 'git-blame-same-commit'}}] : []));
    const root = document.createElement('section'); root.className = 'git-blame-popup'; root.setAttribute('role', 'tooltip');
    const head = document.createElement('div'); head.append(document.createTextNode('commit '));
    const link = document.createElement('a'); link.href = '#'; link.textContent = commit.hash; link.onclick = event => { event.preventDefault(); hidePopup(); showInLog(commit.hash); }; head.append(link);
    const author = document.createElement('div'); author.textContent = msg`Autor: ${commit.author ?? ''} <${commit.email ?? ''}>`;
    const date = document.createElement('div'); const at = new Date((commit.authorTime ?? 0) * 1000);
    date.textContent = tr('Data: ') + at.toLocaleDateString(activeLanguage?.() || undefined, {day: '2-digit', month: '2-digit', year: '2-digit'}) + ', ' + at.toLocaleTimeString(activeLanguage?.() || undefined, {hour: '2-digit', minute: '2-digit'});
    const message = document.createElement('p'); message.textContent = commit.message || commit.summary || '';
    root.append(head, author, date, message);
    root.onmouseleave = () => hidePopup();
    document.body.append(root); popup = root;
    const box = root.getBoundingClientRect();
    root.style.left = Math.max(4, Math.min(x + 12, innerWidth - box.width - 8)) + 'px';
    root.style.top = (y + 16 + box.height > innerHeight ? Math.max(4, y - box.height - 8) : y + 16) + 'px';
  }
  function showInLog(hash: string, path?: string) { document.dispatchEvent(new CustomEvent('ide-git-show-commit', {detail: {hash, path}})); }

  function update(patch: Partial<Settings>, refetch = false) {
    const next = {...blameSettings(), ...patch}; saveSettings(next); listeners.forEach(fn => fn());
    if (refetch) void load(); else paint();
  }
  function menu(line: number, x: number, y: number) {
    const commit = commitAt(line); const s = blameSettings(); const path = result?.path ?? hooks.path() ?? '';
    const view: MenuEntry[] = [
      {label: tr('Revisão'), checked: s.revision, run: () => update({revision: !s.revision})},
      {label: tr('Data'), checked: s.date, run: () => update({date: !s.date})},
      {label: tr('Autor'), checked: s.author, run: () => update({author: !s.author})},
      {label: tr('Número do commit'), checked: s.number, run: () => update({number: !s.number})},
      'separator',
      {label: tr('Nomes'), items: ([['initials', tr('Iniciais')], ['last', tr('Sobrenome')], ['first', tr('Primeiro nome')], ['full', tr('Nome completo')], ['email', 'Email']] as const)
        .map(([value, label]) => ({label, checked: s.names === value, run: () => update({names: value})}))},
    ];
    const options: MenuEntry[] = [
      {label: tr('Ignorar espaços em branco'), checked: s.ignoreWhitespace, run: () => update({ignoreWhitespace: !s.ignoreWhitespace}, true)},
      {label: tr('Detectar movimentos no arquivo'), checked: s.movesWithin, run: () => update({movesWithin: !s.movesWithin}, true)},
      {label: tr('Detectar movimentos entre arquivos'), checked: s.movesAcross, run: () => update({movesAcross: !s.movesAcross}, true)},
      {label: tr('Mostrar data do commit'), checked: s.commitTimestamp, run: () => update({commitTimestamp: !s.commitTimestamp})},
    ];
    showMenu([
      {label: tr('Fechar anotações'), run: () => { close(); hooks.closed?.(); }},
      {label: tr('Mostrar diff'), disabled: !commit, run: () => document.dispatchEvent(new CustomEvent('ide-git-show-diff', {detail: {hash: commit!.hash, path: commit!.path ?? path}}))},
      {label: tr('Exibir'), items: view},
      {label: tr('Copiar número da revisão'), disabled: !commit, run: () => { void navigator.clipboard?.writeText(commit!.hash); hooks.status(msg`Revisão ${commit!.hash.slice(0, 8)} copiada.`); }},
      'separator',
      {label: tr('Anotar revisão'), disabled: !commit, run: () => hooks.annotateRevision(commit!.path ?? path, commit!.hash)},
      {label: tr('Anotar revisão anterior'), disabled: !commit?.previous, run: () => hooks.annotateRevision(commit!.previous!.path, commit!.previous!.hash)},
      {label: tr('Mostrar no histórico do arquivo'), disabled: !commit, run: () => showInLog(commit!.hash, commit!.path ?? path)},
      {label: tr('Opções'), items: options},
    ], x, y, tr('Anotações Git'));
  }

  // Eventos na coluna: o host já remapeia o x do gutter; a linha vem do y.
  const onDown = (event: MouseEvent) => {
    if (!inColumn(event) || event.button !== 0) return;
    const commit = commitAt(lineAt(event)); event.preventDefault(); event.stopPropagation();
    if (commit) { hidePopup(); showInLog(commit.hash); }
  };
  const onContext = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('.line-numbers')) return;
    event.preventDefault(); event.stopPropagation(); hidePopup();
    const line = lineAt(event);
    if (active) menu(line, event.clientX, event.clientY);
    else showMenu([{label: tr('Anotar com Git Blame'), disabled: !hooks.path(), run: () => void open()}], event.clientX, event.clientY, tr('Gutter'));
  };
  const onMove = (event: MouseEvent) => {
    if (!inColumn(event)) { if (popup && !popup.contains(event.target as Node)) { clearTimeout(hoverTimer); hoverTimer = setTimeout(hidePopup, 250); } return; }
    const line = lineAt(event); if (line === hoverLine && popup) { clearTimeout(hoverTimer); return; }
    clearTimeout(hoverTimer); const {clientX, clientY} = event;
    hoverTimer = setTimeout(() => showPopup(line, clientX, clientY), 350);
  };
  container.addEventListener('mousedown', onDown, true); container.addEventListener('contextmenu', onContext, true); container.addEventListener('mousemove', onMove);
  const onLeave = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { if (!popup?.matches(':hover')) hidePopup(); }, 250); };
  container.addEventListener('mouseleave', onLeave);
  const repaint = () => paint(); listeners.add(repaint);
  const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') hidePopup(); };
  document.addEventListener('keydown', keys);
  const controller = {
    open, close, get active() { return active; }, reload: () => { if (active) void load(); },
    dispose() { close(); closeMenus(); listeners.delete(repaint); container.removeEventListener('mousedown', onDown, true); container.removeEventListener('contextmenu', onContext, true); container.removeEventListener('mousemove', onMove); container.removeEventListener('mouseleave', onLeave); document.removeEventListener('keydown', keys); },
  };
  own(() => controller.dispose());
  return controller;
}

/** Mostra o arquivo como era em uma revisão (Annotate Revision), somente leitura e anotado, na área do editor. */
export function revisionViewer(api: any, status: (text: string) => void) {
  const panel = document.createElement('section'); panel.id = 'git-revision-view'; panel.hidden = true;
  panel.innerHTML = '<div class="git-revision-head"><strong id="git-revision-title"></strong><button type="button" id="git-revision-close"></button></div><div id="git-revision-editor"></div>';
  document.querySelector('.code')?.append(panel); own(() => panel.remove());
  const close = panel.querySelector<HTMLButtonElement>('#git-revision-close')!; close.textContent = tr('Fechar'); close.setAttribute('aria-label', tr('Fechar revisão anotada'));
  const editor = monaco.editor.create(panel.querySelector('#git-revision-editor')!, {readOnly: true, automaticLayout: true, minimap: {enabled: false}, scrollBeyondLastLine: false, glyphMargin: false});
  own(() => editor.dispose());
  let model: monaco.editor.ITextModel | undefined; let current: {path: string; revision: string} | undefined;
  const annotator = blameAnnotator(editor, {
    path: () => current?.path, status,
    fetch: settings => api.gitBlame({path: current!.path, revision: current!.revision, ...settings}),
    annotateRevision: (path, revision) => void show(path, revision),
  });
  function hide() { annotator.close(); panel.hidden = true; model?.dispose(); model = undefined; for (const id of ['tabs', 'breadcrumbs', 'navigation', 'editor']) { const node = document.getElementById(id); if (node) node.hidden = false; } }
  close.onclick = hide;
  async function show(path: string, revision: string) {
    try {
      const value: BlameResult = await api.gitBlame({path, revision, ...blameSettings()});
      current = {path, revision}; model?.dispose();
      model = monaco.editor.createModel(value.content ?? '', path.endsWith('.php') ? 'php' : undefined);
      editor.setModel(model);
      panel.querySelector('#git-revision-title')!.textContent = `${path} @ ${revision.slice(0, 8)}`;
      for (const id of ['tabs', 'breadcrumbs', 'navigation', 'editor']) { const node = document.getElementById(id); if (node) node.hidden = true; }
      panel.hidden = false; editor.layout(); await annotator.open();
    } catch (error) { status(`Git: ${error instanceof Error ? error.message : String(error)}`); }
  }
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hide(); } });
  return {show, hide};
}
