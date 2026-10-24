import {msg} from './sdk';

export function gitFileSelection(list: HTMLElement, changed: () => void) {
 const selected = new Set<string>();
 let anchor: string | undefined;
 const buttons = () => [...list.querySelectorAll<HTMLButtonElement>('.git-file-row')];
 function paint() {
  for (const button of buttons()) {
   const active = selected.has(button.dataset.path!);
   button.classList.toggle('agent-selected', active);
   button.setAttribute('aria-pressed', String(active));
   button.setAttribute('aria-label', msg`Selecionar ${button.dataset.path} para consultar o agente e ver diff`);
  }
  changed();
 }
 function choose(path: string, additive: boolean, range: boolean) {
  const visible = buttons().filter(button => button.closest('details')?.open !== false).map(button => button.dataset.path!);
  const from = anchor ? visible.indexOf(anchor) : -1;
  const to = visible.indexOf(path);
  if (range && from >= 0 && to >= 0) {
   if (!additive) selected.clear();
   for (const name of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(name);
  } else {
   if (!additive) selected.clear();
   if (additive && selected.has(path)) selected.delete(path);
   else selected.add(path);
   anchor = path;
  }
  paint();
 }
 function clicked(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.git-file-row') : null;
  if (!target?.dataset.path) return;
  choose(target.dataset.path, event.ctrlKey || event.metaKey, event.shiftKey);
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
   event.preventDefault();
   event.stopImmediatePropagation();
  }
 }
 function keyed(event: KeyboardEvent) {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.git-file-row') : null;
  if (!target?.dataset.path) return;
  if (event.key === ' ') {
   event.preventDefault();
   event.stopImmediatePropagation();
   choose(target.dataset.path, true, event.shiftKey);
  }
 }
 list.addEventListener('click', clicked, true);
 list.addEventListener('keydown', keyed, true);
 return {
  paths: () => [...selected],
  sync(changes: GitChange[]) {
   const paths = new Set(changes.map(change => change.path));
   for (const path of selected) if (!paths.has(path)) selected.delete(path);
   if (anchor && !paths.has(anchor)) anchor = undefined;
   paint();
  },
  clear() { selected.clear(); anchor = undefined; paint(); },
  all() { for (const button of buttons()) if (button.closest('details')?.open !== false) selected.add(button.dataset.path!); paint(); },
  dispose() {
   list.removeEventListener('click', clicked, true);
   list.removeEventListener('keydown', keyed, true);
   for (const button of buttons()) { button.classList.remove('agent-selected'); button.removeAttribute('aria-pressed'); }
  },
 };
}
