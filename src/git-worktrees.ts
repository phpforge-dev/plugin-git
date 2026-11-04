import {sdk, tr, msg, toolIcon} from './sdk';

/** Worktrees (PhpStorm 2026.1.4, G-25/G-26 e documentação pública): aba "Worktrees" na janela Git, mostrada
 *  quando o repositório tem mais de um worktree; lista com ✓ no atual, nome em negrito, branch e caminho;
 *  barra com New Worktree, Delete e Prune; diálogo New Worktree com From branch, New branch, Project name e
 *  Location ("The worktree will be created in: …"). Restrições: não excluir o principal nem o aberto, não
 *  criar dentro do projeto, branch já aberta em outro worktree exige New branch. Desenho e código próprios. */
type Worktree = {path: string; name: string; branch?: string; head?: string; current?: boolean; main?: boolean; detached?: boolean; locked?: string; prunable?: string};
type Hooks = {busy(): boolean; setBusy(value: boolean): void; showLog(): void};

export function worktreesView(api: any, panel: HTMLElement, hooks: Hooks) {
  const tabs = panel.querySelector<HTMLElement>('#git-log-tabs')!; const body = panel.querySelector<HTMLElement>('.git-log-body')!;
  const title = panel.querySelector<HTMLElement>('#git-log-title')!; const status = panel.querySelector<HTMLElement>('#git-log-status')!;
  const tab = document.createElement('span'); tab.className = 'tool-window-tab git-worktrees-tab'; tab.hidden = true;
  const open = document.createElement('button'); open.type = 'button'; open.id = 'git-worktrees-tab'; open.textContent = 'Worktrees';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'git-tab-close'; close.textContent = '×'; close.setAttribute('aria-label', tr('Fechar aba Worktrees'));
  tab.append(open, close); tabs.append(tab);
  const view = document.createElement('section'); view.id = 'git-worktrees'; view.hidden = true;
  view.innerHTML = '<div class="git-log-actions"><button type="button" id="git-worktree-new"></button><button type="button" id="git-worktree-delete" disabled></button><button type="button" id="git-worktree-prune"></button></div><div id="git-worktree-list" role="listbox" aria-label="Worktrees"></div>';
  body.after(view);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => view.querySelector<T>('#' + id)!;
  toolIcon($('git-worktree-new'), '<path d="M12 5v14M5 12h14"/>', tr('Novo worktree…'));
  toolIcon($('git-worktree-delete'), '<path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12"/>', tr('Excluir'));
  toolIcon($('git-worktree-prune'), '<path d="M19 7a8 8 0 1 0 1 8M19 3v5h-5"/>', tr('Prune: remover registros de pastas apagadas'));
  let items: Worktree[] = []; let tools: any = {branches: []}; let selected: string | undefined; let dismissed = false; let epoch = 0;
  const say = (text: string) => { status.textContent = text; };
  const run = async (input: Record<string, unknown>) => { const state = await api.gitStatus(); return api.gitOperation({...input, expectedHead: state.head}); };

  function showTab(active: boolean) {
    tab.hidden = false; tab.classList.toggle('active', active); title.classList.toggle('inactive', active);
    body.hidden = active; view.hidden = !active;
    if (active) void load(); else hooks.showLog();
  }
  function render() {
    const list = $('git-worktree-list'); list.replaceChildren();
    for (const item of items) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'git-worktree-row'; row.dataset.path = item.path; row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected === item.path)); row.classList.toggle('current', !!item.current);
      const mark = document.createElement('span'); mark.className = 'git-worktree-mark'; mark.textContent = item.current ? '✓' : '';
      const name = document.createElement('strong'); name.textContent = item.name;
      const branch = document.createElement('span'); branch.className = 'git-worktree-branch'; branch.textContent = item.branch ?? (item.detached ? msg`HEAD destacado ${(item.head ?? '').slice(0, 8)}` : '');
      const path = document.createElement('span'); path.className = 'git-worktree-path'; path.textContent = item.path;
      const state = document.createElement('span'); state.className = 'git-worktree-state'; state.textContent = item.prunable ? 'Prunable' : item.locked ? 'Locked' : '';
      row.append(mark, name, branch, path, state);
      row.onclick = () => { selected = item.path; render(); };
      row.ondblclick = () => void openWorktree(item);
      row.onkeydown = event => { if (event.key === 'Enter') void openWorktree(item); };
      list.append(row);
    }
    const current = items.find(i => i.path === selected);
    $<HTMLButtonElement>('git-worktree-delete').disabled = !current || !!current.main || !!current.current;
  }
  async function load() {
    const token = ++epoch;
    try {
      tools = await api.gitTools(); if (token !== epoch) return;
      items = tools.worktrees ?? []; if (!items.some(i => i.path === selected)) selected = undefined;
      render(); say(items.length > 1 ? msg`${items.length} worktrees` : tr('Somente o worktree principal.'));
    } catch (error) { if (token === epoch) say(String(error instanceof Error ? error.message : error)); }
  }
  /** Abrir em outra janela depende do host; sem a rota, informa o caminho para abrir pelo Welcome. */
  async function openWorktree(item: Worktree) {
    if (item.current) { say(tr('Este é o worktree aberto.')); return; }
    const choose = sdk?.host?.chooseProject;
    if (typeof choose === 'function') { try { await choose(item.path); return; } catch (error) { say(String(error)); return; } }
    try { await navigator.clipboard?.writeText(item.path); } catch {}
    say(msg`Caminho copiado: ${item.path}. Abra-o em Arquivo → Abrir projeto.`);
  }
  async function operation(input: Record<string, unknown>, done: string) {
    if (hooks.busy()) return false; hooks.setBusy(true);
    try { await run(input); say(done); return true; }
    catch (error) { say(String(error instanceof Error ? error.message : error)); return false; }
    finally { hooks.setBusy(false); await load(); }
  }
  async function create() {
    const workspace = await api.workspace().catch(() => ({root: '', name: ''}));
    const parent = workspace.root ? workspace.root.replace(/\/[^/]+\/?$/, '') || '/' : '';
    const busyBranches = new Set(items.map(i => i.branch).filter(Boolean));
    document.querySelector('.git-worktree-dialog')?.remove();
    const box = document.createElement('dialog'); box.className = 'git-worktree-dialog git-changelist-dialog';
    box.innerHTML = `<form method="dialog"><h2></h2>
      <label class="git-cl-row"><span></span><select name="branch"></select></label>
      <label class="git-cl-row git-wt-new"><span><input type="checkbox" name="useNew"> <em></em></span><input name="newBranch" disabled spellcheck="false" autocomplete="off"></label>
      <label class="git-cl-row"><span></span><input name="name" spellcheck="false" autocomplete="off"></label>
      <label class="git-cl-row"><span></span><input name="location" spellcheck="false" autocomplete="off"></label>
      <p class="git-wt-hint"></p><p class="git-cl-error" role="alert"></p><div class="git-cl-buttons"><button type="button"></button><button type="submit" class="primary"></button></div></form>`;
    const form = box.querySelector('form')!; const f = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as unknown as T;
    box.querySelector('h2')!.textContent = tr('Novo worktree');
    const labels = box.querySelectorAll('label > span');
    labels[0]!.textContent = tr('Da branch:'); box.querySelector('.git-wt-new em')!.textContent = tr('Nova branch:'); labels[2]!.textContent = tr('Nome do projeto:'); labels[3]!.textContent = tr('Local:');
    const select = f<HTMLSelectElement>('branch'); select.append(new Option(tr('Selecione a branch'), ''));
    for (const b of (tools.branches ?? []).filter((b: GitBranch) => !b.name.endsWith('/HEAD'))) {
      const option = new Option(b.name + (busyBranches.has(b.name) ? tr(' (aberta em outro worktree)') : b.remote ? tr(' (remota)') : ''), b.name); select.append(option);
    }
    const useNew = f<HTMLInputElement>('useNew'); const newBranch = f<HTMLInputElement>('newBranch'); const name = f<HTMLInputElement>('name'); const location = f<HTMLInputElement>('location');
    location.value = parent;
    const [cancel, ok] = [...box.querySelectorAll<HTMLButtonElement>('.git-cl-buttons button')]; cancel!.textContent = tr('Cancelar'); ok!.textContent = tr('Criar worktree');
    let touched = false; name.addEventListener('input', () => { touched = true; });
    const target = () => (location.value.replace(/\/+$/, '') || '') + '/' + name.value.trim();
    const sync = () => {
      const branch = select.value; const needsNew = busyBranches.has(branch);
      if (needsNew && !useNew.checked) useNew.checked = true;
      newBranch.disabled = !useNew.checked;
      if (!touched && branch) name.value = `${workspace.name || 'project'}-${(useNew.checked && newBranch.value.trim() ? newBranch.value.trim() : branch).split('/').pop()}`;
      box.querySelector('.git-wt-hint')!.textContent = name.value.trim() && location.value.trim() ? msg`O worktree será criado em: ${target()}` : '';
      ok!.disabled = !branch || !name.value.trim() || !location.value.trim().startsWith('/') || (useNew.checked && !newBranch.value.trim());
    };
    form.oninput = sync; form.onchange = sync; sync();
    cancel!.onclick = () => box.close(); box.onclose = () => box.remove();
    form.onsubmit = async event => {
      event.preventDefault(); const error = box.querySelector('.git-cl-error')!; error.textContent = '';
      if (hooks.busy()) return; hooks.setBusy(true); ok!.disabled = true;
      try {
        await run({kind: 'worktree-add', target: target(), branch: select.value, ...(useNew.checked ? {newBranch: newBranch.value.trim()} : {})});
        box.close(); say(msg`Worktree criado em ${target()}.`);
      } catch (failure) { error.textContent = String(failure instanceof Error ? failure.message : failure); }
      finally { hooks.setBusy(false); sync(); await load(); }
    };
    document.body.append(box); box.showModal(); select.focus();
  }
  async function remove() {
    const item = items.find(i => i.path === selected); if (!item || item.main || item.current) return;
    document.querySelector('.git-worktree-confirm')?.remove();
    const box = document.createElement('dialog'); box.className = 'git-worktree-confirm git-changelist-dialog';
    box.innerHTML = '<form method="dialog"><h2></h2><p></p><div class="git-cl-buttons"><button type="button"></button><button type="submit" class="primary"></button></div></form>';
    box.querySelector('h2')!.textContent = tr('Excluir worktree');
    box.querySelector('p')!.textContent = msg`Excluir ${item.path}? Alterações não commitadas impedem a exclusão.`;
    const [cancel, ok] = [...box.querySelectorAll<HTMLButtonElement>('button')]; cancel!.textContent = tr('Cancelar'); ok!.textContent = tr('Excluir');
    cancel!.onclick = () => box.close(); box.onclose = () => box.remove();
    box.querySelector('form')!.onsubmit = event => { event.preventDefault(); box.close(); void operation({kind: 'worktree-remove', target: item.path}, msg`Worktree ${item.name} excluído.`); };
    document.body.append(box); box.showModal(); cancel!.focus();
  }
  $('git-worktree-new').onclick = () => void create();
  $('git-worktree-delete').onclick = () => void remove();
  $('git-worktree-prune').onclick = () => void operation({kind: 'worktree-prune'}, tr('Registros de worktrees apagados foram removidos.'));
  view.addEventListener('keydown', event => { if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) { event.preventDefault(); void remove(); } });
  open.onclick = () => showTab(true);
  title.addEventListener('click', () => { if (!view.hidden) showTab(false); });
  close.onclick = () => { dismissed = true; tab.hidden = true; showTab(false); };
  /** Como no PhpStorm: a aba aparece sozinha quando já existe mais de um worktree. */
  async function sync(worktrees: Worktree[] | undefined) { if (worktrees && worktrees.length > 1 && !dismissed) tab.hidden = false; }
  return {sync, open: () => showTab(true), reset() { epoch++; items = []; selected = undefined; dismissed = false; tab.hidden = true; view.hidden = true; body.hidden = false; title.classList.remove('inactive'); }};
}
