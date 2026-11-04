/** Layout do grafo do Log: uma coluna por linha de desenvolvimento ativa, em ordem topológica.
 *  Cada linha recebe a coluna do nó e os segmentos que atravessam a metade de cima (entrando) e a de baixo
 *  (saindo), para desenhar linhas contínuas entre commits como o grafo do PhpStorm. Código próprio. */
export type GraphCommit = {hash: string; parents?: string[]};
export type Segment = {from: number; to: number; color: number};
export type GraphRow = {column: number; color: number; top: Segment[]; bottom: Segment[]};

export function layoutGraph(commits: GraphCommit[]): {rows: GraphRow[]; width: number} {
  const present = new Set(commits.map(c => c.hash));
  let lanes: ({hash: string; color: number} | undefined)[] = [];
  let nextColor = 0; let width = 0;
  const rows: GraphRow[] = [];
  const free = (list: typeof lanes) => { const i = list.indexOf(undefined); return i < 0 ? list.length : i; };
  for (const commit of commits) {
    // Coluna do commit: a primeira que o esperava; senão uma nova (topo de branch).
    let column = lanes.findIndex(l => l?.hash === commit.hash);
    if (column < 0) { column = free(lanes); lanes[column] = {hash: commit.hash, color: nextColor++}; }
    const color = lanes[column]!.color;
    // Metade de cima: cada linha ativa desce; as que esperavam este commit convergem para o nó.
    const top: Segment[] = [];
    lanes.forEach((lane, i) => { if (lane) top.push({from: i, to: lane.hash === commit.hash ? column : i, color: lane.color}); });
    const after = lanes.map(l => (l?.hash === commit.hash ? undefined : l));
    // Pais: o primeiro herda a coluna; os outros reaproveitam uma linha que já o espera ou abrem outra.
    const parents = (commit.parents ?? []).filter(p => present.has(p));
    parents.forEach((parent, index) => {
      if (after.some(l => l?.hash === parent)) return;
      if (index === 0 && after[column] === undefined) after[column] = {hash: parent, color};
      else { const slot = free(after); after[slot] = {hash: parent, color: index === 0 ? color : nextColor++}; }
    });
    const bottom: Segment[] = [];
    after.forEach((lane, i) => {
      if (!lane) return;
      // Linha que só atravessa mantém a coluna; linha nova (pai deste commit) sai do nó.
      bottom.push({from: lanes[i] === lane ? i : column, to: i, color: lane.color});
    });
    // Pai que outra linha já esperava: aresta do nó até aquela linha (merge).
    for (const parent of parents) {
      const j = after.findIndex(l => l?.hash === parent);
      if (j >= 0 && lanes[j] === after[j]) bottom.push({from: column, to: j, color: after[j]!.color});
    }
    while (after.length && after[after.length - 1] === undefined) after.pop();
    width = Math.max(width, lanes.length, after.length, column + 1);
    rows.push({column, color, top, bottom});
    lanes = after;
  }
  return {rows, width};
}

/** Commits alcançáveis a partir de HEAD (fundo azul-claro do "Current Branch" no PhpStorm). */
export function reachable(commits: GraphCommit[], head: string | undefined): Set<string> {
  const byHash = new Map(commits.map(c => [c.hash, c])); const seen = new Set<string>();
  const stack = head ? [head] : [];
  while (stack.length) { const hash = stack.pop()!; if (seen.has(hash) || !byHash.has(hash)) continue; seen.add(hash); stack.push(...(byHash.get(hash)!.parents ?? [])); }
  return seen;
}

/** Rótulos do `%D`: branch atual (HEAD ->), locais, remotas e tags. */
export type RefLabel = {name: string; kind: 'head' | 'local' | 'remote' | 'tag'};
export function parseRefs(decoration: string | undefined, remotes: Set<string>): RefLabel[] {
  const labels: RefLabel[] = [];
  for (const raw of (decoration ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (raw === 'HEAD') continue;
    if (raw.startsWith('HEAD -> ')) labels.push({name: raw.slice(8), kind: 'head'});
    else if (raw.startsWith('tag: ')) labels.push({name: raw.slice(5), kind: 'tag'});
    else if (raw.endsWith('/HEAD')) continue;
    else labels.push({name: raw, kind: remotes.has(raw) ? 'remote' : 'local'});
  }
  return labels;
}
