import {tr, msg} from './sdk';
import {type MenuEntry, type MenuItem} from './git-menu';
import {parseRefs} from './git-graph';
import type {LogContext} from './git-log-view';

/** Tags (PhpStorm 2026.1.4, G-18/G-20 e documentação pública): Log → New Tag… pede só o nome ("Create New Tag
 *  On <hash>", OK habilitado com texto) e cria tag leve; Git → New Tag… tem Tag name, Force, Commit e Message
 *  (mensagem vazia = tag leve) e o botão Create Tag; Tag <nome> → Delete / Push to <remote>. */
type Run = (input: Record<string, unknown>) => Promise<string>;

export function tagActions(api: any, hooks: {busy(): boolean; setBusy(value: boolean): void; feedback(text: string): void}) {
  const run: Run = async input => { const state = await api.gitStatus(); return api.gitOperation({...input, expectedHead: state.head}); };
  async function guarded(input: Record<string, unknown>, done: string, context?: LogContext) {
    if (hooks.busy()) return false;
    hooks.setBusy(true);
    const say = context?.feedback ?? hooks.feedback;
    try { await run(input); await context?.reload(); say(done); return true; }
    catch (error) { say(String(error instanceof Error ? error.message : error)); return false; }
    finally { hooks.setBusy(false); }
  }

  /** Diálogo de tag. `commit` presente = variante do Log (só o nome). */
  function dialog(options: {commit?: string; context?: LogContext}) {
    document.querySelector('.git-tag-dialog')?.remove();
    const simple = !!options.commit;
    const box = document.createElement('dialog'); box.className = 'git-tag-dialog git-changelist-dialog';
    box.innerHTML = `<form method="dialog"><h2></h2><p class="git-tag-prompt"></p>
      <label class="git-cl-row git-tag-name"><span></span><input name="name" autocomplete="off" spellcheck="false"></label>
      <label class="git-cl-check git-tag-full"><input type="checkbox" name="force"><span></span></label>
      <label class="git-cl-row git-tag-full"><span></span><input name="commit" value="HEAD" spellcheck="false"></label>
      <label class="git-cl-row git-cl-comment git-tag-full"><span></span><textarea name="message" rows="4"></textarea></label>
      <p class="git-cl-error" role="alert"></p><div class="git-cl-buttons"><button type="button" value="cancel"></button><button type="submit" class="primary"></button></div></form>`;
    const form = box.querySelector('form')!; const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const [cancel, ok] = [...box.querySelectorAll<HTMLButtonElement>('.git-cl-buttons button')];
    box.querySelector('h2')!.textContent = simple ? msg`Criar nova tag em ${options.commit!}` : tr('Tag');
    box.querySelector('.git-tag-prompt')!.textContent = simple ? tr('Digite o nome da nova tag') : '';
    const spans = box.querySelectorAll('label span');
    spans[0]!.textContent = simple ? '' : tr('Nome da tag:'); spans[1]!.textContent = tr('Forçar'); spans[2]!.textContent = tr('Commit:'); spans[3]!.textContent = tr('Mensagem:');
    box.querySelectorAll<HTMLElement>('.git-tag-full').forEach(node => node.hidden = simple);
    cancel!.textContent = tr('Cancelar'); ok!.textContent = simple ? 'OK' : tr('Criar tag');
    const sync = () => { ok!.disabled = !field('name').value.trim() || (!simple && !field('commit').value.trim()); };
    form.oninput = sync; sync();
    cancel!.onclick = () => box.close();
    box.onclose = () => box.remove();
    form.onsubmit = async event => {
      event.preventDefault(); const name = field('name').value.trim(); if (!name) return;
      const error = box.querySelector('.git-cl-error')!; error.textContent = '';
      const input = simple ? {kind: 'create-tag', target: name, commit: options.commit} : {kind: 'create-tag', target: name, commit: field('commit').value.trim(), force: field('force').checked, message: (form.elements.namedItem('message') as HTMLTextAreaElement).value};
      ok!.disabled = true;
      try { await run(input); box.close(); await options.context?.reload(); (options.context?.feedback ?? hooks.feedback)(msg`Tag ${name} criada.`); }
      catch (failure) { error.textContent = String(failure instanceof Error ? failure.message : failure); sync(); }
    };
    document.body.append(box); box.showModal(); field('name').focus();
  }

  /** Itens de uma tag: Checkout (quando disponível), Push to <remote> e Delete. */
  function items(name: string, commit: string | undefined, context: LogContext, extra: MenuItem[] = []): MenuEntry[] {
    const remotes: string[] = context.tools()?.remotes ?? [];
    return [
      ...extra,
      ...remotes.map(remote => ({label: msg`Enviar para ${remote}`, run: () => void guarded({kind: 'push-tag', target: name, remote}, msg`Tag ${name} enviada para ${remote}.`, context)})),
      {label: tr('Excluir'), run: () => void guarded({kind: 'delete-tag', target: name}, msg`Tag ${name} excluída.`, context)},
    ];
  }

  /** Menu do commit no Log: New Tag… e um submenu por tag do commit. */
  function extendLog(menu: MenuEntry[], commit: {hash: string; refs?: string}, context: LogContext) {
    const at = menu.findIndex(item => item !== 'separator' && item.label === tr('Ir para o commit filho'));
    const tags = parseRefs(commit.refs, new Set()).filter(r => r.kind === 'tag');
    const added: MenuEntry[] = [{label: tr('Nova tag…'), run: () => dialog({commit: commit.hash, context})}];
    for (const tag of tags) added.push({label: msg`Tag ${tag.name}`, items: items(tag.name, commit.hash, context)});
    menu.splice(at < 0 ? menu.length : at, 0, ...added, 'separator');
  }
  return {dialog, items, extendLog, run};
}
