//! Tags: listar, criar (leve ou anotada, com Force), excluir e enviar ao remoto.
use super::extra::*;
use super::*;

pub(super) async fn tags(root: &Path) -> Res<Value> {
    let text = git(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(objecttype)",
            "refs/tags",
        ],
    )
    .await?;
    Ok(json!(text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let p: Vec<_> = l.split('\0').collect();
            let target = if p.get(2).is_some_and(|v| !v.is_empty()) {
                p[2]
            } else {
                p.get(1).copied().unwrap_or("")
            };
            json!({"name":p[0],"commit":target,"annotated":p.get(3)==Some(&"tag")})
        })
        .collect::<Vec<_>>()))
}

/// `create-tag`, `delete-tag` e `push-tag` de `gitOperation`; `None` para outros tipos.
pub(super) async fn operation(
    root: &Path,
    kind: &str,
    input: &Value,
    accounts: Option<&Accounts>,
) -> Option<Res<Value>> {
    let target = input["target"].as_str().unwrap_or("");
    let result = match kind {
        "create-tag" => create(root, target, input).await,
        "delete-tag" | "push-tag" => {
            async {
                let list = tags(root).await?;
                if !list.as_array().unwrap().iter().any(|t| t["name"] == target) {
                    return Err("Tag não encontrada".into());
                }
                if kind == "delete-tag" {
                    return git(root, &["tag", "-d", target]).await;
                }
                let remote = input["remote"].as_str().unwrap_or("origin");
                if !git(root, &["remote"]).await?.lines().any(|r| r == remote) {
                    return Err("Remoto inválido".into());
                }
                let (env, account) = match accounts {
                    Some(accounts) => accounts.credential_env(root, Some(remote)).await?,
                    None => (vec![], None),
                };
                run_env(
                    root,
                    "git",
                    &[
                        "push".into(),
                        "--porcelain".into(),
                        "--".into(),
                        remote.into(),
                        format!("refs/tags/{0}:refs/tags/{0}", target),
                    ],
                    None,
                    &env,
                )
                .await
                .map_err(|e| auth_error(e, account.as_ref()))
            }
            .await
        }
        _ => return None,
    };
    Some(result.map(|v| json!(v)))
}

async fn create(root: &Path, target: &str, input: &Value) -> Res<String> {
    if target.is_empty() || target.starts_with('-') {
        return Err("Nome de tag inválido".into());
    }
    git(
        root,
        &["check-ref-format", &format!("refs/tags/{}", target)],
    )
    .await
    .map_err(|_| "Nome de tag inválido".to_string())?;
    let commit = input["commit"].as_str().unwrap_or("HEAD");
    let resolved = reference(root, &format!("{}^{{commit}}", commit))
        .await
        .ok_or("Commit inválido")?;
    let mut argv: Vec<String> = vec!["tag".into()];
    if flag(input, "force") {
        argv.push("-f".into());
    }
    if let Some(message) = input["message"].as_str().filter(|m| !m.trim().is_empty()) {
        if message.len() > 10_000 || message.contains('\0') {
            return Err("Mensagem inválida".into());
        }
        argv.extend(["-a".into(), "-m".into(), message.into()]);
    }
    argv.extend([target.into(), resolved]);
    run(root, "git", &argv, None).await
}
