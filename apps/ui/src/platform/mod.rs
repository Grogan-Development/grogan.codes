//! The UI never talks to the network directly. Every call goes through
//! [`Platform`], so the same build can run against the hosted API, a Tauri
//! native core, or the in-memory mock used while the backend doesn't exist.

mod mock;

use std::sync::Arc;

use api_types::{
    AiConnection, ApiError, BuildRun, BuildSummary, Capabilities, ChangeDetail, ChangeSummary,
    InboxItem, Repo, RepoHome, RepoMap, RepoRef, SearchResults, Session, Space,
};
use futures::future::LocalBoxFuture;
use leptos::prelude::*;

pub use mock::MockPlatform;

pub type Reply<'a, T> = LocalBoxFuture<'a, Result<T, ApiError>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformKind {
    Web,
    MacOs,
    Windows,
    Linux,
    Ios,
    Android,
}

impl PlatformKind {
    pub const ALL: [Self; 6] = [
        Self::Web,
        Self::MacOs,
        Self::Windows,
        Self::Linux,
        Self::Ios,
        Self::Android,
    ];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Web => "Web",
            Self::MacOs => "macOS",
            Self::Windows => "Windows",
            Self::Linux => "Linux",
            Self::Ios => "iOS",
            Self::Android => "Android",
        }
    }

    #[must_use]
    pub fn is_mobile(self) -> bool {
        match self {
            Self::Ios | Self::Android => true,
            Self::Web | Self::MacOs | Self::Windows | Self::Linux => false,
        }
    }

    /// Capability matrix from wireframe board F1.
    #[must_use]
    pub fn capabilities(self) -> Capabilities {
        let desktop = Capabilities {
            local_repos: true,
            local_ai: true,
            terminal: true,
            push_notifications: true,
            offline_cache: true,
            cli_install: true,
        };
        let mobile = Capabilities {
            local_repos: false,
            local_ai: false,
            terminal: false,
            push_notifications: true,
            offline_cache: true,
            cli_install: false,
        };
        match self {
            Self::Web => Capabilities {
                local_repos: false,
                local_ai: false,
                terminal: false,
                push_notifications: false,
                offline_cache: false,
                cli_install: false,
            },
            Self::MacOs | Self::Windows | Self::Linux => desktop,
            Self::Ios | Self::Android => mobile,
        }
    }

    #[must_use]
    pub fn from_query(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.label().eq_ignore_ascii_case(value))
    }
}

pub trait Platform: Send + Sync {
    fn kind(&self) -> PlatformKind;

    fn capabilities(&self) -> Capabilities {
        self.kind().capabilities()
    }

    fn session(&self) -> Reply<'_, Session>;
    fn ai_connections(&self) -> Reply<'_, Vec<AiConnection>>;
    fn inbox(&self, org: String) -> Reply<'_, Vec<InboxItem>>;
    fn repos(&self, org: String) -> Reply<'_, Vec<Repo>>;
    fn repo_home(&self, repo: RepoRef) -> Reply<'_, RepoHome>;
    fn changes(&self, repo: RepoRef) -> Reply<'_, Vec<ChangeSummary>>;
    fn change(&self, repo: RepoRef, number: u32) -> Reply<'_, ChangeDetail>;
    fn builds(&self, repo: RepoRef) -> Reply<'_, Vec<BuildSummary>>;
    fn build(&self, repo: RepoRef, id: String) -> Reply<'_, BuildRun>;
    fn search(&self, repo: RepoRef, query: String) -> Reply<'_, SearchResults>;
    /// Selected code map (identities, supports edges, model provenance) for a repo.
    fn repo_map(&self, repo: RepoRef) -> Reply<'_, RepoMap>;
    /// All Spaces visible in an org (global board; repo pages filter by repo).
    fn spaces(&self, org: String) -> Reply<'_, Vec<Space>>;
}

pub type SharedPlatform = Arc<dyn Platform>;

/// Reactive handle to the active platform. Swapping it re-runs every resource
/// that read it, which is how the preview switcher re-renders per platform.
#[derive(Clone, Copy)]
pub struct PlatformHandle(RwSignal<SharedPlatform>);

impl PlatformHandle {
    pub fn provide(platform: SharedPlatform) {
        provide_context(Self(RwSignal::new(platform)));
    }

    #[must_use]
    pub fn get(self) -> SharedPlatform {
        self.0.get()
    }

    pub fn set(self, platform: SharedPlatform) {
        self.0.set(platform);
    }
}

#[must_use]
pub fn use_platform() -> PlatformHandle {
    use_context::<PlatformHandle>().unwrap_or_else(|| {
        let handle = PlatformHandle(RwSignal::new(Arc::new(MockPlatform::new(
            PlatformKind::Web,
        ))));
        provide_context(handle);
        handle
    })
}

/// The org (tenant) the user is currently working in.
#[derive(Clone, Copy)]
pub struct ActiveOrg(pub RwSignal<String>);

#[must_use]
pub fn use_active_org() -> RwSignal<String> {
    use_context::<ActiveOrg>().map_or_else(
        || {
            let org = RwSignal::new(String::new());
            provide_context(ActiveOrg(org));
            org
        },
        |active| active.0,
    )
}
