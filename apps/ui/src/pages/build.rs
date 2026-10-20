use api_types::BuildRun;
use leptos::prelude::*;
use leptos_router::{components::A, hooks::use_params_map};

use super::use_repo_ref;
use crate::components::{CheckBadge, StepBadge, load};
use crate::platform::use_platform;

/// Repository Builds index (`/r/:owner/:repo/builds`), backed by
/// `Platform::builds` — the UI projection of Loom's durable exact-OID CI jobs
/// (`jobs::CiDurableJob`): digest-cached, lease-claimed, evidence-bound.
#[component]
pub fn BuildList() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let builds = LocalResource::new(move || {
        let platform = platform.get();
        let repo = repo.get();
        async move { platform.builds(repo).await }
    });
    let base = move || repo.get().path();

    view! {
        <section class="page">
            <header class="page-head">
                <div>
                    <h1>"Builds & Content-Addressed Cache"</h1>
                    <p class="muted">
                        "Durable exact-OID jobs on disposable micro-VMs. A passing job for one revision is the "
                        "digest cache for the next admission of the same tree — evidence never transfers across OIDs."
                    </p>
                </div>
                <A href=move || format!("{}/builds/b-c3d07f1", base()) attr:class="button primary">
                    "Inspect failing build b-c3d07f1 →"
                </A>
            </header>

            <div class="build-kpi-grid">
                <div class="card">
                    <p class="small muted mono">"CACHE HIT RATE (7D)"</p>
                    <p class="kpi-num mono">"78%"</p>
                    <p class="small muted">"13m 52s saved across 4 runs · warm S3 input-tree store"</p>
                </div>
                <div class="card">
                    <p class="small muted mono">"BUILD MINUTES (INCLUDED ALLOWANCE)"</p>
                    <p class="kpi-num mono">"142 / 500 min"</p>
                    <div class="meter" aria-hidden="true">
                        <span style:width="28%"></span>
                    </div>
                    <p class="small muted" style="margin-top:6px">"Cached steps cost 0 build minutes"</p>
                </div>
                <div class="card accent">
                    <p class="small muted mono">"NEEDS ATTENTION"</p>
                    <p class="strong" style="margin:4px 0">"Build b-c3d07f1 failed on CR #42"</p>
                    <p class="small">
                        "AI triage pinpointed "
                        <code>"projection.rs:87"</code>
                        " (86% confidence) with a 2-line fix ready."
                    </p>
                </div>
            </div>

            {load(builds, move |runs| {
                view! {
                    <ul class="list" style="margin-top:16px">
                        {runs
                            .into_iter()
                            .map(|row| {
                                let href = format!("{}/builds/{}", base(), row.id);
                                view! {
                                    <li class="list-row build-list-row">
                                        <CheckBadge state=row.state/>
                                        <div>
                                            <A href=href attr:class="row-title strong">
                                                <span class="mono">{row.id.clone()}</span>
                                                " · "
                                                {row.title}
                                            </A>
                                            <p class="small muted mono">
                                                {format!("{} · commit {} · {}", row.trigger, row.commit, row.saved)}
                                            </p>
                                        </div>
                                        <div class="step-pills" aria-label="Pipeline steps">
                                            {row.steps
                                                .into_iter()
                                                .map(|step| {
                                                    view! {
                                                        <span class="step-pill">
                                                            <span class="mono small">{step.name}</span>
                                                            " "
                                                            <StepBadge state=step.state/>
                                                        </span>
                                                    }
                                                })
                                                .collect_view()}
                                        </div>
                                        <span class="mono muted small">{row.duration}</span>
                                        <span class="muted small">{row.age}</span>
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum InspectorTab {
    Source,
    Fix,
    Cache,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceTarget {
    ProjectionRs,
    ProjectionTestRs,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LogFilter {
    All,
    FailuresOnly,
}

/// DeepWiki-grade Build Run workbench (`/r/:owner/:repo/builds/:id`):
/// Left pane: interactive step pipeline + AI triage with clickable evidence pills + filterable log
/// Right pane: synced Failure Inspector (Source & Assertion | Proposed Fix Diff | Cache & Firecracker VM)
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
            {load(run, |run| view! { <BuildWorkbench run/> })}
        </section>
    }
}

#[component]
fn BuildWorkbench(run: BuildRun) -> impl IntoView {
    let repo = use_repo_ref();
    let selected_step = RwSignal::new(1usize);
    let inspector_tab = RwSignal::new(InspectorTab::Source);
    let source_target = RwSignal::new(SourceTarget::ProjectionRs);
    let log_filter = RwSignal::new(LogFilter::All);
    let fix_applied = RwSignal::new(false);
    let rerun_queued = RwSignal::new(false);

    let jump_to_source = move |target: SourceTarget| {
        inspector_tab.set(InspectorTab::Source);
        source_target.set(target);
    };

    let open_fix = move |_| {
        inspector_tab.set(InspectorTab::Fix);
    };

    let failed_line_idx = run.log.iter().position(|line| line.contains("FAIL"));

    view! {
        <div class="dw-chat-crumbs" style="margin-bottom:8px">
            <A href=move || format!("{}/builds", repo.get().path()) attr:class="dw-back-link">
                "← All builds for zack/grogan-code"
            </A>
        </div>

        <header class="page-head build-workbench-head">
            <div>
                <div class="build-title-row">
                    <h1>
                        "Build " <span class="mono">{run.id.clone()}</span>
                    </h1>
                    <CheckBadge state=run.state/>
                    <span class="badge cached">"saved 1m 48s via cache"</span>
                </div>
                <p class="muted">
                    <A href=move || format!("{}/changes/42", repo.get().path()) attr:class="inline-sym">
                        {run.trigger.clone()}
                    </A>
                    " · commit " <code class="mono">{run.commit.clone()}</code>
                    " · " {run.backend.clone()}
                </p>
                <p class="small muted mono">
                    {format!(
                        "exact OID {} · attempts {} · evidence {}{}",
                        run.git_oid,
                        run.attempts,
                        run.evidence_digest.as_deref().unwrap_or("—"),
                        run.cached_from
                            .as_ref()
                            .map(|id| format!(" · cached from {id}"))
                            .unwrap_or_default(),
                    )}
                </p>
                <p class="small muted mono">{format!("source key {}", run.source_key)}</p>
            </div>

            <div class="actions" style="margin-top:0">
                <button
                    type="button"
                    class="button"
                    on:click=move |_| rerun_queued.set(true)
                >
                    {move || if rerun_queued.get() { "✓ Re-running test on Spot VM…" } else { "↻ Re-run failed step" }}
                </button>
                <button
                    type="button"
                    class="button primary"
                    on:click=open_fix
                >
                    "✨ Inspect & apply AI fix →"
                </button>
            </div>
        </header>

        <div class="pipeline-rail" role="tablist" aria-label="Build steps">
            {run.steps
                .iter()
                .cloned()
                .enumerate()
                .map(|(idx, step)| {
                    let why = match idx {
                        0 => "100% tree match with main@0705846 · 0s billed",
                        1 => "Cache miss: crates/source/src/projection.rs (+24 -3)",
                        _ => "Blocked on failed upstream step `test`",
                    };
                    view! {
                        <button
                            type="button"
                            role="tab"
                            class="pipeline-step-btn"
                            class:active=move || selected_step.get() == idx
                            on:click=move |_| {
                                selected_step.set(idx);
                                if idx == 0 {
                                    inspector_tab.set(InspectorTab::Cache);
                                }
                            }
                        >
                            <div class="pipeline-step-top">
                                <span class="mono strong">{format!("{}. {}", idx + 1, step.name)}</span>
                                <StepBadge state=step.state/>
                                <span class="spacer"></span>
                                <span class="mono small muted">{format!("{} · {}", step.machine, step.duration)}</span>
                            </div>
                            <p class="small muted truncate">{why}</p>
                            <p class="mono small muted">{format!("input tree key {}", step.cache_key)}</p>
                        </button>
                    }
                })
                .collect_view()}
        </div>

        <div class="dw-chat-split" style="margin-top:16px">
            <div class="dw-chat-left">
                {run.triage.map(|triage| {
                    view! {
                        <article class="card accent build-triage-card">
                            <div class="build-triage-head">
                                <span class="badge bad">"Root Cause · Triage"</span>
                                <span class="mono small strong">{format!("{}% confidence · BYO key", triage.confidence)}</span>
                                <span class="spacer"></span>
                                <button
                                    type="button"
                                    class="dw-view-chip codemap"
                                    on:click=open_fix
                                >
                                    "✨ View 2-line fix diff"
                                </button>
                            </div>

                            <p class="dw-answer-lead" style="margin:8px 0">
                                {triage.root_cause}
                            </p>

                            <div class="triage-evidence-box">
                                <p class="small strong muted">"Causal chain (click to inspect source on the right):"</p>
                                <ol class="triage-chain">
                                    <li>
                                        <span class="dw-cm-step-id mono">"1"</span>
                                        <span>
                                            "Cache key constructed as "
                                            <code>"(grant.id, rev)"</code>
                                            " without "
                                            <code>"grant.revocation_epoch"</code>
                                            " "
                                        </span>
                                        <button
                                            type="button"
                                            class="dw-cite-link"
                                            class:active=move || inspector_tab.get() == InspectorTab::Source && source_target.get() == SourceTarget::ProjectionRs
                                            on:click=move |_| jump_to_source(SourceTarget::ProjectionRs)
                                        >
                                            "projection.rs:87-91"
                                        </button>
                                    </li>
                                    <li>
                                        <span class="dw-cm-step-id mono">"2"</span>
                                        <span>
                                            "Test revokes grant and reads again; warm cache returns 3 stale rows instead of 0 "
                                        </span>
                                        <button
                                            type="button"
                                            class="dw-cite-link"
                                            class:active=move || inspector_tab.get() == InspectorTab::Source && source_target.get() == SourceTarget::ProjectionTestRs
                                            on:click=move |_| jump_to_source(SourceTarget::ProjectionTestRs)
                                        >
                                            "tests/projection.rs:58-64"
                                        </button>
                                    </li>
                                </ol>
                            </div>
                        </article>
                    }
                })}

                <div class="log-card">
                    <div class="log-toolbar">
                        <span class="mono small strong">
                            {move || match selected_step.get() {
                                0 => "Step 1 · lint (cached replay from 9f1e…a2)",
                                1 => "Step 2 · test (cargo nextest run · 212 tests)",
                                _ => "Step 3 · image (skipped — upstream `test` failed)",
                            }}
                        </span>
                        <span class="spacer"></span>
                        <div class="log-filter-pills" role="group" aria-label="Log filter">
                            <button
                                type="button"
                                class="dw-mode-pill"
                                class:active=move || log_filter.get() == LogFilter::All
                                on:click=move |_| log_filter.set(LogFilter::All)
                            >
                                "All lines (11)"
                            </button>
                            <button
                                type="button"
                                class="dw-mode-pill"
                                class:active=move || log_filter.get() == LogFilter::FailuresOnly
                                on:click=move |_| log_filter.set(LogFilter::FailuresOnly)
                            >
                                "Failures only (3)"
                            </button>
                        </div>
                    </div>

                    <pre class="log" aria-label="Build log" style="margin-top:0;border-radius:0 0 6px 6px">
                        {move || {
                            let only_fail = log_filter.get() == LogFilter::FailuresOnly;
                            run.log
                                .iter()
                                .cloned()
                                .enumerate()
                                .filter(|(index, line)| {
                                    let is_failure = failed_line_idx == Some(*index)
                                        || line.contains("panicked")
                                        || line.contains("assertion failed");
                                    !only_fail || is_failure
                                })
                                .map(|(index, line)| {
                                    let is_failure = failed_line_idx == Some(index)
                                        || line.contains("panicked")
                                        || line.contains("assertion failed");
                                    let hits_test = line.contains("tests/projection.rs");
                                    view! {
                                        <span
                                            class="log-line"
                                            class:fail=is_failure
                                            on:click=move |_| {
                                                if hits_test {
                                                    jump_to_source(SourceTarget::ProjectionTestRs);
                                                }
                                            }
                                        >
                                            <span class="ln">{index + 1}</span>
                                            {line}
                                        </span>
                                    }
                                })
                                .collect_view()
                        }}
                    </pre>
                </div>
            </div>

            <aside class="dw-code-pane" aria-label="Build failure inspector">
                <div class="dw-code-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        class="dw-code-tab"
                        class:active=move || inspector_tab.get() == InspectorTab::Source && source_target.get() == SourceTarget::ProjectionRs
                        on:click=move |_| jump_to_source(SourceTarget::ProjectionRs)
                    >
                        "projection.rs:87"
                    </button>
                    <button
                        type="button"
                        role="tab"
                        class="dw-code-tab"
                        class:active=move || inspector_tab.get() == InspectorTab::Source && source_target.get() == SourceTarget::ProjectionTestRs
                        on:click=move |_| jump_to_source(SourceTarget::ProjectionTestRs)
                    >
                        "tests/projection.rs:61"
                    </button>
                    <button
                        type="button"
                        role="tab"
                        class="dw-code-tab"
                        class:active=move || inspector_tab.get() == InspectorTab::Fix
                        on:click=move |_| inspector_tab.set(InspectorTab::Fix)
                    >
                        "✨ Proposed Fix"
                    </button>
                    <button
                        type="button"
                        role="tab"
                        class="dw-code-tab"
                        class:active=move || inspector_tab.get() == InspectorTab::Cache
                        on:click=move |_| inspector_tab.set(InspectorTab::Cache)
                    >
                        "Cache & VM"
                    </button>
                </div>

                {move || match inspector_tab.get() {
                    InspectorTab::Source => match source_target.get() {
                        SourceTarget::ProjectionRs => view! {
                            <div>
                                <div class="dw-code-path mono small">
                                    <span class="muted">"Cause · "</span>
                                    <span class="strong">"crates/source/src/projection.rs"</span>
                                    <span class="spacer"></span>
                                    <span class="badge bad">"missing revocation_epoch"</span>
                                </div>
                                <pre class="dw-code-view mono">
                                    <span class="dw-code-line"><span class="ln">" 85"</span>"// CR #42 revision 2 (commit c3d07f1)"</span>
                                    <span class="dw-code-line"><span class="ln">" 86"</span>"pub fn read(&self, grant: &Grant, rev: Oid) -> Result<Rows> {"</span>
                                    <span class="dw-code-line hl"><span class="ln">" 87"</span>"    let key = (grant.id, rev); // ← ignores grant.revocation_epoch"</span>
                                    <span class="dw-code-line hl"><span class="ln">" 88"</span>"    if let Some(rows) = self.cache.get(&key) {"</span>
                                    <span class="dw-code-line hl"><span class="ln">" 89"</span>"        return Ok(rows.clone());"</span>
                                    <span class="dw-code-line"><span class="ln">" 90"</span>"    }"</span>
                                    <span class="dw-code-line"><span class="ln">" 91"</span>"    let pack = self.packs.open(rev)?;"</span>
                                    <span class="dw-code-line"><span class="ln">" 92"</span>"    pack.project(grant.scope())"</span>
                                    <span class="dw-code-line"><span class="ln">" 93"</span>"}"</span>
                                </pre>
                                <div class="inspector-foot">
                                    <p class="small muted">
                                        "Because " <code>"key"</code> " omits " <code>"grant.revocation_epoch"</code>
                                        ", revoking a grant leaves its cached rows live until LRU eviction."
                                    </p>
                                    <button type="button" class="button primary" on:click=open_fix>
                                        "Preview 2-line fix →"
                                    </button>
                                </div>
                            </div>
                        }.into_any(),
                        SourceTarget::ProjectionTestRs => view! {
                            <div>
                                <div class="dw-code-path mono small">
                                    <span class="muted">"Failing assertion · "</span>
                                    <span class="strong">"crates/source/tests/projection.rs"</span>
                                    <span class="spacer"></span>
                                    <span class="badge bad">"panicked at line 61"</span>
                                </div>
                                <pre class="dw-code-view mono">
                                    <span class="dw-code-line"><span class="ln">" 56"</span>"#[test]"</span>
                                    <span class="dw-code-line"><span class="ln">" 57"</span>"fn revoked_grant_cannot_read_cache() {"</span>
                                    <span class="dw-code-line"><span class="ln">" 58"</span>"    let (store, mut grant) = fixture_with_three_rows();"</span>
                                    <span class="dw-code-line"><span class="ln">" 59"</span>"    assert_eq!(store.read(&grant, HEAD).unwrap().len(), 3);"</span>
                                    <span class="dw-code-line"><span class="ln">" 60"</span>"    grant.revoke(); // increments grant.revocation_epoch"</span>
                                    <span class="dw-code-line hl"><span class="ln">" 61"</span>"    assert_eq!(store.read(&grant, HEAD).unwrap().len(), 0); // ← returned 3"</span>
                                    <span class="dw-code-line"><span class="ln">" 62"</span>"}"</span>
                                </pre>
                                <div class="inspector-foot">
                                    <button
                                        type="button"
                                        class="button"
                                        on:click=move |_| jump_to_source(SourceTarget::ProjectionRs)
                                    >
                                        "← Jump to offending cache key (projection.rs:87)"
                                    </button>
                                    <button type="button" class="button primary" on:click=open_fix>
                                        "Preview 2-line fix →"
                                    </button>
                                </div>
                            </div>
                        }.into_any(),
                    },

                    InspectorTab::Fix => view! {
                        <div>
                            <div class="dw-code-path mono small">
                                <span class="badge running">"Generated with your BYO key"</span>
                                <span class="strong">"crates/source/src/projection.rs"</span>
                                <span class="spacer"></span>
                                <span class="muted">"+1 −1"</span>
                            </div>
                            <pre class="diff-body mono" style="border:0;border-radius:0;padding:10px 0">
                                <span class="diff-line"><span class="ln">"86"</span>" pub fn read(&self, grant: &Grant, rev: Oid) -> Result<Rows> {"</span>
                                <span class="diff-line del"><span class="ln">"87"</span>"-    let key = (grant.id, rev);"</span>
                                <span class="diff-line add"><span class="ln">"87"</span>"+    let key = (grant.id, grant.revocation_epoch, rev);"</span>
                                <span class="diff-line"><span class="ln">"88"</span>"     if let Some(rows) = self.cache.get(&key) {"</span>
                                <span class="diff-line"><span class="ln">"89"</span>"         return Ok(rows.clone());"</span>
                            </pre>
                            <div class="inspector-foot">
                                <p class="small muted">
                                    "Includes " <code>"grant.revocation_epoch"</code>
                                    " in the cache key so any revocation immediately misses the old cache entry."
                                </p>
                                <div class="actions" style="margin-top:6px">
                                    <button
                                        type="button"
                                        class="button primary"
                                        on:click=move |_| fix_applied.set(true)
                                    >
                                        {move || if fix_applied.get() {
                                            "✓ Pushed revision 3 to CR #42 (re-running test…)"
                                        } else {
                                            "Push revision 3 to CR #42"
                                        }}
                                    </button>
                                    <A href=move || format!("{}/changes/42", repo.get().path()) attr:class="button">
                                        "Open CR #42 →"
                                    </A>
                                </div>
                            </div>
                        </div>
                    }.into_any(),

                    InspectorTab::Cache => view! {
                        <div style="padding:14px">
                            <p class="small strong mono muted">"CONTENT-ADDRESSED CACHE PROVENANCE"</p>
                            <ul class="list" style="margin-top:8px">
                                <li class="list-row">
                                    <span class="badge cached">"cached"</span>
                                    <div>
                                        <p class="mono strong small">"lint · key 9f1e…a2"</p>
                                        <p class="small muted">"Matched main@0705846 · 0.4s replay · 0 min billed"</p>
                                    </div>
                                </li>
                                <li class="list-row">
                                    <span class="badge bad">"miss → failed"</span>
                                    <div>
                                        <p class="mono strong small">"test · key 51b0…7c"</p>
                                        <p class="small muted">"Invalidated by crates/source/src/projection.rs · 3m 12s on 8vCPU/16GB"</p>
                                    </div>
                                </li>
                                <li class="list-row">
                                    <span class="badge neutral">"skipped"</span>
                                    <div>
                                        <p class="mono strong small">"image · depends on test"</p>
                                        <p class="small muted">"Not started because upstream `test` exited with code 101"</p>
                                    </div>
                                </li>
                            </ul>
                            <p class="small muted" style="margin-top:10px">
                                "Runner: " <code>"Spot Firecracker · c8i.4xlarge · us-west-2"</code>
                                " · microVM destroyed after log upload."
                            </p>
                        </div>
                    }.into_any(),
                }}
            </aside>
        </div>
    }
}
