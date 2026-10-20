//! AI Spaces: per-branch cloud dev machines with an agent attached.
//!
//! Contract note: Loom (`~/Repos/Loom`) has no Spaces backend yet. The shape
//! here mirrors its durable CI jobs (`jobs::CiDurableJob`): a Space is claimed
//! under a lease, runs in a disposable VM pinned by the CI worker fingerprint
//! (`ci_worker::ExecutionConfig`), hibernates at $0 when idle, and lands work
//! only as a change request. State changes below are local to this mock
//! session — a real `spaces` service would persist them the same way CI jobs
//! persist under `jobs/ci/`.

use api_types::{AiBilling, AiProvider, RepoRef, Space, SpaceAgent, SpaceStatus};
use leptos::prelude::*;
use leptos_router::components::A;

use super::use_repo_ref;
use crate::components::{billing_label, load, provider_label};
use crate::platform::{use_active_org, use_platform};

#[derive(Clone, Copy, PartialEq, Eq)]
enum StatusFilter {
    All,
    Running,
    Hibernated,
}

fn status_badge(status: SpaceStatus) -> impl IntoView {
    let (class, label) = match status {
        SpaceStatus::Starting => ("badge running", "starting"),
        SpaceStatus::Running => ("badge ok", "running"),
        SpaceStatus::Hibernated => ("badge neutral", "hibernated · $0/hr"),
        SpaceStatus::Stopped => ("badge neutral", "stopped"),
    };
    view! { <span class=class>{label}</span> }
}

fn billing_badge(billing: AiBilling) -> impl IntoView {
    let class = match billing {
        AiBilling::ManagedCredits => "badge cached",
        AiBilling::BringYourOwn => "badge open",
    };
    view! { <span class=class>{billing_label(billing)}</span> }
}

/// Global Spaces board (`/spaces`): every Space in the active org.
#[component]
pub fn Spaces() -> impl IntoView {
    let platform = use_platform();
    let org = use_active_org();
    let spaces = LocalResource::new(move || {
        let platform = platform.get();
        let org = org.get();
        async move { platform.spaces(org).await }
    });

    view! {
        <section class="page">
            <header class="page-head">
                <div>
                    <h1>"AI Spaces"</h1>
                    <p class="muted">
                        "Per-branch cloud dev machines, pre-warmed with the repo, build cache and code graph. "
                        "Agents work here; humans approve in change requests."
                    </p>
                </div>
            </header>
            {load(spaces, |spaces| view! { <SpaceBoard spaces/> })}
        </section>
    }
}

/// Repo-scoped Spaces (`/r/:owner/:repo/spaces`).
#[component]
pub fn RepoSpaces() -> impl IntoView {
    let platform = use_platform();
    let org = use_active_org();
    let repo = use_repo_ref();
    let spaces = LocalResource::new(move || {
        let platform = platform.get();
        let org = org.get();
        async move { platform.spaces(org).await }
    });

    view! {
        <section class="page">
            {load(spaces, move |spaces| {
                let current = repo.get();
                let scoped: Vec<Space> = spaces
                    .into_iter()
                    .filter(|space| space.repo == current)
                    .collect();
                view! { <SpaceBoard spaces=scoped/> }
            })}
        </section>
    }
}

#[component]
fn SpaceBoard(spaces: Vec<Space>) -> impl IntoView {
    let all = spaces.clone();
    let spaces = RwSignal::new(spaces);
    let filter = RwSignal::new(StatusFilter::All);
    let selected = RwSignal::new(all.first().map(|space| space.id.clone()));
    let show_new = RwSignal::new(false);
    let new_name = RwSignal::new(String::new());
    let new_task = RwSignal::new(String::new());
    let new_provider = RwSignal::new(AiProvider::Zai);

    let counts = {
        let running = all
            .iter()
            .filter(|space| space.status == SpaceStatus::Running)
            .count();
        let hibernated = all
            .iter()
            .filter(|space| space.status == SpaceStatus::Hibernated)
            .count();
        (all.len(), running, hibernated)
    };

    let set_status = move |id: String, status: SpaceStatus| {
        spaces.update(|list| {
            if let Some(space) = list.iter_mut().find(|space| space.id == id) {
                space.status = status;
                if status == SpaceStatus::Hibernated {
                    space.idle_for =
                        Some("hibernated just now · $0/hr · resumes in <1s".to_owned());
                } else if status == SpaceStatus::Running {
                    space.idle_for = None;
                }
            }
        });
    };

    view! {
        <div class="space-kpis">
            <div class="card">
                <p class="small muted mono">"SPACES"</p>
                <p class="kpi-num mono">{counts.0}</p>
                <p class="small muted">"one worktree branch each"</p>
            </div>
            <div class="card">
                <p class="small muted mono">"RUNNING"</p>
                <p class="kpi-num mono">{counts.1}</p>
                <p class="small muted">"disposable VMs · worker-pinned image"</p>
            </div>
            <div class="card">
                <p class="small muted mono">"HIBERNATED"</p>
                <p class="kpi-num mono">{counts.2}</p>
                <p class="small muted">"snapshot sealed · $0/hr while idle"</p>
            </div>
        </div>

        <div class="toolbar" style="margin-top:16px">
            <div class="log-filter-pills" role="group" aria-label="Filter spaces by status">
                <button
                    type="button"
                    class="dw-mode-pill"
                    class:active=move || filter.get() == StatusFilter::All
                    on:click=move |_| filter.set(StatusFilter::All)
                >
                    "All"
                </button>
                <button
                    type="button"
                    class="dw-mode-pill"
                    class:active=move || filter.get() == StatusFilter::Running
                    on:click=move |_| filter.set(StatusFilter::Running)
                >
                    "Running"
                </button>
                <button
                    type="button"
                    class="dw-mode-pill"
                    class:active=move || filter.get() == StatusFilter::Hibernated
                    on:click=move |_| filter.set(StatusFilter::Hibernated)
                >
                    "Hibernated"
                </button>
            </div>
            <span class="spacer"></span>
            <button
                type="button"
                class="button primary"
                on:click=move |_| show_new.update(|v| *v = !*v)
            >
                {move || if show_new.get() { "Close" } else { "+ New Space" }}
            </button>
        </div>

        <Show when=move || show_new.get()>
            <form
                class="card accent space-new"
                on:submit=move |event| {
                    event.prevent_default();
                    let name = new_name.get_untracked();
                    if name.trim().is_empty() {
                        return;
                    }
                    let provider = new_provider.get_untracked();
                    let billing = match provider {
                        AiProvider::ClaudeCode | AiProvider::Codex => AiBilling::BringYourOwn,
                        _ => AiBilling::ManagedCredits,
                    };
                    let id = format!("space-{name}");
                    spaces.update(|list| {
                        list.insert(
                            0,
                            Space {
                                id: id.clone(),
                                name: name.clone(),
                                repo: RepoRef::new("zack", "grogan-code"),
                                branch: format!("agent/{name}"),
                                status: SpaceStatus::Starting,
                                agent: SpaceAgent {
                                    provider,
                                    model: "default".to_owned(),
                                    billing,
                                },
                                machine: "4 vCPU · 8 GB".to_owned(),
                                task: new_task.get_untracked(),
                                change_number: None,
                                tests: None,
                                idle_for: None,
                                log: vec![
                                    "provisioning disposable VM (worker fingerprint loom-ci-worker.v1:…)".to_owned(),
                                ],
                            },
                        );
                    });
                    selected.set(Some(id));
                    show_new.set(false);
                }
            >
                <h2 class="card-title">"New Space — one branch, one agent, one task"</h2>
                <div class="space-form-grid">
                    <label>
                        <span class="small muted">"Name (becomes branch agent/<name>)"</span>
                        <input
                            type="text"
                            placeholder="e.g. go-indexer-bench"
                            prop:value=move || new_name.get()
                            on:input=move |event| new_name.set(event_target_value(&event))
                        />
                    </label>
                    <label>
                        <span class="small muted">"Task for the agent"</span>
                        <input
                            type="text"
                            placeholder="e.g. Fix revocation epoch cache key"
                            prop:value=move || new_task.get()
                            on:input=move |event| new_task.set(event_target_value(&event))
                        />
                    </label>
                    <label>
                        <span class="small muted">"Harness / provider"</span>
                        <select
                            on:change=move |event| {
                                let value = event_target_value(&event);
                                new_provider.set(match value.as_str() {
                                    "claude" => AiProvider::ClaudeCode,
                                    "minimax" => AiProvider::MiniMax,
                                    "mimo" => AiProvider::Mimo,
                                    "deepseek" => AiProvider::DeepSeek,
                                    _ => AiProvider::Zai,
                                });
                            }
                        >
                            <option value="zai">"Z.ai GLM (Grogan credits)"</option>
                            <option value="claude">"Claude Code (BYO sub)"</option>
                            <option value="minimax">"MiniMax (Coding Plan / credits)"</option>
                            <option value="mimo">"Xiaomi MiMo (credits)"</option>
                            <option value="deepseek">"DeepSeek (credits / BYO key)"</option>
                        </select>
                    </label>
                </div>
                <div class="actions">
                    <button type="submit" class="button primary">"Start Space"</button>
                    <span class="small muted">
                        "Boots pre-warmed with the repo, CI cache and code graph @ head. Lands work only as a change request."
                    </span>
                </div>
            </form>
        </Show>

        <div class="space-board">
            <ul class="list space-list">
                {move || {
                    let visible: Vec<Space> = spaces
                        .get()
                        .into_iter()
                        .filter(|space| match filter.get() {
                            StatusFilter::All => true,
                            StatusFilter::Running => {
                                matches!(space.status, SpaceStatus::Running | SpaceStatus::Starting)
                            }
                            StatusFilter::Hibernated => space.status == SpaceStatus::Hibernated,
                        })
                        .collect();
                    if visible.is_empty() {
                        return view! { <li class="empty">"No Spaces in this state."</li> }.into_any();
                    }
                    visible
                        .into_iter()
                        .map(|space| {
                            let id = space.id.clone();
                            let repo_path = space.repo.path();
                            view! {
                                <li
                                    class="list-row space-row"
                                    class:active=move || selected.get().as_deref() == Some(id.as_str())
                                    on:click={
                                        let id = space.id.clone();
                                        move |_| selected.set(Some(id.clone()))
                                    }
                                >
                                    {status_badge(space.status)}
                                    <div class="row-title">
                                        <span class="mono strong">{space.name.clone()}</span>
                                        <p class="small muted">{space.task.clone()}</p>
                                        <p class="small muted mono">
                                            {format!(
                                                "{}/{} · {} · {}",
                                                space.repo.owner,
                                                space.repo.name,
                                                space.branch,
                                                space.machine,
                                            )}
                                        </p>
                                    </div>
                                    <span class="mono small">
                                        {provider_label(space.agent.provider)}
                                        " "
                                        {billing_badge(space.agent.billing)}
                                    </span>
                                    {space.change_number.map(|number| {
                                        view! {
                                            <A
                                                href=format!("{repo_path}/changes/{number}")
                                                attr:class="badge open"
                                            >
                                                {format!("CR #{number}")}
                                            </A>
                                        }
                                    })}
                                </li>
                            }
                        })
                        .collect_view()
                        .into_any()
                }}
            </ul>

            <aside class="space-detail">
                {move || {
                    let list = spaces.get();
                    let Some(space) = list
                        .iter()
                        .find(|space| selected.get().as_deref() == Some(space.id.as_str()))
                        .or_else(|| list.first())
                    else {
                        return view! { <p class="empty">"Select a Space."</p> }.into_any();
                    };
                    let space = space.clone();
                    let id = space.id.clone();
                    let repo_path = space.repo.path();
                    view! {
                        <div class="card">
                            <h2 class="card-title mono">
                                {space.name.clone()}
                                <span class="spacer"></span>
                                {status_badge(space.status)}
                            </h2>
                            <ul class="mini-list">
                                <li>
                                    <span class="muted">"Agent"</span>
                                    <span class="mono small">
                                        {format!(
                                            "{} · {}",
                                            provider_label(space.agent.provider),
                                            space.agent.model,
                                        )}
                                        " "
                                        {billing_badge(space.agent.billing)}
                                    </span>
                                </li>
                                <li>
                                    <span class="muted">"Worktree"</span>
                                    <code>{space.branch.clone()}</code>
                                </li>
                                <li>
                                    <span class="muted">"Machine"</span>
                                    <span class="mono small">{space.machine.clone()}</span>
                                </li>
                                {space.tests.clone().map(|tests| {
                                    view! {
                                        <li>
                                            <span class="muted">"Tests"</span>
                                            <span class="mono small">{tests}</span>
                                        </li>
                                    }
                                })}
                                {space.idle_for.clone().map(|idle| {
                                    view! {
                                        <li>
                                            <span class="muted">"Idle"</span>
                                            <span class="small">{idle}</span>
                                        </li>
                                    }
                                })}
                            </ul>
                            <div class="actions">
                                {match space.status {
                                    SpaceStatus::Running | SpaceStatus::Starting => {
                                        let id = id.clone();
                                        view! {
                                            <button
                                                type="button"
                                                class="button"
                                                on:click=move |_| set_status(id.clone(), SpaceStatus::Hibernated)
                                            >
                                                "Hibernate (seal snapshot · $0/hr)"
                                            </button>
                                        }
                                            .into_any()
                                    }
                                    SpaceStatus::Hibernated => {
                                        view! {
                                            <button
                                                type="button"
                                                class="button primary"
                                                on:click=move |_| set_status(id.clone(), SpaceStatus::Running)
                                            >
                                                "Resume Space (<1s)"
                                            </button>
                                        }
                                            .into_any()
                                    }
                                    SpaceStatus::Stopped => view! { <span></span> }.into_any(),
                                }}
                                {space.change_number.map(|number| {
                                    view! {
                                        <A href=format!("{repo_path}/changes/{number}") attr:class="button">
                                            {format!("Review CR #{number} →")}
                                        </A>
                                    }
                                })}
                            </div>
                        </div>
                        <div class="log-card" style="margin-top:12px">
                            <div class="log-toolbar">
                                <span class="mono small strong">
                                    {format!("{} · agent session", space.id)}
                                </span>
                                <span class="spacer"></span>
                                <span class="mono small muted">"graph tools via grogan mcp"</span>
                            </div>
                            <pre class="log" style="margin-top:0;border-radius:0 0 6px 6px">
                                {space
                                    .log
                                    .iter()
                                    .cloned()
                                    .enumerate()
                                    .map(|(index, line)| {
                                        view! {
                                            <span class="log-line">
                                                <span class="ln">{index + 1}</span>
                                                {line}
                                            </span>
                                        }
                                    })
                                    .collect_view()}
                            </pre>
                        </div>
                        <p class="small muted" style="margin-top:10px">
                            "Agents can push their worktree branch and open a change request. "
                            "They can never approve, accept (Gate 2), or move a protected ref."
                        </p>
                    }
                        .into_any()
                }}
            </aside>
        </div>
    }
}
