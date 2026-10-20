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

/// CI policy for a repository (Loom `catalog::CiPolicy`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CiPolicy {
    /// Run the repository's `loom-ci.toml` (or the language-default pipeline).
    LoomCi,
}

/// How releases are applied (Loom `catalog::DeployTarget`, kind only).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeployTarget {
    None,
    LocalApply,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repo {
    pub id: RepoRef,
    pub description: String,
    pub default_branch: String,
    /// Protected ref promoted only by Gate-2 accept + atomic CAS
    /// (Loom catalog `protected_ref`, default `refs/main`).
    pub protected_ref: String,
    pub ci_policy: CiPolicy,
    pub deploy_target: DeployTarget,
    pub branches: u32,
    pub tags: u32,
    pub languages: Vec<LanguageShare>,
    pub open_changes: u32,
    pub updated: String,
    pub graph: GraphSummary,
}

/// How one admitted tree entered the store (Loom `admissions::AdmissionSource`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdmissionSource {
    GitPush,
    Import,
    NativeCommit,
    ChangeRequestAccept,
}

/// One durable admission edge: base revision -> head revision on a ref.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Admission {
    pub source: AdmissionSource,
    pub ref_name: Option<String>,
    pub base: Option<String>,
    pub head: String,
    pub age: String,
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
    /// Recent admission edges that moved the protected ref (Loom admissions ledger).
    pub admissions: Vec<Admission>,
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
    /// Inclusive end line (Loom review `Finding::end_line`).
    pub end_line: u32,
    pub message: String,
    /// Suggested patch text, when the reviewer proposed one (Loom `suggested_patch`).
    pub suggested_fix: Option<String>,
    /// A human approved the suggestion; it may then be applied (Loom `approved`).
    pub approved: bool,
    /// The suggestion was applied, producing a new candidate revision (Loom `applied`).
    pub applied: bool,
}

/// Two-gate lifecycle of a feature contract / change request
/// (Loom `features::FeatureGate`): Gate 1 authorizes work, Gate 2 promotes source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GateStage {
    Draft,
    Gate1Approved,
    Accepted,
    Rejected,
}

/// Human-observable acceptance scenario (Loom `features::Scenario`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scenario {
    pub name: String,
    pub given: String,
    pub when: String,
    pub then: String,
    pub passed: bool,
}

/// Digest-bound CI evidence pinned to one candidate (Loom `features::EvidenceBundle`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceBundle {
    pub digest: String,
    pub tests_passed: bool,
    pub job_id: String,
}

/// Final judgment on a completed review (Loom `review::ReviewVerdict`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewVerdict {
    Approve,
    Comment,
    RequestChanges,
}

/// One comment in a change-request thread (Loom `review::Comment`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewComment {
    pub author: String,
    pub body: String,
    pub age: String,
    pub finding_path: Option<String>,
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
    /// Two-gate contract state (Gate 1 approve -> candidate -> Gate 2 accept).
    pub gate_stage: GateStage,
    /// Acceptance scenarios the candidate must satisfy.
    pub scenarios: Vec<Scenario>,
    /// CI evidence bound to the current candidate head, when CI has run.
    pub evidence: Option<EvidenceBundle>,
    /// Recorded review verdict; blocking when the contract's policy requires it.
    pub review_verdict: Option<ReviewVerdict>,
    /// Threaded comments from humans and agents.
    pub comments: Vec<ReviewComment>,
    /// Exact reverse CAS retained at promotion, so Gate 2 is reversible.
    pub rollback_available: bool,
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
    /// Exact Git OID CI verified; evidence never transfers to another OID
    /// (Loom `jobs::CiDurableJob::git_oid`).
    pub git_oid: String,
    /// Digest-cache source key, e.g. `ci-v2:<worker fingerprint>|repo:base:head`.
    pub source_key: String,
    /// Protected ref whose movement queued this job, when any.
    pub ref_name: Option<String>,
    /// Claims started, including reclaims after an interrupted lease.
    pub attempts: u32,
    /// Job whose passing evidence this run replays (digest cache), when any.
    pub cached_from: Option<String>,
    /// Digest of the published log / evidence bundle, when finished.
    pub evidence_digest: Option<String>,
    pub trigger: String,
    pub state: CheckState,
    pub backend: String,
    pub steps: Vec<BuildStep>,
    pub log: Vec<String>,
    pub triage: Option<Triage>,
}

/// One row of the Builds index; full step detail lives on `BuildRun`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildStepSummary {
    pub name: String,
    pub state: StepState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildSummary {
    pub id: String,
    pub title: String,
    pub trigger: String,
    pub commit: String,
    pub state: CheckState,
    pub duration: String,
    /// Human summary of cache savings, e.g. `saved 4m 19s (2/3 cached)`.
    pub saved: String,
    pub steps: Vec<BuildStepSummary>,
    pub age: String,
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

/// Readiness of a revision's selected code map (Loom `maps::MapReadStatus`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MapStatus {
    Ready,
    Pending,
    Failed,
    Missing,
}

/// Lifecycle of one map generation (Loom `maps::GenerationStatus`).
/// Only `Complete` generations are selectable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenerationStatus {
    Complete,
    Failed,
}

/// One identity's membership at a map generation's exact revision
/// (Loom `maps::MembershipEntry`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MapIdentity {
    pub id: String,
    /// `feature` or `substrate`.
    pub kind: String,
    pub paths: Vec<String>,
}

/// One `substrate -> feature | substrate` supports edge (Loom `maps::SupportsEdge`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportsEdge {
    pub source: String,
    pub target: String,
    /// Shared (2+ dependents) vs dedicated (Loom `SupportKind`).
    pub shared: bool,
    pub confidence: Option<u8>,
    pub anchors: Vec<String>,
}

/// Model provenance recorded beside every map generation (Loom
/// `maps::ModelProvenance` + `Usage`). Credentials are never recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProvenance {
    pub provider: String,
    pub model: String,
    pub route: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Cost in micros of the provider's billing unit.
    pub cost_micros: u64,
}

/// The selected code map for one repo at one revision (Loom `maps::ResolvedMap`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoMap {
    pub revision: String,
    pub status: MapStatus,
    pub generation: Option<String>,
    pub generation_status: Option<GenerationStatus>,
    pub identities: Vec<MapIdentity>,
    pub supports: Vec<SupportsEdge>,
    pub provenance: Option<ModelProvenance>,
    /// State of the in-flight or latest map job, when any.
    pub job_state: Option<String>,
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

/// Model providers and coding-plan harnesses. Grogan sells managed token
/// credits (one balance routes to any of these) AND supports bring-your-own:
/// an existing subscription, coding plan, CLI login, or API key at $0 markup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiProvider {
    ClaudeCode,
    Codex,
    AnthropicApiKey,
    OpenAiApiKey,
    Gemini,
    Grok,
    Zai,
    MiniMax,
    Mimo,
    DeepSeek,
    Kimi,
    Qwen,
    OpenRouter,
}

/// How model usage is paid for on one connection / agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiBilling {
    /// Grogan-managed token credits (token packs / pay-as-you-go balance).
    ManagedCredits,
    /// User's own subscription, coding plan, or API key. $0 platform markup.
    BringYourOwn,
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
    pub billing: AiBilling,
    pub account: String,
}

/// Lifecycle of one AI Space. Modelled on Loom's durable CI jobs: claimed
/// under a lease, runs in a disposable VM pinned by the CI worker fingerprint,
/// hibernates at $0 when idle, lands work only as a change request.
/// NOTE: Loom has no Spaces backend yet — this is the frontend contract a
/// future `spaces` service must implement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpaceStatus {
    Starting,
    Running,
    Hibernated,
    Stopped,
}

/// One agent attached to a Space: which harness/model runs, and who pays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceAgent {
    pub provider: AiProvider,
    pub model: String,
    pub billing: AiBilling,
}

/// One AI-managed Codespace (Grogan "Space").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub repo: RepoRef,
    /// Worktree branch this Space owns, e.g. `zack/projection-cache`.
    pub branch: String,
    pub status: SpaceStatus,
    pub agent: SpaceAgent,
    /// Machine size label, e.g. `8 vCPU · 16 GB`.
    pub machine: String,
    pub task: String,
    /// Change request this Space opened, when it has landed work.
    pub change_number: Option<u32>,
    /// Latest test roll-up, e.g. `212/212 passing`.
    pub tests: Option<String>,
    /// Idle / hibernation summary, e.g. `hibernated after 30m idle · $0/hr`.
    pub idle_for: Option<String>,
    pub log: Vec<String>,
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
