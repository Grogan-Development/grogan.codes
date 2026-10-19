use api_types::{EntryKind, RepoRef};
use leptos::prelude::*;
use leptos_router::{
    components::{A, Outlet},
    hooks::use_params_map,
};

use crate::components::{ChangeBadge, CheckBadge, load};
use crate::platform::use_platform;

#[must_use]
pub fn use_repo_ref() -> Memo<RepoRef> {
    let params = use_params_map();
    Memo::new(move |_| {
        let params = params.get();
        RepoRef::new(
            &params.get("owner").unwrap_or_default(),
            &params.get("repo").unwrap_or_default(),
        )
    })
}

#[component]
pub fn RepoLayout() -> impl IntoView {
    let repo = use_repo_ref();
    let base = move || repo.get().path();
    let tab = move |suffix: &'static str| move || format!("{}{suffix}", base());

    view! {
        <div class="repo">
            <header class="repo-head">
                <p class="repo-title mono">
                    <A href="/repos" attr:class="muted">{move || repo.get().owner}</A>
                    " / "
                    <A href=base attr:class="strong">{move || repo.get().name}</A>
                    <span class="badge neutral">"private"</span>
                </p>
                <nav class="tabs" aria-label="Repository">
                    <A href=base exact=true>"Code"</A>
                    <A href=tab("/changes")>"Change requests"</A>
                    <A href=tab("/graph")>"Search & graph"</A>
                    <A href=tab("/ask")>"Ask"</A>
                    <A href=tab("/builds/b-c3d07f1")>"Build"</A>
                    <A href=tab("/spaces")>"Spaces"</A>
                    <A href=tab("/settings")>"Settings"</A>
                </nav>
            </header>
            <Outlet/>
        </div>
    }
}

#[component]
pub fn RepoCode() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let home = LocalResource::new(move || {
        let platform = platform.get();
        let repo = repo.get();
        async move { platform.repo_home(repo).await }
    });

    view! {
        <section class="page">
            {load(home, |home| {
                let base = home.repo.id.path();
                let languages = home
                    .repo
                    .languages
                    .iter()
                    .map(|l| format!("{} {}%", l.name, l.percent))
                    .collect::<Vec<_>>()
                    .join(" · ");
                let graph = home.repo.graph.clone();
                view! {
                    <div class="repo-grid">
                        <div class="repo-main">
                            <div class="toolbar">
                                <button class="button mono">{format!("⎇ {} ▾", home.repo.default_branch)}</button>
                                <span class="muted">
                                    {format!("{} branches · {} tags", home.repo.branches, home.repo.tags)}
                                </span>
                                <span class="spacer"></span>
                                <button class="button">"Go to file"</button>
                                <button class="button primary">"Clone ▾"</button>
                            </div>
                            <div class="commit-row">
                                <span class="strong">{home.head.author}</span>
                                <span class="commit-msg">{home.head.message}</span>
                                <span class="mono muted">{home.head.oid}</span>
                                <CheckBadge state=home.head.checks/>
                                <span class="muted">{home.head.age}</span>
                            </div>
                            <ul class="tree">
                                {home
                                    .entries
                                    .into_iter()
                                    .map(|entry| {
                                        let (icon, name) = match entry.kind {
                                            EntryKind::Dir => ("▸", format!("{}/", entry.name)),
                                            EntryKind::File => ("·", entry.name),
                                        };
                                        view! {
                                            <li class="tree-row">
                                                <span class="muted" aria-hidden="true">{icon}</span>
                                                <span class="mono">{name}</span>
                                                <span class="muted truncate">{entry.last_message}</span>
                                                <span class="muted">{entry.age}</span>
                                            </li>
                                        }
                                    })
                                    .collect_view()}
                            </ul>
                            <article class="card readme">
                                <h2 class="card-title">"README.md"</h2>
                                {home
                                    .readme
                                    .into_iter()
                                    .map(|line| match line.strip_prefix("# ") {
                                        Some(title) => view! { <h3>{title.to_owned()}</h3> }.into_any(),
                                        None => view! { <p>{line}</p> }.into_any(),
                                    })
                                    .collect_view()}
                            </article>
                        </div>
                        <aside class="repo-side">
                            <div class="card">
                                <h2 class="card-title">"About"</h2>
                                <p>{home.repo.description}</p>
                                <p class="muted small">{languages}</p>
                            </div>
                            <A href=format!("{base}/graph") attr:class="card link-card">
                                <h2 class="card-title">{format!("Code graph @ {}", graph.revision)}</h2>
                                <p class="mono small">
                                    {format!(
                                        "{} files · exact {}% · candidate {}%",
                                        graph.files,
                                        graph.exact_percent,
                                        graph.candidate_percent,
                                    )}
                                </p>
                                <div class="meter" aria-hidden="true">
                                    <span style:width=format!("{}%", graph.exact_percent)></span>
                                </div>
                            </A>
                            <A href=format!("{base}/ask") attr:class="card link-card accent">
                                <h2 class="card-title">"Ask this repo"</h2>
                                <p class="small">
                                    "“Where are refs updated on push?” → answer with "
                                    <code>"path:line"</code>
                                    " citations"
                                </p>
                            </A>
                            <div class="card">
                                <h2 class="card-title">"Open change requests"</h2>
                                <ul class="mini-list">
                                    {home
                                        .changes
                                        .into_iter()
                                        .map(|change| {
                                            view! {
                                                <li>
                                                    <A href=format!("{base}/changes/{}", change.number)>
                                                        <span class="strong">{format!("#{}", change.number)}</span>
                                                        " "
                                                        {change.title}
                                                    </A>
                                                    <ChangeBadge state=change.state/>
                                                </li>
                                            }
                                        })
                                        .collect_view()}
                                </ul>
                            </div>
                        </aside>
                    </div>
                }
            })}
        </section>
    }
}
