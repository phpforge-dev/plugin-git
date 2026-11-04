import {tr, msg} from './sdk';
import {type MenuEntry} from './git-menu';
import type {LogContext} from './git-log-view';

/** Reset Current Branch to Here (PhpStorm 2026.1.4, G-19): diálogo "Git Reset" com "<branch> -> <hash>
 *  "<assunto>" by <autor>", o texto explicativo, Soft/Mixed/Hard/Keep com as descrições e Mixed marcado; botões
 *  Cancel e Reset. Também Checkout Revision e New Branch… a partir do commit. Desenho e código próprios. */
export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';
export const resetModes: {mode: ResetMode; label: string; help: string[]}[] = [
  {mode: 'soft', label: 'Soft', help: ['Os arquivos não mudam; as diferenças ficam preparadas para commit.']},
  {mode: 'mixed', label: 'Mixed', help: ['Os arquivos não mudam; as diferenças não ficam preparadas.']},
  {mode: 'hard', label: 'Hard', help: ['Os arquivos voltam ao estado do commit selecionado.', 'Atenção: todas as alterações locais serão perdidas.']},
  {mode: 'keep', label: 'Keep', help: ['Os arquivos voltam ao estado do commit selecionado,', 'mas as alterações locais são mantidas.']},
];
type Commit = {hash: string; subject: string; author: string};
type Hooks = {busy(): boolean; setBusy(value: boolean): void; hasUnsaved(): boolean; changed(): Promise<void>; feedback(text: string): void};

function modal(className: string, build: (form: HTMLFormElement) => void): HTMLDialogElement {
  document.querySelector('.' + className)?.remove();
  const box = document.createElement('dialog'); box.className = `${className} git-changelist-dialog`;
  const form = document.createElement('form'); form.method = 'dialog'; box.append(form); build(form);
  box.onclose = () => box.remove(); document.body.append(box); box.showModal(); return box;
}

export function resetActions(api: any, hooks: Hooks) {
  const run = async (input: Record<string, unknown>) => { const state = await api.gitStatus(); return api.gitOperation({...input, expectedHead: state.head}); };
  async function perform(input: Record<string, unknown>, done: string, context: LogContext, touchesFiles: boolean) {
    if (hooks.busy()) return false;
    if (touchesFiles && hooks.hasUnsaved()) { context.feedback(tr('Salve os buffers antes de alterar a árvore de trabalho.')); return false; }
    hooks.setBusy(true); let failure: unknown;
    try { await run(input); } catch (error) { failure = error; } finally { hooks.setBusy(false); }
    // Git pode ter mexido em arquivos mesmo ao falhar: reconcilia o editor e o Log nos dois casos.
    await hooks.changed(); await context.reload();
    context.feedback(failure === undefined ? done : String(failure instanceof Error ? failure.message : failure));
    return failure === undefined;
  }

  /** Diálogo "Git Reset"; resolve com o modo escolhido ou null. */
  function resetDialog(commit: Commit, branch: string): Promise<ResetMode | null> {
    return new Promise(resolve => {
      let chosen: ResetMode | null = null;
      const box = modal('git-reset-dialog', form => {
        const title = document.createElement('h2'); title.textContent = tr('Git Reset');
        const target = document.createElement('p'); target.className = 'git-reset-target';
        const strong = document.createElement('strong'); strong.textContent = `${branch} -> ${commit.hash.slice(0, 8)}`;
        target.append(strong, document.createTextNode(` "${commit.subject}" ${tr('por')} `), Object.assign(document.createElement('span'), {className: 'git-reset-author', textContent: commit.author}));
        const intro = document.createElement('p'); intro.textContent = tr('Isto redefine o HEAD da branch atual para o commit selecionado e atualiza a árvore de trabalho e o index conforme o modo escolhido:');
        form.append(title, target, intro);
        for (const item of resetModes) {
          const label = document.createElement('label'); label.className = 'git-reset-mode';
          const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'mode'; radio.value = item.mode; radio.checked = item.mode === 'mixed';
          const name = document.createElement('span'); name.textContent = item.label;
          const help = document.createElement('small'); help.textContent = item.help.map(tr).join('\n');
          label.append(radio, name, help); form.append(label);
        }
        const buttons = document.createElement('div'); buttons.className = 'git-cl-buttons';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = tr('Cancelar'); cancel.onclick = () => box.close();
        const ok = document.createElement('button'); ok.type = 'submit'; ok.className = 'primary'; ok.textContent = tr('Redefinir');
        buttons.append(cancel, ok); form.append(buttons);
        form.onsubmit = event => { event.preventDefault(); chosen = (form.elements.namedItem('mode') as RadioNodeList).value as ResetMode; box.close(); };
      });
      box.addEventListener('close', () => resolve(chosen));
      (box.querySelector('input[value=mixed]') as HTMLInputElement).focus();
    });
  }

  /** New Branch… a partir do commit: nome e "Fazer checkout da branch" (marcado por padrão). */
  function branchDialog(commit: Commit): Promise<{name: string; checkout: boolean} | null> {
    return new Promise(resolve => {
      let chosen: {name: string; checkout: boolean} | null = null;
      const box = modal('git-new-branch-dialog', form => {
        form.innerHTML = `<h2></h2><label class="git-cl-row"><span></span><input name="name" autocomplete="off" spellcheck="false"></label><label class="git-cl-check"><input type="checkbox" name="checkout" checked><span></span></label><div class="git-cl-buttons"><button type="button"></button><button type="submit" class="primary"></button></div>`;
        form.querySelector('h2')!.textContent = msg`Criar branch a partir de ${commit.hash.slice(0, 8)}`;
        const spans = form.querySelectorAll('label span'); spans[0]!.textContent = tr('Nome:'); spans[1]!.textContent = tr('Fazer checkout da branch');
        const [cancel, ok] = [...form.querySelectorAll<HTMLButtonElement>('.git-cl-buttons button')]; cancel!.textContent = tr('Cancelar'); ok!.textContent = tr('Criar');
        const name = form.elements.namedItem('name') as HTMLInputElement; const sync = () => { ok!.disabled = !name.value.trim(); }; name.oninput = sync; sync();
        cancel!.onclick = () => box.close();
        form.onsubmit = event => { event.preventDefault(); if (!name.value.trim()) return; chosen = {name: name.value.trim(), checkout: (form.elements.namedItem('checkout') as HTMLInputElement).checked}; box.close(); };
      });
      box.addEventListener('close', () => resolve(chosen));
      (box.querySelector('input[name=name]') as HTMLInputElement).focus();
    });
  }

  async function reset(commit: Commit, context: LogContext) {
    const state = await api.gitStatus().catch(() => undefined);
    const mode = await resetDialog(commit, state?.branch ?? 'HEAD');
    if (mode) await perform({kind: 'reset', target: commit.hash, mode}, msg`Branch redefinida para ${commit.hash.slice(0, 8)} (${mode}).`, context, mode === 'hard' || mode === 'keep');
  }
  async function newBranch(commit: Commit, context: LogContext) {
    const choice = await branchDialog(commit);
    if (choice) await perform({kind: 'create-branch', target: choice.name, startPoint: commit.hash, checkout: choice.checkout}, msg`Branch ${choice.name} criada.`, context, choice.checkout);
  }
  const checkout = (hash: string, context: LogContext) => perform({kind: 'checkout-revision', target: hash}, msg`HEAD destacado em ${hash.slice(0, 8)}.`, context, true);

  /** Ordem do menu do PhpStorm: …Cherry-Pick | Checkout Revision | Reset Current Branch to Here…, Revert | New Branch…, New Tag… */
  function extendLog(menu: MenuEntry[], commit: Commit, context: LogContext) {
    const index = (label: string) => menu.findIndex(item => item !== 'separator' && item.label === label);
    const revert = index(tr('Reverter commit'));
    menu.splice(revert < 0 ? menu.length : revert, 0, {label: tr('Redefinir branch atual até aqui…'), run: () => void reset(commit, context)});
    const pick = index('Cherry-pick');
    menu.splice(pick + 1, 0, 'separator', {label: tr('Checkout da revisão'), run: () => void checkout(commit.hash, context)});
    const tag = index(tr('Nova tag…'));
    menu.splice(tag < 0 ? menu.length : tag, 0, {label: tr('Nova branch…'), shortcut: '⌥⌘N', run: () => void newBranch(commit, context)});
  }
  return {resetDialog, branchDialog, reset, newBranch, checkout, extendLog};
}
