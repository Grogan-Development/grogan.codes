use api_types::{AiRunsOn, CiPolicy, DeployTarget, InboxKind};
use leptos::prelude::*;
use leptos_router::components::A;

use crate::components::{billing_label, load, provider_label};
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
    let filter = RwSignal::new(String::new());

    view! {
        <section class="page">
            <header class="page-head">
                <div>
                    <h1>"Repositories"</h1>
                    <p class="muted">
                        "Content-addressed source on S3. Protected refs move only through Gate-2 accept + atomic CAS."
                    </p>
                </div>
                <A href="/new" attr:class="button primary">"New repo"</A>
            </header>
            <div class="search wide" role="search">
                <input
                    type="search"
                    placeholder="Filter repos by name or description…"
                    aria-label="Filter repositories"
                    prop:value=move || filter.get()
                    on:input=move |event| filter.set(event_target_value(&event))
                />
            </div>
            {load(repos, move |repos| {
                let query = filter.get().to_lowercase();
                let visible: Vec<_> = repos
                    .into_iter()
                    .filter(|repo| {
                        query.is_empty()
                            || repo.id.name.to_lowercase().contains(&query)
                            || repo.description.to_lowercase().contains(&query)
                    })
                    .collect();
                if visible.is_empty() {
                    return view! { <p class="empty">"No repositories match."</p> }.into_any();
                }
                view! {
                    <ul class="list">
                        {visible
                            .into_iter()
                            .map(|repo| {
                                let languages = repo
                                    .languages
                                    .iter()
                                    .map(|l| format!("{} {}%", l.name, l.percent))
                                    .collect::<Vec<_>>()
                                    .join(" · ");
                                let ci = match repo.ci_policy {
                                    CiPolicy::LoomCi => "loom-ci.toml",
                                };
                                let deploy = match repo.deploy_target {
                                    DeployTarget::None => "no deploy target",
                                    DeployTarget::LocalApply => "local apply script",
                                };
                                view! {
                                    <li class="list-row repo-row">
                                        <div>
                                            <A href=repo.id.path() attr:class="row-title mono">
                                                {format!("{}/{}", repo.id.owner, repo.id.name)}
                                            </A>
                                            <p class="muted">{repo.description}</p>
                                            <p class="small muted mono">
                                                {format!(
                                                    "protected {} · CI {} · {} · graph @ {} exact {}%",
                                                    repo.protected_ref,
                                                    ci,
                                                    deploy,
                                                    repo.graph.revision,
                                                    repo.graph.exact_percent,
                                                )}
                                            </p>
                                        </div>
                                        <span class="muted small">{languages}</span>
                                        <span class="muted small">{format!("{} open CRs", repo.open_changes)}</span>
                                        <span class="muted small">{repo.updated}</span>
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
                "Two ways to pay for models: buy Grogan token credits (one balance routes to any "
                "provider below), or bring your own subscription, coding plan, or API key at $0 markup. "
                "Reviews, triage, DeepWiki maps and Spaces run on whichever you pick per agent."
            </p>
            {load(connections, |connections| {
                view! {
                    <ul class="list">
                        {connections
                            .into_iter()
                            .map(|c| {
                                let provider = provider_label(c.provider);
                                let place = match c.runs_on {
                                    AiRunsOn::ThisDevice => "Runs on this device with your login",
                                    AiRunsOn::UserSandbox => "Runs in an isolated sandbox",
                                };
                                view! {
                                    <li class="list-row">
                                        <span class="row-title">{provider}</span>
                                        <span class="badge cached">{billing_label(c.billing)}</span>
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
                    work uses Grogan credits or a key/plan you add here."
                </p>
            </Show>
            <div class="actions">
                <button class="button primary">"Buy token credits"</button>
                <button class="button">"Add API key / coding plan"</button>
                <button class="button" disabled=move || !local_ai()>"Connect local Claude Code"</button>
            </div>
            <p class="small muted" style="margin-top:10px">
                "Managed credits and BYO plans cover Anthropic, OpenAI, Gemini, Grok, Z.ai GLM, MiniMax, "
                "Xiaomi MiMo, DeepSeek, Kimi, Qwen and OpenRouter. Managed-credit runs record only "
                "provider/model/route + token usage as provenance — never your credential."
            </p>
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
