//! Types shared across the API boundary. Everything here must compile for
//! `wasm32-unknown-unknown`, so no I/O, clocks or platform dependencies.

use serde::{Deserialize, Serialize};

/// A tenant. Every resource key carries its org so one deployment can host many.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Org {
    pub slug: String,
    pub name: String,
    pub plan: Plan,
    pub role: OrgRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Plan {
    Personal,
    Team,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrgRole {
    Member,
    Admin,
    Owner,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub handle: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub user: User,
    pub orgs: Vec<Org>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

impl RepoRef {
    #[must_use]
    pub fn new(owner: &str, name: &str) -> Self {
        Self {
            owner: owner.to_owned(),
            name: name.to_owned(),
        }
    }

    #[must_use]
    pub fn path(&self) -> String {
        format!("/r/{}/{}", self.owner, self.name)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repo {
    pub id: RepoRef,
    pub description: String,
    pub default_branch: String,
    pub branches: u32,
    pub tags: u32,
    pub languages: Vec<LanguageShare>,
    pub open_changes: u32,
    pub updated: String,
    pub graph: GraphSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageShare {
    pub name: String,
    pub percent: u8,
}

/// Coverage of the code graph at one revision, split by tier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphSummary {
    pub revision: String,
    pub files: u32,
    pub exact_percent: u8,
    pub candidate_percent: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitSummary {
    pub oid: String,
    pub author: String,
    pub message: String,
    pub age: String,
    pub checks: CheckState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeEntry {
    pub name: String,
    pub kind: EntryKind,
    pub last_message: String,
    pub age: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoHome {
    pub repo: Repo,
    pub head: CommitSummary,
    pub entries: Vec<TreeEntry>,
    pub readme: Vec<String>,
    pub changes: Vec<ChangeSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckState {
    Queued,
    Running,
    Passed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeState {
    Draft,
    Open,
    Queued,
    Merged,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSummary {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub state: ChangeState,
    pub checks: CheckState,
    pub approvals: u32,
    pub required_approvals: u32,
    pub updated: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision {
    pub index: u32,
    pub head: String,
    pub summary: String,
    pub age: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub state: CheckState,
    pub duration: String,
    pub build_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Severity {
    Info,
    Warning,
    Risk,
}

/// AI review output. Advisory: it never counts toward a gate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    pub path: String,
    pub line: u32,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gate {
    pub rule: String,
    pub satisfied: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub hunk: Vec<DiffLine>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub number: u32,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeDetail {
    pub summary: ChangeSummary,
    pub source: String,
    pub target: String,
    pub description: String,
    pub revisions: Vec<Revision>,
    pub checks: Vec<Check>,
    pub gates: Vec<Gate>,
    pub findings: Vec<Finding>,
    pub impact: Vec<GraphHit>,
    pub files: Vec<DiffFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepState {
    Cached,
    Passed,
    Failed,
    Running,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildStep {
    pub name: String,
    pub state: StepState,
    pub machine: String,
    pub duration: String,
    pub cache_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildRun {
    pub id: String,
    pub repo: RepoRef,
    pub commit: String,
    pub trigger: String,
    pub state: CheckState,
    pub backend: String,
    pub steps: Vec<BuildStep>,
    pub log: Vec<String>,
    pub triage: Option<Triage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Triage {
    pub root_cause: String,
    pub evidence: Vec<String>,
    pub confidence: u8,
}

/// Graph answers say how they were derived. `Exact` comes from a compiler
/// index; `Candidate` is inferred and must be shown as such.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    Exact,
    Candidate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphHit {
    pub tier: Tier,
    pub path: String,
    pub line: u32,
    pub symbol: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResults {
    pub query: String,
    pub revision: String,
    pub text: Vec<GraphHit>,
    pub definition: Option<GraphHit>,
    pub callers: Vec<GraphHit>,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum InboxKind {
    ReviewRequested,
    ChecksFailed,
    Mentioned,
    SpaceIdle,
    FixReady,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxItem {
    pub kind: InboxKind,
    pub repo: RepoRef,
    pub title: String,
    pub href: String,
    pub age: String,
    pub unread: bool,
}

/// Where AI work runs. The platform never resells model access: users bring
/// their own Claude Code login, other harness, or API key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiProvider {
    ClaudeCode,
    Codex,
    AnthropicApiKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiRunsOn {
    ThisDevice,
    UserSandbox,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConnection {
    pub provider: AiProvider,
    pub runs_on: AiRunsOn,
    pub account: String,
}

/// Feature flags reported by the host platform. The UI shows a feature when
/// its flag is set, so one build serves web, desktop and mobile.
#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub local_repos: bool,
    pub local_ai: bool,
    pub terminal: bool,
    pub push_notifications: bool,
    pub offline_cache: bool,
    pub cli_install: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiError {
    /// Private resources the caller can't read are reported as not found.
    NotFound,
    Unauthorized,
    Unavailable {
        fix: String,
    },
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("Not found"),
            Self::Unauthorized => f.write_str("Sign in to continue"),
            Self::Unavailable { fix } => write!(f, "Service unavailable. {fix}"),
        }
    }
}
