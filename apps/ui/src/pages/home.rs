use api_types::{AiProvider, AiRunsOn, InboxKind};
use leptos::prelude::*;
use leptos_router::components::A;

use crate::components::load;
use crate::platform::{use_active_org, use_platform};

#[component]
pub fn Inbox() -> impl IntoView {
    let platform = use_platform();
    let org = use_active_org();
    let items = LocalResource::new(move || {
        let platform = platform.get();
        let org = org.get();
        async move { platform.inbox(org).await }
    });

    view! {
        <section class="page narrow">
            <header class="page-head">
                <h1>"Inbox"</h1>
                <A href="/repos" attr:class="button">"All repos"</A>
            </header>
            {load(items, |items| {
                if items.is_empty() {
                    return view! { <p class="empty">"Nothing needs you right now."</p> }.into_any();
                }
                view! {
                    <ul class="list">
                        {items
                            .into_iter()
                            .map(|item| {
                                let kind = match item.kind {
                                    InboxKind::ReviewRequested => "review",
                                    InboxKind::ChecksFailed => "failed",
                                    InboxKind::Mentioned => "mention",
                                    InboxKind::SpaceIdle => "space",
                                    InboxKind::FixReady => "fix ready",
                                };
                                view! {
                                    <li class="list-row" class:unread=item.unread>
                                        <span class="kind">{kind}</span>
                                        <A href=item.href attr:class="row-title">{item.title}</A>
                                        <span class="muted mono">
                                            {format!("{}/{}", item.repo.owner, item.repo.name)}
                                        </span>
                                        <span class="muted">{item.age}</span>
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                }
                .into_any()
            })}
        </section>
    }
}

#[component]
pub fn Repos() -> impl IntoView {
    let platform = use_platform();
    let org = use_active_org();
    let repos = LocalResource::new(move || {
        let platform = platform.get();
        let org = org.get();
        async move { platform.repos(org).await }
    });

    view! {
        <section class="page narrow">
            <header class="page-head">
                <h1>"Repositories"</h1>
                <A href="/new" attr:class="button primary">"New repo"</A>
            </header>
            {load(repos, |repos| {
                view! {
                    <ul class="list">
                        {repos
                            .into_iter()
                            .map(|repo| {
                                let languages = repo
                                    .languages
                                    .iter()
                                    .map(|l| format!("{} {}%", l.name, l.percent))
                                    .collect::<Vec<_>>()
                                    .join(" · ");
                                view! {
                                    <li class="list-row repo-row">
                                        <div>
                                            <A href=repo.id.path() attr:class="row-title mono">
                                                {format!("{}/{}", repo.id.owner, repo.id.name)}
                                            </A>
                                            <p class="muted">{repo.description}</p>
                                        </div>
                                        <span class="muted">{languages}</span>
                                        <span class="muted">{format!("{} open", repo.open_changes)}</span>
                                        <span class="muted">{repo.updated}</span>
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                }
            })}
        </section>
    }
}

#[component]
pub fn AiSettings() -> impl IntoView {
    let platform = use_platform();
    let connections = LocalResource::new(move || {
        let platform = platform.get();
        async move { platform.ai_connections().await }
    });
    let local_ai = move || platform.get().capabilities().local_ai;

    view! {
        <section class="page narrow">
            <header class="page-head">
                <h1>"AI connections"</h1>
            </header>
            <p class="lede">
                "Grogan Code doesn't resell model access. Connect the tools and keys you already
                pay for; reviews, triage and Fix this run on them."
            </p>
            {load(connections, |connections| {
                view! {
                    <ul class="list">
                        {connections
                            .into_iter()
                            .map(|c| {
                                let provider = match c.provider {
                                    AiProvider::ClaudeCode => "Claude Code",
                                    AiProvider::Codex => "Codex",
                                    AiProvider::AnthropicApiKey => "Anthropic API key",
                                };
                                let place = match c.runs_on {
                                    AiRunsOn::ThisDevice => "Runs on this device with your login",
                                    AiRunsOn::UserSandbox => "Runs in an isolated sandbox, billed to your key",
                                };
                                view! {
                                    <li class="list-row">
                                        <span class="row-title">{provider}</span>
                                        <span class="muted mono">{c.account}</span>
                                        <span class="muted">{place}</span>
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                }
            })}
            <Show when=move || !local_ai()>
                <p class="note">
                    "Claude Code on this device is available in the desktop app. In the browser, AI
                    work uses an API key you add here."
                </p>
            </Show>
            <div class="actions">
                <button class="button">"Add API key"</button>
                <button class="button" disabled=move || !local_ai()>"Connect local Claude Code"</button>
            </div>
        </section>
    }
}

#[component]
pub fn Login() -> impl IntoView {
    view! {
        <section class="login">
            <div class="login-card">
                <p class="wordmark">
                    <span class="wordmark-mark" aria-hidden="true">"g/"</span>
                    "Grogan Code"
                </p>
                <h1>"Sign in"</h1>
                <p class="muted">"Sign-in opens in your browser and returns here."</p>
                <A href="/" attr:class="button primary block">"Continue with passkey"</A>
                <A href="/" attr:class="button block">"Continue with Google"</A>
                <A href="/" attr:class="button block">"Continue with GitHub"</A>
                <p class="muted small">
                    "Signing in from the CLI? Run " <code>"grogan auth login"</code> "."
                </p>
            </div>
        </section>
    }
}

#[component]
pub fn NotFound() -> impl IntoView {
    view! {
        <section class="page narrow">
            <h1>"Not found"</h1>
            <p class="muted">"It doesn't exist, or you don't have access to it."</p>
            <A href="/" attr:class="button">"Back to inbox"</A>
        </section>
    }
}
