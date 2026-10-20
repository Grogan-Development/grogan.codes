use api_types::{
    AiBilling, AiProvider, ApiError, ChangeState, CheckState, GraphHit, StepState, Tier,
};
use leptos::prelude::*;

/// Display name for a model provider / harness.
#[must_use]
pub fn provider_label(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::ClaudeCode => "Claude Code",
        AiProvider::Codex => "Codex",
        AiProvider::AnthropicApiKey => "Anthropic API key",
        AiProvider::OpenAiApiKey => "OpenAI API key",
        AiProvider::Gemini => "Gemini",
        AiProvider::Grok => "Grok",
        AiProvider::Zai => "Z.ai GLM",
        AiProvider::MiniMax => "MiniMax",
        AiProvider::Mimo => "Xiaomi MiMo",
        AiProvider::DeepSeek => "DeepSeek",
        AiProvider::Kimi => "Kimi",
        AiProvider::Qwen => "Qwen",
        AiProvider::OpenRouter => "OpenRouter",
    }
}

/// Chip label for how model usage is paid for.
#[must_use]
pub fn billing_label(billing: AiBilling) -> &'static str {
    match billing {
        AiBilling::ManagedCredits => "Grogan credits",
        AiBilling::BringYourOwn => "BYO plan",
    }
}

/// Renders a resource with shared loading and error states.
pub fn load<T, V, F>(resource: LocalResource<Result<T, ApiError>>, render: F) -> impl IntoView
where
    T: Clone + 'static,
    V: IntoView + 'static,
    F: Fn(T) -> V + Send + Sync + 'static,
{
    view! {
        <Suspense fallback=|| view! { <Loading/> }>
            {move || {
                resource
                    .get()
                    .map(|result| match result {
                        Ok(value) => render(value).into_any(),
                        Err(error) => view! { <ErrorState error/> }.into_any(),
                    })
            }}
        </Suspense>
    }
}

#[component]
pub fn Loading() -> impl IntoView {
    view! {
        <div class="loading" aria-busy="true" aria-label="Loading">
            <span class="skeleton w-60"></span>
            <span class="skeleton w-90"></span>
            <span class="skeleton w-75"></span>
        </div>
    }
}

#[component]
pub fn ErrorState(error: ApiError) -> impl IntoView {
    let hint = match &error {
        ApiError::NotFound => "It doesn't exist, or you don't have access to it.",
        ApiError::Unauthorized => "Your session ended. Sign in again to continue.",
        ApiError::Unavailable { .. } => "Retry in a moment. Cached pages still work.",
    };
    view! {
        <div class="error-state" role="alert">
            <p class="error-title">{error.to_string()}</p>
            <p class="muted">{hint}</p>
        </div>
    }
}

#[component]
pub fn CheckBadge(state: CheckState) -> impl IntoView {
    let (class, label) = match state {
        CheckState::Queued => ("badge neutral", "queued"),
        CheckState::Running => ("badge running", "running"),
        CheckState::Passed => ("badge ok", "passed"),
        CheckState::Failed => ("badge bad", "failed"),
        CheckState::Cancelled => ("badge neutral", "cancelled"),
    };
    view! { <span class=class>{label}</span> }
}

#[component]
pub fn ChangeBadge(state: ChangeState) -> impl IntoView {
    let (class, label) = match state {
        ChangeState::Draft => ("badge neutral", "draft"),
        ChangeState::Open => ("badge open", "open"),
        ChangeState::Queued => ("badge running", "in queue"),
        ChangeState::Merged => ("badge merged", "merged"),
        ChangeState::Closed => ("badge neutral", "closed"),
    };
    view! { <span class=class>{label}</span> }
}

#[component]
pub fn StepBadge(state: StepState) -> impl IntoView {
    let (class, label) = match state {
        StepState::Cached => ("badge cached", "cached"),
        StepState::Passed => ("badge ok", "passed"),
        StepState::Failed => ("badge bad", "failed"),
        StepState::Running => ("badge running", "running"),
        StepState::Skipped => ("badge neutral", "skipped"),
    };
    view! { <span class=class>{label}</span> }
}

/// One graph answer line: tier tag, location, and the inlined source line.
#[component]
pub fn HitRow(hit: GraphHit) -> impl IntoView {
    let tier = match hit.tier {
        Tier::Exact => view! { <span class="tier exact">"exact"</span> },
        Tier::Candidate => view! { <span class="tier cand">"cand"</span> },
    };
    let symbol = (!hit.symbol.is_empty())
        .then(|| view! { <span class="hit-symbol">{hit.symbol.clone()}</span> });
    view! {
        <li class="hit">
            {tier}
            <span class="hit-loc">{format!("{}:{}", hit.path, hit.line)}</span>
            {symbol}
            <code class="hit-src">{hit.source}</code>
        </li>
    }
}

#[component]
pub fn NotBuilt(#[prop(into)] board: String, #[prop(into)] title: String) -> impl IntoView {
    view! {
        <section class="page narrow">
            <h1>{title}</h1>
            <p class="muted">
                "This screen is specified in wireframe board " <code>{board}</code>
                " and hasn't been built yet."
            </p>
        </section>
    }
}
