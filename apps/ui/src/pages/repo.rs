use api_types::{AdmissionSource, EntryKind, RepoRef};
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
                    <A href=tab("/graph")>"Wiki"</A>
                    <A href=tab("/builds")>"Build"</A>
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
    let file_filter = RwSignal::new(String::new());
    let show_clone = RwSignal::new(false);
    let selected_entry = RwSignal::new(String::new());

    view! {
        <section class="page">
            {load(home, move |home| {
                let base = home.repo.id.path();
                let languages = home
                    .repo
                    .languages
                    .iter()
                    .map(|l| format!("{} {}%", l.name, l.percent))
                    .collect::<Vec<_>>()
                    .join(" · ");
                let graph = home.repo.graph.clone();
                let graph_revision = graph.revision.clone();
                let protected_ref = home.repo.protected_ref.clone();
                let protected_ref_show = protected_ref.clone();
                let base_link = base.clone();
                let owner = home.repo.id.owner.clone();
                let name = home.repo.id.name.clone();
                let query = file_filter.get().to_lowercase();
                let visible: Vec<_> = home
                    .entries
                    .clone()
                    .into_iter()
                    .filter(|entry| query.is_empty() || entry.name.to_lowercase().contains(&query))
                    .collect();
                view! {
                    <div class="repo-grid">
                        <div class="repo-main">
                            <div class="toolbar">
                                <button class="button mono">{format!("⎇ {} ▾", home.repo.default_branch)}</button>
                                <span class="muted">
                                    {format!("{} branches · {} tags", home.repo.branches, home.repo.tags)}
                                </span>
                                <span class="spacer"></span>
                                <input
                                    type="search"
                                    class="file-filter"
                                    placeholder="Go to file…"
                                    aria-label="Go to file"
                                    prop:value=move || file_filter.get()
                                    on:input=move |event| file_filter.set(event_target_value(&event))
                                />
                                <button
                                    type="button"
                                    class="button primary"
                                    on:click=move |_| show_clone.update(|v| *v = !*v)
                                >
                                    "Clone ▾"
                                </button>
                            </div>
                            <Show when=move || show_clone.get()>
                                <div class="card clone-card">
                                    <p class="small strong mono">"Clone this repository"</p>
                                    <p class="mono small">
                                        {format!(
                                            "git clone https://grogan.codes/git/{}/{}.git",
                                            owner.clone(),
                                            name.clone(),
                                        )}
                                    </p>
                                    <p class="small muted">
                                        "Protected ref " <code>{protected_ref_show.clone()}</code>
                                        " only moves through change-request accept (Gate 2 + atomic CAS). "
                                        "Push a worktree branch and open a change request instead."
                                    </p>
                                </div>
                            </Show>
                            <div class="commit-row">
                                <span class="strong">{home.head.author}</span>
                                <span class="commit-msg">{home.head.message}</span>
                                <span class="mono muted">{home.head.oid}</span>
                                <CheckBadge state=home.head.checks/>
                                <span class="muted">{home.head.age}</span>
                            </div>
                            <ul class="tree">
                                {visible
                                    .into_iter()
                                    .map(|entry| {
                                        let (icon, display) = match entry.kind {
                                            EntryKind::Dir => ("▸", format!("{}/", entry.name)),
                                            EntryKind::File => ("·", entry.name.clone()),
                                        };
                                        let entry_name = entry.name.clone();
                                        view! {
                                            <li
                                                class="tree-row tree-row-btn"
                                                class:active=move || selected_entry.get() == entry_name
                                                on:click={
                                                    let entry_name = entry.name.clone();
                                                    move |_| selected_entry.set(entry_name.clone())
                                                }
                                            >
                                                <span class="muted" aria-hidden="true">{icon}</span>
                                                <span class="mono">{display}</span>
                                                <span class="muted truncate">{entry.last_message}</span>
                                                <span class="muted">{entry.age}</span>
                                            </li>
                                        }
                                    })
                                    .collect_view()}
                            </ul>
                            {move || {
                                let picked = selected_entry.get();
                                if picked.is_empty() {
                                    return view! { <span></span> }.into_any();
                                }
                                view! {
                                    <div class="card entry-preview">
                                        <p class="mono small">
                                            <span class="strong">{picked.clone()}</span>
                                            {format!(" · blob/tree @ {} · last change above", graph_revision)}
                                        </p>
                                        <p class="small muted">
                                            "Served from the CAS tree at the head revision — the same materialization "
                                            "the code graph, CI and DeepWiki read."
                                        </p>
                                        <A href=format!("{base_link}/graph?q={picked}") attr:class="button">
                                            "Open in DeepWiki →"
                                        </A>
                                    </div>
                                }
                                    .into_any()
                            }}
                            <article class="card readme">
                                <h2 class="card-title">"README.md"</h2>
                                {home
                                    .readme
                                    .clone()
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
                                <ul class="mini-list" style="margin-top:8px">
                                    <li>
                                        <span class="muted">"Protected ref"</span>
                                        <code>{protected_ref.clone()}</code>
                                    </li>
                                    <li>
                                        <span class="muted">"CI policy"</span>
                                        <span class="mono small">"loom-ci.toml"</span>
                                    </li>
                                    <li>
                                        <span class="muted">"Storage"</span>
                                        <span class="mono small">"CAS on S3"</span>
                                    </li>
                                </ul>
                            </div>
                            <div class="card">
                                <h2 class="card-title">"How refs moved (admissions)"</h2>
                                <ul class="mini-list">
                                    {home
                                        .admissions
                                        .into_iter()
                                        .map(|admission| {
                                            let source = match admission.source {
                                                AdmissionSource::GitPush => "git push",
                                                AdmissionSource::Import => "import",
                                                AdmissionSource::NativeCommit => "native commit",
                                                AdmissionSource::ChangeRequestAccept => "CR accept (CAS)",
                                            };
                                            view! {
                                                <li>
                                                    <span>
                                                        <span class="strong small">{source}</span>
                                                        <br/>
                                                        <span class="mono muted small">
                                                            {format!(
                                                                "{} → {}",
                                                                admission.base.as_deref().unwrap_or("∅"),
                                                                admission.head,
                                                            )}
                                                        </span>
                                                    </span>
                                                    <span class="muted small">{admission.age}</span>
                                                </li>
                                            }
                                        })
                                        .collect_view()}
                                </ul>
                                <p class="small muted">
                                    "Every non-empty tree records an admission edge; CI never runs inside receive-pack."
                                </p>
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
                            <A href=format!("{base}/graph?q=Where+are+refs+updated+on+push%3F") attr:class="card link-card accent">
                                <h2 class="card-title">"Ask the wiki"</h2>
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
