//! Utilitários dos recursos Git adicionados em 1.2 (blame, changelists, linhas, Log, tags, reset, worktrees).
//! Requisitos e observações do PhpStorm 2026.1.4: `docs/research/phpstorm-git.md` no php-ide.
use super::*;

pub(super) fn relative_file(root: &Path, input: &str) -> Res<String> {
    let path = workspace::confined(root, input)?;
    Ok(path
        .strip_prefix(root)
        .map_err(err)?
        .to_str()
        .ok_or("Caminho inválido")?
        .to_string())
}

/// Caminho relativo informado pela interface, sem `..`, absoluto nem NUL (pode não existir no disco).
pub(super) fn plain_path(path: &str) -> Res<&str> {
    if path.is_empty()
        || path.starts_with('-')
        || Path::new(path).is_absolute()
        || path.contains(['\0', '\n', '\r'])
        || Path::new(path)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Caminho inválido".into());
    }
    Ok(path)
}

pub(super) fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
