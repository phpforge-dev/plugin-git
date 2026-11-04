//! Login pelo navegador e validação de tokens das contas GitHub/GitLab.
//!
//! GitHub usa o OAuth device flow documentado (RFC 8628), que não precisa de segredo de
//! cliente: o client id do OAuth App é configuração pública (`PHP_IDE_GITHUB_CLIENT_ID` em
//! tempo de execução ou `PHPIDE_GITHUB_CLIENT_ID` na compilação). O `device_code` fica só
//! neste processo e o token vai direto para o cofre do sistema; a interface recebe apenas
//! o código a digitar no navegador e o id da conta criada.
use crate::workspace::{err, Res};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Escopos clássicos pedidos pela documentação de contas GitHub da JetBrains.
pub const GITHUB_SCOPES: &str = "repo gist read:org workflow read:user user:email";
/// Escopos do token pessoal GitLab citados na mesma documentação.
pub const GITLAB_SCOPES: &str = "api,read_user";
const TOKEN_NAME: &str = "PHP IDE";
const MAX_BODY: usize = 1 << 20;
const MAX_PENDING: usize = 4;

pub type Browser = Arc<dyn Fn(&str) -> Res<()> + Send + Sync>;

/// Endereços do provedor. `web` recebe o login e a página de tokens; `api` a REST API.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub web: String,
    pub api: String,
}

/// Configuração de login: client id público, endereços de teste e como abrir o navegador.
#[derive(Clone)]
pub struct OAuth {
    pub github_client_id: Option<String>,
    /// Substitui os endereços reais (só servidores locais, para testes com servidor falso).
    pub endpoints: Option<Endpoints>,
    pub browser: Browser,
}

fn loopback(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|u| {
        u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost"))
    })
}

impl OAuth {
    /// Configuração do processo da IDE. Endereços alternativos só valem para loopback.
    pub fn system() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let github_client_id = env("PHP_IDE_GITHUB_CLIENT_ID")
            .or_else(|| option_env!("PHPIDE_GITHUB_CLIENT_ID").map(str::to_string))
            .filter(|v| !v.trim().is_empty());
        let endpoints = match (env("PHP_IDE_GIT_OAUTH_WEB"), env("PHP_IDE_GIT_OAUTH_API")) {
            (Some(web), Some(api)) if loopback(&web) && loopback(&api) => Some(Endpoints { web, api }),
            _ => None,
        };
        let browser: Browser = if env("PHP_IDE_GIT_BROWSER").as_deref() == Some("none") {
            Arc::new(|_| Err("navegador desativado".into()))
        } else {
            Arc::new(open_browser)
        };
        Self { github_client_id, endpoints, browser }
    }
    fn endpoints(&self, kind: &str, host: &str) -> Endpoints {
        if let Some(e) = &self.endpoints {
            return e.clone();
        }
        let web = format!("https://{}", host);
        let api = match (kind, host) {
            ("github", "github.com") => "https://api.github.com".to_string(),
            ("github", _) => format!("{}/api/v3", web),
            _ => format!("{}/api/v4", web),
        };
        Endpoints { web, api }
    }
}

/// Abre a URL no navegador padrão sem passar por um shell.
pub fn open_browser(url: &str) -> Res<()> {
    let parsed = url::Url::parse(url).map_err(err)?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Endereço inválido".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(parsed.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Não foi possível abrir o navegador: {}", e))
}

fn client() -> Res<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("PHP-IDE-Git")
        .build()
        .map_err(err)
}

async fn body(response: reqwest::Response) -> Res<(u16, Value)> {
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(network)?;
    if bytes.len() > MAX_BODY {
        return Err("Resposta do servidor grande demais".into());
    }
    Ok((status, serde_json::from_slice(&bytes).unwrap_or(Value::Null)))
}

fn network(e: reqwest::Error) -> String {
    // Sem a URL nem cabeçalhos: só o tipo de falha.
    let what = if e.is_timeout() {
        "tempo esgotado"
    } else if e.is_connect() {
        "sem conexão"
    } else {
        "falha de rede"
    };
    format!("Não foi possível falar com o servidor ({})", what)
}

fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

/// Usuário dono do token, como a REST API responde.
#[derive(Debug, Clone, PartialEq)]
pub struct User {
    pub login: String,
    pub name: String,
    pub email: String,
}

/// Erro marcado quando o servidor recusa o token (expirado, revogado ou inválido).
pub const REJECTED: &str = "Token inválido, expirado ou revogado";

/// Consulta o usuário do token. `Err(REJECTED…)` para 401; outros erros são de rede/servidor.
pub async fn user(oauth: &OAuth, kind: &str, host: &str, token: &str) -> Res<User> {
    let e = oauth.endpoints(kind, host);
    let http = client()?;
    let get = |path: &str| {
        http.get(format!("{}{}", e.api, path))
            .bearer_auth(token)
            .header("Accept", if kind == "github" { "application/vnd.github+json" } else { "application/json" })
            .send()
    };
    let (status, me) = body(get("/user").await.map_err(network)?).await?;
    match status {
        200 => {}
        401 => return Err(format!("{}. Gere um novo token e tente de novo.", REJECTED)),
        403 => return Err("O servidor recusou o token: faltam permissões para ler o usuário (read:user/read_user)".into()),
        _ => return Err(format!("O servidor respondeu {} ao validar o token", status)),
    }
    let field = |k: &str| me[k].as_str().unwrap_or("").trim().to_string();
    let login = field(if kind == "github" { "login" } else { "username" });
    if login.is_empty() {
        return Err("Resposta do servidor sem o usuário do token".into());
    }
    let name = Some(field("name")).filter(|v| !v.is_empty()).unwrap_or_else(|| login.clone());
    let mut email = if kind == "github" { field("email") } else { Some(field("commit_email")).filter(|v| !v.is_empty()).unwrap_or_else(|| field("email")) };
    if kind == "github" && email.is_empty() {
        // Com user:email a API lista os e-mails; sem eles, o endereço noreply do GitHub.
        if let Ok(response) = get("/user/emails").await {
            if let Ok((200, Value::Array(list))) = body(response).await {
                if let Some(primary) = list.iter().find(|m| m["primary"] == true && m["verified"] == true) {
                    email = primary["email"].as_str().unwrap_or("").to_string();
                }
            }
        }
        if email.is_empty() {
            email = match me["id"].as_u64() {
                Some(id) => format!("{}+{}@users.noreply.{}", id, login, host),
                None => format!("{}@users.noreply.{}", login, host),
            };
        }
    }
    Ok(User { login, name, email })
}

/// Página do provedor para gerar um token com os escopos certos (botão Generate).
pub fn token_page(oauth: &OAuth, kind: &str, host: &str) -> Res<String> {
    let web = oauth.endpoints(kind, host).web;
    match kind {
        "github" => Ok(format!(
            "{}/settings/tokens/new?{}",
            web,
            form(&[("description", TOKEN_NAME), ("scopes", &GITHUB_SCOPES.replace(' ', ","))])
        )),
        "gitlab" => Ok(format!(
            "{}/-/user_settings/personal_access_tokens?{}",
            web,
            form(&[("name", TOKEN_NAME), ("scopes", GITLAB_SCOPES)])
        )),
        _ => Err("Gerar token só está disponível para GitHub e GitLab".into()),
    }
}

struct Pending {
    host: String,
    verification: String,
    device_code: String,
    interval: u64,
    next: Instant,
    expires: Instant,
}
static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);

fn pending<T>(f: impl FnOnce(&mut HashMap<String, Pending>) -> T) -> Res<T> {
    let mut guard = PENDING.lock().map_err(err)?;
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    map.retain(|_, p| p.expires > now);
    Ok(f(map))
}

/// Inicia o login: pede o código ao GitHub e abre a página de verificação no navegador.
pub async fn start(oauth: &OAuth, kind: &str, host: &str) -> Res<Value> {
    if kind != "github" {
        return Err("Login pelo navegador só está disponível para GitHub. Use Entrar com token.".into());
    }
    if host != "github.com" && oauth.endpoints.is_none() {
        return Err("Login pelo navegador só está disponível para github.com. Para GitHub Enterprise, use Entrar com token.".into());
    }
    let Some(client_id) = oauth.github_client_id.clone() else {
        return Err("Login pelo navegador não configurado: falta o client id público do OAuth App do GitHub (PHP_IDE_GITHUB_CLIENT_ID). Use Entrar com token.".into());
    };
    let e = oauth.endpoints(kind, host);
    let response = client()?
        .post(format!("{}/login/device/code", e.web))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(&[("client_id", &client_id), ("scope", GITHUB_SCOPES)]))
        .send()
        .await
        .map_err(network)?;
    let (status, v) = body(response).await?;
    if status != 200 || v["error"].is_string() {
        return Err(match v["error"].as_str() {
            Some("device_flow_disabled") => "O OAuth App configurado não tem o Device Flow habilitado.".into(),
            Some("incorrect_client_credentials") => "O client id do OAuth App do GitHub não é válido.".into(),
            _ => format!("O GitHub recusou o início do login ({})", status),
        });
    }
    let text = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let (device_code, user_code, verification) = (text("device_code"), text("user_code"), text("verification_uri"));
    let interval = v["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    let expires_in = v["expires_in"].as_u64().unwrap_or(900).clamp(30, 1800);
    let same_site = url::Url::parse(&verification).ok().zip(url::Url::parse(&e.web).ok()).is_some_and(|(a, b)| {
        a.host_str() == b.host_str() && (a.scheme() == "https" || loopback(&verification))
    });
    if device_code.is_empty() || user_code.is_empty() || user_code.len() > 32 || !same_site {
        return Err("Resposta inesperada do GitHub ao iniciar o login".into());
    }
    let session = uuid::Uuid::new_v4().to_string();
    let now = Instant::now();
    pending(|map| {
        if map.len() >= MAX_PENDING {
            return Err("Há logins demais em andamento; cancele um deles".to_string());
        }
        map.insert(session.clone(), Pending {
            host: host.to_string(),
            verification: verification.clone(),
            device_code,
            interval,
            next: now + Duration::from_secs(interval),
            expires: now + Duration::from_secs(expires_in),
        });
        Ok(())
    })??;
    let opened = (oauth.browser)(&verification).is_ok();
    Ok(json!({"session":session,"userCode":user_code,"verificationUri":verification,"interval":interval,"expiresIn":expires_in,"opened":opened}))
}

/// Resultado de uma consulta ao login em andamento.
pub enum Poll {
    Pending(u64),
    Token { host: String, token: String },
}

/// Uma consulta ao GitHub, respeitando o intervalo pedido pelo servidor.
pub async fn poll(oauth: &OAuth, session: &str) -> Res<Poll> {
    let Some(client_id) = oauth.github_client_id.clone() else {
        return Err("Login pelo navegador não configurado".into());
    };
    let (host, device_code, wait) = pending(|map| {
        map.get(session).map(|p| (p.host.clone(), p.device_code.clone(), p.next.saturating_duration_since(Instant::now())))
    })?
    .ok_or("O código de login expirou ou foi cancelado. Tente novamente.")?;
    if !wait.is_zero() {
        return Ok(Poll::Pending(wait.as_secs().max(1)));
    }
    let e = oauth.endpoints("github", &host);
    let response = client()?
        .post(format!("{}/login/oauth/access_token", e.web))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(&[
            ("client_id", &client_id),
            ("device_code", &device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ]))
        .send()
        .await
        .map_err(network)?;
    let (_, v) = body(response).await?;
    let reschedule = |extra: u64| {
        pending(|map| {
            map.get_mut(session).map(|p| {
                p.interval = (p.interval + extra).min(60);
                p.next = Instant::now() + Duration::from_secs(p.interval);
                p.interval
            })
        })
    };
    let done = || pending(|map| map.remove(session));
    if let Some(token) = v["access_token"].as_str().filter(|t| !t.is_empty() && t.len() <= 8192 && !t.contains(['\r', '\n', '\0'])) {
        done()?;
        return Ok(Poll::Token { host, token: token.to_string() });
    }
    match v["error"].as_str() {
        Some("authorization_pending") => Ok(Poll::Pending(reschedule(0)?.unwrap_or(5))),
        Some("slow_down") => Ok(Poll::Pending(reschedule(5)?.unwrap_or(10))),
        Some("expired_token") | Some("incorrect_device_code") => {
            done()?;
            Err("O código de login expirou. Tente novamente.".into())
        }
        Some("access_denied") => {
            done()?;
            Err("O login foi cancelado no navegador.".into())
        }
        _ => {
            done()?;
            Err("O GitHub recusou o login. Tente novamente.".into())
        }
    }
}

/// Abre de novo a página de verificação do login em andamento.
pub fn reopen(oauth: &OAuth, session: &str) -> Res<bool> {
    let url = pending(|map| map.get(session).map(|p| p.verification.clone()))?
        .ok_or("O código de login expirou ou foi cancelado. Tente novamente.")?;
    Ok((oauth.browser)(&url).is_ok())
}

pub fn cancel(session: &str) -> Res<()> {
    pending(|map| {
        map.remove(session);
    })
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
pub(crate) mod tests;
