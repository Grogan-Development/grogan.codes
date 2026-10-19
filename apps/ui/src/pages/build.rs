use leptos::prelude::*;
use leptos_router::hooks::use_params_map;

use super::use_repo_ref;
use crate::components::{CheckBadge, StepBadge, load};
use crate::platform::use_platform;

#[component]
pub fn BuildView() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let params = use_params_map();
    let run = LocalResource::new(move || {
        let platform = platform.get();
        let repo = repo.get();
        let id = params.get().get("id").unwrap_or_default();
        async move { platform.build(repo, id).await }
    });

    view! {
        <section class="page">
            {load(run, |run| {
                let failed = run.log.iter().position(|line| line.contains("FAIL"));
                view! {
                    <header class="page-head">
                        <div>
                            <h1>
                                "Build " <span class="mono">{run.id.clone()}</span>
                            </h1>
                            <p class="muted">
                                {run.trigger.clone()} " · " <span class="mono">{run.commit.clone()}</span>
                                " · " {run.backend.clone()}
                            </p>
                        </div>
                        <CheckBadge state=run.state/>
                    </header>
                    <div class="build-grid">
                        <ol class="steps">
                            {run
                                .steps
                                .into_iter()
                                .map(|step| {
                                    view! {
                                        <li class="step">
                                            <span class="mono strong">{step.name}</span>
                                            <StepBadge state=step.state/>
                                            <span class="muted small">{format!("{} · {}", step.machine, step.duration)}</span>
                                            <span class="muted mono small">{format!("key {}", step.cache_key)}</span>
                                        </li>
                                    }
                                })
                                .collect_view()}
                        </ol>
                        <div class="build-main">
                            {run
                                .triage
                                .map(|triage| {
                                    view! {
                                        <article class="card accent">
                                            <h2 class="card-title">
                                                "Triage "
                                                <span class="muted small">
                                                    {format!("{}% confidence", triage.confidence)}
                                                </span>
                                            </h2>
                                            <p>{triage.root_cause}</p>
                                            <ul class="evidence">
                                                {triage
                                                    .evidence
                                                    .into_iter()
                                                    .map(|e| view! { <li class="mono small">{e}</li> })
                                                    .collect_view()}
                                            </ul>
                                            <div class="actions">
                                                <button class="button primary">"Fix this"</button>
                                                <button class="button">"Re-run failed step"</button>
                                            </div>
                                        </article>
                                    }
                                })}
                            <pre class="log" aria-label="Build log">
                                {run
                                    .log
                                    .into_iter()
                                    .enumerate()
                                    .map(|(index, line)| {
                                        let is_failure = failed == Some(index)
                                            || line.contains("panicked")
                                            || line.contains("assertion failed");
                                        view! {
                                            <span class="log-line" class:fail=is_failure>
                                                <span class="ln">{index + 1}</span>
                                                {line}
                                            </span>
                                        }
                                    })
                                    .collect_view()}
                            </pre>
                        </div>
                    </div>
                }
            })}
        </section>
    }
}
