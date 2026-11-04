import {sdk,tr,msg,html,dockWindow,resizeToolWindow,toolIcon,editorFont,keymap,fileIcon,activeLanguage,monaco,own,on,every,iconButton} from './sdk';


import {mountGitFileAgent} from './git-file-agent';
import {mountCommitGeneration} from './git-generate-message';
import { mountGitAccount } from './git-account';
import { mountGitAccounts, accountError, describeAccount } from './git-accounts';

import { gitLogView } from './git-log-view';

import { gitTools } from './git-tools';
import { changelistDialog, closeChangelistDialog, findList, groupByChangelist, listLabel, type Changelist } from './git-changelists';
import { showMenu, closeMenus } from './git-menu';
import { lineSelection, countLabel } from './git-line-selection';


export function mountGit(api: IdeApi, hasUnsaved: () => boolean, reloadWorkspace: () => Promise<void>) {
  const sidebar = document.querySelector('main > aside')!;
  const tools = document.createElement('div');
  tools.className = 'switch';
  tools.innerHTML = html('<button id="show-project">Projeto</button><button id="show-commit">Commit</button><button id="show-git">Git</button>');
  sidebar.prepend(tools);
  const panel = document.createElement('section');
  panel.id = 'git-panel'; panel.hidden = true;
  panel.innerHTML = html`<div class="git-heading"><strong>Commit</strong><span id="git-branch" hidden></span><button id="git-panel-menu" aria-label="Opções do Commit">⋮</button></div>
    <div class="git-commit-toolbar"><button id="git-refresh"></button><button id="git-show-diff"></button><button id="git-tools"></button><button id="git-log-tab"></button><button id="git-search-toggle"></button><button id="git-expand-all"></button><button id="git-collapse-all"></button></div>
    <div id="git-panel-options" hidden><button id="git-accounts-menu">Contas Git…</button><button id="git-project-account-menu">Conta Git deste projeto…</button><button id="git-account">Identidade e autenticação locais (git config)…</button></div>
    <input id="git-file-filter" hidden type="search" placeholder="Buscar arquivos alterados…" aria-label="Buscar arquivos alterados…">
    <div id="git-changes-tab" hidden></div><div id="git-changes"></div>
    <div id="git-feedback" role="status" aria-live="polite"></div>
    <div id="git-commit-form"><div class="git-commit-options"><label><input type="checkbox" id="git-amend">Amend</label><span id="git-amend-target">último commit</span><button type="button" id="git-project-account" class="git-project-account"></button></div><textarea id="git-message" aria-label="Mensagem do commit" placeholder="Mensagem do commit"></textarea><div class="git-commit-buttons"><button id="git-review-commit" disabled>Commit</button><button id="git-commit-push" disabled>Commit e Push…</button><button id="git-commit-settings" aria-label="Conta Git deste projeto…"></button></div></div>`;
  sidebar.append(panel);
  const review = document.createElement('section');
  review.id = 'git-review'; review.hidden = true;
  // Layout follows the PhpStorm diff viewer: navigation icons, viewer/whitespace/highlight choices, difference count; then path and sides.
  review.innerHTML = html('<div class="git-diff-toolbar"><span class="git-diff-icons"><button id="git-diff-prev" type="button"></button><button id="git-diff-next" type="button"></button><button id="git-diff-source" type="button"></button><span class="git-diff-separator"></span><button id="git-file-prev" type="button"></button><button id="git-file-next" type="button"></button></span>'
    + '<select id="git-diff-viewer" aria-label="Modo de visualização"><option value="side">Visualizador lado a lado</option><option value="unified">Visualizador unificado</option></select>'
    + '<select id="git-diff-whitespace" aria-label="Espaços em branco"><option value="none">Não ignorar</option><option value="trim">Ignorar espaços nas pontas</option></select>'
    + '<select id="git-diff-highlight" aria-label="Destaque das diferenças"><option value="chars">Destacar caracteres</option><option value="lines">Destacar linhas</option><option value="none">Não destacar</option></select>'
    + '<span id="git-diff-count" role="status"></span></div>'
    + '<div class="git-diff-header"><strong id="git-file"></strong><span id="git-sides"></span><span class="git-diff-actions"><button id="git-stage-lines" hidden>Preparar linhas incluídas</button><button id="git-hunks">Selecionar trechos…</button><button id="git-stage">Preparar arquivo</button><button id="git-close-diff">Voltar ao editor</button></span></div><div id="git-diff"></div>');
  document.querySelector('.code')!.append(review);
  const dialog = document.createElement('dialog');
  dialog.innerHTML = html('<h2>Conferir commit local</h2><p>Será gravada a versão preparada de todos os arquivos abaixo. Mudanças somente no disco ficam de fora.</p><ul id="git-commit-files"></ul><pre id="git-commit-message"></pre><p id="git-commit-error" role="alert"></p><button id="git-cancel-commit">Voltar à revisão</button> <button id="git-confirm-commit">Criar commit local</button>');
  document.body.append(dialog);own(()=>dialog.remove());
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  toolIcon(el('git-refresh'),'<path d="M19 7a8 8 0 1 0 1 8M19 3v5h-5"/>',tr('Atualizar alterações'));
  toolIcon(el('git-tools'),'<circle cx="7" cy="5" r="2"/><circle cx="17" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10m10-10c0 7-10 2-10 8"/>',tr('Branches e operações…'));
  toolIcon(el('git-commit-settings'),'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',tr('Conta Git deste projeto…'));
  toolIcon(el('git-show-diff'),'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',tr('Mostrar diff'));
  toolIcon(el('git-log-tab'),'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',tr('Histórico'));
  toolIcon(el('git-search-toggle'),'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',tr('Buscar arquivos alterados…'));
  toolIcon(el('git-expand-all'),'<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',tr('Expandir tudo'));
  toolIcon(el('git-collapse-all'),'<path d="m8 4 4 4 4-4m-8 16 4-4 4 4"/>',tr('Recolher tudo'));
  el('git-panel-menu').onclick=()=>{el('git-panel-options').hidden=!el('git-panel-options').hidden;};
  el('git-search-toggle').onclick=()=>{const input=el<HTMLInputElement>('git-file-filter');input.hidden=!input.hidden;if(!input.hidden)input.focus();else{input.value='';if(state)render();}};
  el('git-expand-all').onclick=()=>panel.querySelectorAll('details').forEach(d=>d.open=true);
  el('git-collapse-all').onclick=()=>panel.querySelectorAll('details').forEach(d=>d.open=false);
  el('git-show-diff').onclick=()=>(panel.querySelector<HTMLButtonElement>('.git-file-row.selected')??panel.querySelector<HTMLButtonElement>('.git-file-row'))?.click();
  const diff = ownEditor(el('git-diff'), { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, renderSideBySideInlineBreakpoint: 600, minimap: { enabled: false }, scrollBeyondLastLine: false });
  const diffPrefs = (() => { try { return JSON.parse(localStorage.getItem('phpforge.git.diff') ?? '{}'); } catch { return {}; } })() as { viewer?: string; whitespace?: string; highlight?: string };
  const viewer = el<HTMLSelectElement>('git-diff-viewer'), whitespace = el<HTMLSelectElement>('git-diff-whitespace'), highlight = el<HTMLSelectElement>('git-diff-highlight');
  viewer.value = diffPrefs.viewer === 'unified' ? 'unified' : 'side'; whitespace.value = diffPrefs.whitespace === 'trim' ? 'trim' : 'none';
  highlight.value = ['lines', 'none'].includes(diffPrefs.highlight ?? '') ? diffPrefs.highlight! : 'chars';
  function applyDiffPrefs() {
    diff.updateOptions?.({ renderSideBySide: viewer.value === 'side', ignoreTrimWhitespace: whitespace.value === 'trim' });
    review.dataset.highlight = highlight.value;
    try { localStorage.setItem('phpforge.git.diff', JSON.stringify({ viewer: viewer.value, whitespace: whitespace.value, highlight: highlight.value })); } catch {}
  }
  for (const select of [viewer, whitespace, highlight]) select.onchange = applyDiffPrefs;
  applyDiffPrefs();
  iconButton(el('git-diff-prev'), '<path d="M12 19V5m-6 6 6-6 6 6"/>', tr('Diferença anterior (Shift+F7)'));
  iconButton(el('git-diff-next'), '<path d="M12 5v14m-6-6 6 6 6-6"/>', tr('Próxima diferença (F7)'));
  iconButton(el('git-diff-source'), '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/>', tr('Ir para o código-fonte (F4)'));
  iconButton(el('git-file-prev'), '<path d="M19 12H5m6-6-6 6 6 6"/>', tr('Arquivo anterior'));
  iconButton(el('git-file-next'), '<path d="M5 12h14m-6-6 6 6-6 6"/>', tr('Próximo arquivo'));
  let reviewPath: string | undefined;
  const changeCount = () => diff.getLineChanges?.()?.length ?? 0;
  // Seleção de trechos/linhas no gutter do diff (PhpStorm: "1 difference, 0 included").
  const lines = lineSelection(api, diff, {busy: () => busy, setBusy(value) { busy = value; el<HTMLButtonElement>('open').disabled = value; commitEnabled(); },
    feedback: text => feedback(text), countChanged: () => updateCount(),
    async changed() {
      const current = selected; await refresh(true); if (!current) return;
      const change = state?.changes.find(c => c.path === current.value.path);
      const stillThere = change && (current.staged ? change.index !== ' ' && change.index !== '?' : change.worktree !== ' ');
      if (stillThere) await showDiff(current.value.path, current.staged); else closeDiff();
    }});
  function updateCount() {
    const count = changeCount();
    const stageable = !!selected && lines.available();
    el('git-diff-count').textContent = countLabel(count, stageable ? lines.included() : -1, !!selected?.staged);
    const button = el<HTMLButtonElement>('git-stage-lines'); button.hidden = !stageable;
    button.textContent = selected?.staged ? tr('Retirar linhas marcadas') : tr('Preparar linhas incluídas');
    button.disabled = busy || !stageable || lines.included() === 0;
    for (const id of ['git-diff-prev', 'git-diff-next']) el<HTMLButtonElement>(id).disabled = !count;
  }
  own(diff.onDidUpdateDiff?.(updateCount));
  const goToDiff = (target: 'next' | 'previous') => { if (changeCount()) diff.goToDiff(target); };
  /** Opens the reviewed file at the line under the cursor of the right-hand (current) side, like PhpStorm Jump to Source. */
  async function jumpToSource() {
    if (!reviewPath) return;
    const line = diff.getModifiedEditor?.().getPosition?.()?.lineNumber ?? diff.getLineChanges?.()?.[0]?.modifiedStartLineNumber ?? 1;
    const path = reviewPath; closeDiff();
    try { await sdk.host.open(path, Math.max(0, line - 1)); } catch (error) { feedback(String(error)); }
  }
  function stepFile(delta: number) {
    const rows = [...panel.querySelectorAll<HTMLButtonElement>('.git-file-row')];
    const at = rows.findIndex(row => row.classList.contains('selected'));
    if (rows.length) rows[(at + delta + rows.length) % rows.length].click();
  }
  el('git-diff-prev').onclick = () => goToDiff('previous'); el('git-diff-next').onclick = () => goToDiff('next');
  el('git-diff-source').onclick = () => { void jumpToSource(); };
  el('git-file-prev').onclick = () => stepFile(-1); el('git-file-next').onclick = () => stepFile(1);
  on(review, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'F7') { event.preventDefault(); goToDiff(event.shiftKey ? 'previous' : 'next'); }
    else if (event.key === 'F4' || (event.key === 'ArrowDown' && (event.metaKey || event.ctrlKey))) { event.preventDefault(); void jumpToSource(); }
  });
  let models: monaco.editor.ITextModel[] = [];
  let state: GitState | undefined;
  let selected: { value: GitDiff; staged: boolean } | undefined;
  let busy = false;
  let pushAfterCommit = false;
  let messageBeforeAmend = "";
  let loading = false;
  let generation = 0;
  const agentFiles = mountGitFileAgent(api, panel, hasUnsaved);
  let selectionRequest = 0;own(()=>{generation++;selectionRequest++;closeDiff();el('tree').hidden=false;const heading=sidebar.querySelector('h3');if(heading)heading.hidden=false;document.querySelector('main')?.classList.remove('git-open');});
  let diffQueue = Promise.resolve();
  
  let lastState = '';
  const feedback = (message: string) => { el('git-feedback').textContent = message; };
  const conflictStatus = (code: string) => ['DD','AU','UD','UA','DU','AA','UU'].includes(code);
  const staged = () => state?.changes.filter(c => c.index !== ' ' && c.index !== '?' && !conflictStatus(c.index + c.worktree)) ?? [];
  const operations = gitTools(api, { ensureAccount: (kind: string) => accounts.ensure(kind), chooseAccount: (reason: string) => accounts.choose(reason), hasUnsaved, busy: () => busy, setBusy(value) { busy = value; el<HTMLButtonElement>('open').disabled = value; commitEnabled(); if (!value) {void refresh(true);history.refresh();} }, async changed() { closeDiff(); try { await reloadWorkspace(); } catch(error) { feedback(String(error)); } }, feedback });
  const account=mountGitAccount(api,()=>busy,value=>{busy=value;el<HTMLButtonElement>('open').disabled=value;commitEnabled();});
  const accounts=mountGitAccounts(api);
  const chooseAccount=()=>accounts.choose(tr('Escolha a conta usada nos commits e pushes deste projeto.'));
  let accountRequest=0;
  /** Conta do projeto sempre visível no Commit; clicar troca a conta. */
  async function showAccount(){
    const version=++accountRequest;const chip=el<HTMLButtonElement>('git-project-account');
    try{const {project}=await accounts.load();if(version!==accountRequest)return;chip.hidden=!project;if(!project)return;
      chip.classList.toggle('warning',project.missing||!project.binding);
      chip.textContent=project.missing?tr('Conta removida — escolher…'):project.binding==='system'?tr('Conta: Git do sistema'):project.account?msg`Conta: ${project.account.login}@${project.account.host}`:tr('Conta: escolher no commit');
      chip.title=project.account?describeAccount(project.account):tr('Conta Git deste projeto');
    }catch{chip.hidden=true;}
  }
  accounts.onChange(()=>{void showAccount();});
  el('git-project-account').onclick=()=>{void chooseAccount();};
  el('git-accounts-menu').onclick=()=>{el('git-panel-options').hidden=true;void accounts.open();};
  el('git-project-account-menu').onclick=()=>{el('git-panel-options').hidden=true;void chooseAccount();};
  el('git-account').onclick=()=>{el('git-panel-options').hidden=true;void account.open();};
  el('git-commit-settings').onclick=()=>{void chooseAccount();};
  el('git-tools').onclick = () => { void operations.branches(); };
  on(document,'ide-git-branches',()=>{void operations.branches();});
  function commitEnabled() {
    agentFiles.setBusy(busy);
    const amend=el<HTMLInputElement>('git-amend');
    amend.disabled=busy||!state?.head||!!state.operation||!!state.mergeHead;
    const disabled=busy||!state||!!state.changes.some(c=>conflictStatus(c.index+c.worktree))||(!staged().length&&!state.mergeHead&&!amend.checked)||!el<HTMLTextAreaElement>('git-message').value.trim();
    el<HTMLButtonElement>('git-review-commit').disabled=disabled;el<HTMLButtonElement>('git-commit-push').disabled=disabled;
    panel.querySelectorAll<HTMLInputElement>('#git-changes input').forEach(input=>input.disabled=busy);
  }
  /** Stages/unstages a batch: one status, diffs read in parallel, stages in sequence (git index lock). Boxes flip at once; the refresh corrects them on failure. */
  async function prepareFiles(paths:string[],prepare:boolean){
    if(busy)return;const focus=document.activeElement?.getAttribute('aria-label');busy=true;el<HTMLButtonElement>('open').disabled=true;commitEnabled();
    for(const path of paths){const box=panel.querySelector<HTMLInputElement>(`#git-changes input[aria-label="${CSS.escape(msg`Preparar ${path}`)}"]`);if(box){box.checked=prepare;box.indeterminate=false;}}
    try{
      const current=await api.gitStatus();
      const targets=paths.filter(path=>{const change=current.changes.find(c=>c.path===path);if(!change||conflictStatus(change.index+change.worktree))return false;
        const inIndex=change.index!==' '&&change.index!=='?';return !(prepare&&change.worktree===' '&&inIndex||!prepare&&!inIndex);});
      const diffs=await Promise.all(targets.map(path=>api.gitDiff(path,!prepare)));
      for(const [i,path] of targets.entries()){
        if(targets.length>1)feedback(prepare?msg`Preparando ${i+1}/${targets.length}…`:msg`Retirando ${i+1}/${targets.length}…`);
        await api.gitStage(path,!prepare,diffs[i].token);
      }
      if(selected&&targets.includes(el('git-file').textContent??''))closeDiff();feedback('');
    }catch(error){feedback(String(error));}
    finally{busy=false;el<HTMLButtonElement>('open').disabled=false;lastState='';await refresh();commitEnabled();if(focus)panel.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(focus)}"]`)?.focus();}
  }
  el<HTMLInputElement>('git-amend').onchange=async()=>{
    const amend=el<HTMLInputElement>('git-amend');if(!amend.checked){el<HTMLTextAreaElement>('git-message').value=messageBeforeAmend;commitEnabled();return;}
    messageBeforeAmend=el<HTMLTextAreaElement>('git-message').value;const version=generation;busy=true;el<HTMLButtonElement>('open').disabled=true;commitEnabled();
    try{const message=await api.gitCommitMessage();if(version===generation)el<HTMLTextAreaElement>('git-message').value=message;}catch(error){amend.checked=false;feedback(String(error));}
    finally{busy=false;el<HTMLButtonElement>('open').disabled=false;commitEnabled();}
  };
  function closeDiff() {
    selectionRequest++; selected = undefined; reviewPath = undefined; lines.clear(); diff.setModel(null); models.forEach(m => m.dispose()); models = [];
    review.hidden = true;
    for (const id of ['tabs', 'breadcrumbs', 'navigation', 'editor']) el(id).hidden = false;
  }
  async function showDiff(path: string, prepared: boolean, revision?: string) {
    const request = ++selectionRequest;
    feedback(tr('Carregando comparação…'));
    el<HTMLButtonElement>('git-stage').disabled = true;
    const previous = diffQueue;
    let release!: () => void;
    diffQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (request !== selectionRequest) return;
      const value = revision ? await api.gitHistoryDiff(revision, path) : await api.gitDiff(path, prepared);
      if (request !== selectionRequest) return;
      diff.setModel(null); models.forEach(m => m.dispose());
      const language = path.endsWith('.php') ? 'php' : undefined;
      models = [monaco.editor.createModel(value.before, language), monaco.editor.createModel(value.after, language)];
      diff.setModel({ original: models[0], modified: models[1] });
      selected = revision ? undefined : { value, staged: prepared };
      el('git-stage').hidden = !!revision; el('git-hunks').hidden = !!revision;
      for (const row of panel.querySelectorAll<HTMLButtonElement>('.git-file-row')) row.classList.toggle('selected', row.dataset.path === path && row.dataset.staged === String(prepared));
      el('git-file').textContent = path; reviewPath = path;
      el('git-sides').textContent = `${value.beforeLabel}   →   ${value.afterLabel}`;
      if (revision) lines.clear(); else void lines.load(path, prepared);
      el('git-stage').textContent = prepared ? tr('Retirar do commit') : tr('Preparar arquivo inteiro');
      el<HTMLButtonElement>('git-stage').disabled = busy;
      for (const id of ['tabs', 'breadcrumbs', 'navigation', 'editor']) el(id).hidden = true;
      review.hidden = false; diff.layout(); updateCount();
      feedback(revision ? tr('Comparação histórica somente leitura; merges são comparados com o primeiro pai.') : hasUnsaved() ? tr('Há buffers não salvos. O Git compara somente o conteúdo do disco.') : tr('Revise o diff antes de preparar ou retirar o arquivo.'));
    } catch (error) { if (request === selectionRequest) { closeDiff(); feedback(String(error)); } }
    finally { release(); }
  }
  function render() {
    const list = el('git-changes'); list.replaceChildren();
    const tracked = state!.changes.filter(c => c.index !== '?' && !conflictStatus(c.index + c.worktree));
    type Group = {label: string; changes: GitChange[]; conflicts?: boolean; changelist?: Changelist};
    const groups: Group[] = [{label: tr('Conflitos · clique para resolver'), changes: state!.changes.filter(c => conflictStatus(c.index + c.worktree)), conflicts: true}];
    // Changelists (PhpStorm): uma por grupo, a ativa em negrito; sem o serviço, um grupo único como antes.
    if (lists?.length) for (const {list: changelist, changes} of groupByChangelist(lists, tracked)) groups.push({label: listLabel(changelist), changes, changelist});
    else groups.push({label: tr('Alterações'), changes: tracked});
    groups.push({label: tr('Não rastreados'), changes: state!.changes.filter(c => c.index === '?')});
    for (const {label, changes, conflicts, changelist} of groups) {
      if(!changes.length&&!changelist)continue;const group=document.createElement('details');group.open=true;const heading=document.createElement('summary');const title=document.createElement('strong');title.textContent=label;const count=document.createElement('small');count.textContent=!changes.length?'':changes.length===1?tr('1 arquivo'):msg`${changes.length} arquivos`;heading.append(title,count);group.append(heading);list.append(group);
      if(changelist){group.classList.add('git-changelist');group.dataset.changelist=changelist.id;group.classList.toggle('git-changelist-active',changelist.active);if(changelist.comment)heading.title=changelist.comment;
        heading.addEventListener('contextmenu',event=>{event.preventDefault();heading.click();changelistMenu(changelist,event.clientX,event.clientY);});
        heading.addEventListener('keydown',event=>{if(event.key==='F2'){event.preventDefault();void editChangelist(changelist);}else if(event.key===' '&&event.ctrlKey){event.preventDefault();void changelistAction({action:'set-active',id:changelist.id});}});
        // Arrastar arquivos entre changelists.
        group.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('application/x-phpforge-path')){event.preventDefault();group.classList.add('git-drop');}});
        group.addEventListener('dragleave',()=>group.classList.remove('git-drop'));
        group.addEventListener('drop',event=>{group.classList.remove('git-drop');const path=event.dataTransfer?.getData('application/x-phpforge-path');if(!path)return;event.preventDefault();if(!changelist.files.includes(path))void changelistAction({action:'move',paths:[path],target:changelist.id});});}
      if(!conflicts&&changes.length){const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.setAttribute('aria-label',label);const indexed=changes.filter(c=>c.index!==' '&&c.index!=='?');checkbox.checked=indexed.length===changes.length;checkbox.indeterminate=indexed.length>0&&indexed.length<changes.length;checkbox.onclick=e=>e.stopPropagation();checkbox.onchange=()=>void prepareFiles(changes.map(c=>c.path),checkbox.checked);heading.prepend(checkbox);}
      heading.addEventListener('click',()=>{panel.querySelectorAll('summary').forEach(row=>row.classList.remove('selected'));heading.classList.add('selected');});
      if (conflicts && changes.length) {
        // Mesmas ações da notificação do PhpStorm durante um merge com conflitos.
        const actions = document.createElement('div'); actions.className = 'git-conflict-actions';
        const all = document.createElement('button'); all.textContent = tr('Resolver conflitos…'); all.onclick = () => void operations.conflicts();
        actions.append(all);
        // Abortar conforme a operação em andamento (merge, rebase, cherry-pick ou revert).
        const current = state!.operation ?? (state!.mergeHead ? 'merge' : null);
        const abortKind = ({ merge: 'merge-abort', rebase: 'rebase-abort', 'cherry-pick': 'cherry-pick-abort', revert: 'revert-abort' } as const)[current as 'merge'];
        if (abortKind) { const abort = document.createElement('button'); abort.textContent = tr({ 'merge-abort': 'Abortar merge', 'rebase-abort': 'Abortar rebase', 'cherry-pick-abort': 'Abortar cherry-pick', 'revert-abort': 'Abortar revert' }[abortKind]); abort.onclick = () => void operations.open(abortKind); actions.append(abort); }
        list.append(actions);
      }
      for (const change of changes.filter(c=>c.path.toLowerCase().includes(el<HTMLInputElement>('git-file-filter').value.toLowerCase()))) {
        const button = document.createElement('button');
        const prepared=change.index!==' '&&change.index!=='?'&&change.worktree===' ';
        button.className = 'git-file-row'; button.dataset.path = change.path; button.dataset.staged = String(prepared);
        button.textContent = change.path.split('/').pop()!; button.prepend(fileIcon(change.path));const directory=document.createElement('small');directory.className='git-file-directory';directory.textContent=change.path.includes('/')?change.path.slice(0,change.path.lastIndexOf('/')):'';button.append(directory);button.dataset.status=change.index==='?'?'?':prepared?change.index:change.worktree;
        button.title = change.originalPath ? `${change.originalPath} → ${change.path}` : change.path;
        button.onclick = () => { void (conflictStatus(change.index + change.worktree) ? operations.resolve(change.path) : showDiff(change.path, prepared)); };const row=document.createElement('div');row.className='git-change-row';
        if(changelist){button.draggable=true;button.addEventListener('dragstart',event=>{event.dataTransfer?.setData('application/x-phpforge-path',change.path);});
          button.addEventListener('contextmenu',event=>{event.preventDefault();for(const other of panel.querySelectorAll('.git-file-row.selected'))other.classList.remove('selected');button.classList.add('selected');fileMenu(change,prepared,changelist,event.clientX,event.clientY);});
          button.addEventListener('keydown',event=>{if(event.key.toLowerCase()==='m'&&event.shiftKey&&(event.metaKey||event.ctrlKey)){event.preventDefault();void moveToChangelist([change.path]);}});}
        if(!conflictStatus(change.index+change.worktree)){const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=change.index!==' '&&change.index!=='?';checkbox.indeterminate=checkbox.checked&&change.worktree!==' ';checkbox.setAttribute('aria-label',msg`Preparar ${change.path}`);checkbox.title=tr('Incluir no index para commit');checkbox.onchange=()=>void prepareFiles([change.path],checkbox.checked);row.append(checkbox);}row.append(button);group.append(row);
      }
    }
    agentFiles.sync(state!.changes);
    if (!state!.changes.length) { const p = document.createElement('p'); p.textContent = state!.mergeHead ? tr('Conteúdo sem alterações. Conclua o merge com um commit.') : tr('Nenhuma alteração. Diretório de trabalho limpo.'); list.append(p); }
    commitEnabled();
  }
  /** Changelists: lidas junto com o status quando ele muda; host sem o serviço mantém o grupo único. */
  let lists: Changelist[] | undefined;
  async function loadLists() {
    try { lists = (await api.gitChangelists({action: 'list'})).lists; } catch { lists = undefined; }
  }
  async function changelistAction(input: Record<string, unknown>) {
    if (busy) return;
    try { lists = (await api.gitChangelists(input)).lists; render(); }
    catch (error) { feedback(String(error instanceof Error ? error.message : error)); }
  }
  async function moveToChangelist(paths: string[]) {
    if (!lists) return;
    const current = lists.find(l => paths.every(p => l.files.includes(p)));
    const choice = await changelistDialog({title: tr('Mover para outra changelist'), lists, name: current ? listLabel(current) : '', comment: current?.comment, choose: true});
    if (!choice) return;
    const existing = findList(lists, choice.name);
    await changelistAction(existing ? {action: 'move', paths, target: existing.id, setActive: choice.setActive} : {action: 'move', paths, name: choice.name, comment: choice.comment, setActive: choice.setActive});
  }
  async function newChangelist() {
    if (!lists) return;
    const choice = await changelistDialog({title: tr('Nova changelist'), lists});
    if (choice) await changelistAction({action: 'create', name: choice.name, comment: choice.comment, setActive: choice.setActive});
  }
  async function editChangelist(changelist: Changelist) {
    if (!lists) return;
    const choice = await changelistDialog({title: tr('Editar changelist'), lists, name: changelist.name === 'Changes' && changelist.id === 'default' ? listLabel(changelist) : changelist.name, comment: changelist.comment, setActive: changelist.active});
    if (choice) await changelistAction({action: 'edit', id: changelist.id, name: changelist.id === 'default' && choice.name === listLabel(changelist) ? changelist.name : choice.name, comment: choice.comment, setActive: choice.setActive});
  }
  function changelistMenu(changelist: Changelist, x: number, y: number) {
    showMenu([
      {label: tr('Nova changelist…'), run: () => void newChangelist()},
      {label: tr('Editar changelist…'), shortcut: 'F2', run: () => void editChangelist(changelist)},
      {label: tr('Definir como changelist ativa'), disabled: changelist.active, run: () => void changelistAction({action: 'set-active', id: changelist.id})},
      {label: tr('Excluir changelist'), disabled: changelist.active, run: () => void changelistAction({action: 'delete', id: changelist.id})},
    ], x, y, listLabel(changelist));
  }
  function fileMenu(change: GitChange, prepared: boolean, changelist: Changelist, x: number, y: number) {
    showMenu([
      {label: tr('Mover para outra changelist…'), shortcut: '⇧⌘M', run: () => void moveToChangelist([change.path])},
      {label: tr('Mostrar diff'), shortcut: '⌘D', run: () => void showDiff(change.path, prepared)},
      {label: tr('Ir para o código-fonte'), run: () => { void sdk.host.open(change.path).catch((error: unknown) => feedback(String(error))); }},
      'separator',
      {label: tr('Nova changelist…'), run: () => void newChangelist()},
      {label: tr('Editar changelist…'), shortcut: 'F2', run: () => void editChangelist(changelist)},
    ], x, y, change.path);
  }
  async function refresh(force = false) {
    if (loading || busy) return;
    loading = true; const version = generation;
    try {
      const result = await api.gitStatus();
      if (version !== generation) return;
      const changed = force || JSON.stringify(result) !== lastState;
      if (changed) await loadLists();
      if (version !== generation) return;
      state = result; el('git-branch').textContent = `⑂ ${state.branch}${state.mergeHead ? tr(' · merge em andamento') : ''}`;
      const serialized = JSON.stringify(state);
      if (force || serialized !== lastState) { lastState = serialized; render(); }
      if (force) feedback(hasUnsaved() ? tr('Há buffers não salvos. Git usa o conteúdo do disco.') : '');
    } catch (error) {
      if (version !== generation) return;
      state = undefined; agentFiles.sync([]); lastState = ''; el('git-branch').textContent = '';  el('git-changes').replaceChildren(); commitEnabled(); closeDiff(); feedback(String(error));
    } finally { loading = false; }
  }
  const history = gitLogView(api,{diff(path,revision){void showDiff(path,false,revision);},branches(){void operations.branches();},operation(kind,hash){void operations.open(kind,hash);},commit(){el('show-commit').click();}});
  // Annotate → Mostrar diff: diff histórico do arquivo no commit da linha.
  on(document, 'ide-git-show-diff', (event: Event) => { const {hash, path} = (event as CustomEvent).detail ?? {}; if (hash && path) void showDiff(path, false, hash); });
  el('show-commit').onclick = () => { panel.hidden=false;el('tree').hidden=true;sidebar.querySelector('h3')!.hidden=true;document.querySelector('main')!.classList.add('git-open');void refresh(true);void showAccount(); };
  el('show-project').onclick = () => { panel.hidden=true;el('tree').hidden=false;sidebar.querySelector('h3')!.hidden=false;document.querySelector('main')!.classList.remove('git-open');closeDiff(); };
  el('git-refresh').onclick=()=>{void refresh(true);history.refresh();};
  el('git-changes-tab').onclick=()=>{void refresh(true);};el('git-log-tab').onclick=()=>{void history.open();};
  el('git-close-diff').onclick = closeDiff;
  el('git-stage-lines').onclick = () => { void lines.apply(); };
  el('git-hunks').onclick = async () => {
    if (!selected || busy) return;
    const current = selected;
    try {
      const data = await api.gitHunks(current.value.path, current.staged);
      if (selected !== current) return;
      const modal = document.createElement('dialog'); modal.className = 'git-hunk-dialog';
      const heading = document.createElement('h2'); heading.textContent = tr('Selecionar trechos · ') + current.value.path; modal.append(heading);
      const error = document.createElement('p'); error.setAttribute('role','alert'); modal.append(error);
      for(const hunk of data.hunks) {
        const pre = document.createElement('pre'); pre.textContent = hunk.patch;
        const button = document.createElement('button'); button.textContent = `${current.staged ? tr('Retirar') : tr('Preparar')} trecho ${hunk.id + 1}`;
        button.onclick = async () => {
          if(busy) return; busy = true; el<HTMLButtonElement>('open').disabled = true; modal.querySelectorAll('button').forEach(b=>b.disabled=true);
          try { await api.gitApplyHunk(current.value.path, current.staged, data.token, hunk.id); modal.close(); closeDiff(); feedback(tr('Trecho aplicado ao index. O arquivo no disco foi preservado.')); }
          catch(e) { error.textContent=String(e); }
          finally { busy=false; el<HTMLButtonElement>('open').disabled=false; modal.querySelectorAll('button').forEach(b=>b.disabled=false); await refresh(); }
        };
        modal.append(pre,button);
      }
      const cancel = document.createElement('button'); cancel.textContent=tr('Fechar trechos'); cancel.onclick=()=>modal.close(); modal.append(cancel);
      modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();}); modal.onclose=()=>modal.remove(); document.body.append(modal);own(()=>modal.remove()); modal.showModal();
    } catch(error) { feedback(String(error)); }
  };
  el('git-file-filter').oninput=()=>{if(state)render();};
  const commitGeneration = mountCommitGeneration(api, panel, commitEnabled);
  el('git-message').oninput = commitEnabled;
  el('git-stage').onclick = async () => {
    if (!selected || busy) return;
    const current = selected; busy = true; el<HTMLButtonElement>('git-stage').disabled = true; commitEnabled();
    el<HTMLButtonElement>('open').disabled = true;
    let message: string;
    try { await api.gitStage(current.value.path, current.staged, current.value.token); message = current.staged ? tr('Arquivo retirado do commit; conteúdo no disco preservado.') : tr('Arquivo preparado para commit.'); closeDiff(); }
    catch (error) { message = String(error); }
    finally { busy = false; el<HTMLButtonElement>('open').disabled = false; }
    await refresh(); feedback(message!); if (selected) el<HTMLButtonElement>('git-stage').disabled = false;
  };
  async function reviewCommit(push=false) {
    if (!state || busy) return;
    const files = staged(); if (!files.length && !state.mergeHead&&!el<HTMLInputElement>('git-amend').checked) return;
    // Primeiro commit/push sem conta: pergunta e guarda a escolha no repositório.
    try { if (!await accounts.ensure(push ? tr('commit e push') : tr('commit'))) { feedback(tr('Commit não iniciado: escolha uma conta Git para este projeto.')); return; } }
    catch (error) { feedback(accountError(error).text); return; }
    void showAccount();
    if (!state || busy) return;
    pushAfterCommit=push;
    el('git-commit-files').replaceChildren(...files.map(file => { const li = document.createElement('li'); li.textContent = `${file.index} ${file.path}`; return li; }));
    if(state.mergeHead) { const li = document.createElement('li'); li.textContent = tr('Finalizar merge com ') + state.mergeHead.slice(0,8); el('git-commit-files').append(li); }
    el('git-commit-message').textContent = el<HTMLTextAreaElement>('git-message').value;
    const amend=el<HTMLInputElement>('git-amend').checked;el('git-commit-error').textContent = amend?tr('Amend substitui o último commit e altera seu hash.'):'';dialog.dataset.amend=String(amend);dialog.dataset.token = state.indexToken; dialog.showModal();
  };
  el('git-review-commit').onclick=()=>{void reviewCommit();};el('git-commit-push').onclick=()=>{void reviewCommit(true);};
  el('git-cancel-commit').onclick = () => dialog.close();
  el('git-confirm-commit').onclick = async () => {
    if (busy) return;
    busy = true; el<HTMLButtonElement>('git-confirm-commit').disabled = true;
    el<HTMLButtonElement>('open').disabled = true;
    el<HTMLButtonElement>('git-cancel-commit').disabled = true;
    try {
      const hash = await api.gitCommit(el('git-commit-message').textContent!, dialog.dataset.token!,dialog.dataset.amend==='true');
      dialog.close(); el<HTMLInputElement>('git-amend').checked=false;el<HTMLTextAreaElement>('git-message').value = ''; closeDiff(); feedback(msg`Commit criado: ${hash.slice(0, 8)}. Nenhum push foi realizado.`);
    } catch (error) {
      const failure = accountError(error); el('git-commit-error').textContent = failure.text;
      if (failure.required) { busy = false; if (await accounts.choose(failure.text)) el('git-commit-error').textContent = tr('Conta escolhida. Confirme o commit novamente.'); void showAccount(); }
    }
    finally { busy = false; el<HTMLButtonElement>('open').disabled = false; el<HTMLButtonElement>('git-confirm-commit').disabled = false; el<HTMLButtonElement>('git-cancel-commit').disabled = false; await refresh(); history.refresh(); }
    if(!dialog.open&&pushAfterCommit){pushAfterCommit=false;await operations.open('push');}
  };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  // Poll only while visible; keep a reviewed diff stable until explicitly reopened.
  every(() => { if (!panel.hidden && !dialog.open && document.hasFocus()) void refresh(); }, 3000);
  on(window,'focus', () => { if (!panel.hidden) void refresh(); });
  own(() => { closeChangelistDialog(); closeMenus(); });
  return { reset() { lists = undefined; void showAccount(); accounts.close(); agentFiles.reset(); commitGeneration.reset(); account.close(); operations.close(); generation++; selectionRequest++; state = undefined; lastState = ''; el<HTMLInputElement>('git-amend').checked=false;pushAfterCommit=false;dialog.close(); closeDiff(); el<HTMLTextAreaElement>('git-message').value = ''; history.reset(); el('git-changes').replaceChildren(); if (!panel.hidden) void refresh(true); } };
}

function ownEditor(...args:any[]){const v=monaco.editor.createDiffEditor(...args);own(()=>v.dispose());return v;}

