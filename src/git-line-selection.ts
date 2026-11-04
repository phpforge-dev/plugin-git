import {tr, msg, monaco, own} from './sdk';

/** Seleção de trechos e linhas no diff da revisão (PhpStorm 2026.1.4, G-14/G-15): caixa por trecho ao lado
 *  dos números do lado atual, caixa por linha, contador "N differences, M included", menu Include/Exclude
 *  Selected Chunks e Split Chunks and Include Selected Lines. Aqui "incluir" marca linhas para preparar (diff
 *  index → disco) ou retirar (diff HEAD → index); o botão aplica tudo de uma vez pelo `gitApplyHunk`. */
export type ParsedHunk = {id: number; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: {kind: '-' | '+'; text: string; line: number}[]};

export function parseHunk(id: number, patch: string): ParsedHunk {
  const rows = patch.split('\n'); const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0] ?? '');
  if (!header) throw Error(tr('Trecho inválido'));
  const oldStart = Number(header[1]), oldCount = header[2] === undefined ? 1 : Number(header[2]);
  const newStart = Number(header[3]), newCount = header[4] === undefined ? 1 : Number(header[4]);
  const lines: ParsedHunk['lines'] = []; let oldLine = oldStart, newLine = newStart;
  for (const row of rows.slice(1)) {
    if (row.startsWith('-')) lines.push({kind: '-', text: row.slice(1), line: oldLine++});
    else if (row.startsWith('+')) lines.push({kind: '+', text: row.slice(1), line: newLine++});
  }
  return {id, oldStart, oldCount, newStart, newCount, lines};
}

/** `{id: true}` para trecho inteiro, `{id: [índices]}` para linhas; trechos sem marca ficam de fora. */
export function selectionPayload(hunks: ParsedHunk[], selected: Map<number, Set<number>>): Record<string, true | number[]> {
  const payload: Record<string, true | number[]> = {};
  for (const hunk of hunks) {
    const set = selected.get(hunk.id); if (!set?.size) continue;
    payload[hunk.id] = set.size === hunk.lines.length ? true : [...set].sort((a, b) => a - b);
  }
  return payload;
}

type Hooks = {busy(): boolean; setBusy(value: boolean): void; feedback(text: string): void; changed(): Promise<void>; countChanged(): void};

export function lineSelection(api: any, diff: monaco.editor.IStandaloneDiffEditor, hooks: Hooks) {
  let hunks: ParsedHunk[] = []; let token = ''; let current: {path: string; staged: boolean} | undefined; let epoch = 0;
  const selected = new Map<number, Set<number>>();
  const modified = diff.getModifiedEditor?.(); const original = diff.getOriginalEditor?.();
  if (!modified || !original) return {load: async () => {}, clear() {}, apply: async () => {}, included: () => 0, available: () => false, selectAll() {}};
  const marks = {modified: modified.createDecorationsCollection(), original: original.createDecorationsCollection()};

  function paint() {
    const right: monaco.editor.IModelDeltaDecoration[] = []; const left: monaco.editor.IModelDeltaDecoration[] = [];
    for (const hunk of hunks) {
      const set = selected.get(hunk.id) ?? new Set<number>();
      const state = set.size === 0 ? '' : set.size === hunk.lines.length ? ' checked' : ' partial';
      // Caixa do trecho no lado atual, na primeira linha nova (ou onde a remoção aconteceu).
      const anchor = Math.max(1, hunk.lines.find(l => l.kind === '+')?.line ?? hunk.newStart);
      // Caixas por linha só em trechos com mais de uma linha (no PhpStorm aparecem ao passar o mouse).
      if (hunk.lines.length > 1) hunk.lines.forEach((line, index) => (line.kind === '+' ? right : left).push({range: new monaco.Range(line.line, 1, line.line, 1),
        options: {glyphMarginClassName: 'git-line-box' + (set.has(index) ? ' checked' : ''), glyphMarginHoverMessage: {value: tr('Incluir esta linha')}}}));
      right.push({range: new monaco.Range(anchor, 1, anchor, 1), options: {lineNumberClassName: 'git-chunk-box' + state}});
    }
    marks.modified.set(right.filter(d => d.range.startLineNumber <= (modified.getModel()?.getLineCount() ?? 0)));
    marks.original.set(left.filter(d => d.range.startLineNumber <= (original.getModel()?.getLineCount() ?? 0)));
    hooks.countChanged();
  }
  function toggle(hunk: ParsedHunk, indexes: number[], value?: boolean) {
    const set = selected.get(hunk.id) ?? new Set<number>();
    const on = value ?? !indexes.every(i => set.has(i));
    for (const i of indexes) on ? set.add(i) : set.delete(i);
    selected.set(hunk.id, set); paint();
  }
  /** Clique no gutter: na caixa do trecho (lado atual) alterna o trecho; nas caixas de linha, a linha. */
  function click(side: 'modified' | 'original', line: number, onNumber: boolean) {
    for (const hunk of hunks) {
      const anchor = Math.max(1, hunk.lines.find(l => l.kind === '+')?.line ?? hunk.newStart);
      if (side === 'modified' && onNumber && line === anchor) { toggle(hunk, hunk.lines.map((_, i) => i)); return true; }
      const index = hunk.lines.findIndex(l => (side === 'modified' ? l.kind === '+' : l.kind === '-') && l.line === line);
      if (index >= 0 && !onNumber && hunk.lines.length > 1) { toggle(hunk, [index]); return true; }
    }
    return false;
  }
  for (const [side, editor] of [['modified', modified], ['original', original]] as const) {
    own(editor.onMouseDown(event => {
      const line = event.target.position?.lineNumber; if (!line || !hunks.length) return;
      const type = event.target.type;
      if (type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) click(side, line, false);
      else if (type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && (event.target.element?.classList.contains('git-chunk-box') ?? false)) { event.event.preventDefault(); click(side, line, true); }
    }));
    // Menu de contexto do diff, como no PhpStorm (ações sobre a seleção do editor).
    const linesIn = (selection: monaco.Selection) => hunks.map(hunk => ({hunk, indexes: hunk.lines.map((l, i) => ({l, i})).filter(({l}) => (side === 'modified' ? l.kind === '+' : l.kind === '-') && l.line >= selection.startLineNumber && l.line <= selection.endLineNumber).map(({i}) => i)}));
    const touched = (selection: monaco.Selection) => hunks.filter(hunk => {
      const lo = side === 'modified' ? hunk.newStart : hunk.oldStart; const count = side === 'modified' ? hunk.newCount : hunk.oldCount;
      return selection.startLineNumber <= lo + Math.max(count, 1) - 1 && selection.endLineNumber >= lo;
    });
    own(editor.addAction({id: `php-ide.git.include-chunks-${side}`, label: tr('Incluir trechos selecionados'), contextMenuGroupId: '1_git', contextMenuOrder: 1,
      run: ed => { const s = ed.getSelection(); if (s) touched(s).forEach(h => toggle(h, h.lines.map((_, i) => i), true)); }}));
    own(editor.addAction({id: `php-ide.git.exclude-chunks-${side}`, label: tr('Excluir trechos selecionados'), contextMenuGroupId: '1_git', contextMenuOrder: 2,
      run: ed => { const s = ed.getSelection(); if (s) touched(s).forEach(h => toggle(h, h.lines.map((_, i) => i), false)); }}));
    own(editor.addAction({id: `php-ide.git.split-include-${side}`, label: tr('Dividir trechos e incluir linhas selecionadas'), contextMenuGroupId: '1_git', contextMenuOrder: 3,
      run: ed => { const s = ed.getSelection(); if (s) linesIn(s).forEach(({hunk, indexes}) => { if (indexes.length) toggle(hunk, indexes, true); }); }}));
  }

  async function load(path: string, staged: boolean) {
    clear(); const request = ++epoch;
    try {
      const data = await api.gitHunks(path, staged);
      if (request !== epoch) return;
      hunks = data.hunks.map((h: {id: number; patch: string}) => parseHunk(h.id, h.patch)); token = data.token; current = {path, staged};
      diff.updateOptions({glyphMargin: true}); paint();
    } catch { if (request === epoch) { hunks = []; paint(); } /* binário, novo, removido: só o arquivo inteiro */ }
  }
  function clear() { epoch++; hunks = []; token = ''; current = undefined; selected.clear(); marks.modified.clear(); marks.original.clear(); hooks.countChanged(); }
  const included = () => hunks.filter(h => selected.get(h.id)?.size).length;
  async function apply() {
    if (!current || hooks.busy()) return;
    const payload = selectionPayload(hunks, selected);
    if (!Object.keys(payload).length) { hooks.feedback(tr('Marque trechos ou linhas no gutter do diff.')); return; }
    hooks.setBusy(true);
    try {
      await api.gitApplyHunk(current.path, current.staged, token, payload);
      hooks.feedback(current.staged ? tr('Linhas retiradas do index; o disco foi preservado.') : tr('Linhas preparadas para commit; o restante continua no disco.'));
    } catch (error) { hooks.feedback(String(error instanceof Error ? error.message : error)); }
    finally { hooks.setBusy(false); await hooks.changed(); }
  }
  return {load, clear, apply, included, available: () => hunks.length > 0, selectAll(value: boolean) { hunks.forEach(h => toggle(h, h.lines.map((_, i) => i), value)); }};
}

export const countLabel = (count: number, included: number, staged: boolean) =>
  (count === 0 ? tr('Nenhuma diferença') : count === 1 ? tr('1 diferença') : msg`${count} diferenças`) + (included >= 0 ? (staged ? msg`, ${included} para retirar` : msg`, ${included} incluídas`) : '');
