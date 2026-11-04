//! Log com filtros de branch, usuário, data, caminho e texto/hash.
use super::extra::*;
use super::*;
use std::collections::HashSet;

fn ymd(v: &str) -> Res<&str> {
    let ok = v.len() == 10
        && v.as_bytes()[4] == b'-'
        && v.as_bytes()[7] == b'-'
        && v.bytes()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !ok {
        return Err("Data inválida".into());
    }
    Ok(v)
}

/// Filtros do Log do PhpStorm: Branch, User, Date, Paths e texto/hash (Regex, Match Case).
pub(super) async fn log(root: &Path, input: &Value) -> Res<Value> {
    if reference(root, "HEAD").await.is_none() {
        return Ok(json!([]));
    }
    let refs_text = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    .await?;
    let known: HashSet<&str> = refs_text.lines().collect();
    let mut args: Vec<String> = vec!["log".into()];
    let limit = input["limit"].as_u64().unwrap_or(1000).clamp(1, 5000);
    args.push(format!("-{}", limit));
    args.push("--topo-order".into());
    args.push("--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D%x00%cn%x00".into());
    if let Some(users) = input["authors"].as_array() {
        for user in users {
            let user = s(user)?;
            if user.is_empty() || user.len() > 200 || user.contains(['\0', '\n']) {
                return Err("Autor inválido".into());
            }
            args.push(format!("--author=^{} <", regex::escape(user)));
        }
    }
    if let Some(since) = input["since"].as_str().filter(|v| !v.is_empty()) {
        args.push(format!("--since={} 00:00:00", ymd(since)?));
    }
    if let Some(until) = input["until"].as_str().filter(|v| !v.is_empty()) {
        args.push(format!("--until={} 23:59:59", ymd(until)?));
    }
    let text = input["text"].as_str().unwrap_or("").trim();
    if text.len() > 500 || text.contains(['\0', '\n']) {
        return Err("Busca inválida".into());
    }
    if !text.is_empty() {
        args.push(format!("--grep={}", text));
        if flag(input, "regex") {
            args.push("--extended-regexp".into());
        } else {
            args.push("--fixed-strings".into());
        }
        if !flag(input, "matchCase") {
            args.push("--regexp-ignore-case".into());
        }
    }
    let refs: Vec<String> = match &input["refs"] {
        Value::Array(items) if !items.is_empty() => items
            .iter()
            .map(|v| s(v).map(String::from))
            .collect::<Res<_>>()?,
        _ => vec![input["ref"].as_str().unwrap_or("HEAD").to_string()],
    };
    for r in &refs {
        if r != "HEAD" && r != "--all" && !known.contains(r.as_str()) {
            return Err("Branch inválida para histórico".into());
        }
        args.push(r.clone());
    }
    args.push("--".into());
    if let Some(paths) = input["paths"].as_array() {
        for p in paths {
            args.push(format!(":(literal){}", plain_path(s(p)?)?));
        }
    }
    let parse = |output: &str| -> Vec<Value> {
        let p: Vec<_> = output.split('\0').collect();
        p.chunks(8)
            .filter(|v| v.len() == 8)
            .map(|p| json!({"hash":p[0].trim(),"author":p[1],"email":p[2],"date":p[3],"subject":p[4],"parents":p[5].split_whitespace().collect::<Vec<_>>(),"refs":p[6],"committer":p[7]}))
            .collect()
    };
    let mut commits = parse(&run(root, "git", &args, None).await?);
    // Busca por hash (prefixo), como "Text or hash" do PhpStorm.
    if text.len() >= 4 && text.len() <= 64 && text.bytes().all(|c| c.is_ascii_hexdigit()) {
        if let Some(full) = reference(root, &format!("{}^{{commit}}", text)).await {
            if !commits.iter().any(|c| c["hash"] == full.as_str()) {
                let one = run(
                    root,
                    "git",
                    &[
                        "log".into(),
                        "-1".into(),
                        "--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%P%x00%D%x00%cn%x00".into(),
                        full,
                        "--".into(),
                    ],
                    None,
                )
                .await?;
                let mut found = parse(&one);
                found.append(&mut commits);
                commits = found;
            }
        }
    }
    Ok(json!(commits))
}
