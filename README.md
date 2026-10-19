# Grogan Code

Private git hosting, change requests, cached CI and a code graph pinned to every revision. Bring your own AI. Formerly Loom.

This repo currently holds the **disconnected frontend**: the landing page, the client UI running on mock data, and the AWS stack that hosts both. The backend (API, git, graph, build) isn't wired in yet.

## Layout

| Path | What it is |
| --- | --- |
| `apps/site` | `grogan.codes` landing page. Static HTML and CSS, no build step. |
| `apps/ui` | `app.grogan.codes` client. Leptos 0.8 single-page app, built with Trunk. The same build will load in the Tauri desktop and mobile shells. |
| `crates/api-types` | WASM-safe request and response types shared by the UI now, and later by the API, CLI and native core. |
| `infra` | AWS CDK (TypeScript): one stack with two private S3 buckets behind CloudFront. |

The UI never calls the network directly. Every screen goes through the `Platform` trait in `apps/ui/src/platform`. `MockPlatform` serves fixtures today; an HTTP platform (web) and a Tauri platform (desktop, mobile) will implement the same trait.

## Run locally

Requires the pinned Rust toolchain (`rust-toolchain.toml` adds the `wasm32-unknown-unknown` target) and [Trunk](https://trunkrs.dev).

```bash
cargo install trunk --locked
cd apps/ui && trunk serve          # http://127.0.0.1:4100
```

A bar at the bottom switches the mock between Web, macOS, Windows, Linux, iOS and Android. That changes the capability flags, which control features like local Claude Code and terminals, and shows mobile at phone width. `?platform=ios` sets it from the URL.

The landing page is plain files: open `apps/site/index.html`, or run `python3 -m http.server -d apps/site`.

Checks:

```bash
cargo fmt --all --check
cargo clippy --target wasm32-unknown-unknown --workspace --all-targets
```

## Deploy to AWS

```bash
(cd apps/ui && trunk build --release)    # synth reads apps/ui/dist
cd infra && npm ci
npx cdk bootstrap                         # once per account and region
npx cdk deploy                            # us-west-2, CloudFront default domains
```

To serve on `grogan.codes` and `app.grogan.codes`, issue one ACM certificate in **us-east-1** covering both names, then:

```bash
npx cdk deploy -c siteDomain=grogan.codes -c appDomain=app.grogan.codes -c certificateArn=arn:aws:acm:us-east-1:…
```

and point DNS at the two distributions in the stack outputs.

Each distribution sends a strict Content-Security-Policy. Synth hashes the inline scripts in each `index.html`, so rebuild the UI before every deploy. `cdk-nag` (AWS Solutions) runs on every synth. The rules it acknowledges carry their reasons in `infra/lib/web-stack.ts`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
