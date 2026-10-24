import {sdk, tr, html} from './sdk';
import {mergeAgentPrompt, parseMergeSuggestion} from './merge-agent-prompt';

type Agent = {generate(prompt: string): Promise<string>; cancel(): Promise<void>};
type Result = {text(): string; version(): number; replace(text: string): void};

export function mountMergeAgent(api: IdeApi, parent: HTMLElement, conflict: GitConflict, result: Result) {
 const section = document.createElement('details');
 section.className = 'merge-ai';
 section.innerHTML = html('<summary>Resolver com IA</summary><label>Como o agente deve resolver este merge?<textarea class="merge-ai-prompt" rows="2" placeholder="Ex.: preserve a validação da esquerda e incorpore o novo retorno da direita."></textarea></label><div class="merge-ai-actions"><button type="button" class="merge-ai-generate">Gerar sugestão</button><button type="button" class="merge-ai-cancel" disabled>Interromper geração</button></div><p role="status" aria-live="polite">A base, os dois lados e o resultado atual deste arquivo serão enviados ao agente conectado.</p><div class="merge-ai-preview" hidden><label>Sugestão editável<textarea rows="5" class="merge-ai-suggestion" spellcheck="false"></textarea></label><button type="button" class="merge-ai-use">Usar no resultado</button></div>');
 parent.querySelector('.merge-panes')!.before(section);
 const prompt = section.querySelector<HTMLTextAreaElement>('.merge-ai-prompt')!;
 const generate = section.querySelector<HTMLButtonElement>('.merge-ai-generate')!;
 const cancel = section.querySelector<HTMLButtonElement>('.merge-ai-cancel')!;
 const use = section.querySelector<HTMLButtonElement>('.merge-ai-use')!;
 const preview = section.querySelector<HTMLElement>('.merge-ai-preview')!;
 const suggestion = section.querySelector<HTMLTextAreaElement>('.merge-ai-suggestion')!;
 const status = section.querySelector('p')!;
 let epoch = 0;
 let disposed = false;
 let running = false;
 let applying = false;
 let submitted = false;
 let version = 0;
 let agent: Agent | undefined;
 const current = (request: number) => !disposed && request === epoch;
 function controls() {
  generate.disabled = running || applying;
  cancel.disabled = !running;
  use.disabled = running || applying;
  prompt.disabled = running;
 }
 async function verify() {
  const state = await api.gitConflict(conflict.path);
  if (state.token !== conflict.token) throw Error(tr('O conflito mudou no disco. Reabra o merge antes de gerar ou usar uma sugestão.'));
 }
 async function stop() {
  epoch++;
  if (!running) return;
  if (!submitted || !agent) { running = false; controls(); return; }
  status.textContent = tr('Interrompendo geração…');
  try {
   await agent.cancel();
   if (!disposed) status.textContent = tr('Geração interrompida. O resultado foi preservado.');
  } catch (error) {
   if (!disposed) status.textContent = String(error);
  } finally {
   running = false;
   if (!disposed) controls();
  }
 }
 cancel.onclick = () => void stop();
 generate.onclick = async () => {
  if (running || applying) return;
  const instruction = prompt.value.trim();
  if (!instruction) {
   status.textContent = tr('Descreva como deseja combinar as alterações antes de gerar.');
   prompt.focus();
   return;
  }
  const request = ++epoch;
  version = result.version();
  const draft = result.text();
  running = true;
  submitted = false;
  preview.hidden = true;
  controls();
  status.textContent = tr('O agente está preparando uma sugestão para este arquivo…');
  try {
   agent = sdk.service?.('agents');
   if (!agent?.generate) throw Error(tr('Abra o painel Agente e conecte um agente.'));
   const text = mergeAgentPrompt(conflict, draft, instruction);
   await verify();
   if (!current(request)) return;
   const response = agent.generate(text);
   submitted = true;
   const generated = await response;
   if (!current(request)) return;
   suggestion.value = parseMergeSuggestion(generated);
   preview.hidden = false;
   status.textContent = tr('Revise a sugestão. Usar no resultado não grava o arquivo; conclua com Aplicar.');
   suggestion.focus();
  } catch (error) {
   if (current(request)) status.textContent = String(error);
  } finally {
   if (current(request)) { running = false; controls(); }
  }
 };
 use.onclick = async () => {
  if (running || applying || preview.hidden) return;
  const request = epoch;
  applying = true;
  controls();
  try {
   await verify();
   if (!current(request)) return;
   if (version !== result.version()) throw Error(tr('O resultado foi editado durante a geração. Gere outra sugestão para preservar suas alterações.'));
   const text = parseMergeSuggestion(JSON.stringify({result: suggestion.value}));
   result.replace(text);
   preview.hidden = true;
   section.open = false;
  } catch (error) {
   if (current(request)) status.textContent = String(error);
  } finally {
   applying = false;
   if (!disposed) controls();
  }
 };
 return {
  refresh: controls,
  dispose() {
   if (disposed) return;
   disposed = true;
   void stop();
   section.remove();
  },
 };
}
