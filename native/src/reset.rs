//! Reset Current Branch to Here (Soft, Mixed, Hard, Keep) e Checkout Revision a partir do Log.
use super::*;

/// `reset` e `checkout-revision` de `gitOperation`; `None` para outros tipos.
pub(super) async fn operation(root: &Path, kind: &str, input: &Value) -> Option<Res<Value>> {
    let target = input["target"].as_str().unwrap_or("");
    let result = match kind {
        "reset" => {
            async {
                valid_hash(target)?;
                let mode = match input["mode"].as_str().unwrap_or("mixed") {
                    m @ ("soft" | "mixed" | "hard" | "keep") => m,
                    _ => return Err("Modo de reset inválido".into()),
                };
                reference(root, &format!("{}^{{commit}}", target))
                    .await
                    .ok_or("Commit inválido")?;
                git(root, &["reset", &format!("--{}", mode), target]).await
            }
            .await
        }
        "checkout-revision" => {
            async {
                valid_hash(target)?;
                git(root, &["switch", "--detach", target]).await
            }
            .await
        }
        _ => return None,
    };
    Some(result.map(|v| json!(v)))
}
