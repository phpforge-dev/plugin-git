//! Login pelo navegador contra um servidor OAuth/REST falso em 127.0.0.1: nenhuma conta,
//! client id ou token real; o cofre é só memória e o navegador é registrado, não aberto.
use super::*;
use crate::accounts::{dispatch, Accounts, MemorySecrets, Secrets};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub(crate) const CLIENT: &str = "fake-client-id";
/// Tokens aceitos pela API falsa e o usuário de cada um.
pub(crate) const USERS: [(&str, &str, &str); 3] = [
    ("gho_device", "octocat", "Mona Lisa"),
    ("good-token", "alice", "Alice Fake"),
    ("glpat-good", "gitlab-user", "GitLab User"),
];

#[derive(Default)]
pub(crate) struct Fake {
    pub log: Mutex<Vec<String>>,
    polls: AtomicUsize,
    /// Respostas do endpoint de token, na ordem; vazio = token emitido.
    pub script: Mutex<Vec<&'static str>>,
}

fn reply(status: &str, body: &str) -> String {
    format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body)
}

/// Servidor HTTP mínimo com o device flow do GitHub e `/user` do GitHub e do GitLab.
pub(crate) async fn fake_provider() -> (String, Arc<Fake>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let fake = Arc::new(Fake::default());
    let (state, verification) = (fake.clone(), format!("{}/login/device", base));
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (state, verification) = (state.clone(), verification.clone());
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut chunk = [0u8; 8192];
                let head_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                    .unwrap_or(0);
                while buf.len() < head_end + 4 + len {
                    let n = socket.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end + 4..]).to_string();
                let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
                let line = head.lines().next().unwrap().to_string();
                let bearer = head
                    .lines()
                    .find_map(|l| l.strip_prefix("authorization: Bearer ").or_else(|| l.strip_prefix("Authorization: Bearer ")))
                    .unwrap_or("")
                    .to_string();
                state.log.lock().unwrap().push(line.clone());
                let path = line.split(' ').nth(1).unwrap_or("");
                let response = match path {
                    "/login/device/code" => {
                        if form.get("client_id").map(String::as_str) != Some(CLIENT) {
                            reply("200 OK", r#"{"error":"incorrect_client_credentials"}"#)
                        } else {
                            assert_eq!(form["scope"], GITHUB_SCOPES);
                            reply("200 OK", &json!({"device_code":"device-secret","user_code":"WDJB-MJHT","verification_uri":verification,"expires_in":900,"interval":1}).to_string())
                        }
                    }
                    "/login/oauth/access_token" => {
                        assert_eq!(form["device_code"], "device-secret");
                        assert_eq!(form["grant_type"], "urn:ietf:params:oauth:grant-type:device_code");
                        assert!(!form.contains_key("client_secret"), "device flow sem segredo");
                        state.polls.fetch_add(1, Ordering::SeqCst);
                        let next = { let mut s = state.script.lock().unwrap(); if s.is_empty() { None } else { Some(s.remove(0)) } };
                        match next {
                            Some(error) => reply("200 OK", &json!({"error":error}).to_string()),
                            None => reply("200 OK", r#"{"access_token":"gho_device","token_type":"bearer","scope":"repo,gist"}"#),
                        }
                    }
                    "/user" | "/user/emails" => match USERS.iter().find(|(t, _, _)| *t == bearer) {
                        None => reply("401 Unauthorized", r#"{"message":"Bad credentials"}"#),
                        Some((_, login, name)) if path == "/user" => {
                            if login.starts_with("gitlab") {
                                reply("200 OK", &json!({"username":login,"name":name,"email":"gl@example.invalid","commit_email":"commits@example.invalid"}).to_string())
                            } else {
                                reply("200 OK", &json!({"login":login,"id":583231,"name":name,"email":null}).to_string())
                            }
                        }
                        Some((_, login, _)) if *login == "octocat" => reply("200 OK", r#"[{"email":"old@example.invalid","primary":false,"verified":true},{"email":"mona@example.invalid","primary":true,"verified":true}]"#),
                        Some(_) => reply("404 Not Found", "[]"),
                    },
                    _ => reply("404 Not Found", "{}"),
                };
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (base, fake)
}

pub(crate) fn fake_oauth(base: &str, opened: Arc<Mutex<Vec<String>>>) -> OAuth {
    OAuth {
        github_client_id: Some(CLIENT.into()),
        endpoints: Some(Endpoints { web: base.into(), api: base.into() }),
        browser: Arc::new(move |url| {
            opened.lock().unwrap().push(url.to_string());
            Ok(())
        }),
    }
}

async fn wait_poll(accounts: &Accounts, root: &std::path::Path, session: &Value) -> Res<Value> {
    for _ in 0..20 {
        let v = dispatch(accounts, root, "gitAccountsLogin", &[json!({"action":"poll","session":session})]).await?;
        if v["status"] != "pending" {
            return Ok(v);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    panic!("login não terminou");
}

#[tokio::test]
async fn github_device_flow_stores_token_only_in_secrets() {
    let (base, fake) = fake_provider().await;
    let state = tempfile::tempdir().unwrap();
    let root = state.path().canonicalize().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let opened = Arc::new(Mutex::new(vec![]));
    let accounts = Accounts::new(state.path().join("git-accounts.json"), secrets.clone()).with_oauth(fake_oauth(&base, opened.clone()));
    let login = |v: Value| {
        let (accounts, root) = (accounts.clone(), root.clone());
        async move { dispatch(&accounts, &root, "gitAccountsLogin", &[v]).await }
    };

    // Início: código para digitar, navegador aberto na página de verificação do mesmo host.
    let started = login(json!({"action":"start","kind":"github","host":"github.com"})).await.unwrap();
    assert_eq!(started["userCode"], "WDJB-MJHT");
    assert_eq!(started["opened"], true);
    assert_eq!(opened.lock().unwrap().as_slice(), [format!("{}/login/device", base)]);
    assert!(started.get("device_code").is_none() && !started.to_string().contains("device-secret"), "device_code fica no processo nativo");
    assert_eq!(login(json!({"action":"reopen","session":started["session"]})).await.unwrap()["opened"], true);
    assert_eq!(opened.lock().unwrap().len(), 2, "Abrir navegador de novo");
    // Consultar antes do intervalo não chama o servidor.
    let early = login(json!({"action":"poll","session":started["session"]})).await.unwrap();
    assert_eq!(early["status"], "pending");
    assert_eq!(fake.polls.load(Ordering::SeqCst), 0);
    // Pendente uma vez, depois o token: conta criada com login, nome e e-mail primário.
    fake.script.lock().unwrap().push("authorization_pending");
    let done = wait_poll(&accounts, &root, &started["session"]).await.unwrap();
    assert_eq!(done["status"], "done");
    assert_eq!(done["login"], "octocat");
    assert_eq!(fake.polls.load(Ordering::SeqCst), 2);
    let id = done["id"].as_str().unwrap().to_string();
    let account = accounts.find(&id).unwrap().unwrap();
    assert_eq!((account["kind"].as_str(), account["host"].as_str(), account["name"].as_str(), account["email"].as_str()), (Some("github"), Some("github.com"), Some("Mona Lisa"), Some("mona@example.invalid")));
    assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("gho_device"));
    assert!(!done.to_string().contains("gho_device"), "token não volta para a interface");
    let stored = std::fs::read_to_string(state.path().join("git-accounts.json")).unwrap();
    assert!(!stored.contains("gho_device") && !stored.contains("device-secret"));
    // A sessão acabou.
    assert!(login(json!({"action":"poll","session":started["session"]})).await.unwrap_err().contains("expirou"));

    // Logar de novo com o mesmo usuário atualiza a conta (não duplica).
    secrets.set(&id, "old").unwrap();
    let again = login(json!({"action":"start","kind":"github"})).await.unwrap();
    let done = wait_poll(&accounts, &root, &again["session"]).await.unwrap();
    assert_eq!((done["id"].as_str(), done["updated"].as_bool()), (Some(id.as_str()), Some(true)));
    assert_eq!(accounts.list().unwrap().len(), 1);
    assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("gho_device"));

    // Negado no navegador e código expirado: erros recuperáveis que encerram a sessão.
    for (error, text) in [("access_denied", "cancelado"), ("expired_token", "expirou")] {
        let s = login(json!({"action":"start","kind":"github"})).await.unwrap();
        fake.script.lock().unwrap().push(error);
        let e = wait_poll(&accounts, &root, &s["session"]).await.unwrap_err();
        assert!(e.contains(text), "{}", e);
    }
    // slow_down aumenta o intervalo em 5 s.
    let s = login(json!({"action":"start","kind":"github"})).await.unwrap();
    fake.script.lock().unwrap().push("slow_down");
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let slow = login(json!({"action":"poll","session":s["session"]})).await.unwrap();
    assert_eq!((slow["status"].as_str(), slow["interval"].as_u64()), (Some("pending"), Some(6)));
    // Cancelar descarta a sessão.
    login(json!({"action":"cancel","session":s["session"]})).await.unwrap();
    assert!(login(json!({"action":"poll","session":s["session"]})).await.is_err());
    assert!(!fake.log.lock().unwrap().iter().any(|l| l.contains("gho_") || l.contains("device-secret")), "segredos nunca na URL");
}

#[tokio::test]
async fn login_configuration_and_generate_pages() {
    let (base, _fake) = fake_provider().await;
    let state = tempfile::tempdir().unwrap();
    let root = state.path().canonicalize().unwrap();
    let opened = Arc::new(Mutex::new(vec![]));
    let mut oauth = fake_oauth(&base, opened.clone());
    let accounts = Accounts::new(state.path().join("a.json"), Arc::new(MemorySecrets::default())).with_oauth(oauth.clone());
    let login = |accounts: &Accounts, v: Value| {
        let (accounts, root) = (accounts.clone(), root.clone());
        async move { dispatch(&accounts, &root, "gitAccountsLogin", &[v]).await }
    };
    // GitLab: a documentação só descreve token; o login pelo navegador é recusado com orientação.
    assert!(login(&accounts, json!({"action":"start","kind":"gitlab"})).await.unwrap_err().contains("Entrar com token"));
    // Generate abre a página de token com os escopos documentados.
    let gh = login(&accounts, json!({"action":"generate","kind":"github","host":"github.com"})).await.unwrap();
    assert_eq!(gh["url"], format!("{}/settings/tokens/new?description=PHP+IDE&scopes=repo%2Cgist%2Cread%3Aorg%2Cworkflow%2Cread%3Auser%2Cuser%3Aemail", base));
    let gl = login(&accounts, json!({"action":"generate","kind":"gitlab"})).await.unwrap();
    assert_eq!(gl["url"], format!("{}/-/user_settings/personal_access_tokens?name=PHP+IDE&scopes=api%2Cread_user", base));
    assert_eq!(opened.lock().unwrap().len(), 2);
    assert!(login(&accounts, json!({"action":"generate","kind":"bitbucket"})).await.is_err());
    // Endereços reais: github.com usa a API pública; GitHub Enterprise e GitLab, a API do host.
    let real = OAuth { endpoints: None, ..oauth.clone() };
    assert_eq!(token_page(&real, "gitlab", "git.empresa.com").unwrap().split('?').next(), Some("https://git.empresa.com/-/user_settings/personal_access_tokens"));
    assert_eq!(real.endpoints("github", "github.com").api, "https://api.github.com");
    assert_eq!(real.endpoints("github", "ghe.empresa.com").api, "https://ghe.empresa.com/api/v3");
    assert_eq!(real.endpoints("gitlab", "gitlab.com").api, "https://gitlab.com/api/v4");
    let enterprise = Accounts::new(state.path().join("b.json"), Arc::new(MemorySecrets::default())).with_oauth(real);
    assert!(login(&enterprise, json!({"action":"start","kind":"github","host":"ghe.empresa.com"})).await.unwrap_err().contains("Enterprise"));
    // Sem client id configurado: mensagem que leva ao token, sem chamar o servidor.
    oauth.github_client_id = None;
    let unconfigured = Accounts::new(state.path().join("c.json"), Arc::new(MemorySecrets::default())).with_oauth(oauth);
    assert!(login(&unconfigured, json!({"action":"start","kind":"github"})).await.unwrap_err().contains("client id"));
    // Client id errado: o servidor recusa.
    let wrong = OAuth { github_client_id: Some("other".into()), ..fake_oauth(&base, opened) };
    let wrong = Accounts::new(state.path().join("d.json"), Arc::new(MemorySecrets::default())).with_oauth(wrong);
    assert!(login(&wrong, json!({"action":"start","kind":"github"})).await.unwrap_err().contains("client id"));
    // Só loopback substitui os endereços pelo ambiente.
    assert!(loopback("http://127.0.0.1:9") && !loopback("https://127.0.0.1:9") && !loopback("http://evil.example"));
}

#[tokio::test]
async fn token_login_is_validated_and_completed_by_the_api() {
    let (base, _fake) = fake_provider().await;
    let state = tempfile::tempdir().unwrap();
    let root = state.path().canonicalize().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    let accounts = Accounts::new(state.path().join("a.json"), secrets.clone()).with_oauth(fake_oauth(&base, Default::default()));
    let save = |v: Value| {
        let (accounts, root) = (accounts.clone(), root.clone());
        async move { dispatch(&accounts, &root, "gitAccountsSave", &[v]).await }
    };
    // Token recusado (401): nada é gravado.
    let e = save(json!({"kind":"github","login":"","name":"","email":"","secret":"expired"})).await.unwrap_err();
    assert!(e.contains(REJECTED), "{}", e);
    assert!(accounts.list().unwrap().is_empty() && secrets.get("x").unwrap().is_none());
    // Só o token: login, nome e e-mail vêm da API (noreply quando a API não lista e-mails).
    let id = save(json!({"kind":"github","login":"","name":"","email":"","secret":"good-token"})).await.unwrap();
    let a = accounts.find(id.as_str().unwrap()).unwrap().unwrap();
    assert_eq!((a["login"].as_str(), a["name"].as_str(), a["email"].as_str()), (Some("alice"), Some("Alice Fake"), Some("583231+alice@users.noreply.github.com")));
    // Login informado diferente do dono do token.
    assert!(save(json!({"kind":"github","host":"ghe.test","login":"bob","name":"B","email":"b@x.y","secret":"good-token"})).await.unwrap_err().contains("pertence a alice"));
    // GitLab: username e commit_email.
    let id = save(json!({"kind":"gitlab","login":"","name":"","email":"","secret":"glpat-good"})).await.unwrap();
    let a = accounts.find(id.as_str().unwrap()).unwrap().unwrap();
    assert_eq!((a["login"].as_str(), a["email"].as_str()), (Some("gitlab-user"), Some("commits@example.invalid")));
    // Editar sem token novo não consulta a API.
    let mut edit = a.clone();
    edit["name"] = json!("Renomeado");
    edit["secret"] = json!("");
    save(edit).await.unwrap();
    assert_eq!(secrets.get(id.as_str().unwrap()).unwrap().as_deref(), Some("glpat-good"));
}
