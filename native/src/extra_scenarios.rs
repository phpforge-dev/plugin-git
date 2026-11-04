//! Cenários com Git real em repositórios temporários: blame, changelists, linhas, Log, tags,
//! reset e worktrees. Nenhum teste toca repositórios do usuário.
use super::*;
use std::process::Command;

fn command(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8_lossy(&result.stdout).trim().to_string()
}
fn repo() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.name", "Ana Fixture"],
        &["config", "user.email", "ana@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        &["config", "tag.gpgsign", "false"],
        &["config", "core.autocrlf", "false"],
    ] {
        command(&root, args);
    }
    (dir, root)
}
fn commit_as(
    root: &Path,
    file: &str,
    text: &str,
    message: &str,
    author: &str,
    date: &str,
) -> String {
    fs::write(root.join(file), text).unwrap();
    command(root, &["add", "--", file]);
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["commit", "-qm", message, &format!("--author={}", author)])
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    command(root, &["rev-parse", "HEAD"])
}
fn commit(root: &Path, file: &str, text: &str, message: &str) -> String {
    commit_as(
        root,
        file,
        text,
        message,
        "Ana Fixture <ana@example.invalid>",
        "2026-10-01T10:00:00",
    )
}

#[tokio::test]
async fn blame_annotates_buffer_with_commit_details_and_uncommitted_lines() {
    let (_dir, root) = repo();
    let first = commit(&root, "a.php", "<?php\n$a = 1;\n", "Initial\n\nLonger body");
    let second = commit_as(
        &root,
        "a.php",
        "<?php\n$a = 2;\n",
        "Change value",
        "Bruno Dev <bruno@example.invalid>",
        "2026-10-05T12:00:00",
    );
    let result = dispatch(
        &root,
        "gitBlame",
        &[json!({"path":"a.php","text":"<?php\n$a = 2;\n// buffer\n","ignoreWhitespace":true})],
    )
    .await
    .unwrap();
    let lines = result["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["hash"], first.as_str());
    assert_eq!(lines[1]["hash"], second.as_str());
    let pending = lines[2]["hash"].as_str().unwrap();
    assert!(result["commits"][pending]["uncommitted"] == true);
    assert_eq!(
        result["commits"][&first]["message"],
        "Initial\n\nLonger body"
    );
    assert_eq!(result["commits"][&second]["author"], "Bruno Dev");
    assert_eq!(result["commits"][&second]["email"], "bruno@example.invalid");
    assert_eq!(
        result["commits"][&second]["previous"]["hash"],
        first.as_str()
    );
    // Annotate Previous Revision: anota a revisão anterior ao commit escolhido.
    let previous = dispatch(
        &root,
        "gitBlame",
        &[json!({"path":"a.php","revision":first})],
    )
    .await
    .unwrap();
    assert!(previous["lines"]
        .as_array()
        .unwrap()
        .iter()
        .all(|l| l["hash"] == first.as_str()));
    fs::write(root.join("new.php"), "x").unwrap();
    let error = dispatch(&root, "gitBlame", &[json!({"path":"new.php","text":"x"})])
        .await
        .unwrap_err();
    assert!(error.contains("não está no Git"), "{}", error);
    assert!(dispatch(
        &root,
        "gitBlame",
        &[json!({"path":"../escape.php","text":"x"})]
    )
    .await
    .is_err());
}
