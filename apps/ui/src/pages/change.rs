use api_types::{CheckState, DiffLineKind, Severity};
use leptos::prelude::*;
use leptos_router::{components::A, hooks::use_params_map};

use super::use_repo_ref;
use crate::components::{ChangeBadge, CheckBadge, HitRow, load};
use crate::platform::use_platform;

#[component]
pub fn ChangeList() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let changes = LocalResource::new(move || {
        let platform = platform.get();
        let repo = repo.get();
        async move { platform.changes(repo).await }
    });

    view! {
        <section class="page">
            {load(changes, move |changes| {
                let base = repo.get_untracked().path();
                view! {
                    <ul class="list">
                        {changes
                            .into_iter()
                            .map(|change| {
                                view! {
                                    <li class="list-row change-row">
                                        <ChangeBadge state=change.state/>
                                        <A href=format!("{base}/changes/{}", change.number) attr:class="row-title">
                                            {format!("#{} {}", change.number, change.title)}
                                        </A>
                                        <span class="muted mono">{change.author}</span>
                                        <CheckBadge state=change.checks/>
                                        <span class="muted">
                                            {format!("{}/{} approvals", change.approvals, change.required_approvals)}
                                        </span>
                                        <span class="muted">{change.updated}</span>
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
pub fn ChangeView() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let params = use_params_map();
    let number = Memo::new(move |_| {
        params
            .get()
            .get("n")
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or_default()
    });
    let detail = LocalResource::new(move || {
        let platform = platform.get();
        let repo = repo.get();
        let number = number.get();
        async move { platform.change(repo, number).await }
    });

    view! {
        <section class="page">
            {load(detail, move |detail| {
                let base = repo.get_untracked().path();
                let mergeable = detail.gates.iter().all(|gate| gate.satisfied);
                let failed_build = detail
                    .checks
                    .iter()
                    .find(|check| check.state == CheckState::Failed)
                    .and_then(|check| check.build_id.clone());
                view! {
                    <header class="change-head">
                        <h1>
                            {detail.summary.title.clone()}
                            <span class="muted">{format!(" #{}", detail.summary.number)}</span>
                        </h1>
                        <p class="muted">
                            <ChangeBadge state=detail.summary.state/>
                            " "
                            <span class="mono">{detail.summary.author.clone()}</span>
                            " wants to merge "
                            <code>{detail.source.clone()}</code>
                            " into "
                            <code>{detail.target.clone()}</code>
                        </p>
                    </header>
                    <div class="change-grid">
                        <div class="change-main">
                            <p>{detail.description.clone()}</p>
                            <article class="card">
                                <h2 class="card-title">"Files changed"</h2>
                                {detail
                                    .files
                                    .into_iter()
                                    .map(|file| {
                                        view! {
                                            <div class="diff">
                                                <p class="diff-head mono">
                                                    {file.path}
                                                    <span class="add">{format!(" +{}", file.added)}</span>
                                                    <span class="del">{format!(" −{}", file.removed)}</span>
                                                </p>
                                                <pre class="diff-body">
                                                    {file
                                                        .hunk
                                                        .into_iter()
                                                        .map(|line| {
                                                            let (class, sign) = match line.kind {
                                                                DiffLineKind::Context => ("ctx", " "),
                                                                DiffLineKind::Added => ("add", "+"),
                                                                DiffLineKind::Removed => ("del", "−"),
                                                            };
                                                            view! {
                                                                <span class=format!("diff-line {class}")>
                                                                    <span class="ln">{line.number}</span>
                                                                    {format!("{sign} {}", line.text)}
                                                                </span>
                                                            }
                                                        })
                                                        .collect_view()}
                                                </pre>
                                            </div>
                                        }
                                    })
                                    .collect_view()}
                            </article>
                            <article class="card">
                                <h2 class="card-title">
                                    "AI review " <span class="badge neutral">"advisory"</span>
                                </h2>
                                <ul class="findings">
                                    {detail
                                        .findings
                                        .into_iter()
                                        .map(|finding| {
                                            let (class, label) = match finding.severity {
                                                Severity::Info => ("info", "info"),
                                                Severity::Warning => ("warn", "warning"),
                                                Severity::Risk => ("risk", "risk"),
                                            };
                                            view! {
                                                <li class=format!("finding {class}")>
                                                    <span class="finding-sev">{label}</span>
                                                    <span class="mono small">
                                                        {format!("{}:{}", finding.path, finding.line)}
                                                    </span>
                                                    <p>{finding.message}</p>
                                                </li>
                                            }
                                        })
                                        .collect_view()}
                                </ul>
                            </article>
                            <article class="card">
                                <h2 class="card-title">"Impact"</h2>
                                <ul class="hits">
                                    {detail.impact.into_iter().map(|hit| view! { <HitRow hit/> }).collect_view()}
                                </ul>
                            </article>
                        </div>
                        <aside class="change-side">
                            <div class="card">
                                <h2 class="card-title">"Gates"</h2>
                                <ul class="gates">
                                    {detail
                                        .gates
                                        .into_iter()
                                        .map(|gate| {
                                            view! {
                                                <li class:ok=gate.satisfied>
                                                    <span class="gate-mark" aria-hidden="true">
                                                        {if gate.satisfied { "✓" } else { "✕" }}
                                                    </span>
                                                    <div>
                                                        <p class="strong">{gate.rule}</p>
                                                        <p class="muted small">{gate.detail}</p>
                                                    </div>
                                                </li>
                                            }
                                        })
                                        .collect_view()}
                                </ul>
                                <button class="button primary block" disabled=!mergeable>
                                    "Add to merge queue"
                                </button>
                                {failed_build
                                    .map(|id| {
                                        view! {
                                            <A href=format!("{base}/builds/{id}") attr:class="button block">
                                                "Open failing build"
                                            </A>
                                        }
                                    })}
                            </div>
                            <div class="card">
                                <h2 class="card-title">"Checks"</h2>
                                <ul class="mini-list">
                                    {detail
                                        .checks
                                        .into_iter()
                                        .map(|check| {
                                            view! {
                                                <li>
                                                    <span class="mono">{check.name}</span>
                                                    <span class="muted small">{check.duration}</span>
                                                    <CheckBadge state=check.state/>
                                                </li>
                                            }
                                        })
                                        .collect_view()}
                                </ul>
                            </div>
                            <div class="card">
                                <h2 class="card-title">"Revisions"</h2>
                                <ul class="mini-list">
                                    {detail
                                        .revisions
                                        .into_iter()
                                        .rev()
                                        .map(|revision| {
                                            view! {
                                                <li>
                                                    <span class="strong">{format!("r{}", revision.index)}</span>
                                                    <span>{revision.summary}</span>
                                                    <span class="mono muted small">{revision.head}</span>
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
