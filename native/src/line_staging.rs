//! Staging de linhas escolhidas no diff.
use super::*;
use std::collections::{HashMap, HashSet};

struct Hunk {
    old_start: usize,
    old_count: usize,
    /// (tipo '-' ou '+', texto com quebra de linha original)
    lines: Vec<(char, String)>,
}

fn parse_hunks(chunks: &[String]) -> Res<Vec<Hunk>> {
    let header = regex::Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").map_err(err)?;
    chunks
        .iter()
        .map(|chunk| {
            let mut rows = chunk.split_inclusive('\n');
            let first = rows.next().ok_or("Trecho inválido")?;
            let c = header.captures(first).ok_or("Trecho inválido")?;
            let old_start: usize = c[1].parse().map_err(err)?;
            let old_count: usize = c
                .get(2)
                .map_or(Ok(1), |m| m.as_str().parse())
                .map_err(err)?;
            let mut lines: Vec<(char, String)> = vec![];
            for row in rows {
                if row.starts_with('\\') {
                    // "\ No newline at end of file": a linha anterior não termina com \n.
                    if let Some(last) = lines.last_mut() {
                        if last.1.ends_with('\n') {
                            last.1.pop();
                        }
                    }
                    continue;
                }
                let kind = row.chars().next().ok_or("Trecho inválido")?;
                if kind != '-' && kind != '+' {
                    return Err("Trecho com contexto inesperado".into());
                }
                lines.push((kind, row[1..].to_string()));
            }
            Ok(Hunk {
                old_start,
                old_count,
                lines,
            })
        })
        .collect()
}

/// Reconstrói o conteúdo do index aplicando só as linhas escolhidas de cada trecho.
/// `base` é o lado "antes" do diff: index (preparar) ou HEAD (retirar).
/// Preparar: linha `-` escolhida sai, `+` escolhida entra. Retirar: o inverso, sobre HEAD.
fn apply_selection(
    base: &str,
    hunks: &[Hunk],
    selected: &HashMap<usize, Option<HashSet<usize>>>,
    unstage: bool,
) -> Res<String> {
    let lines: Vec<&str> = base.split_inclusive('\n').collect();
    let mut out = String::with_capacity(base.len());
    let mut cursor = 0usize; // próxima linha (0-based) de `base` a copiar
    for (id, hunk) in hunks.iter().enumerate() {
        // Zero contexto: com old_count 0 a inserção vem depois da linha old_start.
        let start = if hunk.old_count == 0 {
            hunk.old_start
        } else {
            hunk.old_start - 1
        };
        if start < cursor || start > lines.len() {
            return Err("Trechos fora de ordem".into());
        }
        for line in &lines[cursor..start] {
            out.push_str(line);
        }
        cursor = start + hunk.old_count;
        let choice = selected.get(&id);
        let chosen = |n: usize| match choice {
            None => false,
            Some(None) => true,
            Some(Some(set)) => set.contains(&n),
        };
        let mut kept_minus = vec![];
        let mut kept_plus = vec![];
        for (n, (kind, text)) in hunk.lines.iter().enumerate() {
            let pick = chosen(n);
            match (kind, unstage) {
                ('-', false) if !pick => kept_minus.push(text.as_str()),
                ('+', false) if pick => kept_plus.push(text.as_str()),
                ('-', true) if pick => kept_minus.push(text.as_str()),
                ('+', true) if !pick => kept_plus.push(text.as_str()),
                _ => {}
            }
        }
        // Linha sem \n que deixa de ser a última ganha a quebra de linha.
        let pieces: Vec<&str> = kept_minus.into_iter().chain(kept_plus).collect();
        let count = pieces.len();
        for (i, piece) in pieces.into_iter().enumerate() {
            out.push_str(piece);
            if !piece.ends_with('\n') && (i + 1 < count || cursor < lines.len()) {
                out.push('\n');
            }
        }
    }
    if cursor > lines.len() {
        return Err("Trechos fora do arquivo".into());
    }
    for line in &lines[cursor..] {
        out.push_str(line);
    }
    Ok(out)
}

/// `selection` = `{"<id do trecho>": true | [índices das linhas +/- do trecho]}`.
pub(super) async fn apply_lines(
    root: &Path,
    path: &str,
    staged: bool,
    token: &Value,
    selection: &Value,
) -> Res<()> {
    let (current, _prefix, chunks) = hunks(root, path, staged).await?;
    if *token != current {
        return Err("Diff mudou".into());
    }
    let hunks = parse_hunks(&chunks)?;
    let mut selected: HashMap<usize, Option<HashSet<usize>>> = HashMap::new();
    for (key, value) in selection.as_object().ok_or("Seleção inválida")? {
        let id: usize = key.parse().map_err(|_| "Seleção inválida")?;
        let hunk = hunks.get(id).ok_or("Trecho inválido")?;
        let lines = match value {
            Value::Bool(true) => None,
            Value::Array(items) => {
                let set: HashSet<usize> = items
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|n| n as usize)
                    .collect();
                if set.len() != items.len() || set.iter().any(|n| *n >= hunk.lines.len()) {
                    return Err("Linha inválida".into());
                }
                if set.is_empty() {
                    continue;
                }
                Some(set)
            }
            _ => return Err("Seleção inválida".into()),
        };
        selected.insert(id, lines);
    }
    if selected.is_empty() {
        return Err("Selecione ao menos uma linha".into());
    }
    let state = status(root).await?;
    let (base, mode) = if staged {
        let head = s(&state["head"])?;
        let tree = git(root, &["ls-tree", head, "--", path]).await?;
        (
            blob(root, &format!("{}:{}", head, path)).await?,
            tree.split_whitespace()
                .next()
                .unwrap_or("100644")
                .to_string(),
        )
    } else {
        let stage = git(root, &["ls-files", "--stage", "--", path]).await?;
        (
            blob(root, &format!(":{}", path)).await?,
            stage
                .split_whitespace()
                .next()
                .unwrap_or("100644")
                .to_string(),
        )
    };
    if !["100644", "100755"].contains(&mode.as_str()) {
        return Err("Somente arquivos de texto comuns aceitam seleção de linhas".into());
    }
    let content = apply_selection(&base, &hunks, &selected, staged)?;
    let object = run(
        root,
        "git",
        &["hash-object".into(), "-w".into(), "--stdin".into()],
        Some(&content),
    )
    .await?;
    let object = object.trim();
    valid_hash(object)?;
    git(
        root,
        &[
            "update-index",
            "--cacheinfo",
            &format!("{},{},{}", mode, object, path),
        ],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hunk(old_start: usize, old_count: usize, lines: &[(char, &str)]) -> Hunk {
        Hunk {
            old_start,
            old_count,
            lines: lines.iter().map(|(k, t)| (*k, t.to_string())).collect(),
        }
    }
    #[test]
    fn stages_only_selected_lines() {
        let base = "a\nb\nc\n";
        let hunks = vec![hunk(2, 1, &[('-', "b\n"), ('+', "B1\n"), ('+', "B2\n")])];
        let mut sel = HashMap::new();
        sel.insert(0, Some(HashSet::from([2usize])));
        assert_eq!(
            apply_selection(base, &hunks, &sel, false).unwrap(),
            "a\nb\nB2\nc\n"
        );
        sel.insert(0, None);
        assert_eq!(
            apply_selection(base, &hunks, &sel, false).unwrap(),
            "a\nB1\nB2\nc\n"
        );
    }
    #[test]
    fn insertion_after_line_and_missing_newline() {
        let hunks = vec![hunk(1, 0, &[('+', "x\n")]), hunk(2, 1, &[('-', "b")])];
        let mut sel = HashMap::new();
        sel.insert(0, None);
        assert_eq!(
            apply_selection("a\nb", &hunks, &sel, false).unwrap(),
            "a\nx\nb"
        );
        sel.insert(1, None);
        assert_eq!(
            apply_selection("a\nb", &hunks, &sel, false).unwrap(),
            "a\nx\n"
        );
    }
}
