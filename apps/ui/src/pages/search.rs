use api_types::{ApiError, RepoRef, SearchResults};
use leptos::prelude::*;
use leptos_router::hooks::{use_navigate, use_query_map};

use super::use_repo_ref;
use crate::components::{HitRow, load};
use crate::platform::{use_active_org, use_platform};

/// Search across the active org. Until cross-repo search exists this
/// searches the org's first repo, which is what the mock serves.
#[component]
pub fn Search() -> impl IntoView {
    let platform = use_platform();
    let org = use_active_org();
    let query = use_query_map();
    let results = LocalResource::new(move || {
        let platform = platform.get();
        let org = org.get();
        let q = query.get().get("q").unwrap_or_default();
        async move {
            let repo = platform
                .repos(org)
                .await?
                .into_iter()
                .next()
                .ok_or(ApiError::NotFound)?;
            platform.search(repo.id, q).await
        }
    });

    view! {
        <section class="page narrow">
            <header class="page-head">
                <h1>"Search"</h1>
            </header>
            {load(results, |results| view! { <Results results/> })}
        </section>
    }
}

#[component]
pub fn RepoSearch() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let query = use_query_map();
    let navigate = use_navigate();
    let draft = RwSignal::new(query.get_untracked().get("q").unwrap_or_default());
    let results = LocalResource::new(move || {
        let platform = platform.get();
        let repo: RepoRef = repo.get();
        let q = query.get().get("q").unwrap_or_default();
        async move { platform.search(repo, q).await }
    });

    let on_submit = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let path = repo.get_untracked().path();
        navigate(
            &format!("{path}/graph?q={}", draft.get_untracked()),
            Default::default(),
        );
    };

    view! {
        <section class="page">
            <form class="search wide" role="search" on:submit=on_submit>
                <input
                    type="search"
                    placeholder="Text, regex, sym:Name or def:Name"
                    aria-label="Search this repo"
                    bind:value=draft
                />
                <button class="button" type="submit">"Search"</button>
            </form>
            {load(results, |results| view! { <Results results/> })}
        </section>
    }
}

#[component]
fn Results(results: SearchResults) -> impl IntoView {
    view! {
        <p class="muted">
            "Results for " <code>{results.query}</code> " at " <span class="mono">{results.revision}</span>
            {results.truncated.then_some(" · truncated")}
        </p>
        <div class="search-grid">
            <article class="card">
                <h2 class="card-title">"Text matches"</h2>
                <ul class="hits">
                    {results.text.into_iter().map(|hit| view! { <HitRow hit/> }).collect_view()}
                </ul>
            </article>
            <article class="card">
                <h2 class="card-title">"Graph"</h2>
                {results
                    .definition
                    .map(|hit| {
                        view! {
                            <p class="muted small">"Definition"</p>
                            <ul class="hits">
                                <HitRow hit/>
                            </ul>
                        }
                    })}
                <p class="muted small">"Callers"</p>
                <ul class="hits">
                    {results.callers.into_iter().map(|hit| view! { <HitRow hit/> }).collect_view()}
                </ul>
                <p class="legend small">
                    <span class="tier exact">"exact"</span>
                    " compiler index · "
                    <span class="tier cand">"cand"</span>
                    " inferred, verify before relying on it"
                </p>
            </article>
        </div>
    }
}
