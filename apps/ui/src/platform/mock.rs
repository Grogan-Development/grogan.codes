//! In-memory platform with fixture data. Latency is simulated so loading
//! states are visible; nothing here touches the network.

use api_types::{
    Admission, AdmissionSource, AiBilling, AiConnection, AiProvider, AiRunsOn, ApiError, BuildRun,
    BuildStep, BuildStepSummary, BuildSummary, ChangeDetail, ChangeState, ChangeSummary, Check,
    CheckState, CiPolicy, CommitSummary, DeployTarget, DiffFile, DiffLine, DiffLineKind, EntryKind,
    EvidenceBundle, Finding, Gate, GateStage, GenerationStatus, GraphHit, GraphSummary, InboxItem,
    InboxKind, LanguageShare, MapIdentity, MapStatus, ModelProvenance, Org, OrgRole, Plan, Repo,
    RepoHome, RepoMap, RepoRef, ReviewComment, ReviewVerdict, Revision, Scenario, SearchResults,
    Session, Severity, Space, SpaceAgent, SpaceStatus, StepState, SupportsEdge, Tier, TreeEntry,
    Triage, User,
};
use gloo_timers::future::TimeoutFuture;

use super::{Platform, PlatformKind, Reply};

const LATENCY_MS: u32 = 140;

pub struct MockPlatform {
    kind: PlatformKind,
}

impl MockPlatform {
    #[must_use]
    pub fn new(kind: PlatformKind) -> Self {
        Self { kind }
    }
}

fn reply<'a, T: 'a>(value: Result<T, ApiError>) -> Reply<'a, T> {
    Box::pin(async move {
        TimeoutFuture::new(LATENCY_MS).await;
        value
    })
}

fn s(value: &str) -> String {
    value.to_owned()
}

fn session() -> Session {
    Session {
        user: User {
            handle: s("zack"),
            name: s("Zack Grogan"),
        },
        orgs: vec![
            Org {
                slug: s("zack"),
                name: s("Zack Grogan"),
                plan: Plan::Personal,
                role: OrgRole::Owner,
            },
            Org {
                slug: s("grogan-dev"),
                name: s("Grogan Development"),
                plan: Plan::Team,
                role: OrgRole::Admin,
            },
        ],
    }
}

fn lang(name: &str, percent: u8) -> LanguageShare {
    LanguageShare {
        name: s(name),
        percent,
    }
}

#[allow(clippy::too_many_arguments)]
fn repo(
    owner: &str,
    name: &str,
    description: &str,
    languages: Vec<LanguageShare>,
    open_changes: u32,
    updated: &str,
    files: u32,
    exact: u8,
) -> Repo {
    Repo {
        id: RepoRef::new(owner, name),
        description: s(description),
        default_branch: s("main"),
        protected_ref: s("refs/main"),
        ci_policy: CiPolicy::LoomCi,
        deploy_target: DeployTarget::None,
        branches: 3,
        tags: 41,
        languages,
        open_changes,
        updated: s(updated),
        graph: GraphSummary {
            revision: s("0705846"),
            files,
            exact_percent: exact,
            candidate_percent: 100 - exact,
        },
    }
}

fn all_repos() -> Vec<Repo> {
    vec![
        repo(
            "zack",
            "grogan-code",
            "Code host, code graph and isolated CI on AWS.",
            vec![lang("Rust", 92), lang("TypeScript", 6), lang("Shell", 2)],
            3,
            "2h ago",
            214,
            78,
        ),
        repo(
            "zack",
            "trace-db",
            "Trace store and query engine.",
            vec![
                lang("TypeScript", 48),
                lang("Python", 27),
                lang("Go", 15),
                lang("Rust", 10),
            ],
            1,
            "1d ago",
            1843,
            41,
        ),
        repo(
            "zack",
            "wingman",
            "Browser pairing agent.",
            vec![lang("TypeScript", 100)],
            0,
            "3d ago",
            44,
            0,
        ),
        repo(
            "zack",
            "clipper",
            "Clip extraction pipeline.",
            vec![lang("Python", 100)],
            0,
            "1w ago",
            49,
            62,
        ),
        repo(
            "grogan-dev",
            "site",
            "Marketing site for grogan.codes.",
            vec![lang("HTML", 70), lang("CSS", 30)],
            1,
            "5h ago",
            12,
            0,
        ),
        repo(
            "grogan-dev",
            "gdg-api",
            "Client portal API.",
            vec![lang("Rust", 100)],
            2,
            "2d ago",
            96,
            88,
        ),
    ]
}

fn find_repo(id: &RepoRef) -> Result<Repo, ApiError> {
    all_repos()
        .into_iter()
        .find(|repo| &repo.id == id)
        .ok_or(ApiError::NotFound)
}

fn change(
    number: u32,
    title: &str,
    author: &str,
    state: ChangeState,
    checks: CheckState,
    approvals: u32,
    updated: &str,
) -> ChangeSummary {
    ChangeSummary {
        number,
        title: s(title),
        author: s(author),
        state,
        checks,
        approvals,
        required_approvals: 1,
        updated: s(updated),
    }
}

fn changes_for(id: &RepoRef) -> Vec<ChangeSummary> {
    if id.name != "grogan-code" {
        return vec![change(
            7,
            "Tighten error copy on sign-in",
            "zack",
            ChangeState::Open,
            CheckState::Passed,
            0,
            "5h ago",
        )];
    }
    vec![
        change(
            42,
            "Projection read cache",
            "zack",
            ChangeState::Open,
            CheckState::Failed,
            0,
            "2h ago",
        ),
        change(
            41,
            "CI worker retry budget",
            "agent:run-8f2",
            ChangeState::Open,
            CheckState::Passed,
            1,
            "6h ago",
        ),
        change(
            39,
            "Scoped tokens in repos list",
            "zack",
            ChangeState::Draft,
            CheckState::Running,
            0,
            "1d ago",
        ),
        change(
            38,
            "Default bare repos to main",
            "zack",
            ChangeState::Merged,
            CheckState::Passed,
            1,
            "5d ago",
        ),
    ]
}

fn entry(name: &str, kind: EntryKind, last_message: &str, age: &str) -> TreeEntry {
    TreeEntry {
        name: s(name),
        kind,
        last_message: s(last_message),
        age: s(age),
    }
}

fn repo_home(id: &RepoRef) -> Result<RepoHome, ApiError> {
    let repo = find_repo(id)?;
    let entries = vec![
        entry("apps", EntryKind::Dir, "Add disconnected UI shell", "2h"),
        entry(
            "crates",
            EntryKind::Dir,
            "Shared API types for the UI",
            "2h",
        ),
        entry(
            "infra",
            EntryKind::Dir,
            "Static site and app distributions",
            "2h",
        ),
        entry("Cargo.toml", EntryKind::File, "Pin Leptos 0.8", "2h"),
        entry("AGENTS.md", EntryKind::File, "Policy mirror update", "1w"),
        entry(
            "README.md",
            EntryKind::File,
            "Rewrite docs for the new layout",
            "3d",
        ),
    ];
    Ok(RepoHome {
        head: CommitSummary {
            oid: s("0705846"),
            author: s("zack"),
            message: s("Preserve projection, CI worker, and runtime integration updates"),
            age: s("2h ago"),
            checks: CheckState::Passed,
        },
        entries,
        readme: vec![
            format!("# {}", repo.id.name),
            repo.description.clone(),
            s("Run `./scripts/ci.sh` for formatting, lints and the full test suite."),
        ],
        changes: changes_for(id)
            .into_iter()
            .filter(|change| change.state != ChangeState::Merged)
            .collect(),
        // Admission ledger edges (Loom `admissions/`): how the protected ref last moved.
        admissions: vec![
            Admission {
                source: AdmissionSource::ChangeRequestAccept,
                ref_name: Some(s("refs/main")),
                base: Some(s("9be21c4")),
                head: s("0705846"),
                age: s("2h ago"),
            },
            Admission {
                source: AdmissionSource::GitPush,
                ref_name: Some(s("refs/heads/zack/projection-cache")),
                base: None,
                head: s("c3d07f1"),
                age: s("2h ago"),
            },
            Admission {
                source: AdmissionSource::Import,
                ref_name: Some(s("refs/main")),
                base: None,
                head: s("41aa90e"),
                age: s("3mo ago"),
            },
        ],
        repo,
    })
}

fn hit(tier: Tier, path: &str, line: u32, symbol: &str, source: &str) -> GraphHit {
    GraphHit {
        tier,
        path: s(path),
        line,
        symbol: s(symbol),
        source: s(source),
    }
}

fn diff_line(kind: DiffLineKind, number: u32, text: &str) -> DiffLine {
    DiffLine {
        kind,
        number,
        text: s(text),
    }
}

fn change_detail(id: &RepoRef, number: u32) -> Result<ChangeDetail, ApiError> {
    let summary = changes_for(id)
        .into_iter()
        .find(|change| change.number == number)
        .ok_or(ApiError::NotFound)?;
    let failed = summary.checks == CheckState::Failed;
    Ok(ChangeDetail {
        source: format!("zack/{}", summary.title.to_lowercase().replace(' ', "-")),
        target: s("main"),
        description: s(
            "Cache projection reads by (grant, revision) so repeated graph tool calls skip the pack decode.",
        ),
        revisions: vec![
            Revision {
                index: 1,
                head: s("a41c9e2"),
                summary: s("Initial cache"),
                age: s("1d ago"),
            },
            Revision {
                index: 2,
                head: s("c3d07f1"),
                summary: s("Evict on grant revoke"),
                age: s("2h ago"),
            },
        ],
        checks: vec![
            Check {
                name: s("lint"),
                state: CheckState::Passed,
                duration: s("cached"),
                build_id: Some(s("b-c3d07f1")),
            },
            Check {
                name: s("test"),
                state: if failed {
                    CheckState::Failed
                } else {
                    CheckState::Passed
                },
                duration: s("3m 12s"),
                build_id: Some(s("b-c3d07f1")),
            },
            Check {
                name: s("image"),
                state: if failed {
                    CheckState::Cancelled
                } else {
                    CheckState::Passed
                },
                duration: s("—"),
                build_id: Some(s("b-c3d07f1")),
            },
        ],
        gates: vec![
            Gate {
                rule: s("Required checks"),
                satisfied: !failed,
                detail: if failed {
                    s("test failed on c3d07f1")
                } else {
                    s("All checks passed on c3d07f1")
                },
            },
            Gate {
                rule: s("1 approval from a code owner"),
                satisfied: summary.approvals >= summary.required_approvals,
                detail: format!(
                    "{} of {} on the current patch set",
                    summary.approvals, summary.required_approvals
                ),
            },
            Gate {
                rule: s("Linear history"),
                satisfied: true,
                detail: s("Fast-forward possible"),
            },
        ],
        findings: vec![
            Finding {
                severity: Severity::Risk,
                path: s("crates/source/src/projection.rs"),
                line: 88,
                end_line: 91,
                message: s(
                    "Cache key omits the grant's revocation epoch, so a revoked grant can read cached rows until eviction.",
                ),
                suggested_fix: Some(s("let key = (grant.id, grant.revocation_epoch, rev);")),
                approved: false,
                applied: false,
            },
            Finding {
                severity: Severity::Info,
                path: s("crates/source/src/projection.rs"),
                line: 131,
                end_line: 131,
                message: s("Eviction walks every entry; consider indexing by grant."),
                suggested_fix: None,
                approved: false,
                applied: false,
            },
        ],
        impact: vec![
            hit(
                Tier::Exact,
                "crates/api/src/repo.rs",
                142,
                "push_refs",
                "if !principal.allows(Perm::Write, &repo) {",
            ),
            hit(
                Tier::Candidate,
                "crates/api/src/admin.rs",
                88,
                "force_update",
                "principal.allows(Perm::Admin, &repo)",
            ),
        ],
        files: vec![DiffFile {
            path: s("crates/source/src/projection.rs"),
            added: 24,
            removed: 3,
            hunk: vec![
                diff_line(
                    DiffLineKind::Context,
                    86,
                    "pub fn read(&self, grant: &Grant, rev: Oid) -> Result<Rows> {",
                ),
                diff_line(
                    DiffLineKind::Removed,
                    87,
                    "    let pack = self.packs.open(rev)?;",
                ),
                diff_line(DiffLineKind::Added, 87, "    let key = (grant.id, rev);"),
                diff_line(
                    DiffLineKind::Added,
                    88,
                    "    if let Some(rows) = self.cache.get(&key) {",
                ),
                diff_line(DiffLineKind::Added, 89, "        return Ok(rows.clone());"),
                diff_line(DiffLineKind::Added, 90, "    }"),
                diff_line(
                    DiffLineKind::Added,
                    91,
                    "    let pack = self.packs.open(rev)?;",
                ),
                diff_line(DiffLineKind::Context, 92, "    pack.project(grant.scope())"),
            ],
        }],
        // Two-gate contract (Loom features.rs): Gate 1 approved the contract,
        // a candidate is under CI + review, Gate 2 (accept + CAS) is pending.
        gate_stage: GateStage::Gate1Approved,
        scenarios: vec![
            Scenario {
                name: s("Revoked grant reads nothing"),
                given: s("a grant with 3 cached projection rows"),
                when: s("the grant is revoked and read again at the same revision"),
                then: s("the read returns 0 rows (cache key includes revocation epoch)"),
                passed: !failed,
            },
            Scenario {
                name: s("Warm cache still hits"),
                given: s("an unrevoked grant read twice at one revision"),
                when: s("the second read executes"),
                then: s("rows come from cache and the pack is not re-opened"),
                passed: true,
            },
        ],
        evidence: Some(EvidenceBundle {
            digest: s("sha256:51b07c…e91a"),
            tests_passed: !failed,
            job_id: s("job_01j…c3d07f1"),
        }),
        review_verdict: Some(if failed {
            ReviewVerdict::RequestChanges
        } else {
            ReviewVerdict::Approve
        }),
        comments: vec![
            ReviewComment {
                author: s("agent:claude-code"),
                body: s(
                    "Cache key at projection.rs:87 is (grant.id, rev) — revocation epoch is missing, so the failing test is a real bug, not a flake. Suggested patch attached to the finding.",
                ),
                age: s("2h ago"),
                finding_path: Some(s("crates/source/src/projection.rs:88")),
            },
            ReviewComment {
                author: s("zack"),
                body: s(
                    "Agreed. Apply the suggested patch as revision 3 and re-run only the `test` step — lint is already cached for this tree.",
                ),
                age: s("1h ago"),
                finding_path: None,
            },
        ],
        rollback_available: true,
        summary,
    })
}

fn step(name: &str, state: StepState, machine: &str, duration: &str, cache_key: &str) -> BuildStep {
    BuildStep {
        name: s(name),
        state,
        machine: s(machine),
        duration: s(duration),
        cache_key: s(cache_key),
    }
}

fn build(id: &RepoRef, build_id: &str) -> Result<BuildRun, ApiError> {
    find_repo(id)?;
    Ok(BuildRun {
        id: s(build_id),
        repo: id.clone(),
        commit: s("c3d07f1"),
        git_oid: s("c3d07f1a9e2b44d0b6f1a2c3d4e5f60718293a4b"),
        source_key: s("ci-v2:loom-ci-worker.v1:uid=1001:9f1e…a2|zack/grogan-code:0705846:c3d07f1"),
        ref_name: Some(s("refs/heads/zack/projection-cache")),
        attempts: 1,
        cached_from: None,
        evidence_digest: Some(s("sha256:51b07c…e91a")),
        trigger: s("Change request #42 · revision 2"),
        state: CheckState::Failed,
        backend: s("Spot Firecracker · c8i.4xlarge · us-west-2"),
        steps: vec![
            step("lint", StepState::Cached, "4x8", "0.4s", "9f1e…a2"),
            step("test", StepState::Failed, "8x16", "3m 12s", "51b0…7c"),
            step("image", StepState::Skipped, "4x8", "—", "—"),
        ],
        log: vec![
            s("$ cargo nextest run"),
            s("    Starting 212 tests across 18 binaries"),
            s("        PASS [   0.031s] source projection::reads_scoped_rows"),
            s("        PASS [   0.044s] source projection::cache_hits_on_second_read"),
            s("        FAIL [   0.052s] source projection::revoked_grant_cannot_read_cache"),
            s(""),
            s("--- STDERR: source projection::revoked_grant_cannot_read_cache ---"),
            s(
                "thread 'revoked_grant_cannot_read_cache' panicked at crates/source/tests/projection.rs:61:5:",
            ),
            s("assertion failed: read after revoke returned 3 cached rows"),
            s(""),
            s("     Summary [ 41.210s] 212 tests run: 211 passed, 1 failed"),
        ],
        triage: Some(Triage {
            root_cause: s(
                "The cache key is (grant id, revision) and ignores revocation, so a revoked grant still hits cached rows.",
            ),
            evidence: vec![
                s("crates/source/src/projection.rs:87 builds the key without the revocation epoch"),
                s("tests/projection.rs:61 reads after revoke and expects 0 rows"),
            ],
            confidence: 86,
        }),
    })
}

fn builds_for(id: &RepoRef) -> Vec<BuildSummary> {
    if id.name != "grogan-code" {
        return Vec::new();
    }
    let row = |id: &str,
               state: CheckState,
               title: &str,
               trigger: &str,
               commit: &str,
               duration: &str,
               saved: &str,
               steps: [(&str, StepState); 3],
               age: &str| BuildSummary {
        id: s(id),
        title: s(title),
        trigger: s(trigger),
        commit: s(commit),
        state,
        duration: s(duration),
        saved: s(saved),
        steps: steps
            .into_iter()
            .map(|(name, state)| BuildStepSummary {
                name: s(name),
                state,
            })
            .collect(),
        age: s(age),
    };
    vec![
        row(
            "b-c3d07f1",
            CheckState::Failed,
            "#42 Projection read cache · rev 2",
            "change_request · zack",
            "c3d07f1",
            "3m 12s",
            "saved 1m 48s (1/3 cached)",
            [
                ("lint", StepState::Cached),
                ("test", StepState::Failed),
                ("image", StepState::Skipped),
            ],
            "2h ago",
        ),
        row(
            "b-0705846",
            CheckState::Passed,
            "main · Enforce Principal::allows across admin routes",
            "git_push · refs/main",
            "0705846",
            "44s",
            "saved 4m 19s (2/3 cached)",
            [
                ("lint", StepState::Cached),
                ("test", StepState::Cached),
                ("image", StepState::Passed),
            ],
            "4h ago",
        ),
        row(
            "b-91e4a10",
            CheckState::Passed,
            "#41 CI worker retry budget · rev 1 (agent fix)",
            "agent_run · claude-code",
            "91e4a10",
            "1m 52s",
            "saved 2m 50s (1/3 cached)",
            [
                ("lint", StepState::Cached),
                ("test", StepState::Passed),
                ("image", StepState::Passed),
            ],
            "6h ago",
        ),
        row(
            "b-4d18c02",
            CheckState::Passed,
            "#39 Scoped tokens in repos list · rev 3",
            "change_request · zack",
            "4d18c02",
            "12s",
            "saved 4m 55s (3/3 cached)",
            [
                ("lint", StepState::Cached),
                ("test", StepState::Cached),
                ("image", StepState::Cached),
            ],
            "1d ago",
        ),
    ]
}

fn repo_map(id: &RepoRef) -> Result<RepoMap, ApiError> {
    let repo = find_repo(id)?;
    let identity = |id: &str, kind: &str, paths: Vec<&str>| MapIdentity {
        id: s(id),
        kind: s(kind),
        paths: paths.into_iter().map(s).collect(),
    };
    Ok(RepoMap {
        revision: repo.graph.revision.clone(),
        status: MapStatus::Ready,
        generation: Some(s("gen_01j…0705846")),
        generation_status: Some(GenerationStatus::Complete),
        identities: vec![
            identity(
                "auth-gate",
                "feature",
                vec!["crates/auth/src/principal.rs (Principal::allows)"],
            ),
            identity(
                "git-receive",
                "feature",
                vec!["crates/api/src/repo.rs (push_refs)"],
            ),
            identity(
                "merge-queue",
                "feature",
                vec!["crates/source/src/merge.rs (accept)"],
            ),
            identity(
                "cas-store",
                "substrate",
                vec![
                    "crates/source/src/projection.rs",
                    "crates/source/src/pack.rs",
                ],
            ),
            identity(
                "audit-log",
                "substrate",
                vec!["crates/auth/src/audit.rs (AuditLog::record)"],
            ),
        ],
        supports: vec![
            SupportsEdge {
                source: s("cas-store"),
                target: s("git-receive"),
                shared: true,
                confidence: Some(98),
                anchors: vec![s("crates/api/src/repo.rs:142")],
            },
            SupportsEdge {
                source: s("cas-store"),
                target: s("merge-queue"),
                shared: true,
                confidence: Some(96),
                anchors: vec![s("crates/source/src/merge.rs:219")],
            },
            SupportsEdge {
                source: s("audit-log"),
                target: s("auth-gate"),
                shared: false,
                confidence: Some(99),
                anchors: vec![s("crates/auth/src/principal.rs:57")],
            },
        ],
        // Provenance of the run that produced this generation (maps.rs):
        // provider/model/route + token usage, never a credential.
        provenance: Some(ModelProvenance {
            provider: s("zai"),
            model: s("glm-5.1"),
            route: s("grogan-managed-credits"),
            input_tokens: 184_203,
            output_tokens: 21_940,
            cost_micros: 412_000,
        }),
        job_state: None,
    })
}

fn spaces_for(org: &str) -> Vec<Space> {
    if org == "grogan-dev" {
        return Vec::new();
    }
    let main = RepoRef::new("zack", "grogan-code");
    vec![
        Space {
            id: s("space-42"),
            name: s("projection-epoch-fix"),
            repo: main.clone(),
            branch: s("zack/projection-cache"),
            status: SpaceStatus::Running,
            agent: SpaceAgent {
                provider: AiProvider::ClaudeCode,
                model: s("claude-opus-4.7"),
                billing: AiBilling::BringYourOwn,
            },
            machine: s("8 vCPU · 16 GB"),
            task: s("Fix cache revocation epoch on CR #42"),
            change_number: Some(42),
            tests: Some(s("211/212 passing (1 known failure)")),
            idle_for: None,
            log: vec![
                s("$ grogan mcp query --callers Principal::allows"),
                s("3 callers from graph @ 0705846 in 11ms (2 exact, 1 cand)"),
                s("$ cargo nextest run -p source projection"),
                s("FAIL revoked_grant_cannot_read_cache — root cause pinned to projection.rs:87"),
                s("agent: suggested patch ready on CR #42 finding 1 (awaiting human approve)"),
            ],
        },
        Space {
            id: s("space-41"),
            name: s("ci-retry-budget"),
            repo: main.clone(),
            branch: s("agent/ci-retry-budget"),
            status: SpaceStatus::Running,
            agent: SpaceAgent {
                provider: AiProvider::Zai,
                model: s("glm-5.1"),
                billing: AiBilling::BringYourOwn,
            },
            machine: s("4 vCPU · 8 GB"),
            task: s("Bounded retry budget for CI worker leases"),
            change_number: Some(41),
            tests: Some(s("212/212 passing")),
            idle_for: None,
            log: vec![
                s("$ grogan change submit --feature ci-retry-budget"),
                s("candidate 91e4a10 queued · CI job job_01j…91e4 (digest-cached lint)"),
                s("CI passed in 1m 52s · evidence sha256:9be2…44d0"),
            ],
        },
        Space {
            id: s("space-43"),
            name: s("go-indexer-bench"),
            repo: main,
            branch: s("agent/go-indexer-bench"),
            status: SpaceStatus::Starting,
            agent: SpaceAgent {
                provider: AiProvider::MiniMax,
                model: s("minimax-m2.7"),
                billing: AiBilling::ManagedCredits,
            },
            machine: s("8 vCPU · 16 GB"),
            task: s("Benchmark SCIP Go indexer against trace-db corpus"),
            change_number: None,
            tests: None,
            idle_for: None,
            log: vec![s(
                "provisioning disposable VM (worker fingerprint loom-ci-worker.v1:…)",
            )],
        },
        Space {
            id: s("space-trace"),
            name: s("trace-db-dev"),
            repo: RepoRef::new("zack", "trace-db"),
            branch: s("main"),
            status: SpaceStatus::Hibernated,
            agent: SpaceAgent {
                provider: AiProvider::Mimo,
                model: s("mimo-7b-rl"),
                billing: AiBilling::ManagedCredits,
            },
            machine: s("4 vCPU · 8 GB"),
            task: s("Trace store query planner experiments"),
            change_number: None,
            tests: None,
            idle_for: Some(s("hibernated after 30m idle · $0/hr · resumes in <1s")),
            log: vec![s(
                "idle 30m — snapshot sealed, VM released (lease expired cleanly)",
            )],
        },
    ]
}

fn search(id: &RepoRef, query: &str) -> Result<SearchResults, ApiError> {
    find_repo(id)?;
    let query = if query.trim().is_empty() {
        s("Principal::allows")
    } else {
        s(query.trim())
    };
    Ok(SearchResults {
        definition: Some(hit(
            Tier::Exact,
            "crates/auth/src/principal.rs",
            54,
            "Principal::allows",
            "pub fn allows(&self, perm: Perm, repo: &RepoId) -> bool {",
        )),
        callers: vec![
            hit(
                Tier::Exact,
                "crates/api/src/repo.rs",
                142,
                "push_refs",
                "if !principal.allows(Perm::Write, &repo) {",
            ),
            hit(
                Tier::Exact,
                "crates/source/src/merge.rs",
                219,
                "accept",
                "ensure!(principal.allows(Perm::Maintain, &cr.repo), Denied);",
            ),
            hit(
                Tier::Candidate,
                "crates/api/src/admin.rs",
                88,
                "force_update",
                "principal.allows(Perm::Admin, &repo)",
            ),
        ],
        text: vec![
            hit(
                Tier::Exact,
                "crates/auth/src/principal.rs",
                54,
                "",
                "pub fn allows(&self, perm: Perm, repo: &RepoId) -> bool {",
            ),
            hit(
                Tier::Exact,
                "crates/auth/tests/matrix.rs",
                12,
                "",
                "// every route must call allows() before touching storage",
            ),
        ],
        truncated: false,
        revision: s("0705846"),
        query,
    })
}

fn inbox(org: &str) -> Vec<InboxItem> {
    let item = |kind, repo: RepoRef, title: &str, href: String, age: &str, unread| InboxItem {
        kind,
        title: s(title),
        href,
        age: s(age),
        unread,
        repo,
    };
    if org == "grogan-dev" {
        let site = RepoRef::new("grogan-dev", "site");
        return vec![item(
            InboxKind::ReviewRequested,
            site.clone(),
            "#7 Tighten error copy on sign-in",
            format!("{}/changes/7", site.path()),
            "5h",
            true,
        )];
    }
    let main = RepoRef::new("zack", "grogan-code");
    vec![
        item(
            InboxKind::ChecksFailed,
            main.clone(),
            "#42 Projection read cache: test failed",
            format!("{}/builds/b-c3d07f1", main.path()),
            "2h",
            true,
        ),
        item(
            InboxKind::FixReady,
            main.clone(),
            "#41 CI worker retry budget: agent run opened a change request",
            format!("{}/changes/41", main.path()),
            "6h",
            true,
        ),
        item(
            InboxKind::Mentioned,
            main.clone(),
            "#39 Scoped tokens in repos list: you were mentioned",
            format!("{}/changes/39", main.path()),
            "1d",
            false,
        ),
        item(
            InboxKind::SpaceIdle,
            RepoRef::new("zack", "trace-db"),
            "Space trace-db-dev hibernated after 30 min idle",
            s("/spaces"),
            "1d",
            false,
        ),
    ]
}

impl Platform for MockPlatform {
    fn kind(&self) -> PlatformKind {
        self.kind
    }

    fn session(&self) -> Reply<'_, Session> {
        reply(Ok(session()))
    }

    fn ai_connections(&self) -> Reply<'_, Vec<AiConnection>> {
        // Both payment modes: Grogan-managed credits AND bring-your-own plans.
        let mut connections = vec![
            AiConnection {
                provider: AiProvider::Zai,
                runs_on: AiRunsOn::UserSandbox,
                billing: AiBilling::ManagedCredits,
                account: s("Grogan credits · balance $18.42"),
            },
            AiConnection {
                provider: AiProvider::AnthropicApiKey,
                runs_on: AiRunsOn::UserSandbox,
                billing: AiBilling::BringYourOwn,
                account: s("sk-ant-…4f2a"),
            },
            AiConnection {
                provider: AiProvider::MiniMax,
                runs_on: AiRunsOn::UserSandbox,
                billing: AiBilling::BringYourOwn,
                account: s("MiniMax Coding Plan · minimax_…8c1d"),
            },
        ];
        if self.capabilities().local_ai {
            connections.insert(
                0,
                AiConnection {
                    provider: AiProvider::ClaudeCode,
                    runs_on: AiRunsOn::ThisDevice,
                    billing: AiBilling::BringYourOwn,
                    account: s("zack@grogan.codes"),
                },
            );
        }
        reply(Ok(connections))
    }

    fn inbox(&self, org: String) -> Reply<'_, Vec<InboxItem>> {
        reply(Ok(inbox(&org)))
    }

    fn repos(&self, org: String) -> Reply<'_, Vec<Repo>> {
        reply(Ok(all_repos()
            .into_iter()
            .filter(|repo| repo.id.owner == org)
            .collect()))
    }

    fn repo_home(&self, repo: RepoRef) -> Reply<'_, RepoHome> {
        reply(repo_home(&repo))
    }

    fn changes(&self, repo: RepoRef) -> Reply<'_, Vec<ChangeSummary>> {
        reply(find_repo(&repo).map(|_| changes_for(&repo)))
    }

    fn change(&self, repo: RepoRef, number: u32) -> Reply<'_, ChangeDetail> {
        reply(change_detail(&repo, number))
    }

    fn builds(&self, repo: RepoRef) -> Reply<'_, Vec<BuildSummary>> {
        reply(find_repo(&repo).map(|_| builds_for(&repo)))
    }

    fn build(&self, repo: RepoRef, id: String) -> Reply<'_, BuildRun> {
        reply(build(&repo, &id))
    }

    fn search(&self, repo: RepoRef, query: String) -> Reply<'_, SearchResults> {
        reply(search(&repo, &query))
    }

    fn repo_map(&self, repo: RepoRef) -> Reply<'_, RepoMap> {
        reply(repo_map(&repo))
    }

    fn spaces(&self, org: String) -> Reply<'_, Vec<Space>> {
        reply(Ok(spaces_for(&org)))
    }
}
