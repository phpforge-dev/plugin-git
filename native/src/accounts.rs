//! Contas Git da IDE: lista sem segredos em `git-accounts.json` (diretório de estado da IDE),
//! token no Keychain/Credential Manager/Secret Service e conta escolhida por projeto em
//! `phpide.account` na configuração local do repositório.
use crate::{
    feature::s,
    oauth::{self, OAuth, Poll},
    process::git,
    workspace::{err, Res},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const SERVICE: &str = "dev.phpforge.ide.git-account";
const KINDS: [(&str, &str); 4] = [
    ("github", "github.com"),
    ("gitlab", "gitlab.com"),
    ("bitbucket", "bitbucket.org"),
    ("generic", ""),
];
/// Valor de `phpide.account` quando o projeto usa a configuração do Git do sistema.
pub const SYSTEM: &str = "system";
/// Prefixo dos erros que a interface trata abrindo a escolha de conta.
pub const ACCOUNT_REQUIRED: &str = "[git-account] ";
/// Prefixo `[git-account-token:<id>] ` do aviso de token recusado no push (ação Use Token).
pub const TOKEN_REJECTED: &str = "[git-account-token:";
// Só responde `get` para o host e protocolo da conta; não grava nem apaga credenciais.
const HELPER: &str = r#"!f() { test "$1" = get || exit 0; p=; h=; while IFS= read -r l; do case "$l" in protocol=*) p=${l#protocol=};; host=*) h=${l#host=};; esac; done; test "$h" = "$PHPIDE_GIT_HOST" || exit 0; case "$p" in https) ;; http) case "$h" in localhost|localhost:*|127.0.0.1|127.0.0.1:*) ;; *) exit 0;; esac;; *) exit 0;; esac; printf 'username=%s\npassword=%s\n' "$PHPIDE_GIT_USER" "$PHPIDE_GIT_SECRET"; }; f"#;

pub trait Secrets: Send + Sync {
    fn get(&self, id: &str) -> Res<Option<String>>;
    fn set(&self, id: &str, secret: &str) -> Res<()>;
    fn delete(&self, id: &str) -> Res<()>;
}
/// Cofre do sistema operacional (Keychain no macOS).
pub struct Keychain;
impl Secrets for Keychain {
    fn get(&self, id: &str) -> Res<Option<String>> {
        match keyring::Entry::new(SERVICE, id).map_err(err)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Cofre de senhas do sistema indisponível: {}", e)),
        }
    }
    fn set(&self, id: &str, secret: &str) -> Res<()> {
        keyring::Entry::new(SERVICE, id)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| format!("Não foi possível gravar o token no cofre do sistema: {}", e))
    }
    fn delete(&self, id: &str) -> Res<()> {
        match keyring::Entry::new(SERVICE, id).map_err(err)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Não foi possível remover o token do cofre: {}", e)),
        }
    }
}
/// Cofre só em memória, para testes com estado descartável.
#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);
impl Secrets for MemorySecrets {
    fn get(&self, id: &str) -> Res<Option<String>> {
        Ok(self.0.lock().map_err(err)?.get(id).cloned())
    }
    fn set(&self, id: &str, secret: &str) -> Res<()> {
        self.0.lock().map_err(err)?.insert(id.into(), secret.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Res<()> {
        self.0.lock().map_err(err)?.remove(id);
        Ok(())
    }
}

#[derive(Clone)]
pub struct Accounts {
    file: PathBuf,
    secrets: Arc<dyn Secrets>,
    oauth: OAuth,
}
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn text(v: &Value, key: &str, max: usize) -> Res<String> {
    let value = v[key].as_str().unwrap_or("").trim().to_string();
    if value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("Campo inválido: {}", key));
    }
    Ok(value)
}
fn valid_host(host: &str) -> bool {
    regex::Regex::new(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$")
        .map(|r| r.is_match(host))
        .unwrap_or(false)
}
/// Host do remoto (`host[:porta]`) e protocolo, como o Git envia ao credential helper.
fn remote_host(url: &str) -> Option<(String, String)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some((
        parsed.scheme().to_string(),
        match parsed.port() {
            Some(port) => format!("{}:{}", host, port),
            None => host,
        },
    ))
}

impl Accounts {
    pub fn new(file: PathBuf, secrets: Arc<dyn Secrets>) -> Self {
        Self { file, secrets, oauth: OAuth::system() }
    }
    /// Login/validação contra outro provedor (testes com servidor OAuth falso).
    pub fn with_oauth(mut self, oauth: OAuth) -> Self {
        self.oauth = oauth;
        self
    }
    /// Contas guardadas no diretório de estado da IDE. Com `PHP_IDE_GIT_SECRETS=memory`
    /// e um diretório de estado explícito (testes), os tokens ficam só em memória.
    pub fn system(state_dir: &Path) -> Self {
        static MEMORY: std::sync::OnceLock<Arc<MemorySecrets>> = std::sync::OnceLock::new();
        let test = std::env::var_os("PHP_IDE_STATE_DIR").is_some()
            && std::env::var("PHP_IDE_GIT_SECRETS").as_deref() == Ok("memory");
        let secrets: Arc<dyn Secrets> = if test {
            MEMORY.get_or_init(Default::default).clone()
        } else {
            Arc::new(Keychain)
        };
        Self::new(state_dir.join("git-accounts.json"), secrets)
    }
    fn load(&self) -> Res<Vec<Value>> {
        match fs::read_to_string(&self.file) {
            Ok(v) => Ok(serde_json::from_str::<Value>(&v)
                .map_err(|_| "Lista de contas Git corrompida".to_string())?["accounts"]
                .as_array()
                .cloned()
                .unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(err(e)),
        }
    }
    fn store(&self, accounts: &[Value]) -> Res<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(err)?;
        }
        let temp = self.file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(err)?;
        }
        let body = json!({"version":1,"accounts":accounts}).to_string();
        let written = file.write_all(body.as_bytes()).and_then(|_| file.sync_all());
        drop(file);
        if let Err(e) = written.and_then(|_| fs::rename(&temp, &self.file)) {
            let _ = fs::remove_file(&temp);
            return Err(err(e));
        }
        Ok(())
    }
    /// Contas sem segredo, com `hasSecret` indicando se o cofre tem token.
    pub fn list(&self) -> Res<Vec<Value>> {
        let accounts = self.load()?;
        Ok(accounts
            .into_iter()
            .map(|mut a| {
                let id = a["id"].as_str().unwrap_or("").to_string();
                a["hasSecret"] = json!(self.secrets.get(&id).ok().flatten().is_some());
                a
            })
            .collect())
    }
    pub fn find(&self, id: &str) -> Res<Option<Value>> {
        Ok(self.load()?.into_iter().find(|a| a["id"] == id))
    }
    pub fn save(&self, input: &Value) -> Res<Value> {
        let kind = text(input, "kind", 16)?;
        let default_host = KINDS
            .iter()
            .find(|(k, _)| *k == kind)
            .ok_or("Tipo de conta inválido")?
            .1;
        let mut host = text(input, "host", 260)?.to_ascii_lowercase();
        if host.is_empty() {
            host = default_host.into();
        }
        if !valid_host(&host) {
            return Err("Informe o host, por exemplo github.com ou git.empresa.com:8443".into());
        }
        let login = text(input, "login", 256)?;
        let name = text(input, "name", 256)?;
        let email = text(input, "email", 256)?;
        if login.is_empty() || login.contains([':', ' ']) {
            return Err("Informe o usuário (login) sem espaços nem dois-pontos".into());
        }
        if name.is_empty() || format!("{}{}", name, email).contains(['<', '>']) {
            return Err("Informe o nome de autor dos commits".into());
        }
        if !regex::Regex::new(r"^[^@\s]+@[^@\s]+$").map_err(err)?.is_match(&email) {
            return Err("Informe um e-mail de autor válido".into());
        }
        let secret = input["secret"].as_str().unwrap_or("");
        if secret.len() > 8192 || secret.contains(['\0', '\r', '\n']) {
            return Err("Token inválido".into());
        }
        let _guard = FILE_LOCK.lock().map_err(err)?;
        let mut accounts = self.load()?;
        let id = match input["id"].as_str().filter(|v| !v.is_empty()) {
            Some(id) => {
                if !accounts.iter().any(|a| a["id"] == id) {
                    return Err("Conta não encontrada; ela pode ter sido removida".into());
                }
                id.to_string()
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        if accounts
            .iter()
            .any(|a| a["id"] != id.as_str() && a["host"] == host.as_str() && a["login"] == login.as_str())
        {
            return Err(format!("Já existe uma conta {} em {}", login, host));
        }
        if !secret.is_empty() {
            self.secrets.set(&id, secret)?;
        }
        let first = accounts.is_empty();
        let value = json!({"id":id,"kind":kind,"host":host,"login":login,"name":name,"email":email});
        match accounts.iter_mut().find(|a| a["id"] == id.as_str()) {
            Some(existing) => {
                let default = existing["default"].clone();
                *existing = value;
                existing["default"] = default;
            }
            None => {
                let mut value = value;
                value["default"] = json!(first);
                accounts.push(value);
            }
        }
        self.store(&accounts)?;
        Ok(json!(id))
    }
    pub fn remove(&self, id: &str) -> Res<()> {
        let _guard = FILE_LOCK.lock().map_err(err)?;
        let mut accounts = self.load()?;
        let before = accounts.len();
        let was_default = accounts.iter().any(|a| a["id"] == id && a["default"] == true);
        accounts.retain(|a| a["id"] != id);
        if accounts.len() == before {
            return Err("Conta não encontrada".into());
        }
        if was_default {
            if let Some(first) = accounts.first_mut() {
                first["default"] = json!(true);
            }
        }
        self.store(&accounts)?;
        self.secrets.delete(id)
    }
    pub fn set_default(&self, id: &str) -> Res<()> {
        let _guard = FILE_LOCK.lock().map_err(err)?;
        let mut accounts = self.load()?;
        if !accounts.iter().any(|a| a["id"] == id) {
            return Err("Conta não encontrada".into());
        }
        for a in &mut accounts {
            a["default"] = json!(a["id"] == id);
        }
        self.store(&accounts)
    }
    /// Conta escolhida para o repositório: `None` sem escolha, `Some(SYSTEM)` ou o id.
    pub async fn binding(root: &Path) -> Option<String> {
        git(root, &["config", "--local", "--get", "phpide.account"])
            .await
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
    pub async fn bind(&self, root: &Path, id: &str) -> Res<()> {
        if id != SYSTEM && self.find(id)?.is_none() {
            return Err("Conta não encontrada; ela pode ter sido removida".into());
        }
        git(root, &["config", "--local", "phpide.account", id]).await?;
        Ok(())
    }
    /// Estado da conta do projeto: escolha, conta resolvida e se ela foi removida.
    pub async fn project(&self, root: &Path) -> Res<Value> {
        let binding = Self::binding(root).await;
        let account = match binding.as_deref() {
            Some(SYSTEM) | None => None,
            Some(id) => self.list()?.into_iter().find(|a| a["id"] == id),
        };
        let missing = binding.as_deref().is_some_and(|b| b != SYSTEM) && account.is_none();
        Ok(json!({"binding":binding,"account":account,"missing":missing}))
    }
    /// Conta do projeto para commit/push. Sem escolha no projeto vale a conta padrão (✓) e,
    /// sem contas, a configuração do Git do sistema, como no PhpStorm: nada bloqueia o commit.
    async fn resolve(&self, root: &Path) -> Res<Option<Value>> {
        match Self::binding(root).await.as_deref() {
            None => Ok(self.list()?.into_iter().find(|a| a["default"] == true)),
            Some(SYSTEM) => Ok(None),
            Some(id) => match self.find(id)? {
                Some(a) => Ok(Some(a)),
                None => Err(format!(
                    "{}A conta Git deste projeto foi removida. Escolha outra conta.",
                    ACCOUNT_REQUIRED
                )),
            },
        }
    }
    /// Autor e committer da conta do projeto, só no ambiente do processo `git commit`.
    pub async fn identity_env(&self, root: &Path) -> Res<Vec<(String, String)>> {
        Ok(match self.resolve(root).await? {
            None => vec![],
            Some(a) => {
                let name = a["name"].as_str().unwrap_or("").to_string();
                let email = a["email"].as_str().unwrap_or("").to_string();
                vec![
                    ("GIT_AUTHOR_NAME".into(), name.clone()),
                    ("GIT_AUTHOR_EMAIL".into(), email.clone()),
                    ("GIT_COMMITTER_NAME".into(), name),
                    ("GIT_COMMITTER_EMAIL".into(), email),
                ]
            }
        })
    }
    /// Credential helper efêmero para fetch/pull/push: o token só existe no ambiente desse
    /// processo; `credential.helper` vazio descarta helpers do sistema (sem gravar o token).
    pub async fn credential_env(&self, root: &Path, remote: Option<&str>) -> Res<(Vec<(String, String)>, Option<Value>)> {
        let Some(account) = self.resolve(root).await? else {
            return Ok((vec![], None));
        };
        let id = account["id"].as_str().unwrap_or("");
        let Some(secret) = self.secrets.get(id)? else {
            return Ok((vec![], Some(account)));
        };
        let host = account["host"].as_str().unwrap_or("").to_string();
        if let Some(name) = remote {
            let url = git(root, &["remote", "get-url", "--push", "--", name]).await?;
            if remote_host(url.trim()).map(|(_, h)| h) != Some(host.clone()) {
                // Remoto de outro host ou SSH: o token da conta não se aplica.
                return Ok((vec![], Some(account)));
            }
        }
        let env = [
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "credential.helper"),
            ("GIT_CONFIG_VALUE_0", ""),
            ("GIT_CONFIG_KEY_1", "credential.helper"),
            ("GIT_CONFIG_VALUE_1", HELPER),
            ("PHPIDE_GIT_HOST", host.as_str()),
            ("PHPIDE_GIT_USER", account["login"].as_str().unwrap_or("")),
            ("PHPIDE_GIT_SECRET", secret.as_str()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let mut account = account;
        account["tokenUsed"] = json!(true);
        Ok((env, Some(account)))
    }
}

/// Mensagem recuperável quando o servidor recusa a credencial da conta. Para GitHub/GitLab
/// com token salvo vira o aviso de token expirado com a ação Use Token.
pub fn auth_error(error: String, account: Option<&Value>) -> String {
    let lower = error.to_lowercase();
    let auth = ["authentication failed", "401", "403", "could not read username", "invalid username or password", "access denied", "invalid username or token", "token expired", "bad credentials"]
        .iter()
        .any(|m| lower.contains(m));
    match (auth, account) {
        (true, Some(a)) if matches!(a["kind"].as_str(), Some("github" | "gitlab")) && a["tokenUsed"] == true => format!(
            "{}{}] O token da conta {} ({}) expirou ou foi revogado. Clique em Usar token para informar um novo.\n{}",
            TOKEN_REJECTED,
            a["id"].as_str().unwrap_or(""),
            a["login"].as_str().unwrap_or(""),
            a["host"].as_str().unwrap_or(""),
            error
        ),
        (true, Some(a)) => format!(
            "{}O servidor recusou a credencial da conta {} ({}). Atualize o token em Configurações → Contas Git ou escolha outra conta.\n{}",
            ACCOUNT_REQUIRED,
            a["login"].as_str().unwrap_or(""),
            a["host"].as_str().unwrap_or(""),
            error
        ),
        _ => error,
    }
}

impl Accounts {
    /// Confere o token novo de uma conta GitHub/GitLab na API antes de gravar e completa
    /// login, nome e e-mail vazios. Sem rede, só grava se os três campos foram preenchidos.
    async fn validated(&self, mut input: Value) -> Res<Value> {
        let kind = input["kind"].as_str().unwrap_or("").to_string();
        let secret = input["secret"].as_str().unwrap_or("").to_string();
        if !matches!(kind.as_str(), "github" | "gitlab") || secret.is_empty() {
            return Ok(input);
        }
        let default_host = if kind == "github" { "github.com" } else { "gitlab.com" };
        let host = Some(input["host"].as_str().unwrap_or("").trim().to_ascii_lowercase()).filter(|h| !h.is_empty()).unwrap_or(default_host.into());
        if !valid_host(&host) {
            return Err("Informe o host, por exemplo github.com ou git.empresa.com:8443".into());
        }
        let field = |v: &Value, k: &str| v[k].as_str().unwrap_or("").trim().to_string();
        match oauth::user(&self.oauth, &kind, &host, &secret).await {
            Ok(user) => {
                let login = field(&input, "login");
                if !login.is_empty() && !login.eq_ignore_ascii_case(&user.login) {
                    return Err(format!("O token pertence a {}, não a {}", user.login, login));
                }
                input["login"] = json!(user.login);
                if field(&input, "name").is_empty() {
                    input["name"] = json!(user.name);
                }
                if field(&input, "email").is_empty() {
                    input["email"] = json!(user.email);
                }
                Ok(input)
            }
            Err(e) if e.starts_with("Não foi possível falar") && ["login", "name", "email"].iter().all(|k| !field(&input, k).is_empty()) => Ok(input),
            Err(e) => Err(e),
        }
    }
    /// Grava o token do login pelo navegador: atualiza a conta do mesmo usuário ou cria outra.
    async fn store_login(&self, kind: &str, host: &str, token: String) -> Res<Value> {
        let user = oauth::user(&self.oauth, kind, host, &token).await?;
        let existing = self.load()?.into_iter().find(|a| a["host"] == host && a["login"].as_str().is_some_and(|l| l.eq_ignore_ascii_case(&user.login)));
        let input = match &existing {
            Some(a) => json!({"id":a["id"],"kind":a["kind"],"host":host,"login":a["login"],"name":a["name"],"email":a["email"],"secret":token}),
            None => json!({"kind":kind,"host":host,"login":user.login,"name":user.name,"email":user.email,"secret":token}),
        };
        let me = self.clone();
        let id = tokio::task::spawn_blocking(move || me.save(&input)).await.map_err(err)??;
        Ok(json!({"status":"done","id":id,"login":user.login,"updated":existing.is_some()}))
    }
    /// `gitAccountsLogin`: login pelo navegador (start/poll/cancel) e página Generate.
    async fn login(&self, input: &Value) -> Res<Value> {
        let kind = input["kind"].as_str().unwrap_or("github");
        let host = Some(input["host"].as_str().unwrap_or("").trim().to_ascii_lowercase()).filter(|h| !h.is_empty()).unwrap_or(if kind == "gitlab" { "gitlab.com".into() } else { "github.com".into() });
        if !valid_host(&host) {
            return Err("Host inválido".into());
        }
        match input["action"].as_str().unwrap_or("") {
            "start" => oauth::start(&self.oauth, kind, &host).await,
            "poll" => match oauth::poll(&self.oauth, s(&input["session"])?).await? {
                Poll::Pending(interval) => Ok(json!({"status":"pending","interval":interval})),
                Poll::Token { host, token } => self.store_login("github", &host, token).await,
            },
            "cancel" => oauth::cancel(s(&input["session"])?).map(|_| Value::Null),
            "reopen" => oauth::reopen(&self.oauth, s(&input["session"])?).map(|opened| json!({"opened":opened})),
            "generate" => {
                let url = oauth::token_page(&self.oauth, kind, &host)?;
                let opened = (self.oauth.browser)(&url).is_ok();
                Ok(json!({"url":url,"opened":opened}))
            }
            _ => Err("Ação de login desconhecida".into()),
        }
    }
}

/// Serviços `gitAccounts*`: gerenciam contas da IDE e a escolha do projeto aberto.
pub async fn dispatch(accounts: &Accounts, root: &Path, method: &str, args: &[Value]) -> Res<Value> {
    let a = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let repository = git(root, &["rev-parse", "--is-inside-work-tree"]).await.is_ok();
    let blocking = |f: Box<dyn FnOnce() -> Res<Value> + Send>| async move {
        tokio::task::spawn_blocking(f).await.map_err(err)?
    };
    match method {
        "gitAccounts" => {
            let me = accounts.clone();
            let list = blocking(Box::new(move || Ok(json!(me.list()?)))).await?;
            let project = if repository {
                accounts.project(root).await?
            } else {
                Value::Null
            };
            Ok(json!({"accounts":list,"project":project}))
        }
        "gitAccountsSave" => {
            let input = accounts.validated(a(0).clone()).await?;
            let me = accounts.clone();
            blocking(Box::new(move || me.save(&input))).await
        }
        "gitAccountsLogin" => accounts.login(a(0)).await,
        "gitAccountsRemove" => {
            let (me, id) = (accounts.clone(), s(a(0))?.to_string());
            blocking(Box::new(move || me.remove(&id).map(|_| Value::Null))).await
        }
        "gitAccountsDefault" => {
            let (me, id) = (accounts.clone(), s(a(0))?.to_string());
            blocking(Box::new(move || me.set_default(&id).map(|_| Value::Null))).await
        }
        "gitAccountsUse" => {
            if !repository {
                return Err("O projeto aberto não é um repositório Git".into());
            }
            accounts.bind(root, s(a(0))?).await?;
            accounts.project(root).await
        }
        _ => Err("Comando de contas Git desconhecido".into()),
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
