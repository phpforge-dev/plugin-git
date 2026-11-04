/** Item de menu de contexto: ação, alternância (`checked`) ou submenu (`items`). */
export type MenuItem = {label: string; run?: () => void; checked?: boolean; disabled?: boolean; shortcut?: string; items?: MenuEntry[]};
export type MenuEntry = MenuItem | 'separator';

let closeOpen: (() => void) | undefined;
/** Fecha o menu aberto (desativação do plugin, troca de painel). */
export function closeMenus() { closeOpen?.(); }

/** Menu de contexto no estilo das listas do PhpStorm: separadores, marcas de seleção, submenus com seta,
 *  navegação por setas, Enter/Espaço, → abre submenu, ← / Esc fecham. */
export function showMenu(entries: MenuEntry[], x: number, y: number, label = 'Menu'): () => void {
  closeOpen?.();
  const menus: HTMLElement[] = [];
  const restore = document.activeElement as HTMLElement | null;
  function close() {
    menus.forEach(m => m.remove()); menus.length = 0;
    document.removeEventListener('mousedown', outside, true); window.removeEventListener('blur', close);
    if (closeOpen === close) closeOpen = undefined;
  }
  function outside(event: MouseEvent) { if (!menus.some(m => m.contains(event.target as Node))) close(); }
  function open(items: MenuEntry[], left: number, top: number, level: number, name: string): HTMLElement {
    menus.splice(level).forEach(m => m.remove());
    const menu = document.createElement('div'); menu.className = 'git-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', name);
    for (const entry of items) {
      if (entry === 'separator') { const hr = document.createElement('div'); hr.className = 'git-menu-separator'; hr.setAttribute('role', 'separator'); menu.append(hr); continue; }
      const row = document.createElement('button'); row.type = 'button'; row.className = 'git-menu-item';
      row.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (entry.checked !== undefined) row.setAttribute('aria-checked', String(entry.checked));
      row.disabled = !!entry.disabled;
      const mark = document.createElement('span'); mark.className = 'git-menu-check'; mark.textContent = entry.checked ? '✓' : '';
      const text = document.createElement('span'); text.className = 'git-menu-label'; text.textContent = entry.label;
      const tail = document.createElement('span'); tail.className = 'git-menu-tail'; tail.textContent = entry.items ? '›' : entry.shortcut ?? '';
      row.append(mark, text, tail);
      if (entry.items) row.setAttribute('aria-haspopup', 'menu');
      const expand = () => { const r = row.getBoundingClientRect(); const sub = open(entry.items!, r.right - 2, r.top - 4, level + 1, entry.label); return sub; };
      row.onmouseenter = () => { row.focus(); if (entry.items) expand(); else menus.splice(level + 1).forEach(m => m.remove()); };
      row.onclick = () => { if (entry.items) { (expand().querySelector('button:not(:disabled)') as HTMLElement | null)?.focus(); return; } close(); restore?.focus?.(); entry.run?.(); };
      row.onkeydown = event => {
        const rows = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const at = rows.indexOf(row);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus(); }
        else if (event.key === 'ArrowRight' && entry.items) { event.preventDefault(); row.click(); }
        else if (event.key === 'ArrowLeft' && level > 0) { event.preventDefault(); menus.splice(level).forEach(m => m.remove()); (menus[level - 1]?.querySelector(':focus, button[aria-haspopup]') as HTMLElement | null)?.focus(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); restore?.focus?.(); }
      };
      menu.append(row);
    }
    document.body.append(menu); menus[level] = menu;
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(left, innerWidth - box.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(top, innerHeight - box.height - 4)) + 'px';
    return menu;
  }
  const root = open(entries, x, y, 0, label);
  (root.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
  setTimeout(() => { document.addEventListener('mousedown', outside, true); window.addEventListener('blur', close); });
  closeOpen = close;
  return close;
}
