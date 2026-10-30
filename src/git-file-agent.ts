import {sdk, tr, msg, html, own, iconButton} from './sdk';
import {gitFileSelection} from './git-file-selection';
import {selectedFileContext, selectedContextUnchanged, selectedFilesPrompt} from './git-file-context';

type Agent = {generate(prompt: string): Promise<string>; cancel(): Promise<void>};
export function mountGitFileAgent(api: IdeApi, panel: HTMLElement, hasUnsaved: () => boolean) {
 const list = panel.querySelector<HTMLElement>('#git-changes')!;
 const toolbar = document.createElement('div');
 toolbar.className = 'git-agent-selection';
 toolbar.innerHTML = html('<button class="git-agent-ask" type="button" disabled></button><button class="git-agent-all" type="button"></button><button class="git-agent-clear" type="button" disabled></button>');
 // Icon-only, like the PhpStorm Commit toolbar: labels live in the hover tooltip; the selection help joins the ask tooltip.
 const commitToolbar = panel.querySelector<HTMLElement>('.git-commit-toolbar');
 if (commitToolbar) { toolbar.classList.add('git-agent-icons'); commitToolbar.append(toolbar); } else list.before(toolbar);
 const ask = toolbar.querySelector<HTMLButtonElement>('.git-agent-ask')!;
 const clear = toolbar.querySelector<HTMLButtonElement>('.git-agent-clear')!;
 const hint = tr('Selecione com Ctrl/⌘+clique ou Shift+clique. Espaço alterna a seleção. As caixas preparam o commit.');
 const askIcon = '<path d="M5 18V8a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H9l-4 3Z"/><path d="M9 10h6M9 13h4"/>';
 iconButton(toolbar.querySelector<HTMLElement>('.git-agent-all')!, '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>', tr('Selecionar visíveis'));
 iconButton(clear, '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m9 9 6 6m0-6-6 6"/>', tr('Limpar seleção'));
 let busy = false;
 const selection = gitFileSelection(list, () => updateAsk());
 function updateAsk() {
  const count = selection.paths().length;
  iconButton(ask, askIcon, count ? msg`Perguntar ao agente (${count})` : tr('Perguntar ao agente'));
  ask.title += '\n' + hint;
  if (count) { const badge = document.createElement('span'); badge.className = 'git-agent-count'; badge.textContent = String(count); ask.append(badge); }
  ask.disabled = busy || !count;
  clear.disabled = !count;
 }
 updateAsk();
 toolbar.querySelector<HTMLButtonElement>('.git-agent-all')!.onclick = () => selection.all();
 clear.onclick = () => selection.clear();
 const dialog = document.createElement('dialog');
 dialog.className = 'git-agent-query';
 dialog.innerHTML = html('<h2>Consultar agente sobre arquivos</h2><ul class="git-agent-files"></ul><p>Serão enviadas apenas as versões destes arquivos: alterações preparadas e do disco. Buffers não salvos ficam de fora.</p><div class="git-agent-presets"><button type="button" data-preset="review">Revisar alterações</button><button type="button" data-preset="impact">Analisar impacto</button></div><label>O que deseja saber?<textarea class="git-agent-instruction" rows="3" placeholder="Descreva a revisão ou análise para os arquivos selecionados…"></textarea></label><p class="git-agent-status" role="status" aria-live="polite"></p><pre class="git-agent-answer" tabindex="0" aria-label="Resposta do agente" hidden></pre><div class="git-agent-query-actions"><button type="button" class="git-agent-send">Enviar ao agente</button><button type="button" class="git-agent-stop" disabled>Interromper</button><button type="button" class="git-agent-close">Fechar</button></div>');
 document.body.append(dialog);
 const prompt = dialog.querySelector<HTMLTextAreaElement>('.git-agent-instruction')!;
 const send = dialog.querySelector<HTMLButtonElement>('.git-agent-send')!;
 const stop = dialog.querySelector<HTMLButtonElement>('.git-agent-stop')!;
 const answer = dialog.querySelector<HTMLElement>('.git-agent-answer')!;
 const status = dialog.querySelector<HTMLElement>('.git-agent-status')!;
 let epoch = 0;
 let disposed = false;
 let pending = false;
 let submitted = false;
 let paths: string[] = [];
 let agent: Agent | undefined;
 const current = (request: number) => !disposed && request === epoch;
 function controls() {
  send.disabled = pending || busy;
  send.title = busy ? tr('Aguarde a operação Git terminar para enviar uma consulta.') : '';
  stop.disabled = !pending;
  prompt.disabled = pending;
  dialog.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.disabled = pending);
 }
 async function cancel() {
  const request = ++epoch;
  const active = pending && submitted;
  pending = false;
  submitted = false;
  controls();
  status.textContent = tr('Consulta interrompida.');
  if (!active) return;
  try { await agent?.cancel(); }
  catch (error) { if (current(request)) status.textContent = String(error); }
 }
 function close() {
  void cancel();
  dialog.close();
  ask.focus();
 }
 stop.onclick = () => void cancel();
 dialog.querySelector<HTMLButtonElement>('.git-agent-close')!.onclick = close;
 dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
 dialog.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.onclick = () => {
  prompt.value = button.dataset.preset === 'review'
   ? tr('Revise estas alterações. Aponte bugs, regressões e lacunas de testes, citando o arquivo e o trecho relevante. Priorize os problemas por gravidade.')
   : tr('Analise o impacto destas alterações. Explique mudanças de comportamento, compatibilidade e riscos. Diferencie impactos comprovados de hipóteses que precisam de verificação.');
  prompt.focus();
 });
 ask.onclick = () => {
  if (dialog.open) { prompt.focus(); return; }
  paths = selection.paths();
  if (!paths.length) return;
  dialog.querySelector('.git-agent-files')!.replaceChildren(...paths.map(path => {
   const item = document.createElement('li'); item.textContent = path; return item;
  }));
  answer.hidden = true;
  answer.textContent = '';
  status.textContent = hasUnsaved() ? tr('Há buffers não salvos. Salve-os para incluir essas edições na consulta.') : '';
  dialog.show();
  prompt.focus();
 };
 send.onclick = async () => {
  if (pending || busy) return;
  const instruction = prompt.value.trim();
  if (!instruction) { status.textContent = tr('Descreva o que deseja saber sobre os arquivos selecionados.'); prompt.focus(); return; }
  if (instruction.length > 10000) { status.textContent = tr('A orientação é longa demais. Reduza o texto antes de enviar.'); return; }
  const request = ++epoch;
  pending = true;
  submitted = false;
  controls();
  answer.hidden = true;
  status.textContent = tr('Lendo apenas os arquivos selecionados…');
  try {
   agent = sdk.service?.('agents');
   if (!agent?.generate) throw Error(tr('Abra o painel Agente e conecte um agente.'));
   const context = await selectedFileContext(api, paths, () => current(request));
   if (!current(request)) return;
   if (!await selectedContextUnchanged(api, context)) throw Error(tr('As alterações selecionadas mudaram durante a leitura. Tente novamente.'));
   if (!current(request)) return;
   status.textContent = tr('O agente está analisando os arquivos selecionados…');
   const response = agent.generate(selectedFilesPrompt(instruction, context, sdk.activeLanguage()));
   submitted = true;
   const text = await response;
   if (!current(request)) return;
   submitted = false;
   answer.textContent = text;
   answer.hidden = false;
   status.textContent = tr('Análise concluída para os arquivos listados.');
   try {
    if (!await selectedContextUnchanged(api, context) && current(request)) status.textContent = tr('Os arquivos mudaram durante a análise. A resposta se refere às versões enviadas; consulte novamente para atualizar.');
   } catch {
    if (current(request)) status.textContent = tr('A resposta usa as versões enviadas. Não foi possível conferir se os arquivos continuam iguais.');
   }
  } catch (error) {
   if (current(request)) status.textContent = String(error);
  } finally {
   if (current(request)) { pending = false; submitted = false; controls(); }
  }
 };
 function reset() {
  close();
  selection.clear();
  paths = [];
  prompt.value = '';
  answer.textContent = '';
 }
 own(() => {
  disposed = true;
  reset();
  selection.dispose();
  dialog.remove();
  toolbar.remove();
 });
 return {sync: selection.sync, reset, setBusy(value: boolean) { busy = value; ask.disabled = busy || !selection.paths().length; controls(); }};
}
