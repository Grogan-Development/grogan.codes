use api_types::{
    ChangeDetail, ChangeState, CheckState, DiffLineKind, GateStage, ReviewVerdict, Severity,
};
use leptos::prelude::*;
use leptos_router::{components::A, hooks::use_params_map};

use super::use_repo_ref;
use crate::components::{ChangeBadge, CheckBadge, HitRow, load};
use crate::platform::use_platform;

#[derive(Clone, Copy, PartialEq, Eq)]
enum StateFilter {
    All,
    Open,
    Draft,
    Merged,
}

#[component]
pub fn ChangeList() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let changes = LocalResource::new(move || {
        let platform = platform.get();
        let repo = repo.get();
        async move { platform.changes(repo).await }
    });
    let filter = RwSignal::new(StateFilter::All);

    view! {
        <section class="page">
            <header class="page-head">
                <div>
                    <h1>"Change requests"</h1>
                    <p class="muted">
                        "Feature contracts, not loose PRs: Gate 1 approves the contract, CI + review verify a "
                        "candidate, Gate 2 accepts it and CAS-promotes the protected ref."
                    </p>
                </div>
            </header>
            <div class="toolbar">
                <div class="log-filter-pills" role="group" aria-label="Filter change requests">
                    {[
                        (StateFilter::All, "All"),
                        (StateFilter::Open, "Open"),
                        (StateFilter::Draft, "Draft"),
                        (StateFilter::Merged, "Merged"),
                    ]
                        .into_iter()
                        .map(|(value, label)| {
                            view! {
                                <button
                                    type="button"
                                    class="dw-mode-pill"
                                    class:active=move || filter.get() == value
                                    on:click=move |_| filter.set(value)
                                >
                                    {label}
                                </button>
                            }
                        })
                        .collect_view()}
                </div>
            </div>
            {load(changes, move |changes| {
                let base = repo.get_untracked().path();
                let visible: Vec<_> = changes
                    .into_iter()
                    .filter(|change| match filter.get() {
                        StateFilter::All => true,
                        StateFilter::Open => change.state == ChangeState::Open,
                        StateFilter::Draft => change.state == ChangeState::Draft,
                        StateFilter::Merged => change.state == ChangeState::Merged,
                    })
                    .collect();
                if visible.is_empty() {
                    return view! { <p class="empty">"No change requests in this state."</p> }.into_any();
                }
                view! {
                    <ul class="list">
                        {visible
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
                    .into_any()
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
            {load(detail, |detail| view! { <ChangeWorkbench detail/> })}
        </section>
    }
}

fn verdict_label(verdict: ReviewVerdict) -> (&'static str, &'static str) {
    match verdict {
        ReviewVerdict::Approve => ("badge ok", "review: approve"),
        ReviewVerdict::Comment => ("badge neutral", "review: comment"),
        ReviewVerdict::RequestChanges => ("badge bad", "review: request changes"),
    }
}

/// Two-gate change-request workbench. Backend contract (Loom features.rs +
/// review.rs + jobs.rs): Gate 1 owner-approves the contract; a candidate is
/// assembled and verified by digest-cached CI (evidence bundle) and a review
/// (findings may carry a suggested patch a human must approve before apply);
/// Gate 2 accepts, CAS-promoting protected refs with an exact rollback proof.
#[component]
fn ChangeWorkbench(detail: ChangeDetail) -> impl IntoView {
    let repo = use_repo_ref();
    let base = repo.get_untracked().path();
    let mergeable = detail.gates.iter().all(|gate| gate.satisfied);
    let failed_build = detail
        .checks
        .iter()
        .find(|check| check.state == CheckState::Failed)
        .and_then(|check| check.build_id.clone());

    let selected_revision = RwSignal::new(detail.revisions.last().map_or(1, |r| r.index));
    let accepted = RwSignal::new(detail.gate_stage == GateStage::Accepted);
    let fix_applied = RwSignal::new(false);
    let comments = RwSignal::new(detail.comments.clone());
    let draft = RwSignal::new(String::new());

    let gate1_done = matches!(
        detail.gate_stage,
        GateStage::Gate1Approved | GateStage::Accepted
    );
    let evidence = detail.evidence.clone();
    let evidence_passed = evidence.as_ref().is_some_and(|e| e.tests_passed);

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
                " (protected ref refs/main)"
            </p>
        </header>

        // Two-gate stepper (Loom FeatureGate)
        <ol class="gate-stepper">
            <li class:done=gate1_done>
                <span class="gate-step-num">"1"</span>
                <div>
                    <p class="strong">"Gate 1 · Owner approves contract"</p>
                    <p class="small muted">
                        "Scenarios + evidence policy agreed before any code runs. "
                        {if gate1_done { "Approved." } else { "Awaiting owner." }}
                    </p>
                </div>
            </li>
            <li class:done=evidence_passed>
                <span class="gate-step-num">"2"</span>
                <div>
                    <p class="strong">"Candidate verified"</p>
                    <p class="small muted">
                        {match &evidence {
                            Some(e) => format!(
                                "CI job {} · evidence {} · tests {}",
                                e.job_id,
                                e.digest,
                                if e.tests_passed { "passed" } else { "FAILED" },
                            ),
                            None => "No candidate submitted yet.".to_owned(),
                        }}
                    </p>
                </div>
            </li>
            <li class:done=move || accepted.get()>
                <span class="gate-step-num">"3"</span>
                <div>
                    <p class="strong">"Gate 2 · Accept & CAS-promote"</p>
                    <p class="small muted">
                        {move || if accepted.get() {
                            "Accepted · protected ref promoted atomically · rollback proof retained."
                        } else if detail.rollback_available {
                            "Exact reverse CAS will be captured at promotion, so accept is reversible."
                        } else {
                            "Rollback proof required by policy before accept."
                        }}
                    </p>
                </div>
            </li>
        </ol>

        <div class="change-grid">
            <div class="change-main">
                <p>{detail.description.clone()}</p>

                <article class="card">
                    <h2 class="card-title">
                        "Acceptance scenarios "
                        <span class="badge neutral">"given / when / then"</span>
                    </h2>
                    <ul class="findings">
                        {detail
                            .scenarios
                            .clone()
                            .into_iter()
                            .map(|scenario| {
                                view! {
                                    <li>
                                        <span class=if scenario.passed { "badge ok" } else { "badge bad" }>
                                            {if scenario.passed { "passing" } else { "failing" }}
                                        </span>
                                        " "
                                        <span class="strong">{scenario.name}</span>
                                        <p class="small muted">
                                            {format!(
                                                "Given {} · when {} · then {}",
                                                scenario.given, scenario.when, scenario.then,
                                            )}
                                        </p>
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                </article>

                <article class="card">
                    <h2 class="card-title">
                        "Files changed "
                        <span class="spacer"></span>
                        <span class="log-filter-pills" role="group" aria-label="Revision">
                            {detail
                                .revisions
                                .clone()
                                .into_iter()
                                .map(|revision| {
                                    view! {
                                        <button
                                            type="button"
                                            class="dw-mode-pill"
                                            class:active=move || selected_revision.get() == revision.index
                                            on:click=move |_| selected_revision.set(revision.index)
                                        >
                                            {format!("r{} · {}", revision.index, revision.head)}
                                        </button>
                                    }
                                })
                                .collect_view()}
                        </span>
                    </h2>
                    <p class="small muted">
                        {move || {
                            let current = selected_revision.get();
                            if current <= 1 {
                                "Revision 1: initial candidate. Submit a new head to see the range diff (r1 → r2) — approvals survive a clean rebase.".to_owned()
                            } else {
                                format!(
                                    "Showing patchset r{current}. Range diff vs r{} is one file, +1 line (epoch added to cache key). Approvals carried over: the code under them did not change.",
                                    current - 1,
                                )
                            }
                        }}
                    </p>
                    {detail
                        .files
                        .clone()
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
                        "AI review " <span class="badge neutral">"advisory · never a gate"</span>
                        <span class="spacer"></span>
                        {detail.review_verdict.map(|verdict| {
                            let (class, label) = verdict_label(verdict);
                            view! { <span class=class>{label}</span> }
                        })}
                    </h2>
                    <ul class="findings">
                        {detail
                            .findings
                            .clone()
                            .into_iter()
                            .map(|finding| {
                                let (class, label) = match finding.severity {
                                    Severity::Info => ("info", "info"),
                                    Severity::Warning => ("warn", "warning"),
                                    Severity::Risk => ("risk", "risk"),
                                };
                                let fix = finding.suggested_fix.clone();
                                view! {
                                    <li class=format!("finding {class}")>
                                        <span class="finding-sev">{label}</span>
                                        <span class="mono small">
                                            {format!("{}:{}-{}", finding.path, finding.line, finding.end_line)}
                                        </span>
                                        <p>{finding.message}</p>
                                        {fix.map(|fix| {
                                            view! {
                                                <div class="suggested-fix">
                                                    <p class="mono small add">{format!("+ {fix}")}</p>
                                                    <button
                                                        type="button"
                                                        class="button"
                                                        on:click=move |_| fix_applied.set(true)
                                                    >
                                                        {move || if fix_applied.get() {
                                                            "✓ Approved & applied — candidate r3 queued for CI"
                                                        } else {
                                                            "Approve & apply suggestion (human only)"
                                                        }}
                                                    </button>
                                                </div>
                                            }
                                        })}
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                </article>

                <article class="card">
                    <h2 class="card-title">"Impact — blast radius from the code graph"</h2>
                    <ul class="hits">
                        {detail.impact.clone().into_iter().map(|hit| view! { <HitRow hit/> }).collect_view()}
                    </ul>
                    <p class="small muted legend">
                        "One-hop neighbors of changed graph nodes, from the digest-cached insights pre-flight."
                    </p>
                </article>

                <article class="card">
                    <h2 class="card-title">"Discussion"</h2>
                    <ul class="findings">
                        {move || comments
                            .get()
                            .into_iter()
                            .map(|comment| {
                                let is_agent = comment.author.starts_with("agent:");
                                view! {
                                    <li>
                                        <span class=if is_agent { "badge running" } else { "badge neutral" }>
                                            {comment.author.clone()}
                                        </span>
                                        " "
                                        <span class="muted small">{comment.age.clone()}</span>
                                        {comment.finding_path.clone().map(|path| {
                                            view! { <span class="mono small muted"> {format!(" · on {path}")}</span> }
                                        })}
                                        <p>{comment.body.clone()}</p>
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                    <form
                        class="comment-form"
                        on:submit=move |event| {
                            event.prevent_default();
                            let body = draft.get_untracked();
                            if body.trim().is_empty() {
                                return;
                            }
                            comments.update(|list| {
                                list.push(api_types::ReviewComment {
                                    author: "zack".to_owned(),
                                    body,
                                    age: "just now".to_owned(),
                                    finding_path: None,
                                });
                            });
                            draft.set(String::new());
                        }
                    >
                        <input
                            type="text"
                            placeholder="Comment… (agents read this thread via the review API)"
                            aria-label="Add a comment"
                            prop:value=move || draft.get()
                            on:input=move |event| draft.set(event_target_value(&event))
                        />
                        <button type="submit" class="button">"Comment"</button>
                    </form>
                </article>
            </div>

            <aside class="change-side">
                <div class="card">
                    <h2 class="card-title">"Gates"</h2>
                    <ul class="gates">
                        {detail
                            .gates
                            .clone()
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
                    <button
                        type="button"
                        class="button primary block"
                        disabled=!mergeable
                        on:click=move |_| accepted.set(true)
                    >
                        {move || if accepted.get() {
                            "✓ Accepted — refs/main promoted (CAS)"
                        } else {
                            "Accept candidate (Gate 2)"
                        }}
                    </button>
                    {failed_build.map(|id| {
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
                            .clone()
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
                            .clone()
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
}
