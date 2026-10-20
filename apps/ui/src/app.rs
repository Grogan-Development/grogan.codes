use std::sync::Arc;

use api_types::AiRunsOn;
use leptos::prelude::*;
use leptos_router::{
    components::{A, Outlet, ParentRoute, Route, Router, Routes},
    hooks::{use_navigate, use_query_map},
    path,
};

use crate::components::{NotBuilt, provider_label};
use crate::pages::{
    AiSettings, BuildList, BuildView, ChangeList, ChangeView, Inbox, Login, NotFound, RepoCode,
    RepoLayout, RepoSearch, RepoSpaces, Repos, Search, Spaces,
};
use crate::platform::{
    ActiveOrg, MockPlatform, PlatformHandle, PlatformKind, use_active_org, use_platform,
};

#[component]
pub fn App() -> impl IntoView {
    PlatformHandle::provide(Arc::new(MockPlatform::new(PlatformKind::Web)));
    provide_context(ActiveOrg(RwSignal::new(String::from("zack"))));

    view! {
        <Router>
            <PreviewFrame>
                <Routes fallback=|| view! { <NotFound/> }>
                    <Route path=path!("/login") view=Login/>
                    <ParentRoute path=path!("") view=Shell>
                        <Route path=path!("") view=Inbox/>
                        <Route path=path!("repos") view=Repos/>
                        <Route path=path!("search") view=Search/>
                        <Route path=path!("settings/ai") view=AiSettings/>
                        <Route path=path!("ask") view=|| view! { <NotBuilt board="5" title="Ask"/> }/>
                        <Route path=path!("spaces") view=Spaces/>
                        <Route path=path!("settings") view=|| view! { <NotBuilt board="M16 · D-Account" title="Settings"/> }/>
                        <Route path=path!("new") view=|| view! { <NotBuilt board="D4" title="New repo"/> }/>
                        <ParentRoute path=path!("r/:owner/:repo") view=RepoLayout>
                            <Route path=path!("") view=RepoCode/>
                            <Route path=path!("changes") view=ChangeList/>
                            <Route path=path!("changes/:n") view=ChangeView/>
                            <Route path=path!("builds") view=BuildList/>
                            <Route path=path!("builds/:id") view=BuildView/>
                            <Route path=path!("graph") view=RepoSearch/>
                            <Route path=path!("ask") view=RepoSearch/>
                            <Route path=path!("spaces") view=RepoSpaces/>
                            <Route path=path!("settings") view=|| view! { <NotBuilt board="D11" title="Repo settings"/> }/>
                        </ParentRoute>
                    </ParentRoute>
                </Routes>
            </PreviewFrame>
        </Router>
    }
}

/// Mock-only preview chrome: emulates each platform's capability flags and,
/// for mobile, a phone-width viewport. Initial value comes from `?platform=`.
#[component]
fn PreviewFrame(children: Children) -> impl IntoView {
    let platform = use_platform();
    let query = use_query_map();
    if let Some(kind) = query
        .get_untracked()
        .get("platform")
        .and_then(|value| PlatformKind::from_query(&value))
    {
        platform.set(Arc::new(MockPlatform::new(kind)));
    }
    let kind = move || platform.get().kind();

    view! {
        <div class="preview" class:mobile=move || kind().is_mobile()>
            <div class="viewport">{children()}</div>
            <div class="preview-bar" role="group" aria-label="Preview platform">
                <span class="preview-label">"Mock data · preview as"</span>
                {PlatformKind::ALL
                    .into_iter()
                    .map(|option| {
                        view! {
                            <button
                                class="preview-option"
                                class:active=move || kind() == option
                                on:click=move |_| platform.set(Arc::new(MockPlatform::new(option)))
                            >
                                {option.label()}
                            </button>
                        }
                    })
                    .collect_view()}
            </div>
        </div>
    }
}

#[component]
fn Shell() -> impl IntoView {
    view! {
        <div class="shell">
            <TopBar/>
            <main class="main">
                <Outlet/>
            </main>
        </div>
    }
}

#[component]
fn TopBar() -> impl IntoView {
    let platform = use_platform();
    let org = use_active_org();
    let navigate = use_navigate();
    let session = LocalResource::new(move || {
        let platform = platform.get();
        async move { platform.session().await }
    });
    let ai = LocalResource::new(move || {
        let platform = platform.get();
        async move { platform.ai_connections().await }
    });
    let query = RwSignal::new(String::new());

    let on_search = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        navigate(
            &format!("/search?q={}", query.get_untracked()),
            Default::default(),
        );
    };

    view! {
        <header class="topbar">
            <A href="/" attr:class="wordmark">
                <span class="wordmark-mark" aria-hidden="true">"g/"</span>
                "Grogan Code"
            </A>
            <Suspense fallback=|| ()>
                {move || {
                    session
                        .get()
                        .and_then(Result::ok)
                        .map(|session| {
                            view! {
                                <label class="org-switch">
                                    <span class="visually-hidden">"Organization"</span>
                                    <select
                                        prop:value=move || org.get()
                                        on:change=move |event| org.set(event_target_value(&event))
                                    >
                                        {session
                                            .orgs
                                            .into_iter()
                                            .map(|o| view! { <option value=o.slug.clone()>{o.name}</option> })
                                            .collect_view()}
                                    </select>
                                </label>
                            }
                        })
                }}
            </Suspense>
            <form class="search" role="search" on:submit=on_search>
                <input
                    type="search"
                    placeholder="Search code, symbols, repos…"
                    aria-label="Search"
                    bind:value=query
                />
                <kbd>"⌘K"</kbd>
            </form>
            <Suspense fallback=|| ()>
                {move || {
                    ai.get()
                        .and_then(Result::ok)
                        .map(|connections| {
                            let label = connections.first().map_or_else(
                                || String::from("Connect AI"),
                                |c| {
                                    let provider = provider_label(c.provider);
                                    let place = match c.runs_on {
                                        AiRunsOn::ThisDevice => "this device",
                                        AiRunsOn::UserSandbox => "sandbox",
                                    };
                                    format!("AI · {provider} · {place}")
                                },
                            );
                            view! { <A href="/settings/ai" attr:class="ai-chip">{label}</A> }
                        })
                }}
            </Suspense>
            <A href="/settings" attr:class="avatar" attr:aria-label="Account">"ZG"</A>
        </header>
    }
}
