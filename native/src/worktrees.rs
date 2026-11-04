//! Worktrees: listar, criar a partir de branch (ou nova branch), excluir e Prune.
use super::*;

pub(super) async fn worktrees(root: &Path) -> Res<Value> {
    let text = git(root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let mut items: Vec<Value> = vec![];
    let mut current = json!({});
    for field in text.split('\0') {
        if field.is_empty() {
            if current.get("path").is_some() {
                items.push(std::mem::replace(&mut current, json!({})));
            }
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        match key {
            "worktree" => {
                let canonical = Path::new(value).canonicalize().ok();
                current["path"] = json!(value);
                current["current"] = json!(canonical.as_deref() == Some(root));
                current["name"] = json!(Path::new(value)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(value));
            }
            "HEAD" => current["head"] = json!(value),
            "branch" => current["branch"] = json!(value.trim_start_matches("refs/heads/")),
            "detached" => current["detached"] = json!(true),
            "bare" => current["bare"] = json!(true),
            "locked" => current["locked"] = json!(if value.is_empty() { "locked" } else { value }),
            "prunable" => {
                current["prunable"] = json!(if value.is_empty() { "prunable" } else { value })
            }
            _ => {}
        }
    }
    if current.get("path").is_some() {
        items.push(current);
    }
    if let Some(first) = items.first_mut() {
        first["main"] = json!(true);
    }
    Ok(json!(items))
}

/// `worktree-add`, `worktree-remove` e `worktree-prune` de `gitOperation`; `None` para outros tipos.
pub(super) async fn operation(root: &Path, kind: &str, input: &Value) -> Option<Res<Value>> {
    let target = input["target"].as_str().unwrap_or("");
    let result: Res<String> = async {
        match kind {
            "worktree-add" => {
                let location = Path::new(target);
                if !location.is_absolute() || target.contains(['\0', '\n', '\r']) {
                    return Err("Informe um caminho absoluto para o worktree".into());
                }
                if location.exists() {
                    return Err("O destino já existe".into());
                }
                let parent = location
                    .parent()
                    .ok_or("Destino inválido")?
                    .canonicalize()
                    .map_err(|_| "Pasta de destino não existe".to_string())?;
                if parent.starts_with(root) {
                    return Err("Não crie o worktree dentro do projeto atual".into());
                }
                let destination = parent.join(location.file_name().ok_or("Destino inválido")?);
                let branch = s(&input["branch"])?;
                let refs = git(
                    root,
                    &[
                        "for-each-ref",
                        "--format=%(refname)",
                        "refs/heads",
                        "refs/remotes",
                    ],
                )
                .await?;
                let full = refs
                    .lines()
                    .find(|r| {
                        *r == format!("refs/heads/{}", branch)
                            || *r == format!("refs/remotes/{}", branch)
                    })
                    .ok_or("Branch de origem inválida")?
                    .to_string();
                let mut argv: Vec<String> = vec!["worktree".into(), "add".into()];
                match input["newBranch"].as_str().filter(|b| !b.is_empty()) {
                    Some(name) => {
                        git(root, &["check-ref-format", "--branch", name])
                            .await
                            .map_err(|_| "Nome de branch inválido".to_string())?;
                        if name.starts_with('-') {
                            return Err("Nome de branch inválido".into());
                        }
                        argv.extend(["-b".into(), name.into()]);
                        argv.extend([
                            "--".into(),
                            destination.to_string_lossy().into_owned(),
                            full,
                        ]);
                    }
                    None if full.starts_with("refs/remotes/") => {
                        // Como o PhpStorm: remota vira branch local de mesmo nome.
                        let local = branch.split_once('/').map(|(_, b)| b).unwrap_or(branch);
                        git(root, &["check-ref-format", "--branch", local]).await?;
                        argv.extend([
                            "--track".into(),
                            "-b".into(),
                            local.into(),
                            "--".into(),
                            destination.to_string_lossy().into_owned(),
                            full,
                        ]);
                    }
                    None => argv.extend([
                        "--".into(),
                        destination.to_string_lossy().into_owned(),
                        branch.into(),
                    ]),
                }
                run(root, "git", &argv, None).await?;
                Ok(destination.to_string_lossy().into_owned())
            }
            "worktree-remove" => {
                let list = worktrees(root).await?;
                let item = list
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|w| w["path"] == target)
                    .ok_or("Worktree não encontrado")?;
                if item["main"] == true || item["current"] == true {
                    return Err("Não é possível excluir o worktree principal nem o aberto".into());
                }
                git(root, &["worktree", "remove", "--", target]).await
            }
            "worktree-prune" => git(root, &["worktree", "prune", "-v"]).await,
            _ => Err(String::new()),
        }
    }
    .await;
    match result {
        Err(e) if e.is_empty() => None,
        other => Some(other.map(|v| json!(v))),
    }
}
