//! Changelists da janela Commit.
use super::extra::*;
use super::*;
use std::collections::{HashMap, HashSet};

/// Changelists são metadados do IDE (como no PhpStorm, que as guarda no workspace do projeto):
/// gravadas em `<git-dir>/phpforge-changelists.json`, nunca no repositório versionado.
async fn changelist_file(root: &Path) -> Res<PathBuf> {
    let dir = git(root, &["rev-parse", "--absolute-git-dir"]).await?;
    Ok(PathBuf::from(dir.trim()).join("phpforge-changelists.json"))
}

fn default_lists() -> Value {
    json!({"lists":[{"id":"default","name":"Changes","comment":""}],"active":"default","files":{}})
}

fn load_lists(file: &Path) -> Value {
    let value = fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v["lists"].as_array().is_some_and(|l| !l.is_empty()) && v["files"].is_object())
        .unwrap_or_else(default_lists);
    let mut value = value;
    let active = value["active"].as_str().unwrap_or("").to_string();
    if !value["lists"]
        .as_array()
        .unwrap()
        .iter()
        .any(|l| l["id"] == active)
    {
        value["active"] = value["lists"][0]["id"].clone();
    }
    value
}

fn save_lists(file: &Path, value: &Value) -> Res<()> {
    let temp = file.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(value).map_err(err)?).map_err(err)?;
    fs::rename(&temp, file).map_err(err)
}

fn list_name(name: &str) -> Res<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 || name.contains(['\0', '\n', '\r']) {
        return Err("Nome de changelist inválido".into());
    }
    Ok(name.to_string())
}

fn find_list(value: &Value, name: &str) -> Option<String> {
    value["lists"]
        .as_array()?
        .iter()
        .find(|l| {
            l["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .and_then(|l| l["id"].as_str().map(String::from))
}

fn new_list(value: &mut Value, name: &str, comment: &str) -> Res<String> {
    let name = list_name(name)?;
    if find_list(value, &name).is_some() {
        return Err("Já existe uma changelist com esse nome".into());
    }
    if comment.len() > 10_000 {
        return Err("Comentário grande demais".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    value["lists"]
        .as_array_mut()
        .ok_or("Changelists inválidas")?
        .push(json!({"id":id,"name":name,"comment":comment}));
    Ok(id)
}

/// Lista, cria, move arquivos, define a ativa, edita e exclui changelists.
/// Mudanças novas entram na changelist ativa; arquivos que deixaram de mudar saem das listas.
/// Arquivos não rastreados ficam no grupo "Unversioned Files", fora das changelists.
pub(super) async fn changelists(root: &Path, input: &Value) -> Res<Value> {
    let file = changelist_file(root).await?;
    let mut value = load_lists(&file);
    let before = value.clone();
    let state = status(root).await?;
    let tracked: Vec<String> = state["changes"]
        .as_array()
        .ok_or("Status inválido")?
        .iter()
        .filter(|c| c["index"] != "?")
        .filter_map(|c| c["path"].as_str().map(String::from))
        .collect();
    let action = input["action"].as_str().unwrap_or("list");
    let ids = |value: &Value| -> HashSet<String> {
        value["lists"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter_map(|l| l["id"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let list_id = |value: &Value, key: &str| -> Res<String> {
        let id = s(&input[key])?.to_string();
        if !ids(value).contains(&id) {
            return Err("Changelist não encontrada".into());
        }
        Ok(id)
    };
    match action {
        "list" => {}
        "create" => {
            let id = new_list(
                &mut value,
                s(&input["name"])?,
                input["comment"].as_str().unwrap_or(""),
            )?;
            if flag(input, "setActive") {
                value["active"] = json!(id);
            }
        }
        "move" => {
            let paths = input["paths"].as_array().ok_or("Arquivos inválidos")?;
            if paths.is_empty() || paths.len() > 5000 {
                return Err("Selecione arquivos alterados".into());
            }
            let target = match input["target"].as_str() {
                Some(id) if ids(&value).contains(id) => id.to_string(),
                _ => {
                    let name = list_name(s(&input["name"])?)?;
                    match find_list(&value, &name) {
                        Some(id) => id,
                        None => {
                            new_list(&mut value, &name, input["comment"].as_str().unwrap_or(""))?
                        }
                    }
                }
            };
            for path in paths {
                let path = s(path)?;
                if !tracked.iter().any(|p| p == path) {
                    return Err("Arquivo não tem alterações rastreadas. Atualize a lista.".into());
                }
                value["files"][path] = json!(target);
            }
            if flag(input, "setActive") {
                value["active"] = json!(target);
            }
        }
        "set-active" => {
            let id = list_id(&value, "id")?;
            value["active"] = json!(id);
        }
        "edit" => {
            let id = list_id(&value, "id")?;
            let name = list_name(s(&input["name"])?)?;
            if find_list(&value, &name).is_some_and(|other| other != id) {
                return Err("Já existe uma changelist com esse nome".into());
            }
            let comment = input["comment"].as_str().unwrap_or("");
            for list in value["lists"].as_array_mut().unwrap() {
                if list["id"] == id {
                    list["name"] = json!(name);
                    list["comment"] = json!(comment);
                }
            }
            if flag(input, "setActive") {
                value["active"] = json!(id);
            }
        }
        "delete" => {
            let id = list_id(&value, "id")?;
            if value["active"] == id {
                return Err("A changelist ativa não pode ser excluída. Ative outra antes.".into());
            }
            let active = value["active"].clone();
            value["lists"]
                .as_array_mut()
                .unwrap()
                .retain(|l| l["id"] != id);
            for (_, list) in value["files"].as_object_mut().unwrap().iter_mut() {
                if *list == id {
                    *list = active.clone();
                }
            }
        }
        _ => return Err("Ação de changelist desconhecida".into()),
    }
    // Reconcilia com o status: novos arquivos → ativa; arquivos sem alteração → removidos.
    let known = ids(&value);
    let active = value["active"].clone();
    let files = value["files"]
        .as_object_mut()
        .ok_or("Changelists inválidas")?;
    files.retain(|path, list| {
        tracked.iter().any(|p| p == path) && list.as_str().is_some_and(|l| known.contains(l))
    });
    for path in &tracked {
        if !files.contains_key(path) {
            files.insert(path.clone(), active.clone());
        }
    }
    if value != before {
        save_lists(&file, &value)?;
    }
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    for (path, list) in value["files"].as_object().unwrap() {
        members
            .entry(list.as_str().unwrap_or("").to_string())
            .or_default()
            .push(path.clone());
    }
    let lists: Vec<Value> = value["lists"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let id = l["id"].as_str().unwrap_or("");
            let mut files = members.remove(id).unwrap_or_default();
            files.sort();
            json!({"id":id,"name":l["name"],"comment":l["comment"],"active":value["active"]==id,"files":files})
        })
        .collect();
    Ok(json!({"lists":lists}))
}
