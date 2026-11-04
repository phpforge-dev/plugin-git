//! Contas por projeto contra um remoto HTTP local: `git http-backend` atrás de Basic Auth,
//! contas falsas e cofre em memória (nunca o Keychain nem o GitHub reais).
use super::*;
use crate::feature::dispatch_with;
use std::process::Command;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn command(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
    assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
fn base64(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}
fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}
/// Servidor HTTP mínimo: exige `user:token` e repassa ao CGI `git http-backend`.
async fn serve(root: PathBuf, user: &'static str, token: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    let expected = format!("Basic {}", base64(format!("{}:{}", user, token).as_bytes()));
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (root, expected, log) = (root.clone(), expected.clone(), log.clone());
            tokio::spawn(async move {
                let mut buf = vec![];
                let mut chunk = [0u8; 65536];
                let head_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 { return; }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = find(&buf, b"\r\n\r\n") { break i; }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.lines();
                let request: Vec<&str> = lines.next().unwrap().split(' ').collect();
                let headers: HashMap<String, String> = lines
                    .filter_map(|l| l.split_once(':'))
                    .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                    .collect();
                let mut body = buf[head_end + 4..].to_vec();
                if let Some(len) = headers.get("content-length").map(|v| v.parse::<usize>().unwrap()) {
                    while body.len() < len {
                        let n = socket.read(&mut chunk).await.unwrap();
                        body.extend_from_slice(&chunk[..n]);
                    }
                } else if headers.get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
                    let mut raw = body;
                    body = vec![];
                    loop {
                        while find(&raw, b"\r\n").is_none() {
                            let n = socket.read(&mut chunk).await.unwrap();
                            raw.extend_from_slice(&chunk[..n]);
                        }
                        let i = find(&raw, b"\r\n").unwrap();
                        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..i]).trim(), 16).unwrap();
                        while raw.len() < i + 2 + size + 2 {
                            let n = socket.read(&mut chunk).await.unwrap();
                            raw.extend_from_slice(&chunk[..n]);
                        }
                        if size == 0 { break; }
                        body.extend_from_slice(&raw[i + 2..i + 2 + size]);
                        raw.drain(..i + 2 + size + 2);
                    }
                }
                let auth = headers.get("authorization").cloned().unwrap_or_default();
                log.lock().unwrap().push(auth.clone());
                if auth != expected {
                    let _ = socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"fixture\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }
                let (path, query) = request[1].split_once('?').unwrap_or((request[1], ""));
                let mut cgi = tokio::process::Command::new("git");
                cgi.arg("http-backend")
                    .env("GIT_PROJECT_ROOT", &root)
                    .env("GIT_HTTP_EXPORT_ALL", "1")
                    .env("REMOTE_USER", "fixture")
                    .env("REQUEST_METHOD", request[0])
                    .env("PATH_INFO", path)
                    .env("QUERY_STRING", query)
                    .env("CONTENT_TYPE", headers.get("content-type").cloned().unwrap_or_default())
                    .env("CONTENT_LENGTH", body.len().to_string())
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped());
                if let Some(enc) = headers.get("content-encoding") {
                    cgi.env("HTTP_CONTENT_ENCODING", enc);
                }
                if let Some(proto) = headers.get("git-protocol") {
                    cgi.env("GIT_PROTOCOL", proto);
                }
                let mut child = cgi.spawn().unwrap();
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(&body).await.unwrap();
                drop(stdin);
                let out = child.wait_with_output().await.unwrap().stdout;
                let split = find(&out, b"\r\n\r\n").map(|i| (i, 4)).or_else(|| find(&out, b"\n\n").map(|i| (i, 2))).unwrap();
                let cgi_head = String::from_utf8_lossy(&out[..split.0]).to_string();
                let payload = &out[split.0 + split.1..];
                let status = cgi_head.lines().find_map(|l| l.strip_prefix("Status: ")).unwrap_or("200 OK").to_string();
                let mut response = format!("HTTP/1.1 {}\r\n", status);
                for l in cgi_head.lines().filter(|l| !l.starts_with("Status:")) {
                    response.push_str(l.trim_end());
                    response.push_str("\r\n");
                }
                response.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", payload.len()));
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(payload).await;
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn project_account_sets_author_and_push_credential() {
    let state = tempfile::tempdir().unwrap();
    let served = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let served_root = served.path().canonicalize().unwrap();
    let root = work.path().canonicalize().unwrap();
    command(&served_root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    let (port, seen) = serve(served_root.clone(), "alice", "good-token").await;
    let host = format!("127.0.0.1:{}", port);
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "System User"],
        &["config", "user.email", "system@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        &["remote", "add", "origin", &format!("http://{}/remote.git", host)],
        &["config", "branch.main.remote", "origin"],
        &["config", "branch.main.merge", "refs/heads/main"],
    ] {
        command(&root, args);
    }
    let accounts = Accounts::new(state.path().join("git-accounts.json"), Arc::new(MemorySecrets::default()));
    let save = |login: &str, name: &str, secret: &str| {
        json!({"kind":"generic","host":host,"login":login,"name":name,"email":format!("{}@example.invalid",login),"secret":secret})
    };
    let alice = dispatch(&accounts, &root, "gitAccountsSave", &[save("alice", "Alice Fake", "good-token")]).await.unwrap();
    let bob = dispatch(&accounts, &root, "gitAccountsSave", &[save("bob", "Bob Fake", "wrong-token")]).await.unwrap();
    // Duplicata e e-mail inválido são recusados sem perder a lista.
    assert!(accounts.save(&save("alice", "Outra", "x")).is_err());
    assert!(accounts.save(&json!({"kind":"github","login":"x","name":"X","email":"sem-arroba"})).is_err());
    let listed = dispatch(&accounts, &root, "gitAccounts", &[]).await.unwrap();
    assert_eq!(listed["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(listed["accounts"][0]["default"], true, "primeira conta vira padrão");
    assert_eq!(listed["accounts"][1]["hasSecret"], true);
    assert!(listed["project"]["binding"].is_null());
    let stored = fs::read_to_string(state.path().join("git-accounts.json")).unwrap();
    assert!(!stored.contains("good-token") && !stored.contains("wrong-token"), "token nunca vai ao arquivo");
    dispatch(&accounts, &root, "gitAccountsDefault", &[bob.clone()]).await.unwrap();
    let listed = accounts.list().unwrap();
    assert_eq!(listed.iter().filter(|a| a["default"] == true).count(), 1);
    assert!(listed.iter().any(|a| a["id"] == bob && a["default"] == true));

    let commit = |message: &'static str| {
        let root = root.clone();
        let accounts = accounts.clone();
        async move {
            fs::write(root.join("file.txt"), message).unwrap();
            command(&root, &["add", "file.txt"]);
            let st = crate::feature::status(&root).await.unwrap();
            dispatch_with(&root, "gitCommit", &[json!(message), st["indexToken"].clone()], Some(&accounts)).await
        }
    };
    let push = || {
        let root = root.clone();
        let accounts = accounts.clone();
        async move {
            let st = crate::feature::status(&root).await.unwrap();
            dispatch_with(&root, "gitOperation", &[json!({"kind":"push","target":"","expectedHead":st["head"]})], Some(&accounts)).await
        }
    };
    // Sem conta escolhida no projeto: vale a conta padrão (✓ em Bob), sem bloquear o commit.
    commit("zero").await.unwrap();
    assert_eq!(command(&root, &["log", "-1", "--format=%an"]), "Bob Fake");
    dispatch(&accounts, &root, "gitAccountsUse", &[alice.clone()]).await.unwrap();
    commit("first").await.unwrap();
    assert_eq!(command(&root, &["log", "-1", "--format=%an <%ae>|%cn <%ce>"]), "Alice Fake <alice@example.invalid>|Alice Fake <alice@example.invalid>");
    push().await.unwrap();
    assert_eq!(command(&served_root.join("remote.git"), &["log", "-1", "--format=%s"]), "first");
    let alice_auth = format!("Basic {}", base64(b"alice:good-token"));
    assert!(seen.lock().unwrap().contains(&alice_auth), "push usou a credencial da conta");
    let config = fs::read_to_string(root.join(".git/config")).unwrap();
    assert!(!config.contains("good-token") && config.contains(alice.as_str().unwrap()));

    // Trocar para a conta com token inválido: autor muda e o push falha de forma recuperável.
    dispatch(&accounts, &root, "gitAccountsUse", &[bob.clone()]).await.unwrap();
    commit("second").await.unwrap();
    assert_eq!(command(&root, &["log", "-1", "--format=%an"]), "Bob Fake");
    let error = push().await.unwrap_err();
    assert!(error.starts_with(ACCOUNT_REQUIRED) && error.contains("bob"), "{}", error);
    assert_eq!(command(&served_root.join("remote.git"), &["log", "-1", "--format=%s"]), "first");
    // Corrigir o token da conta (sem reescrever o resto) resolve sem trocar de conta.
    let mut fixed = save("bob", "Bob Fake", "good-token");
    fixed["id"] = bob.clone();
    accounts.save(&fixed).unwrap();
    let error = push().await.unwrap_err();
    assert!(error.contains("bob"), "servidor aceita só alice: {}", error);

    // Conta removida: o projeto pede outra escolha, sem cair na identidade do sistema.
    dispatch(&accounts, &root, "gitAccountsUse", &[alice.clone()]).await.unwrap();
    dispatch(&accounts, &root, "gitAccountsRemove", &[alice.clone()]).await.unwrap();
    let project = dispatch(&accounts, &root, "gitAccounts", &[]).await.unwrap()["project"].clone();
    assert_eq!(project["missing"], true);
    let error = commit("third").await.unwrap_err();
    assert!(error.contains("removida"), "{}", error);
    assert!(dispatch(&accounts, &root, "gitAccountsUse", &[alice]).await.is_err());
    // Configuração do Git do sistema, escolhida explicitamente.
    dispatch(&accounts, &root, "gitAccountsUse", &[json!(SYSTEM)]).await.unwrap();
    commit("third").await.unwrap();
    assert_eq!(command(&root, &["log", "-1", "--format=%an"]), "System User");
}

#[tokio::test]
async fn accounts_without_repository_and_helper_scope() {
    let state = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let accounts = Accounts::new(state.path().join("nested/git-accounts.json"), Arc::new(MemorySecrets::default()));
    let empty = dispatch(&accounts, dir.path(), "gitAccounts", &[]).await.unwrap();
    assert!(empty["project"].is_null() && empty["accounts"].as_array().unwrap().is_empty());
    let id = accounts
        .save(&json!({"kind":"github","login":"octo","name":"Octo","email":"octo@example.invalid","secret":"t"}))
        .unwrap();
    assert_eq!(accounts.find(id.as_str().unwrap()).unwrap().unwrap()["host"], "github.com");
    assert!(dispatch(&accounts, dir.path(), "gitAccountsUse", &[id]).await.is_err());
    assert!(accounts.save(&json!({"kind":"svn","login":"a","name":"A","email":"a@b"})).is_err());
    assert!(accounts.save(&json!({"kind":"generic","host":"bad host","login":"a","name":"A","email":"a@b"})).is_err());
    assert_eq!(remote_host("https://GitHub.com/a/b.git").unwrap().1, "github.com");
    assert_eq!(remote_host("http://127.0.0.1:8080/r.git").unwrap().1, "127.0.0.1:8080");
    assert!(remote_host("git@github.com:a/b.git").is_none());
}
