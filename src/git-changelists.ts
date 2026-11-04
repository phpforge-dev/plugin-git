import {tr} from './sdk';

/** Changelists da janela Commit (PhpStorm 2026.1.4, capturas G-10..G-13): a lista padrão "Changes", a ativa
 *  em negrito, "Move to Another Changelist…" (⇧⌘M) com Name/Comment/Set active, New/Edit Changelist… (F2),
 *  Set Active Changelist e Delete Changelist. As listas são metadados do IDE guardados no git-dir. */
export type Changelist = {id: string; name: string; comment: string; active: boolean; files: string[]};
export type ChangelistChoice = {name: string; comment: string; setActive: boolean};

/** Nome exibido: a lista padrão aparece traduzida enquanto o usuário não a renomear. */
export const listLabel = (list: Changelist) => list.id === 'default' && list.name === 'Changes' ? tr('Alterações') : list.name;

/** Agrupa as mudanças rastreadas por changelist; arquivo sem lista (corrida com o status) vai para a ativa. */
export function groupByChangelist<T extends {path: string}>(lists: Changelist[], changes: T[]): {list: Changelist; changes: T[]}[] {
  const owner = new Map<string, string>();
  for (const list of lists) for (const path of list.files) owner.set(path, list.id);
  const active = lists.find(l => l.active) ?? lists[0];
  return lists.map(list => ({list, changes: changes.filter(c => (owner.get(c.path) ?? active?.id) === list.id)}));
}

let open: HTMLDialogElement | undefined;
/** Fecha o diálogo aberto (desativação do plugin). */
export function closeChangelistDialog() { open?.close(); }

/** Diálogo de changelist. `choose` mostra as listas existentes no campo Nome (Move to Another Changelist). */
export function changelistDialog(options: {title: string; lists: Changelist[]; name?: string; comment?: string; setActive?: boolean; choose?: boolean; ok?: string}): Promise<ChangelistChoice | null> {
  open?.remove();
  const dialog = document.createElement('dialog'); dialog.className = 'git-changelist-dialog'; open = dialog;
  const id = 'git-changelist-names';
  dialog.innerHTML = `<form method="dialog"><h2></h2><label class="git-cl-row"><span></span><input name="name" required autocomplete="off"></label>
    <label class="git-cl-row git-cl-comment"><span></span><textarea name="comment" rows="3"></textarea></label>
    <label class="git-cl-check"><input type="checkbox" name="active"><span></span></label>
    <p class="git-cl-error" role="alert"></p><div class="git-cl-buttons"><button type="button" value="cancel"></button><button type="submit" value="ok" class="primary"></button></div></form>`;
  const form = dialog.querySelector('form')!; const name = form.elements.namedItem('name') as HTMLInputElement; const comment = form.elements.namedItem('comment') as HTMLTextAreaElement;
  const active = form.elements.namedItem('active') as HTMLInputElement; const [cancel, ok] = [...dialog.querySelectorAll<HTMLButtonElement>('.git-cl-buttons button')];
  dialog.querySelector('h2')!.textContent = options.title;
  const spans = dialog.querySelectorAll('label span');
  spans[0]!.textContent = tr('Nome:'); spans[1]!.textContent = tr('Comentário:'); spans[2]!.textContent = tr('Tornar ativa');
  cancel!.textContent = tr('Cancelar'); ok!.textContent = options.ok ?? 'OK';
  if (options.choose) {
    const list = document.createElement('datalist'); list.id = id;
    for (const item of options.lists) list.append(new Option(listLabel(item), listLabel(item)));
    dialog.append(list); name.setAttribute('list', id);
  }
  name.value = options.name ?? ''; comment.value = options.comment ?? ''; active.checked = !!options.setActive;
  const sync = () => {
    ok!.disabled = !name.value.trim();
    // Escolher lista existente traz o comentário dela, como no combo do PhpStorm.
    const existing = options.choose && options.lists.find(l => listLabel(l).toLowerCase() === name.value.trim().toLowerCase());
    if (existing && document.activeElement === name) comment.value = existing.comment;
  };
  name.oninput = sync; sync();
  return new Promise(resolve => {
    let result: ChangelistChoice | null = null;
    cancel!.onclick = () => dialog.close();
    form.onsubmit = event => { event.preventDefault(); if (!name.value.trim()) return; result = {name: name.value.trim(), comment: comment.value, setActive: active.checked}; dialog.close(); };
    dialog.onclose = () => { dialog.remove(); if (open === dialog) open = undefined; resolve(result); };
    document.body.append(dialog); dialog.showModal(); name.select();
  });
}

/** Resolve o nome digitado para o id de uma lista existente (a padrão aceita "Alterações" e "Changes"). */
export function findList(lists: Changelist[], name: string) {
  const wanted = name.trim().toLowerCase();
  return lists.find(l => l.name.toLowerCase() === wanted || listLabel(l).toLowerCase() === wanted);
}
