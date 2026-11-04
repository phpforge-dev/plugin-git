# Git plugin

Independent PHPForge workbench package, extracted from the MIT PHP IDE implementation. Requires IDE 0.2.13 and explicit project.read/workbench/process consent.

Owns feature UI, interaction workflows and rendering. The host currently brokers the declared operations in plugin.json. Feature-specific Rust implementation lives in `native/` and is pinned by the IDE as a statically linked library; it is not a dynamically unloadable backend. No Node runtime is used in the IDE.

Build and validate: `npm ci --ignore-scripts`, `npm test`, `npm run build`. Prebuilt browser assets are committed. Disable removes owned UI, listeners and polling. Native process access remains governed by host permissions.

## Native feature library

`native/` owns the git feature implementation and protocol/domain operations. The IDE pins this Rust crate by Git revision, retaining IPC authorization and lifecycle coordination. This library is statically linked; disabling the workbench removes access and UI rather than unloading native machine code. Filesystem operations use canonical confinement and optimistic write checks. Synthetic tests do not invoke real inference.

The process permission authorizes brokered native operations under the user account. Consent is required before activation; the workbench grant alone does not authorize process execution.

## GitHub/GitLab accounts

Settings → Git accounts → GitHub → + → *Entrar via GitHub…* uses the public OAuth device flow (RFC 8628): no client secret is embedded or needed. Register your own GitHub OAuth App with **Enable Device Flow** checked and provide its public client id either at build time (`PHPIDE_GITHUB_CLIENT_ID=… cargo build`) or at runtime (`PHP_IDE_GITHUB_CLIENT_ID`). Without it the browser login reports that it is not configured and *Entrar com token…* keeps working. Tokens go only to the OS keychain. GitHub Enterprise and GitLab use personal access tokens (*Gerar…* opens the token page with the required scopes).
