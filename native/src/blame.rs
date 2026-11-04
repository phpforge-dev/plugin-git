//! Annotate with Git Blame.
use super::extra::*;
use super::*;
use std::collections::BTreeMap;

/// `git blame --porcelain` sobre o buffer (`text`) ou sobre uma revisão (`revision`).
/// Opções do menu Options do PhpStorm: ignorar espaços (-w, ligado por padrão lá),
/// movimentos no arquivo (-M) e entre arquivos (-C).
pub(super) async fn blame(root: &Path, input: &Value) -> Res<Value> {
    let path = s(&input["path"])?;
    let revision = input["revision"].as_str();
    let mut args: Vec<String> = vec!["blame".into(), "--porcelain".into()];
    if flag(input, "ignoreWhitespace") {
        args.push("-w".into());
    }
    if flag(input, "movesWithin") {
        args.push("-M".into());
    }
    if flag(input, "movesAcross") {
        args.push("-C".into());
    }
    let text = input["text"].as_str();
    let relative = match revision {
        Some(rev) => {
            valid_hash(rev)?;
            args.push(rev.into());
            plain_path(path)?.to_string()
        }
        None => {
            let text = text.ok_or("Documento inválido")?;
            if text.len() > 2_097_152 {
                return Err("Arquivo grande demais para anotar".into());
            }
            args.extend(["--contents".into(), "-".into()]);
            relative_file(root, path)?
        }
    };
    args.extend(["--".into(), relative.clone()]);
    let output = run(
        root,
        "git",
        &args,
        if revision.is_some() { None } else { text },
    )
    .await
    .map_err(|e| {
        if e.contains("no such path") {
            "Arquivo ainda não está no Git; não há anotações.".to_string()
        } else {
            e
        }
    })?;
    let mut lines = vec![];
    let mut commits: BTreeMap<String, Value> = BTreeMap::new();
    let mut current = String::new();
    let mut original = 0u64;
    for line in output.lines() {
        if let Some(_content) = line.strip_prefix('\t') {
            lines.push(json!({"hash":current,"original":original}));
            continue;
        }
        let mut parts = line.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() >= 40 && first.bytes().all(|c| c.is_ascii_hexdigit()) {
            current = first.to_string();
            original = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            commits.entry(current.clone()).or_insert_with(|| json!({}));
            continue;
        }
        let entry = commits.get_mut(&current).ok_or("Blame inválido")?;
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "author" => entry["author"] = json!(value),
            "author-mail" => entry["email"] = json!(value.trim_matches(['<', '>'])),
            "author-time" => entry["authorTime"] = json!(value.parse::<i64>().unwrap_or(0)),
            "committer-time" => entry["commitTime"] = json!(value.parse::<i64>().unwrap_or(0)),
            "summary" => entry["summary"] = json!(value),
            "previous" => {
                let (hash, file) = value.split_once(' ').unwrap_or((value, ""));
                entry["previous"] = json!({"hash":hash,"path":file});
            }
            "filename" => entry["path"] = json!(value),
            _ => {}
        }
    }
    // Mensagem completa para o popup (commit, autor, data e mensagem).
    let real: Vec<String> = commits
        .keys()
        .filter(|h| !h.bytes().all(|c| c == b'0'))
        .cloned()
        .collect();
    if !real.is_empty() {
        let mut args = vec![
            "show".to_string(),
            "-s".into(),
            "--no-walk=unsorted".into(),
            "--format=%H%x00%B%x1e".into(),
        ];
        args.extend(real.iter().cloned());
        let shown = run(root, "git", &args, None).await?;
        for record in shown.split('\x1e') {
            let record = record.trim_start_matches('\n');
            if let Some((hash, body)) = record.split_once('\0') {
                if let Some(entry) = commits.get_mut(hash) {
                    entry["message"] = json!(body.trim_end());
                }
            }
        }
    }
    for (hash, entry) in commits.iter_mut() {
        entry["hash"] = json!(hash);
        entry["uncommitted"] = json!(hash.bytes().all(|c| c == b'0'));
    }
    // Annotate Revision mostra o arquivo como era depois daquele commit.
    let content = match revision {
        Some(rev) => Some(blob(root, &format!("{}:{}", rev, relative)).await?),
        None => None,
    };
    Ok(json!({"path":relative,"revision":revision,"content":content,"lines":lines,"commits":commits}))
}
