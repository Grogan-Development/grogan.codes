use api_types::{ApiError, GenerationStatus, MapStatus, RepoMap, RepoRef, SearchResults};
use leptos::prelude::*;
use leptos_router::hooks::{use_navigate, use_query_map};

use super::use_repo_ref;
use crate::components::load;
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
        <section class="page wiki-page">
            {load(results, |results| view! { <WikiSurface results map=None/> })}
        </section>
    }
}

#[component]
pub fn RepoSearch() -> impl IntoView {
    let platform = use_platform();
    let repo = use_repo_ref();
    let query = use_query_map();
    let results = LocalResource::new(move || {
        let platform = platform.get();
        let repo: RepoRef = repo.get();
        let q = query.get().get("q").unwrap_or_default();
        async move { platform.search(repo, q).await }
    });
    let map = LocalResource::new(move || {
        let platform = platform.get();
        let repo: RepoRef = repo.get();
        async move { platform.repo_map(repo).await }
    });

    view! {
        <section class="page wiki-page">
            {load(results, move |results| {
                let results = results.clone();
                view! {
                    {load(map, move |map| {
                        view! { <WikiSurface results=results.clone() map=Some(map)/> }
                    })}
                }
            })}
        </section>
    }
}

/// Top-level state machine for the Wiki tab:
/// - `Browse(PageId)`: 3-column DeepWiki documentation reader (chapters left, article centre, TOC right)
/// - `Chat`: full-page 50/50 split (Answer / Codemap on the left, synced multi-file source reader on the right)
#[derive(Clone, PartialEq, Eq)]
enum SurfaceMode {
    Browse(PageId),
    Chat {
        question: String,
        view: ChatView,
        focus: CodeRef,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChatView {
    Fast,
    Codemap,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
enum SourceFile {
    PrincipalRs,
    RoleRs,
    AuditRs,
    RepoRs,
    MergeRs,
    AdminRs,
    MatrixTestRs,
}

impl SourceFile {
    const ALL: [Self; 7] = [
        Self::PrincipalRs,
        Self::RepoRs,
        Self::MergeRs,
        Self::AdminRs,
        Self::RoleRs,
        Self::AuditRs,
        Self::MatrixTestRs,
    ];

    const fn tab_label(self) -> &'static str {
        match self {
            Self::PrincipalRs => "principal.rs",
            Self::RoleRs => "role.rs",
            Self::AuditRs => "audit.rs",
            Self::RepoRs => "repo.rs",
            Self::MergeRs => "merge.rs",
            Self::AdminRs => "admin.rs",
            Self::MatrixTestRs => "matrix.rs",
        }
    }

    const fn full_path(self) -> &'static str {
        match self {
            Self::PrincipalRs => "crates/auth/src/principal.rs",
            Self::RoleRs => "crates/auth/src/role.rs",
            Self::AuditRs => "crates/auth/src/audit.rs",
            Self::RepoRs => "crates/api/src/repo.rs",
            Self::MergeRs => "crates/source/src/merge.rs",
            Self::AdminRs => "crates/api/src/admin.rs",
            Self::MatrixTestRs => "crates/auth/tests/matrix.rs",
        }
    }

    const fn lines(self) -> &'static [(u32, &'static str)] {
        match self {
            Self::PrincipalRs => &[
                (
                    48,
                    "/// Identity of the caller and the tenant memberships it holds.",
                ),
                (49, "pub struct Principal {"),
                (50, "    pub user: UserId,"),
                (51, "    pub roles: SmallVec<[(TenantId, OrgRole); 4]>,"),
                (52, "    pub audit: AuditHandle,"),
                (53, "}"),
                (54, "impl Principal {"),
                (
                    55,
                    "    pub fn allows(&self, perm: Perm, repo: &RepoId) -> bool {",
                ),
                (56, "        let role = self.role_in(repo.tenant());"),
                (57, "        let allowed = role.grants(perm);"),
                (
                    58,
                    "        self.audit.record(self.user, perm, repo, allowed);",
                ),
                (59, "        allowed"),
                (60, "    }"),
                (61, "}"),
            ],
            Self::RepoRs => &[
                (136, "/// Git smart-protocol `git-receive-pack` handler."),
                (
                    137,
                    "/// Rejects unauthorized callers before streaming pack bytes.",
                ),
                (138, "pub async fn push_refs("),
                (139, "    principal: &Principal,"),
                (140, "    repo: RepoId,"),
                (141, "    pack: PackStream,"),
                (142, ") -> Result<RefReport, ApiError> {"),
                (143, "    if !principal.allows(Perm::Write, &repo) {"),
                (144, "        return Err(ApiError::NotFound);"),
                (145, "    }"),
                (
                    146,
                    "    let unpacked = storage::receive_pack(&repo, pack).await?;",
                ),
                (
                    147,
                    "    refs::advance_fast_forward(&repo, &unpacked.updates).await",
                ),
                (148, "}"),
            ],
            Self::MergeRs => &[
                (
                    214,
                    "/// Enqueues an open change request onto the fast-forward merge train.",
                ),
                (215, "pub fn accept("),
                (216, "    principal: &Principal,"),
                (217, "    cr: &ChangeRequest,"),
                (218, ") -> Result<MergeTicket, MergeError> {"),
                (
                    219,
                    "    ensure!(principal.allows(Perm::Maintain, &cr.repo), MergeError::Denied);",
                ),
                (
                    220,
                    "    ensure!(cr.gates_satisfied(), MergeError::GatesPending);",
                ),
                (221, "    queue::enqueue(cr.id, cr.head_oid)"),
                (222, "}"),
            ],
            Self::AdminRs => &[
                (
                    82,
                    "// Invoked through `Box<dyn AdminAction>` in incident recovery.",
                ),
                (
                    83,
                    "// Marked `cand` in the graph because dispatch is dynamic.",
                ),
                (84, "impl AdminAction for ForceUpdate {"),
                (
                    85,
                    "    fn run(&self, principal: &Principal, repo: &RepoId, mv: RefMove) -> Result<(), AdminError> {",
                ),
                (86, "        if !principal.allows(Perm::Admin, repo) {"),
                (87, "            return Err(AdminError::Forbidden);"),
                (88, "        }"),
                (89, "        refs::force_move(repo, mv)"),
                (90, "    }"),
                (91, "}"),
            ],
            Self::RoleRs => &[
                (
                    28,
                    "/// Pure policy table mapping a tenant role to repository permissions.",
                ),
                (29, "impl OrgRole {"),
                (30, "    pub const fn grants(self, perm: Perm) -> bool {"),
                (31, "        match (self, perm) {"),
                (32, "            (Self::Owner, _) => true,"),
                (
                    33,
                    "            (Self::Admin, Perm::Read | Perm::Write | Perm::Maintain) => true,",
                ),
                (
                    34,
                    "            (Self::Member, Perm::Read | Perm::Write) => true,",
                ),
                (35, "            _ => false,"),
                (36, "        }"),
                (37, "    }"),
                (38, "}"),
            ],
            Self::AuditRs => &[
                (15, "impl AuditHandle {"),
                (
                    16,
                    "    /// Appends every allow/deny decision with principal, repo and revision.",
                ),
                (
                    17,
                    "    pub fn record(&self, user: UserId, perm: Perm, repo: &RepoId, allowed: bool) {",
                ),
                (
                    18,
                    "        self.ring.push(AuditEntry { user, perm, repo: repo.clone(), allowed });",
                ),
                (19, "    }"),
                (20, "}"),
            ],
            Self::MatrixTestRs => &[
                (9, "#[test]"),
                (10, "fn every_mutating_route_calls_principal_allows() {"),
                (
                    11,
                    "    for route in api::route_table().iter().filter(|r| r.mutates_storage()) {",
                ),
                (
                    12,
                    "        assert!(route.static_calls().contains(&Symbol::PrincipalAllows),",
                ),
                (
                    13,
                    "            \"route {} mutates storage without Principal::allows\", route.path);",
                ),
                (14, "    }"),
                (15, "}"),
            ],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct CodeRef {
    file: SourceFile,
    start: u32,
    end: u32,
}

impl CodeRef {
    const fn new(file: SourceFile, start: u32, end: u32) -> Self {
        Self { file, start, end }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PageId {
    Overview,
    ModuleAuth,
    ModuleApi,
    ModuleSource,
    SymAllows,
    SymPushRefs,
    SymAccept,
    SymForceUpdate,
    SymGrants,
    SymAuditRecord,
}

impl PageId {
    const fn label(self) -> &'static str {
        match self {
            Self::Overview => "Architecture Overview",
            Self::ModuleAuth => "Authorization (crates/auth)",
            Self::ModuleApi => "HTTP & Git Entry (crates/api)",
            Self::ModuleSource => "Storage & Merge Queue (crates/source)",
            Self::SymAllows => "Principal::allows",
            Self::SymPushRefs => "api::push_refs",
            Self::SymAccept => "source::accept",
            Self::SymForceUpdate => "api::force_update",
            Self::SymGrants => "Role::grants",
            Self::SymAuditRecord => "AuditLog::record",
        }
    }

    fn toc(self) -> Vec<(&'static str, &'static str)> {
        match self {
            Self::Overview => vec![
                ("#purpose", "Purpose & Scope"),
                ("#architecture", "Layered Architecture"),
                ("#flows", "End-to-End Request Flows"),
                ("#subsystems", "Subsystems & Crates"),
            ],
            Self::ModuleAuth | Self::ModuleApi | Self::ModuleSource => vec![
                ("#purpose", "Purpose & Scope"),
                ("#invariant", "Rule Enforced"),
                ("#symbols", "Key Symbols"),
            ],
            _ => vec![
                ("#purpose", "Purpose & Contract"),
                ("#impl", "1. Annotated Implementation"),
                ("#callers", "2. Inbound Call Sites"),
                ("#tests", "3. Guarding Tests"),
            ],
        }
    }
}

fn initial_mode(q: &str) -> SurfaceMode {
    let trimmed = q.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("overview") {
        return SurfaceMode::Browse(PageId::Overview);
    }
    let lower = trimmed.to_ascii_lowercase();
    let looks_like_question = lower.ends_with('?')
        || lower.contains(' ')
        || lower.starts_with("where")
        || lower.starts_with("why")
        || lower.starts_with("how")
        || lower.starts_with("what");
    if looks_like_question {
        return SurfaceMode::Chat {
            question: trimmed.to_owned(),
            view: ChatView::Fast,
            focus: CodeRef::new(SourceFile::RepoRs, 138, 148),
        };
    }
    let page = if trimmed.contains("push_refs") {
        PageId::SymPushRefs
    } else if trimmed.contains("accept") {
        PageId::SymAccept
    } else if trimmed.contains("force_update") {
        PageId::SymForceUpdate
    } else if trimmed.contains("grants") {
        PageId::SymGrants
    } else if trimmed.contains("record") {
        PageId::SymAuditRecord
    } else if trimmed.contains("crates/auth") {
        PageId::ModuleAuth
    } else if trimmed.contains("crates/api") {
        PageId::ModuleApi
    } else if trimmed.contains("crates/source") {
        PageId::ModuleSource
    } else {
        PageId::SymAllows
    };
    SurfaceMode::Browse(page)
}

#[component]
fn WikiSurface(results: SearchResults, map: Option<RepoMap>) -> impl IntoView {
    let mode = RwSignal::new(initial_mode(&results.query));
    let draft = RwSignal::new(String::new());
    let ask_view_pref = RwSignal::new(ChatView::Fast);
    let navigate = use_navigate();
    let repo = use_repo_ref();

    let start_question = move |q: String, view: ChatView, focus: CodeRef| {
        mode.set(SurfaceMode::Chat {
            question: q,
            view,
            focus,
        });
    };

    let on_submit = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let text = draft.get_untracked();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return;
        }
        let chosen_view = ask_view_pref.get_untracked();
        let focus = if trimmed.to_ascii_lowercase().contains("cache") {
            CodeRef::new(SourceFile::MatrixTestRs, 10, 15)
        } else {
            CodeRef::new(SourceFile::RepoRs, 138, 148)
        };
        start_question(trimmed.to_owned(), chosen_view, focus);
        draft.set(String::new());
        let path = repo.get_untracked().path();
        navigate(&format!("{path}/graph?q={trimmed}"), Default::default());
    };

    view! {
        {move || match mode.get() {
            SurfaceMode::Browse(active_page) => view! {
                <BrowseWiki
                    active_page=active_page
                    revision=results.revision.clone()
                    map=map.clone()
                    on_select_page=Callback::new(move |p| mode.set(SurfaceMode::Browse(p)))
                    on_open_chat=Callback::new(move |(q, v, f)| start_question(q, v, f))
                />
            }.into_any(),
            SurfaceMode::Chat { question, view, focus } => view! {
                <ChatSplitView
                    question=question
                    view=view
                    focus=focus
                    on_back_to_wiki=Callback::new(move |p: PageId| mode.set(SurfaceMode::Browse(p)))
                    on_switch_view=Callback::new(move |v: ChatView| {
                        ask_view_pref.set(v);
                        mode.update(|m| {
                            if let SurfaceMode::Chat { view, .. } = m {
                                *view = v;
                            }
                        });
                    })
                    on_focus_code=Callback::new(move |new_focus: CodeRef| {
                        mode.update(|m| {
                            if let SurfaceMode::Chat { focus, .. } = m {
                                *focus = new_focus;
                            }
                        });
                    })
                />
            }.into_any(),
        }}

        // Persistent DeepWiki-style floating bottom Ask dock (works in both Browse and Chat modes)
        <div class="dw-ask-float" role="region" aria-label="Ask this repository">
            <form class="dw-ask-box" on:submit=on_submit>
                <input
                    type="search"
                    placeholder=move || match mode.get() {
                        SurfaceMode::Browse(_) => "Ask Grogan Code about zack/grogan-code…",
                        SurfaceMode::Chat { .. } => "Ask a follow-up question…",
                    }
                    aria-label="Ask a question about this repository"
                    bind:value=draft
                />
                <div class="dw-ask-bar">
                    <div class="dw-mode-switch" role="group" aria-label="Answer mode">
                        <button
                            type="button"
                            class="dw-mode-pill"
                            class:active=move || ask_view_pref.get() == ChatView::Fast
                            on:click=move |_| {
                                ask_view_pref.set(ChatView::Fast);
                                mode.update(|m| {
                                    if let SurfaceMode::Chat { view, .. } = m {
                                        *view = ChatView::Fast;
                                    }
                                });
                            }
                        >
                            "⚡ Fast"
                        </button>
                        <button
                            type="button"
                            class="dw-mode-pill codemap"
                            class:active=move || ask_view_pref.get() == ChatView::Codemap
                            on:click=move |_| {
                                ask_view_pref.set(ChatView::Codemap);
                                mode.update(|m| {
                                    if let SurfaceMode::Chat { view, .. } = m {
                                        *view = ChatView::Codemap;
                                    }
                                });
                            }
                        >
                            "🗺 Codemap"
                        </button>
                        <span class="muted small mono">"BYO key · @ 0705846"</span>
                    </div>

                    <div class="dw-try-inline small">
                        <button
                            type="button"
                            class="chip"
                            on:click=move |_| start_question(
                                String::from("Where are refs updated on push?"),
                                ask_view_pref.get_untracked(),
                                CodeRef::new(SourceFile::RepoRs, 138, 148),
                            )
                        >
                            "“Where are refs updated on push?”"
                        </button>
                        <button
                            type="button"
                            class="chip"
                            on:click=move |_| start_question(
                                String::from("How does Principal::allows guard every route?"),
                                ChatView::Codemap,
                                CodeRef::new(SourceFile::PrincipalRs, 54, 60),
                            )
                        >
                            "🗺 Codemap: Principal::allows"
                        </button>
                    </div>

                    <button type="submit" class="dw-send-btn" aria-label="Submit question">"→"</button>
                </div>
            </form>
        </div>
    }
}

/// Full-page DeepWiki Chat / Codemap split view:
/// Left 50%: question header + Fast/Codemap toggle + structured answer or hierarchical codemap tree
/// Right 50%: sticky multi-file code viewer synced to every citation and codemap step
#[component]
fn ChatSplitView(
    question: String,
    view: ChatView,
    focus: CodeRef,
    on_back_to_wiki: Callback<PageId>,
    on_switch_view: Callback<ChatView>,
    on_focus_code: Callback<CodeRef>,
) -> impl IntoView {
    let cite_btn = move |label: &'static str, target: CodeRef| {
        let is_active = move || focus == target;
        view! {
            <button
                type="button"
                class="dw-cite-link"
                class:active=is_active
                on:click=move |_| on_focus_code.run(target)
            >
                {label}
            </button>
        }
    };

    view! {
        <div class="dw-chat-split">
            // Left pane: question, mode toggle, and either Fast answer or Codemap tree
            <div class="dw-chat-left">
                <div class="dw-chat-crumbs">
                    <button
                        type="button"
                        class="dw-back-link"
                        on:click=move |_| on_back_to_wiki.run(PageId::Overview)
                    >
                        "← zack/grogan-code Wiki"
                    </button>
                </div>

                <h1 class="dw-chat-q">{question}</h1>

                <div class="dw-chat-toolbar">
                    <button
                        type="button"
                        class="dw-view-chip"
                        class:active=move || view == ChatView::Fast
                        on:click=move |_| on_switch_view.run(ChatView::Fast)
                    >
                        "⚡ Fast"
                    </button>
                    <button
                        type="button"
                        class="dw-view-chip codemap"
                        class:active=move || view == ChatView::Codemap
                        on:click=move |_| on_switch_view.run(ChatView::Codemap)
                    >
                        {if view == ChatView::Codemap { "🗺 Viewing Codemap" } else { "🗺 View as codemap" }}
                    </button>
                </div>

                {match view {
                    ChatView::Fast => view! {
                        <div class="dw-answer-card">
                            <p class="dw-answer-lead">
                                "Refs are updated on push in "
                                <code>"api::push_refs"</code>
                                ", which gates on "
                                <code>"Principal::allows(Perm::Write, &repo)"</code>
                                " before reading a single byte from the incoming pack stream, then advances refs fast-forward. Merge-queue advances and admin overrides pass through the same permission gate with "
                                <code>"Perm::Maintain"</code>
                                " and "
                                <code>"Perm::Admin"</code>
                                "."
                                " "
                                {cite_btn("repo.rs:138-148", CodeRef::new(SourceFile::RepoRs, 138, 148))}
                                {cite_btn("principal.rs:54-60", CodeRef::new(SourceFile::PrincipalRs, 54, 60))}
                            </p>

                            <hr class="dw-answer-hr"/>

                            <h2 class="dw-answer-h2">"Core Characteristics"</h2>
                            <ul class="dw-answer-list">
                                <li>
                                    <span class="strong">"Gate before stream: "</span>
                                    <code>"api::push_refs"</code>
                                    " calls "
                                    <code>"principal.allows(Perm::Write, &repo)"</code>
                                    " prior to "
                                    <code>"storage::receive_pack"</code>
                                    ", returning "
                                    <code>"ApiError::NotFound"</code>
                                    " so private repos never leak existence. "
                                    {cite_btn("repo.rs:143-147", CodeRef::new(SourceFile::RepoRs, 143, 147))}
                                </li>
                                <li>
                                    <span class="strong">"Single policy + audit point: "</span>
                                    <code>"Principal::allows"</code>
                                    " resolves the caller's "
                                    <code>"OrgRole"</code>
                                    ", evaluates the pure table in "
                                    <code>"Role::grants"</code>
                                    ", and appends an entry to "
                                    <code>"AuditLog::record"</code>
                                    " on both allow and deny. "
                                    {cite_btn("principal.rs:55-60", CodeRef::new(SourceFile::PrincipalRs, 55, 60))}
                                    {cite_btn("role.rs:30-37", CodeRef::new(SourceFile::RoleRs, 30, 37))}
                                    {cite_btn("audit.rs:17-19", CodeRef::new(SourceFile::AuditRs, 17, 19))}
                                </li>
                                <li>
                                    <span class="strong">"Merge queue path: "</span>
                                    "change-request merges enter via "
                                    <code>"source::accept"</code>
                                    ", requiring "
                                    <code>"Perm::Maintain"</code>
                                    " and satisfied branch gates before enqueueing the head OID. "
                                    {cite_btn("merge.rs:215-222", CodeRef::new(SourceFile::MergeRs, 215, 222))}
                                </li>
                                <li>
                                    <span class="strong">"Inferred admin override ("</span>
                                    <span class="tier cand">"cand"</span>
                                    <span class="strong">"): "</span>
                                    <code>"ForceUpdate::run"</code>
                                    " moves refs non-fast-forward through a "
                                    <code>"dyn AdminAction"</code>
                                    " trait object after checking "
                                    <code>"Perm::Admin"</code>
                                    ". "
                                    {cite_btn("admin.rs:84-90", CodeRef::new(SourceFile::AdminRs, 84, 90))}
                                </li>
                            </ul>

                            <h2 class="dw-answer-h2">"How the workspace enforces this"</h2>
                            <p>
                                "The route-table test "
                                <code>"every_mutating_route_calls_principal_allows"</code>
                                " walks every registered handler in "
                                <code>"crates/api"</code>
                                " and asserts its static call set includes "
                                <code>"Principal::allows"</code>
                                ". "
                                {cite_btn("matrix.rs:10-15", CodeRef::new(SourceFile::MatrixTestRs, 10, 15))}
                            </p>

                            <div class="dw-explore-links">
                                <p class="small strong muted">"Wiki pages you might want to explore:"</p>
                                <ul>
                                    <li>
                                        <button type="button" class="inline-sym" on:click=move |_| on_back_to_wiki.run(PageId::Overview)>
                                            "Architecture Overview (zack/grogan-code)"
                                        </button>
                                    </li>
                                    <li>
                                        <button type="button" class="inline-sym" on:click=move |_| on_back_to_wiki.run(PageId::ModuleAuth)>
                                            "Authorization — crates/auth (zack/grogan-code)"
                                        </button>
                                    </li>
                                    <li>
                                        <button type="button" class="inline-sym" on:click=move |_| on_back_to_wiki.run(PageId::SymAllows)>
                                            "Principal::allows symbol reference (zack/grogan-code)"
                                        </button>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    }.into_any(),

                    ChatView::Codemap => view! {
                        <div class="dw-codemap">
                            <div class="dw-cm-intro">
                                <p class="strong">"Ref updates & Principal::allows — End-to-End Codemap"</p>
                                <p class="small muted">
                                    "Traces how every ref mutation enters the server, passes the permission gate, and updates pack storage. Notable locations: "
                                    {cite_btn("[1a]", CodeRef::new(SourceFile::RepoRs, 143, 145))}
                                    " receive-pack gate, "
                                    {cite_btn("[2a]", CodeRef::new(SourceFile::PrincipalRs, 55, 60))}
                                    " Principal::allows, "
                                    {cite_btn("[2b]", CodeRef::new(SourceFile::RoleRs, 30, 37))}
                                    " Role::grants, "
                                    {cite_btn("[3b]", CodeRef::new(SourceFile::AdminRs, 84, 90))}
                                    " trait-dispatched admin override."
                                </p>
                            </div>

                            <CodemapGroup
                                number="1"
                                title="What happens on `git push` — receive-pack entry to ref advance"
                                subtitle="Authenticates write permission before reading pack bytes, then advances refs fast-forward."
                                focus=focus
                                on_focus=on_focus_code
                                steps=vec![
                                    ("1a", "Gate push on Perm::Write", "repo.rs:143", "if !principal.allows(Perm::Write, &repo) { return Err(ApiError::NotFound); }", CodeRef::new(SourceFile::RepoRs, 143, 145), false),
                                    ("1b", "Stream and unpack git objects", "repo.rs:146", "let unpacked = storage::receive_pack(&repo, pack).await?;", CodeRef::new(SourceFile::RepoRs, 146, 146), false),
                                    ("1c", "Advance branch refs fast-forward", "repo.rs:147", "refs::advance_fast_forward(&repo, &unpacked.updates).await", CodeRef::new(SourceFile::RepoRs, 147, 148), false),
                                ]
                            />

                            <CodemapGroup
                                number="2"
                                title="How Principal::allows evaluates permissions & writes audit entries"
                                subtitle="Single authorization gate shared by HTTP routes, git smart protocol, and merge queue."
                                focus=focus
                                on_focus=on_focus_code
                                steps=vec![
                                    ("2a", "Resolve tenant role & check permission", "principal.rs:55", "pub fn allows(&self, perm: Perm, repo: &RepoId) -> bool", CodeRef::new(SourceFile::PrincipalRs, 55, 60), false),
                                    ("2b", "Pure role-to-permission table", "role.rs:30", "pub const fn grants(self, perm: Perm) -> bool", CodeRef::new(SourceFile::RoleRs, 30, 37), false),
                                    ("2c", "Append allow/deny decision to audit ring", "audit.rs:17", "self.audit.record(self.user, perm, repo, allowed);", CodeRef::new(SourceFile::AuditRs, 17, 19), false),
                                ]
                            />

                            <CodemapGroup
                                number="3"
                                title="Other paths that move refs — merge queue & emergency admin override"
                                subtitle="Both pass through Principal::allows; force_update is marked cand due to dynamic dispatch."
                                focus=focus
                                on_focus=on_focus_code
                                steps=vec![
                                    ("3a", "Fast-forward merge queue gate", "merge.rs:219", "ensure!(principal.allows(Perm::Maintain, &cr.repo), MergeError::Denied);", CodeRef::new(SourceFile::MergeRs, 215, 222), false),
                                    ("3b", "Inferred dyn AdminAction ref move (cand)", "admin.rs:86", "if !principal.allows(Perm::Admin, repo) { return Err(AdminError::Forbidden); }", CodeRef::new(SourceFile::AdminRs, 84, 90), true),
                                    ("3c", "Static route-table invariant test", "matrix.rs:12", "assert!(route.static_calls().contains(&Symbol::PrincipalAllows));", CodeRef::new(SourceFile::MatrixTestRs, 10, 15), false),
                                ]
                            />
                        </div>
                    }.into_any(),
                }}
            </div>

            // Right pane: DeepWiki-style sticky multi-file code viewer with tabs & highlighted lines
            <aside class="dw-code-pane" aria-label="Referenced source code">
                <div class="dw-code-tabs" role="tablist">
                    {SourceFile::ALL
                        .into_iter()
                        .map(|file| {
                            view! {
                                <button
                                    type="button"
                                    role="tab"
                                    class="dw-code-tab"
                                    class:active=move || focus.file == file
                                    on:click=move |_| {
                                        let first = file.lines().first().map_or(1, |(n, _)| *n);
                                        let last = file.lines().last().map_or(first, |(n, _)| *n);
                                        on_focus_code.run(CodeRef::new(file, first, last));
                                    }
                                >
                                    {file.tab_label()}
                                </button>
                            }
                        })
                        .collect_view()}
                </div>

                <div class="dw-code-path mono small">
                    <span class="muted">"zack/grogan-code · "</span>
                    <span class="strong">{focus.file.full_path()}</span>
                    <span class="spacer"></span>
                    <span class="muted">{format!("lines {}–{}", focus.start, focus.end)}</span>
                </div>

                <pre class="dw-code-view mono">
                    {focus
                        .file
                        .lines()
                        .iter()
                        .map(|(line_no, text)| {
                            let highlighted = *line_no >= focus.start && *line_no <= focus.end;
                            view! {
                                <span class="dw-code-line" class:hl=highlighted>
                                    <span class="ln">{format!("{line_no:>3}")}</span>
                                    {*text}
                                </span>
                            }
                        })
                        .collect_view()}
                </pre>
            </aside>
        </div>
    }
}

#[allow(clippy::type_complexity)]
#[component]
fn CodemapGroup(
    number: &'static str,
    title: &'static str,
    subtitle: &'static str,
    focus: CodeRef,
    on_focus: Callback<CodeRef>,
    steps: Vec<(
        &'static str,
        &'static str,
        &'static str,
        &'static str,
        CodeRef,
        bool,
    )>,
) -> impl IntoView {
    view! {
        <section class="dw-cm-group">
            <header class="dw-cm-head">
                <span class="dw-cm-num mono">{number}</span>
                <div>
                    <h3 class="dw-cm-title">{title}</h3>
                    <p class="small muted">{subtitle}</p>
                </div>
            </header>
            <ol class="dw-cm-steps">
                {steps
                    .into_iter()
                    .map(|(id, label, loc, snippet, target, is_cand)| {
                        let active = focus == target;
                        view! {
                            <li>
                                <button
                                    type="button"
                                    class="dw-cm-step"
                                    class:active=active
                                    class:cand=is_cand
                                    on:click=move |_| on_focus.run(target)
                                >
                                    <div class="dw-cm-step-top">
                                        <span class="dw-cm-step-id mono">{id}</span>
                                        <span class="strong">{label}</span>
                                        {is_cand.then(|| view! { <span class="tier cand">"cand"</span> })}
                                        <span class="spacer"></span>
                                        <span class="mono small muted">{loc}</span>
                                    </div>
                                    <code class="dw-cm-snippet mono">{snippet}</code>
                                </button>
                            </li>
                        }
                    })
                    .collect_view()}
            </ol>
        </section>
    }
}

/// Inline DeepWiki-style source citation pill (`path start-end`).
#[component]
fn Cite(
    file: &'static str,
    lines: &'static str,
    #[prop(optional)] target: Option<PageId>,
    #[prop(optional)] on_jump: Option<Callback<PageId>>,
) -> impl IntoView {
    let label = format!("{file}:{lines}");
    match (target, on_jump) {
        (Some(page), Some(cb)) => view! {
            <button type="button" class="dw-cite-link" on:click=move |_| cb.run(page)>
                {label}
            </button>
        }
        .into_any(),
        _ => view! { <span class="dw-cite-link">{label}</span> }.into_any(),
    }
}

/// 3-column DeepWiki documentation reader (when browsing chapters rather than asking a question).
#[component]
fn BrowseWiki(
    active_page: PageId,
    revision: String,
    map: Option<RepoMap>,
    on_select_page: Callback<PageId>,
    on_open_chat: Callback<(String, ChatView, CodeRef)>,
) -> impl IntoView {
    let show_sources = RwSignal::new(false);
    let rerun_queued = RwSignal::new(false);

    let nav_item = move |id: PageId, indent: bool| {
        view! {
            <li>
                <button
                    type="button"
                    class="wiki-nav-btn"
                    class:indent=indent
                    class:active=move || active_page == id
                    on:click=move |_| on_select_page.run(id)
                >
                    {id.label()}
                </button>
            </li>
        }
    };

    view! {
        <div class="dw-shell">
            <aside class="dw-nav" aria-label="Wiki navigation">
                <div class="dw-indexed">
                    <p class="small muted">"Last indexed"</p>
                    <p class="mono small strong">
                        "19 Oct 2026 (" <code>{revision.clone()}</code> ")"
                    </p>
                    <p class="small muted">"67 files · 94% exact · 6% cand"</p>
                </div>

                <p class="wiki-tree-head">"Getting Started"</p>
                <ul>
                    {nav_item(PageId::Overview, false)}
                </ul>

                <p class="wiki-tree-head">"Core Subsystems"</p>
                <ul>
                    {nav_item(PageId::ModuleAuth, false)}
                    {nav_item(PageId::SymAllows, true)}
                    {nav_item(PageId::SymGrants, true)}
                    {nav_item(PageId::SymAuditRecord, true)}
                    {nav_item(PageId::ModuleApi, false)}
                    {nav_item(PageId::SymPushRefs, true)}
                    {nav_item(PageId::SymForceUpdate, true)}
                    {nav_item(PageId::ModuleSource, false)}
                    {nav_item(PageId::SymAccept, true)}
                </ul>
            </aside>

            <div class="dw-article">
                <div class="dw-sources-toggle">
                    <button
                        type="button"
                        class="sources-btn mono small"
                        on:click=move |_| show_sources.update(|v| *v = !*v)
                    >
                        <span>{move || if show_sources.get() { "▾" } else { "▸" }}</span>
                        " Relevant source files (6)"
                    </button>
                    <button
                        type="button"
                        class="dw-view-chip codemap"
                        on:click=move |_| on_open_chat.run((
                            String::from("How does Principal::allows guard every route?"),
                            ChatView::Codemap,
                            CodeRef::new(SourceFile::PrincipalRs, 54, 60),
                        ))
                    >
                        "🗺 Open interactive Codemap"
                    </button>
                    <Show when=move || show_sources.get()>
                        <div class="sources-drawer">
                            <Cite file="crates/auth/src/principal.rs" lines="1-92" target=PageId::SymAllows on_jump=on_select_page/>
                            <Cite file="crates/auth/src/role.rs" lines="1-64" target=PageId::SymGrants on_jump=on_select_page/>
                            <Cite file="crates/auth/src/audit.rs" lines="1-48" target=PageId::SymAuditRecord on_jump=on_select_page/>
                            <Cite file="crates/api/src/repo.rs" lines="110-168" target=PageId::SymPushRefs on_jump=on_select_page/>
                            <Cite file="crates/api/src/admin.rs" lines="70-112" target=PageId::SymForceUpdate on_jump=on_select_page/>
                            <Cite file="crates/source/src/merge.rs" lines="190-245" target=PageId::SymAccept on_jump=on_select_page/>
                        </div>
                    </Show>
                </div>

                {match active_page {
                    PageId::Overview => view! { <OverviewDoc on_jump=on_select_page on_open_chat=on_open_chat/> }.into_any(),
                    PageId::ModuleAuth => view! { <ModuleDoc
                        name="Authorization (crates/auth)"
                        summary="Owns principals, repository-scoped permissions, and the single authorization gate every mutating route must pass."
                        invariant="No crate outside crates/auth may construct a Perm grant directly; callers pass a Principal into Principal::allows, which checks Role::grants and writes an AuditLog entry before returning."
                        files="crates/auth · 14 files · exact 98%"
                        cite_file="crates/auth/src/principal.rs"
                        cite_lines="1-92"
                        symbols=vec![
                            (PageId::SymAllows, "Principal::allows", "crates/auth/src/principal.rs", "54-60", "Central permission gate called by every route and merge queue operation."),
                            (PageId::SymGrants, "Role::grants", "crates/auth/src/role.rs", "30-37", "Pure table mapping OrgRole (Owner / Admin / Member) to concrete Perm flags."),
                            (PageId::SymAuditRecord, "AuditLog::record", "crates/auth/src/audit.rs", "17-19", "Appends every allow/deny decision with principal, repo and revision."),
                        ]
                        on_jump=on_select_page
                    /> }.into_any(),
                    PageId::ModuleApi => view! { <ModuleDoc
                        name="HTTP & Git Entry (crates/api)"
                        summary="HTTP and git smart-protocol entry points. Authenticates the session or token, resolves the tenant and repository, then delegates to crates/auth and crates/source."
                        invariant="Every mutating handler must call Principal::allows before opening a pack or mutating refs; crates/auth/tests/matrix.rs walks the route table to enforce this."
                        files="crates/api · 22 files · exact 94%"
                        cite_file="crates/api/src/repo.rs"
                        cite_lines="138-148"
                        symbols=vec![
                            (PageId::SymPushRefs, "api::push_refs", "crates/api/src/repo.rs", "138-148", "Git receive-pack handler; checks Perm::Write before streaming pack bytes."),
                            (PageId::SymForceUpdate, "api::force_update", "crates/api/src/admin.rs", "84-90", "Admin ref override; reached via dyn AdminAction trait dispatch (cand edge)."),
                        ]
                        on_jump=on_select_page
                    /> }.into_any(),
                    PageId::ModuleSource => view! { <ModuleDoc
                        name="Storage & Merge Queue (crates/source)"
                        summary="Content-addressed pack storage, fast-forward merge queue, and scoped read projections."
                        invariant="Merge queue advances a target branch only when all required gates pass on the current patch-set head OID."
                        files="crates/source · 31 files · exact 91%"
                        cite_file="crates/source/src/merge.rs"
                        cite_lines="215-222"
                        symbols=vec![
                            (PageId::SymAccept, "source::accept", "crates/source/src/merge.rs", "215-222", "Queues a change request for fast-forward merge after checking Perm::Maintain."),
                        ]
                        on_jump=on_select_page
                    /> }.into_any(),
                    other => view! { <SymbolDoc page=other on_jump=on_select_page on_open_chat=on_open_chat/> }.into_any(),
                }}
            </div>

            <aside class="dw-toc" aria-label="On this page">
                <div class="dw-toc-card">
                    <p class="dw-toc-title">"On this page"</p>
                    <ul class="dw-toc-list">
                        {active_page.toc().into_iter().map(|(href, label)| {
                            view! { <li><a href=href>{label}</a></li> }
                        }).collect_view()}
                    </ul>
                </div>

                <div class="dw-toc-card">
                    <p class="dw-toc-title">"Provenance"</p>
                    <p class="small muted">
                        "Prose is generated with your BYO AI key and grounded in the compiler graph at "
                        <code>{revision}</code> "."
                    </p>
                    <div class="dw-legend small">
                        <div><span class="tier exact">"exact"</span> " compiler-proven call edge"</div>
                        <div><span class="tier cand">"cand"</span> " inferred (trait/macro) — verify"</div>
                    </div>
                </div>

                {map.map(|map| {
                    let status = match map.status {
                        MapStatus::Ready => ("badge ok", "map ready"),
                        MapStatus::Pending => ("badge running", "map pending"),
                        MapStatus::Failed => ("badge bad", "map failed"),
                        MapStatus::Missing => ("badge neutral", "no map yet"),
                    };
                    let generation = match map.generation_status {
                        Some(GenerationStatus::Complete) => "complete · selectable",
                        Some(GenerationStatus::Failed) => "failed · never selectable",
                        None => "—",
                    };
                    view! {
                        <div class="dw-toc-card">
                            <p class="dw-toc-title">
                                "Code map " <span class=status.0>{status.1}</span>
                            </p>
                            <p class="mono small muted">
                                {format!(
                                    "{} · {}",
                                    map.generation.as_deref().unwrap_or("no generation"),
                                    generation,
                                )}
                            </p>
                            <ul class="dw-toc-list" style="margin-top:8px">
                                {map
                                    .identities
                                    .iter()
                                    .map(|identity| {
                                        view! {
                                            <li>
                                                <span class="mono strong small">{identity.id.clone()}</span>
                                                <span class="muted small">
                                                    {format!(
                                                        " · {} · {} anchor(s)",
                                                        identity.kind,
                                                        identity.paths.len(),
                                                    )}
                                                </span>
                                            </li>
                                        }
                                    })
                                    .collect_view()}
                            </ul>
                            <p class="small muted" style="margin-top:8px">
                                {format!(
                                    "{} supports edge(s): {}",
                                    map.supports.len(),
                                    map.supports
                                        .iter()
                                        .map(|edge| format!(
                                            "{} → {}{}",
                                            edge.source,
                                            edge.target,
                                            if edge.shared { " (shared)" } else { "" },
                                        ))
                                        .collect::<Vec<_>>()
                                        .join(" · "),
                                )}
                            </p>
                            {map.provenance.map(|prov| {
                                view! {
                                    <p class="small muted" style="margin-top:8px">
                                        "Generated by "
                                        <span class="mono strong">
                                            {format!("{}/{} via {}", prov.provider, prov.model, prov.route)}
                                        </span>
                                        {format!(
                                            " · {} in / {} out tokens · ${:.2} (provenance only — no credential stored)",
                                            prov.input_tokens,
                                            prov.output_tokens,
                                            prov.cost_micros as f64 / 1_000_000.0,
                                        )}
                                    </p>
                                }
                            })}
                            <button
                                type="button"
                                class="button"
                                style="margin-top:10px"
                                on:click=move |_| rerun_queued.set(true)
                            >
                                {move || if rerun_queued.get() {
                                    "✓ Rerun queued — new generation, never overwrites the selected one"
                                } else {
                                    "↻ Rerun map for this revision"
                                }}
                            </button>
                        </div>
                    }
                })}
            </aside>
        </div>
    }
}

#[component]
fn OverviewDoc(
    on_jump: Callback<PageId>,
    on_open_chat: Callback<(String, ChatView, CodeRef)>,
) -> impl IntoView {
    view! {
        <article class="card dw-doc">
            <h1 id="purpose" class="dw-h1">"Architecture Overview"</h1>
            <p class="lede">
                "Grogan Code separates network entry points in "
                <code>"crates/api"</code> " "
                <Cite file="crates/api/src/repo.rs" lines="138-148" target=PageId::ModuleApi on_jump=on_jump/>
                ", workspace authorization in "
                <code>"crates/auth"</code> " "
                <Cite file="crates/auth/src/principal.rs" lines="54-60" target=PageId::ModuleAuth on_jump=on_jump/>
                ", and git pack storage and merge queues in "
                <code>"crates/source"</code> " "
                <Cite file="crates/source/src/merge.rs" lines="215-222" target=PageId::ModuleSource on_jump=on_jump/>
                ". Every mutating operation passes through a single permission gate before touching storage."
            </p>

            <h2 id="architecture" class="dw-h2">"Layered Crate Architecture"</h2>
            <p class="muted">
                "Click any node below to open its symbol page, or "
                <button
                    type="button"
                    class="inline-sym strong"
                    on:click=move |_| on_open_chat.run((
                        String::from("Where are refs updated on push?"),
                        ChatView::Codemap,
                        CodeRef::new(SourceFile::RepoRs, 138, 148),
                    ))
                >
                    "open this flow in the side-by-side Codemap reader →"
                </button>
            </p>

            <div class="layer-diagram" role="region" aria-label="Layered crate architecture">
                <div class="layer-stage">
                    <p class="layer-title">"1 · Entry Layer (crates/api)"</p>
                    <div class="layer-nodes">
                        <button type="button" class="layer-node" on:click=move |_| on_jump.run(PageId::SymPushRefs)>
                            <span class="tier exact">"exact"</span>
                            <span class="mono strong">"api::push_refs"</span>
                            <span class="mono small muted">"repo.rs:142 · Perm::Write"</span>
                        </button>
                        <button type="button" class="layer-node" on:click=move |_| on_jump.run(PageId::SymAccept)>
                            <span class="tier exact">"exact"</span>
                            <span class="mono strong">"source::accept"</span>
                            <span class="mono small muted">"merge.rs:219 · Perm::Maintain"</span>
                        </button>
                        <button type="button" class="layer-node cand" on:click=move |_| on_jump.run(PageId::SymForceUpdate)>
                            <span class="tier cand">"cand"</span>
                            <span class="mono strong">"api::force_update"</span>
                            <span class="mono small muted">"admin.rs:86 · Perm::Admin"</span>
                        </button>
                    </div>
                </div>
                <div class="layer-connector" aria-hidden="true"><span>"all mutating paths must pass ──▶"</span></div>
                <div class="layer-stage focus">
                    <p class="layer-title">"2 · Authorization Gate (crates/auth)"</p>
                    <div class="layer-nodes">
                        <button type="button" class="layer-node primary" on:click=move |_| on_jump.run(PageId::SymAllows)>
                            <span class="tier exact">"exact"</span>
                            <span class="mono strong">"Principal::allows(&self, perm, repo)"</span>
                            <span class="mono small">"crates/auth/src/principal.rs:55"</span>
                        </button>
                    </div>
                </div>
                <div class="layer-connector" aria-hidden="true"><span>"checks role & logs decision ──▶"</span></div>
                <div class="layer-stage">
                    <p class="layer-title">"3 · Policy Table & Audit (crates/auth)"</p>
                    <div class="layer-nodes">
                        <button type="button" class="layer-node" on:click=move |_| on_jump.run(PageId::SymGrants)>
                            <span class="tier exact">"exact"</span>
                            <span class="mono strong">"Role::grants"</span>
                            <span class="mono small muted">"role.rs:30 · Owner/Admin/Member → Perm"</span>
                        </button>
                        <button type="button" class="layer-node" on:click=move |_| on_jump.run(PageId::SymAuditRecord)>
                            <span class="tier exact">"exact"</span>
                            <span class="mono strong">"AuditLog::record"</span>
                            <span class="mono small muted">"audit.rs:17 · records allow & deny"</span>
                        </button>
                    </div>
                </div>
            </div>

            <h2 id="flows" class="dw-h2">"End-to-End Request Flows"</h2>
            <ul class="dw-prose-list">
                <li>
                    <span class="strong">"Git push (" <code>"POST /:owner/:repo/git-receive-pack"</code> "): "</span>
                    "enters "
                    <button type="button" class="inline-sym mono" on:click=move |_| on_jump.run(PageId::SymPushRefs)>"api::push_refs"</button>
                    " " <Cite file="crates/api/src/repo.rs" lines="138-148" target=PageId::SymPushRefs on_jump=on_jump/>
                    ", which checks " <code>"Principal::allows(Perm::Write, &repo)"</code>
                    " before reading pack bytes."
                </li>
                <li>
                    <span class="strong">"Change-request merge (" <code>"POST /changes/:n/accept"</code> "): "</span>
                    "calls "
                    <button type="button" class="inline-sym mono" on:click=move |_| on_jump.run(PageId::SymAccept)>"source::accept"</button>
                    " " <Cite file="crates/source/src/merge.rs" lines="215-222" target=PageId::SymAccept on_jump=on_jump/>
                    ", requiring " <code>"Perm::Maintain"</code> "."
                </li>
                <li>
                    <span class="strong">"Emergency ref move (" <code>"dyn AdminAction"</code> "): "</span>
                    "dispatches to "
                    <button type="button" class="inline-sym mono" on:click=move |_| on_jump.run(PageId::SymForceUpdate)>"api::force_update"</button>
                    " " <Cite file="crates/api/src/admin.rs" lines="84-90" target=PageId::SymForceUpdate on_jump=on_jump/>
                    " (" <span class="tier cand">"cand"</span> " edge via trait object)."
                </li>
            </ul>

            <h2 id="subsystems" class="dw-h2">"Subsystems & Crates"</h2>
            <div class="module-grid">
                <button type="button" class="card link-card text-left" on:click=move |_| on_jump.run(PageId::ModuleAuth)>
                    <p class="mono strong">"crates/auth"</p>
                    <p class="muted small">"Principals, role grants, audit log · 14 files · 98% exact"</p>
                </button>
                <button type="button" class="card link-card text-left" on:click=move |_| on_jump.run(PageId::ModuleApi)>
                    <p class="mono strong">"crates/api"</p>
                    <p class="muted small">"HTTP + git smart-protocol routes · 22 files · 94% exact"</p>
                </button>
                <button type="button" class="card link-card text-left" on:click=move |_| on_jump.run(PageId::ModuleSource)>
                    <p class="mono strong">"crates/source"</p>
                    <p class="muted small">"Pack store, merge queue, projections · 31 files · 91% exact"</p>
                </button>
            </div>
        </article>
    }
}

#[allow(clippy::too_many_arguments)]
#[component]
fn ModuleDoc(
    name: &'static str,
    summary: &'static str,
    invariant: &'static str,
    files: &'static str,
    cite_file: &'static str,
    cite_lines: &'static str,
    symbols: Vec<(
        PageId,
        &'static str,
        &'static str,
        &'static str,
        &'static str,
    )>,
    on_jump: Callback<PageId>,
) -> impl IntoView {
    view! {
        <article class="card dw-doc">
            <div class="wiki-doc-head">
                <h1 id="purpose" class="dw-h1">{name}</h1>
                <span class="mono muted small">{files}</span>
            </div>
            <p class="lede">
                {summary} " "
                <Cite file=cite_file lines=cite_lines/>
            </p>
            <div id="invariant" class="invariant-box">
                <p class="small strong">"Rule enforced by this subsystem"</p>
                <p>{invariant}</p>
            </div>
            <h2 id="symbols" class="dw-h2">"Key Symbols"</h2>
            <ul class="list">
                {symbols
                    .into_iter()
                    .map(|(page, sym, file, lines, desc)| {
                        view! {
                            <li class="list-row">
                                <span class="tier exact">"exact"</span>
                                <button type="button" class="inline-sym mono strong" on:click=move |_| on_jump.run(page)>
                                    {sym}
                                </button>
                                <span class="muted">{desc}</span>
                                <Cite file=file lines=lines target=page on_jump=on_jump/>
                            </li>
                        }
                    })
                    .collect_view()}
            </ul>
        </article>
    }
}

struct SymbolSpec {
    title: &'static str,
    module: PageId,
    file: &'static str,
    lines: &'static str,
    code_ref: CodeRef,
    purpose: &'static str,
    rule: &'static str,
}

fn symbol_spec(page: PageId) -> SymbolSpec {
    match page {
        PageId::SymPushRefs => SymbolSpec {
            title: "api::push_refs",
            module: PageId::ModuleApi,
            file: "crates/api/src/repo.rs",
            lines: "138-148",
            code_ref: CodeRef::new(SourceFile::RepoRs, 138, 148),
            purpose: "Git receive-pack entry point. Checks that the caller has Perm::Write on the repository before reading the pack stream or advancing branch refs.",
            rule: "Must reject unauthorized pushes before streaming pack bytes from the client.",
        },
        PageId::SymAccept => SymbolSpec {
            title: "source::accept",
            module: PageId::ModuleSource,
            file: "crates/source/src/merge.rs",
            lines: "215-222",
            code_ref: CodeRef::new(SourceFile::MergeRs, 215, 222),
            purpose: "Queues an open change request for fast-forward merge once checks, approvals and linear-history gates pass on the current patch set.",
            rule: "Requires Perm::Maintain via Principal::allows and re-checks gates against the current head OID.",
        },
        PageId::SymForceUpdate => SymbolSpec {
            title: "api::force_update",
            module: PageId::ModuleApi,
            file: "crates/api/src/admin.rs",
            lines: "84-90",
            code_ref: CodeRef::new(SourceFile::AdminRs, 84, 90),
            purpose: "Emergency non-fast-forward ref move for repository owners and incident recovery.",
            rule: "Requires Perm::Admin. Reached through a dyn AdminAction trait object (cand edge).",
        },
        PageId::SymGrants => SymbolSpec {
            title: "Role::grants",
            module: PageId::ModuleAuth,
            file: "crates/auth/src/role.rs",
            lines: "30-37",
            code_ref: CodeRef::new(SourceFile::RoleRs, 30, 37),
            purpose: "Pure table mapping an OrgRole (Owner, Admin, Member) to the Perm flags it confers on a repository.",
            rule: "Pure function with no I/O; exhaustively tested in crates/auth/tests/matrix.rs.",
        },
        PageId::SymAuditRecord => SymbolSpec {
            title: "AuditLog::record",
            module: PageId::ModuleAuth,
            file: "crates/auth/src/audit.rs",
            lines: "17-19",
            code_ref: CodeRef::new(SourceFile::AuditRs, 17, 19),
            purpose: "Writes every allow or deny decision to the append-only audit log with principal, repository, permission and revision.",
            rule: "Called on every Principal::allows check before the boolean decision is returned.",
        },
        _ => SymbolSpec {
            title: "Principal::allows",
            module: PageId::ModuleAuth,
            file: "crates/auth/src/principal.rs",
            lines: "54-60",
            code_ref: CodeRef::new(SourceFile::PrincipalRs, 54, 60),
            purpose: "Single permission gate for the workspace. Checks whether the caller's role in the repository's owning tenant grants the requested permission, and logs the decision before returning.",
            rule: "Every mutating route in crates/api and crates/source must call this before touching storage.",
        },
    }
}

#[component]
fn SymbolDoc(
    page: PageId,
    on_jump: Callback<PageId>,
    on_open_chat: Callback<(String, ChatView, CodeRef)>,
) -> impl IntoView {
    let spec = symbol_spec(page);

    view! {
        <article class="card dw-doc">
            <div class="wiki-doc-head">
                <p class="small muted">
                    <button type="button" class="inline-sym" on:click=move |_| on_jump.run(spec.module)>
                        {spec.module.label()}
                    </button>
                    " · "
                    <Cite file=spec.file lines=spec.lines/>
                </p>
                <button
                    type="button"
                    class="dw-view-chip codemap"
                    on:click=move |_| on_open_chat.run((
                        format!("How does {} fit into the codebase?", spec.title),
                        ChatView::Codemap,
                        spec.code_ref,
                    ))
                >
                    "🗺 View in side-by-side Codemap"
                </button>
            </div>
            <h1 id="purpose" class="dw-h1 mono">{spec.title}</h1>

            <p class="lede">
                {spec.purpose} " "
                <Cite file=spec.file lines=spec.lines/>
            </p>

            <div class="invariant-box">
                <p class="small strong">"Rule enforced"</p>
                <p>
                    {spec.rule} " "
                    <Cite file="crates/auth/tests/matrix.rs" lines="10-15"/>
                </p>
            </div>

            <h2 id="impl" class="dw-h2">"1. Annotated Implementation"</h2>
            <div class="annotated-code" role="region" aria-label="Annotated source">
                <div class="ac-head mono small muted">
                    <span>"crates/auth/src/principal.rs"</span>
                    <span>"lines 54–60 · @ 0705846"</span>
                </div>
                <div class="ac-row">
                    <span class="ln">"55"</span>
                    <code class="ac-code">"pub fn allows(&self, perm: Perm, repo: &RepoId) -> bool {"</code>
                    <span class="ac-note muted">"Entry point for every permission check"</span>
                </div>
                <div class="ac-row">
                    <span class="ln">"56"</span>
                    <code class="ac-code">"    let role = self.role_in(repo.tenant());"</code>
                    <span class="ac-note muted">"Resolves caller's OrgRole in repo's tenant"</span>
                </div>
                <div class="ac-row linked">
                    <span class="ln">"57"</span>
                    <code class="ac-code">"    let allowed = role.grants(perm);"</code>
                    <span class="ac-note">
                        "calls " <span class="tier exact">"exact"</span> " "
                        <button type="button" class="inline-sym mono strong" on:click=move |_| on_jump.run(PageId::SymGrants)>
                            "Role::grants"
                        </button>
                        " " <Cite file="crates/auth/src/role.rs" lines="30-37" target=PageId::SymGrants on_jump=on_jump/>
                    </span>
                </div>
                <div class="ac-row linked">
                    <span class="ln">"58"</span>
                    <code class="ac-code">"    self.audit.record(self.user, perm, repo, allowed);"</code>
                    <span class="ac-note">
                        "calls " <span class="tier exact">"exact"</span> " "
                        <button type="button" class="inline-sym mono strong" on:click=move |_| on_jump.run(PageId::SymAuditRecord)>
                            "AuditLog::record"
                        </button>
                        " " <Cite file="crates/auth/src/audit.rs" lines="17-19" target=PageId::SymAuditRecord on_jump=on_jump/>
                    </span>
                </div>
                <div class="ac-row">
                    <span class="ln">"59"</span>
                    <code class="ac-code">"    allowed"</code>
                    <span class="ac-note"></span>
                </div>
                <div class="ac-row">
                    <span class="ln">"60"</span>
                    <code class="ac-code">"}"</code>
                    <span class="ac-note"></span>
                </div>
            </div>

            <h2 id="callers" class="dw-h2">"2. Inbound Call Sites (3 across 2 crates)"</h2>
            <div class="caller-list">
                <div class="caller-item">
                    <div class="caller-top">
                        <span class="tier exact">"exact"</span>
                        <span class="mono muted small">"POST /:owner/:repo/git-receive-pack  →  "</span>
                        <button type="button" class="inline-sym mono strong" on:click=move |_| on_jump.run(PageId::SymPushRefs)>
                            "api::push_refs"
                        </button>
                        <span class="spacer"></span>
                        <Cite file="crates/api/src/repo.rs" lines="138-148" target=PageId::SymPushRefs on_jump=on_jump/>
                    </div>
                    <pre class="caller-snippet mono">
                        <span class="ln">"142"</span>") -> Result<RefReport, ApiError> {\n"
                        <span class="ln">"143"</span><span class="hl">"    if !principal.allows(Perm::Write, &repo) { return Err(ApiError::NotFound); }\n"</span>
                        <span class="ln">"146"</span>"    let unpacked = storage::receive_pack(&repo, pack).await?;"
                    </pre>
                </div>

                <div class="caller-item">
                    <div class="caller-top">
                        <span class="tier exact">"exact"</span>
                        <span class="mono muted small">"POST /changes/:n/accept  →  "</span>
                        <button type="button" class="inline-sym mono strong" on:click=move |_| on_jump.run(PageId::SymAccept)>
                            "source::accept"
                        </button>
                        <span class="spacer"></span>
                        <Cite file="crates/source/src/merge.rs" lines="215-222" target=PageId::SymAccept on_jump=on_jump/>
                    </div>
                    <pre class="caller-snippet mono">
                        <span class="ln">"218"</span>") -> Result<MergeTicket, MergeError> {\n"
                        <span class="ln">"219"</span><span class="hl">"    ensure!(principal.allows(Perm::Maintain, &cr.repo), MergeError::Denied);\n"</span>
                        <span class="ln">"221"</span>"    queue::enqueue(cr.id, cr.head_oid)"
                    </pre>
                </div>

                <div class="caller-item cand">
                    <div class="caller-top">
                        <span class="tier cand">"cand"</span>
                        <span class="mono muted small">"dyn AdminAction::run  ┄▶  "</span>
                        <button type="button" class="inline-sym mono strong" on:click=move |_| on_jump.run(PageId::SymForceUpdate)>
                            "api::force_update"
                        </button>
                        <span class="spacer"></span>
                        <Cite file="crates/api/src/admin.rs" lines="84-90" target=PageId::SymForceUpdate on_jump=on_jump/>
                    </div>
                    <pre class="caller-snippet mono">
                        <span class="ln">" 85"</span>"fn run(&self, principal: &Principal, repo: &RepoId, mv: RefMove) -> Result<(), AdminError> {\n"
                        <span class="ln">" 86"</span><span class="hl">"    if !principal.allows(Perm::Admin, repo) { return Err(AdminError::Forbidden); }\n"</span>
                        <span class="ln">" 89"</span>"    refs::force_move(repo, mv)"
                    </pre>
                </div>
            </div>

            <h2 id="tests" class="dw-h2">"3. Guarding Tests"</h2>
            <ul class="list">
                <li class="list-row">
                    <span class="tier exact">"exact"</span>
                    <Cite file="crates/auth/tests/matrix.rs" lines="10-15"/>
                    <span class="muted">"Walks every registered route and asserts it calls Principal::allows before storage."</span>
                    <span class="badge ok">"passing"</span>
                </li>
            </ul>
        </article>
    }
}
