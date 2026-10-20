# Loom backend → Grogan Code UI map

Where the actual backend code lives, and which UI surface each module backs.
Backend repo: `~/Repos/Loom` (read-only reference — not part of this repo).
This repo holds the disconnected Leptos frontend (`apps/ui`) on `MockPlatform`;
every screen below goes through the `Platform` trait in `apps/ui/src/platform`,
so a real HTTP platform only has to implement the same methods.

## The five pillars

| UI tab | App route(s) | Loom backend | Key contracts (backend → `crates/api-types`) |
| --- | --- | --- | --- |
| 01 Code Reviews | `/r/:owner/:repo/changes`, `/changes/:n` | `features.rs`, `review.rs`, `insights.rs`, `server.rs` (`/v1/change-requests…`, legacy `/v1/features…`) | `Feature` + `FeatureGate` (Draft → Gate 1 Approved → Accepted/Rejected) → `GateStage`; `Scenario` (given/when/then) → `Scenario`; `EvidenceBundle{digest, tests_passed, job_id}` → `EvidenceBundle`; `Review`/`ReviewVerdict`/`Finding{severity, path, start_line, end_line, suggested_patch, approved, applied}`/`Comment{author: human \| agent:<name>}` → `ReviewVerdict`, `Finding`, `ReviewComment`; insights blast radius → `ChangeDetail.impact` |
| 02 Repos | `/repos`, `/r/:owner/:repo` | `catalog.rs`, `git.rs`, `admissions.rs`, `import.rs`, `server.rs` (`/v1/repos…`, `/git/{repo}.git/…`, `/v1/tree`, `/v1/blob`, `/v1/compare`) | `RepoEntry{name, protected_ref=refs/main, ci: CiPolicy::LoomCi, deploy_target, description}` → `Repo{protected_ref, ci_policy, deploy_target}`; `Admission{source: git_push \| import \| native_commit \| change_request_accept, ref_name, base_revision, head_revision}` → `Admission`; CAS materialization (`tree`/`blob`) → `RepoHome{entries, readme, head}` |
| 03 DeepWiki & Graph | `/r/:owner/:repo/graph` (+ `/search`) | `maps.rs`, `map_jobs.rs`, `mapper_*`, `insights.rs`, `search.rs`, `server.rs` (`/v1/maps/{repo}/{revision}`, `/generations`, `/select/{generation}`, `/v1/map-status/…`, `/v1/search`) | `MapArtifact{membership, substrate_membership, supports, source_anchors}` → `RepoMap{identities, supports}`; `SupportsEdge{kind: dedicated \| shared, confidence, source_anchors}` → `SupportsEdge`; `MapReadStatus` → `MapStatus`; `GenerationStatus` (only complete is selectable) → `GenerationStatus`; `ModelProvenance{actual_provider, actual_model, actual_route, usage{input_tokens, output_tokens, cost_micros}}` → `ModelProvenance` |
| 04 AI Spaces | `/spaces`, `/r/:owner/:repo/spaces` | **No backend yet.** Closest code: `ci_worker.rs` (disposable-VM worker, `ExecutionConfig::Worker` fingerprint, vsock guest `loom-ci-guest`), `jobs.rs` (durable lease-claimed jobs), `runner.rs` | Frontend contract in `api-types`: `Space{branch (worktree), status: starting \| running \| hibernated \| stopped, agent{provider, model, billing}, machine, change_number}` modelled on `CiDurableJob{status, lease, attempts, cached_from}`. A future `spaces` service should persist Spaces the way CI jobs persist under `jobs/ci/`, and land work only via `POST /v1/change-requests/{id}/candidates` |
| 05 Builds | `/r/:owner/:repo/builds`, `/builds/:id` | `ci.rs`, `jobs.rs`, `ci_worker.rs`, `server.rs` (`/v1/releases/{repo}/ci`) | `CiDurableJob{git_oid (exact), revision, ref_name, admission_id, status: queued \| running \| passed \| failed, attempts, lease, cached_from, evidence_digest}` → `BuildRun{git_oid, source_key, ref_name, attempts, cached_from, evidence_digest}` + `BuildSummary`; `CiEngine::source_key = ci-v2:<worker fingerprint>\|repo:base:head` → `BuildRun.source_key`; pipeline from `loom-ci.toml` (`load_pipeline`) |

## Cross-cutting backend facts the UI now shows

- **Protected refs** advance only through Gate-2 accept: atomic compare-and-swap
  with an exact reverse CAS retained as rollback proof (`features.rs`,
  `promotion_updates`, `rollback`) → Gate stepper + "Accept candidate (Gate 2)".
- **Admissions ledger**: every non-empty admitted tree records an edge; CI never
  runs inside receive-pack (`admissions.rs`) → repo-home "How refs moved".
- **CI evidence is exact-OID only**: a passing job for one revision is the digest
  cache for another admission of the same tree (`jobs.rs`) → Builds headers.
- **Review findings** may carry a suggested patch; a human must approve before
  apply, and apply produces a new candidate revision (`review.rs`) → finding card.
- **Map generations are immutable**: failed generations are never selectable and
  never returned as a current artifact; rerun schedules a *new* generation
  (`maps.rs`) → DeepWiki "Code map" card + rerun button.
- **Model provenance, never credentials**: map/CI runs record provider, model,
  route and token usage (`maps::ModelProvenance`) → DeepWiki provenance card.
  This is also where Grogan-managed token credits vs BYO coding plans surface
  (`AiConnection.billing`, `SpaceAgent.billing`).

## Token / provider model (product decision, 2026-10-19)

Grogan **sells managed token credits** (one balance routes to any provider)
**and** supports bring-your-own subscription / coding plan / API key at $0
markup. Providers: Anthropic/Claude Code, OpenAI/Codex, Gemini, Grok, Z.ai GLM,
MiniMax, Xiaomi MiMo, DeepSeek, Kimi, Qwen, OpenRouter (`AiProvider`).
