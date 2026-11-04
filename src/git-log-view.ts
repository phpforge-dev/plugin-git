import {tr, msg, html, dockWindow, resizeToolWindow, toolIcon, fileIcon, activeLanguage, own, on} from './sdk';
import {layoutGraph, reachable, parseRefs, type RefLabel} from './git-graph';
import {showMenu, closeMenus, type MenuEntry} from './git-menu';

/** Log do Git (PhpStorm 2026.1.4, capturas 19, G-16..G-24): painel de branches (HEAD, Local agrupado por
 *  pasta, Remote, Tags), busca "Text or hash" com Regex (.*) e Match Case (Cc), filtros Branch, User, Date e
 *  Paths aplicados pelo Git, grafo com linhas contínuas, rótulos de refs, commits do usuário em negrito,
 *  merges esmaecidos, fundo da branch atual e menu de contexto do commit. Desenho e código próprios. */
type Commit = GitCommit & {email?: string; committer?: string};
type Filters = {refs: string[]; authors: string[]; since: string; until: string; paths: string[]; text: string; regex: boolean; matchCase: boolean};
type Hooks = {diff(path: string, revision: string): void; branches(): void; operation(kind: 'revert' | 'cherry-pick', hash: string): void; commit(): void; extend?(menu: MenuEntry[], commit: Commit, context: LogContext): void;
  refMenu?(ref: {name: string; kind: string; commit?: string}, x: number, y: number, context: LogContext): void};
export type LogContext = {head: string | undefined; reload(): Promise<void>; feedback(text: string): void; tools(): any};

const ROW = 26, LANE = 12;
const empty = (): Filters => ({refs: [], authors: [], since: '', until: '', paths: [], text: '', regex: false, matchCase: false});
const locale = () => { try { return activeLanguage() || undefined; } catch { return undefined; } };

/** Datas da coluna Date: relativas no mesmo dia, como "5 minutes ago" do PhpStorm; depois data e hora. */
export function logDate(iso: string, now = new Date()): string {
  const date = new Date(iso); const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes >= 0 && minutes < 1) return tr('agora');
  if (minutes >= 0 && minutes < 60) return minutes === 1 ? tr('1 minuto atrás') : msg`${minutes} minutos atrás`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const time = date.toLocaleTimeString(locale(), {hour: '2-digit', minute: '2-digit'});
  const days = Math.round((day(now) - day(date)) / 86400000);
  if (days === 0) return tr('Hoje, ') + time;
  if (days === 1) return tr('Ontem, ') + time;
  return date.toLocaleDateString(locale(), {day: '2-digit', month: '2-digit', year: '2-digit'}) + ', ' + time;
}

export function gitLogView(api: any, hooks: Hooks) {
  const panel = document.createElement('section'); panel.id = 'git-log-panel'; panel.hidden = true;
  panel.innerHTML = html`<div class="tool-window-resize" id="git-log-resize" role="separator" tabindex="0" aria-label="Altura do Git" aria-orientation="horizontal"></div>
 <div class="tool-window-head"><strong>Git</strong><span class="tool-window-tab" id="git-log-title">Log</span><span id="git-log-tabs"></span><button id="git-log-commit">Commit</button><span class="tool-window-space"></span><span id="git-log-count"></span><button id="git-log-hide" aria-label="Ocultar Git">−</button></div>
 <div class="git-log-body"><div class="git-log-actions"><button id="git-log-refresh" title="Atualizar histórico"></button><button id="git-log-branches" title="Branches e operações…"></button><button id="git-toggle-branches" title="Ocultar branches" aria-pressed="true"></button></div>
 <div class="git-log-layout"><nav class="git-refs-pane" aria-label="Branches do histórico"><input id="git-branch-search" type="search" placeholder="Branch ou tag" aria-label="Buscar branches ou tags"><div id="git-log-refs" role="tree"></div></nav>
 <section class="git-commits-pane"><div class="git-log-toolbar"><span class="git-log-search-box"><input id="git-log-search" type="search" aria-label="Texto ou hash" placeholder="Texto ou hash"><button type="button" id="git-log-regex" class="git-log-toggle" aria-pressed="false" title="Regex">.*</button><button type="button" id="git-log-case" class="git-log-toggle" aria-pressed="false" title="Diferenciar maiúsculas">Cc</button></span>
 <button type="button" class="git-log-filter" id="git-filter-branch" data-filter="branch">Branch</button><button type="button" class="git-log-filter" id="git-filter-user" data-filter="user">Usuário</button><button type="button" class="git-log-filter" id="git-filter-date" data-filter="date">Data</button><button type="button" class="git-log-filter" id="git-filter-paths" data-filter="paths">Caminhos</button></div>
 <div class="git-log-columns"><span>Mensagem</span><span>Autor</span><span>Data</span></div><div id="git-log" role="listbox" aria-label="Commits"></div></section>
 <section class="git-history-detail"><h3>Arquivos alterados <span id="git-history-count"></span></h3><div id="git-history-files"></div><div id="git-history-info"></div><div id="git-history-actions" hidden><button id="git-history-revert">Reverter…</button><button id="git-history-pick">Cherry-pick…</button></div></section></div></div><div id="git-log-status" role="status" aria-live="polite"></div>`;
  document.querySelector('.code')!.append(panel);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => panel.querySelector<T>('#' + id)!;
  toolIcon(el('git-log-refresh'), '<path d="M19 7a8 8 0 1 0 1 8M19 3v5h-5"/>', tr('Atualizar histórico'));
  toolIcon(el('git-log-branches'), '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10m10-10c0 7-10 2-10 8"/>', tr('Branches e operações…'));
  toolIcon(el('git-toggle-branches'), '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', tr('Ocultar branches'));
  el('git-toggle-branches').onclick = () => { const hidden = panel.classList.toggle('git-branches-hidden'); el('git-toggle-branches').setAttribute('aria-pressed', String(!hidden)); };
  const button = document.getElementById('show-git')!;
  let entries: Commit[] = []; let visible: Commit[] = []; let filters = empty(); let epoch = 0; let selection = 0; let selected: string | undefined;
  let tools: any = {branches: [], remotes: [], tags: [], user: ''}; let head: string | undefined; let onBranch = new Set<string>(); let truncated = false;
  const feedback = (text: string) => { el('git-log-status').textContent = text; };
  function hide() { panel.hidden = true; button.setAttribute('aria-pressed', 'false'); closeMenus(); }
  const show = dockWindow(panel, button, hide); resizeToolWindow(panel, el('git-log-resize'), 'php-ide-git-height');

  // ------------------------------------------------------------------ detalhes do commit
  async function choose(commit: Commit) {
    const request = ++selection; selected = commit.hash; markSelection();
    el('git-history-files').replaceChildren(); el('git-history-info').textContent = tr('Carregando…'); el('git-history-actions').hidden = true;
    try {
      const history = await api.gitHistory(commit.hash); if (request !== selection) return;
      el('git-history-count').textContent = String(history.files.length);
      for (const file of history.files) {
        const row = document.createElement('button'); row.className = 'git-file-row'; row.dataset.status = file.status; row.textContent = file.path.split('/').pop()!; row.title = file.path;
        const directory = document.createElement('small'); directory.textContent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''; row.append(directory); row.prepend(fileIcon(file.path));
        row.onclick = () => hooks.diff(file.path, commit.hash); el('git-history-files').append(row);
      }
      const title = document.createElement('strong'); title.textContent = commit.subject;
      const meta = document.createElement('p'); meta.textContent = `${commit.hash}\n${commit.author}${commit.email ? ` <${commit.email}>` : ''}\n${new Date(commit.date).toLocaleString(locale())}`;
      el('git-history-info').replaceChildren(title, meta); el('git-history-actions').hidden = false;
    } catch (error) { if (request === selection) { el('git-history-info').textContent = String(error); feedback(String(error)); } }
  }
  function markSelection() { for (const row of el('git-log').querySelectorAll<HTMLElement>('.git-commit-row')) row.setAttribute('aria-selected', String(row.dataset.hash === selected)); }

  // ------------------------------------------------------------------ tabela + grafo
  const remotes = () => new Set<string>((tools.branches ?? []).filter((b: GitBranch) => b.remote).map((b: GitBranch) => b.name));
  function label(ref: RefLabel) {
    const span = document.createElement('span'); span.className = `git-ref-label git-ref-${ref.kind}`; span.textContent = ref.name; span.title = ref.name; return span;
  }
  /** Filtro local imediato (texto, hash) sobre o que já veio; a consulta ao Git refaz com o filtro completo. */
  function matches(commit: Commit) {
    const text = filters.text.trim(); if (!text) return true;
    if (/^[0-9a-f]{4,64}$/i.test(text) && commit.hash.startsWith(text.toLowerCase())) return true;
    if (filters.regex) { try { return new RegExp(text, filters.matchCase ? '' : 'i').test(commit.subject); } catch { return true; } }
    return filters.matchCase ? (commit.subject + ' ' + commit.author).includes(text) : (commit.subject + ' ' + commit.author).toLowerCase().includes(text.toLowerCase());
  }
  function render() {
    visible = entries.filter(matches);
    const {rows, width} = layoutGraph(visible); const graphWidth = Math.max(1, width) * LANE + 8;
    const list = el('git-log'); list.replaceChildren(); list.style.setProperty('--git-graph-width', graphWidth + 'px');
    const remoteSet = remotes(); const me = tools.user;
    visible.forEach((commit, index) => {
      const row = document.createElement('button'); row.className = 'git-commit-row'; row.dataset.hash = commit.hash; row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected === commit.hash));
      row.classList.toggle('git-on-branch', onBranch.has(commit.hash));
      row.classList.toggle('git-merge', (commit.parents?.length ?? 0) > 1);
      row.classList.toggle('git-mine', !!me && commit.author === me);
      const subject = document.createElement('span'); subject.className = 'git-commit-subject';
      const text = document.createElement('span'); text.className = 'git-commit-text'; text.textContent = commit.subject; subject.append(text);
      const refs = parseRefs(commit.refs, remoteSet);
      if (refs.length) { const box = document.createElement('span'); box.className = 'git-ref-labels'; refs.slice(0, 2).forEach(r => box.append(label(r))); if (refs.length > 2) { const more = document.createElement('span'); more.className = 'git-ref-more'; more.textContent = `+${refs.length - 2}`; more.title = refs.slice(2).map(r => r.name).join(', '); box.append(more); } subject.append(box); }
      const author = document.createElement('span'); author.className = 'git-commit-author'; author.textContent = commit.author; if (commit.committer && commit.committer !== commit.author) author.textContent += '*';
      const date = document.createElement('time'); date.textContent = logDate(commit.date); date.title = new Date(commit.date).toLocaleString(locale());
      row.append(subject, author, date);
      row.onclick = () => void choose(commit);
      row.oncontextmenu = event => { event.preventDefault(); void choose(commit); commitMenu(commit, event.clientX, event.clientY); };
      row.onkeydown = event => keyboard(event, commit, index);
      list.append(row);
    });
    list.prepend(drawGraph(rows, graphWidth));
    el('git-log-count').textContent = truncated ? msg`${visible.length}+ commits` : msg`${visible.length} commits`;
  }
  function drawGraph(rows: ReturnType<typeof layoutGraph>['rows'], width: number) {
    const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('git-log-graph'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(rows.length * ROW));
    const x = (column: number) => 6 + column * LANE + LANE / 2;
    const path = (d: string, color: number) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('class', `git-lane git-lane-${color % 6}`); svg.append(p); };
    rows.forEach((row, i) => {
      const top = i * ROW, mid = top + ROW / 2, bottom = top + ROW;
      for (const s of row.top) path(`M${x(s.from)} ${top} C${x(s.from)} ${top + 6} ${x(s.to)} ${mid - 6} ${x(s.to)} ${mid}`, s.color);
      for (const s of row.bottom) path(`M${x(s.from)} ${mid} C${x(s.from)} ${mid + 6} ${x(s.to)} ${bottom - 6} ${x(s.to)} ${bottom}`, s.color);
    });
    rows.forEach((row, i) => {
      const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('cx', String(x(row.column))); circle.setAttribute('cy', String(i * ROW + ROW / 2));
      const isHead = visible[i]?.hash === head; circle.setAttribute('r', isHead ? '4' : '3.5');
      circle.setAttribute('class', `git-node git-lane-${row.color % 6}${isHead ? ' git-head-node' : ''}`); svg.append(circle);
    });
    return svg;
  }
  function keyboard(event: KeyboardEvent, commit: Commit, index: number) {
    let next: Commit | undefined;
    if (event.key === 'ArrowDown') next = visible[index + 1];
    else if (event.key === 'ArrowUp') next = visible[index - 1];
    else if (event.key === 'ArrowRight') next = visible.find(c => c.hash === commit.parents?.[0]); // Go to Parent Commit
    else if (event.key === 'ArrowLeft') next = visible.find(c => c.parents?.includes(commit.hash)); // Go to Child Commit
    if (!next) return; event.preventDefault(); void choose(next); focusRow(next.hash);
  }
  function focusRow(hash: string) { const row = el('git-log').querySelector<HTMLButtonElement>(`[data-hash="${hash}"]`); row?.focus(); row?.scrollIntoView({block: 'nearest'}); }

  // ------------------------------------------------------------------ menu do commit
  const context: LogContext = {head: undefined, reload: () => load(), feedback, tools: () => tools};
  function commitMenu(commit: Commit, x: number, y: number) {
    const child = visible.find(c => c.parents?.includes(commit.hash)); const parent = visible.find(c => c.hash === commit.parents?.[0]);
    const go = (target: Commit | undefined) => () => { if (target) { void choose(target); focusRow(target.hash); } };
    const menu: MenuEntry[] = [
      {label: tr('Copiar número da revisão'), shortcut: '⌥⇧⌘C', run: () => { void navigator.clipboard?.writeText(commit.hash); feedback(msg`Revisão ${commit.hash.slice(0, 8)} copiada.`); }},
      {label: 'Cherry-pick', run: () => hooks.operation('cherry-pick', commit.hash)},
      'separator',
      {label: tr('Reverter commit'), run: () => hooks.operation('revert', commit.hash)},
      'separator',
      {label: tr('Ir para o commit filho'), shortcut: '←', disabled: !child, run: go(child)},
      {label: tr('Ir para o commit pai'), shortcut: '→', disabled: !parent, run: go(parent)},
    ];
    context.head = head; hooks.extend?.(menu, commit, context);
    showMenu(menu, x, y, commit.subject);
  }

  // ------------------------------------------------------------------ painel de branches
  function renderBranches() {
    const container = el('git-log-refs'); container.replaceChildren(); const query = el<HTMLInputElement>('git-branch-search').value.toLowerCase();
    const leaf = (parent: HTMLElement, ref: string, text: string, kind: string, current = false) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = `git-ref-row git-ref-${kind}`; row.textContent = text; row.dataset.ref = ref; row.title = ref.replace(/^refs\/(heads|remotes|tags)\//, '');
      row.setAttribute('role', 'treeitem'); row.classList.toggle('git-current-branch', current); row.setAttribute('aria-pressed', String(filters.refs.length === 1 && filters.refs[0] === ref));
      row.onclick = () => { filters.refs = ref === 'HEAD' ? [] : [ref]; void load(); };
      row.oncontextmenu = event => {
        if (!hooks.refMenu || kind === 'head') return; event.preventDefault();
        const name = ref.replace(/^refs\/(heads|remotes|tags)\//, ''); context.head = head;
        hooks.refMenu({name, kind, commit: kind === 'tag' ? (tools.tags ?? []).find((t: any) => t.name === name)?.commit : undefined}, event.clientX, event.clientY, context);
      };
      parent.append(row);
    };
    const folder = (parent: HTMLElement, title: string) => { const d = document.createElement('details'); d.open = true; const s = document.createElement('summary'); s.textContent = title; d.append(s); parent.append(d); return d; };
    leaf(container, 'HEAD', tr('HEAD (Branch atual)'), 'head');
    /** Local agrupado por pasta (feature/login → feature › login), como no PhpStorm. */
    const grouped = (parent: HTMLElement, names: {name: string; ref: string; current?: boolean}[], kind: string) => {
      const folders = new Map<string, HTMLElement>();
      for (const item of names.filter(n => n.name.toLowerCase().includes(query))) {
        const parts = item.name.split('/'); let target = parent; let path = '';
        for (const part of parts.slice(0, -1)) { path += part + '/'; if (!folders.has(path)) folders.set(path, folder(target, part)); target = folders.get(path)!; }
        leaf(target, item.ref, parts.at(-1)!, kind, item.current);
      }
    };
    const locals = (tools.branches ?? []).filter((b: GitBranch) => !b.remote);
    grouped(folder(container, tr('Local')), locals.map((b: GitBranch) => ({name: b.name, ref: 'refs/heads/' + b.name, current: b.current})), 'local');
    const remoteBranches = (tools.branches ?? []).filter((b: GitBranch) => b.remote && !b.name.endsWith('/HEAD'));
    if (remoteBranches.length) grouped(folder(container, tr('Remoto')), remoteBranches.map((b: GitBranch) => ({name: b.name, ref: 'refs/remotes/' + b.name})), 'remote');
    const tags = tools.tags ?? [];
    if (tags.length) { const box = folder(container, 'Tags'); for (const tag of tags.filter((t: any) => t.name.toLowerCase().includes(query))) leaf(box, 'refs/tags/' + tag.name, tag.name, 'tag'); }
  }

  // ------------------------------------------------------------------ filtros
  function filterLabels() {
    const set = (id: string, base: string, value: string) => { const b = el(id); b.textContent = value ? `${base}: ${value}` : base; b.classList.toggle('active', !!value); };
    set('git-filter-branch', 'Branch', filters.refs.map(r => r === '--all' ? tr('Todas') : r.replace(/^refs\/(heads|remotes|tags)\//, '')).join(', '));
    set('git-filter-user', tr('Usuário'), filters.authors.join(', '));
    set('git-filter-date', tr('Data'), filters.since || filters.until ? [filters.since && msg`desde ${filters.since}`, filters.until && msg`até ${filters.until}`].filter(Boolean).join(' ') : '');
    set('git-filter-paths', tr('Caminhos'), filters.paths.join(', '));
  }
  /** Campo flutuante para os itens "Select…" dos filtros. */
  function ask(anchor: HTMLElement, fields: {name: string; label: string; type?: string; value: string; list?: string[]}[], apply: (values: Record<string, string>) => void) {
    closeMenus(); panel.querySelector('.git-log-ask')?.remove();
    const form = document.createElement('form'); form.className = 'git-log-ask';
    for (const field of fields) {
      const labelEl = document.createElement('label'); labelEl.textContent = field.label; const input = document.createElement('input'); input.name = field.name; input.type = field.type ?? 'text'; input.value = field.value;
      if (field.list?.length) { const id = 'git-ask-' + field.name; const data = document.createElement('datalist'); data.id = id; field.list.forEach(v => data.append(new Option(v, v))); input.setAttribute('list', id); form.append(data); }
      labelEl.append(input); form.append(labelEl);
    }
    const buttons = document.createElement('div'); const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = tr('Cancelar'); const ok = document.createElement('button'); ok.type = 'submit'; ok.textContent = 'OK'; ok.className = 'primary'; buttons.append(cancel, ok); form.append(buttons);
    cancel.onclick = () => form.remove();
    form.onsubmit = event => { event.preventDefault(); const values: Record<string, string> = {}; for (const f of fields) values[f.name] = (form.elements.namedItem(f.name) as HTMLInputElement).value.trim(); form.remove(); apply(values); };
    form.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); form.remove(); anchor.focus(); } };
    panel.append(form); const box = anchor.getBoundingClientRect(); const host = panel.getBoundingClientRect();
    form.style.left = Math.max(4, box.left - host.left) + 'px'; form.style.top = box.bottom - host.top + 2 + 'px';
    form.querySelector('input')?.focus();
  }
  const list = (value: string) => value.split(',').map(v => v.trim()).filter(Boolean);
  function filterMenu(kind: string, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect(); const set = (patch: Partial<Filters>) => { filters = {...filters, ...patch}; void load(); };
    const clear: MenuEntry[] = [];
    if (kind === 'branch') {
      const locals = (tools.branches ?? []).filter((b: GitBranch) => !b.remote); const remote = (tools.branches ?? []).filter((b: GitBranch) => b.remote && !b.name.endsWith('/HEAD'));
      const pick = (ref: string) => ({label: ref.replace(/^refs\/(heads|remotes|tags)\//, ''), checked: filters.refs.includes(ref), run: () => set({refs: [ref]})});
      showMenu([
        {label: tr('Selecionar…'), run: () => ask(anchor, [{name: 'refs', label: tr('Branches ou tags (separadas por vírgula)'), value: filters.refs.map(r => r.replace(/^refs\/(heads|remotes|tags)\//, '')).join(', '), list: [...(tools.branches ?? []).map((b: GitBranch) => b.name), ...(tools.tags ?? []).map((t: any) => t.name)]}],
          values => set({refs: list(values.refs).map(name => (tools.branches ?? []).some((b: GitBranch) => !b.remote && b.name === name) ? 'refs/heads/' + name : (tools.branches ?? []).some((b: GitBranch) => b.remote && b.name === name) ? 'refs/remotes/' + name : 'refs/tags/' + name)}))},
        {label: tr('Todas'), checked: filters.refs[0] === '--all', run: () => set({refs: ['--all']})},
        {label: 'HEAD', checked: !filters.refs.length, run: () => set({refs: []})},
        'separator',
        {label: tr('Local'), items: locals.map((b: GitBranch) => pick('refs/heads/' + b.name))},
        ...(remote.length ? [{label: tr('Remoto'), items: remote.map((b: GitBranch) => pick('refs/remotes/' + b.name))}] : []),
        ...((tools.tags ?? []).length ? [{label: 'Tags', items: tools.tags.map((t: any) => pick('refs/tags/' + t.name))}] : []),
      ], r.left, r.bottom + 2, 'Branch');
    } else if (kind === 'user') {
      const authors = [...new Set(entries.map(c => c.author))];
      showMenu([
        {label: tr('Selecionar…'), run: () => ask(anchor, [{name: 'authors', label: tr('Autores (separados por vírgula)'), value: filters.authors.join(', '), list: authors}], values => set({authors: list(values.authors)}))},
        {label: tr('eu'), disabled: !tools.user, checked: filters.authors.length === 1 && filters.authors[0] === tools.user, run: () => set({authors: [tools.user]})},
        ...(filters.authors.length ? [{label: tr('Todos'), run: () => set({authors: []})}] : clear),
        ...(authors.length ? ['separator' as const, ...authors.filter(a => a !== tools.user).slice(0, 12).map(a => ({label: a, checked: filters.authors.includes(a), run: () => set({authors: [a]})}))] : clear),
      ], r.left, r.bottom + 2, tr('Usuário'));
    } else if (kind === 'date') {
      const day = (offset: number) => { const d = new Date(Date.now() - offset * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      showMenu([
        {label: tr('Selecionar…'), run: () => ask(anchor, [{name: 'since', label: tr('Depois de'), type: 'date', value: filters.since}, {name: 'until', label: tr('Antes de'), type: 'date', value: filters.until}], values => set({since: values.since, until: values.until}))},
        {label: tr('Últimas 24 horas'), run: () => set({since: day(1), until: ''})},
        {label: tr('Últimos 7 dias'), run: () => set({since: day(7), until: ''})},
        ...(filters.since || filters.until ? [{label: tr('Todas'), run: () => set({since: '', until: ''})}] : clear),
      ], r.left, r.bottom + 2, tr('Data'));
    } else {
      showMenu([
        {label: tr('Selecionar pastas…'), run: () => ask(anchor, [{name: 'paths', label: tr('Pastas ou arquivos do projeto (separados por vírgula)'), value: filters.paths.join(', ')}], values => set({paths: list(values.paths).map(p => p.replace(/^\.?\/+/, '').replace(/\/+$/, ''))}))},
        ...(filters.paths.length ? [{label: tr('Todos'), run: () => set({paths: []})}] : clear),
      ], r.left, r.bottom + 2, tr('Caminhos'));
    }
  }
  for (const b of panel.querySelectorAll<HTMLButtonElement>('.git-log-filter')) b.onclick = () => filterMenu(b.dataset.filter!, b);

  // ------------------------------------------------------------------ carga
  async function load(keep?: string) {
    const token = ++epoch; selection++; const previous = keep ?? selected;
    el('git-history-files').replaceChildren(); el('git-history-count').textContent = ''; el('git-history-info').textContent = tr('Selecione um commit para ver as alterações.'); el('git-history-actions').hidden = true;
    feedback(tr('Carregando histórico…')); filterLabels();
    try {
      const request: Record<string, unknown> = {limit: 1000, refs: filters.refs.length ? filters.refs : ['HEAD']};
      if (filters.authors.length) request.authors = filters.authors;
      if (filters.since) request.since = filters.since;
      if (filters.until) request.until = filters.until;
      if (filters.paths.length) request.paths = filters.paths;
      if (filters.text.trim()) { request.text = filters.text.trim(); request.regex = filters.regex; request.matchCase = filters.matchCase; }
      const [loadedTools, commits, status] = await Promise.all([api.gitTools().catch(() => undefined), api.gitLog(request), api.gitStatus().catch(() => undefined)]);
      if (token !== epoch) return;
      tools = loadedTools ?? {branches: await api.gitBranches().catch(() => []), remotes: [], tags: [], user: ''};
      entries = commits; truncated = commits.length >= 1000;
      head = entries.find(c => /(^|, )HEAD( ->|,|$)/.test(c.refs ?? ''))?.hash ?? status?.head ?? undefined;
      onBranch = reachable(entries, head);
      const title = filters.refs.length === 1 && filters.refs[0] !== '--all' ? ': ' + filters.refs[0].replace(/^refs\/(heads|remotes|tags)\//, '') : '';
      el('git-log-title').textContent = 'Log' + title;
      renderBranches(); selected = entries.some(c => c.hash === previous) ? previous : undefined; render();
      if (selected) { const commit = entries.find(c => c.hash === selected)!; void choose(commit); }
      feedback(commits.length ? tr('Selecione um commit para ver os arquivos e detalhes.') : tr('Nenhum commit corresponde aos filtros.'));
    } catch (error) {
      if (token === epoch) { entries = []; render(); el('git-log-refs').replaceChildren(); feedback(String(error instanceof Error ? error.message : error)); }
    }
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const search = el<HTMLInputElement>('git-log-search');
  search.oninput = () => { filters.text = search.value; render(); clearTimeout(searchTimer); searchTimer = setTimeout(() => void load(), 400); };
  own(() => clearTimeout(searchTimer));
  for (const [id, key] of [['git-log-regex', 'regex'], ['git-log-case', 'matchCase']] as const) {
    el(id).onclick = () => { filters[key] = !filters[key]; el(id).setAttribute('aria-pressed', String(filters[key])); render(); if (filters.text.trim()) void load(); };
  }
  async function open() { show(); await load(); }
  /** Annotate → clique na anotação: abre o Log e seleciona o commit (com o arquivo como filtro de caminho). */
  async function reveal(hash: string, path?: string) {
    show(); filters = {...empty(), refs: ['--all'], paths: path ? [path] : []}; search.value = '';
    await load(hash); const commit = entries.find(c => c.hash === hash);
    if (!commit) { feedback(tr('Commit não encontrado no histórico carregado.')); return; }
    await choose(commit); focusRow(hash);
  }
  on(document, 'ide-git-show-commit', (event: Event) => { const detail = (event as CustomEvent).detail ?? {}; if (typeof detail.hash === 'string') void reveal(detail.hash, detail.path); });
  button.onclick = () => panel.hidden ? void open() : hide(); el('git-log-hide').onclick = hide; el('git-log-refresh').onclick = () => void load(); el('git-log-branches').onclick = hooks.branches; el('git-log-commit').onclick = hooks.commit;
  el<HTMLInputElement>('git-branch-search').oninput = renderBranches;
  el('git-history-revert').onclick = () => { if (selected) hooks.operation('revert', selected); };
  el('git-history-pick').onclick = () => { if (selected) hooks.operation('cherry-pick', selected); };
  return {
    open, panel, refresh: () => { if (!panel.hidden) void load(); },
    reset() { epoch++; selection++; entries = []; visible = []; filters = empty(); selected = undefined; tools = {branches: [], remotes: [], tags: [], user: ''}; search.value = ''; el<HTMLInputElement>('git-branch-search').value = '';
      for (const id of ['git-log-regex', 'git-log-case']) el(id).setAttribute('aria-pressed', 'false');
      el('git-log-title').textContent = 'Log'; el('git-history-count').textContent = ''; render(); el('git-log-refs').replaceChildren(); el('git-history-files').replaceChildren(); el('git-history-info').replaceChildren(); el('git-history-actions').hidden = true; filterLabels(); hide(); },
  };
}
