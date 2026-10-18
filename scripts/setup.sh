#!/usr/bin/env bash
# One-shot setup: checks prerequisites, installs deps, deploys the CDK stacks to your AWS
# account, starts the first image builds, and builds the app. Safe to re-run.
#
#   AWS_PROFILE=<admin-profile> ./scripts/setup.sh
#
# Optional env: CODESPACE_AWS_REGIONS (default us-east-1,us-east-2,us-west-2; first = home),
# SKIP_INFRA=1 (app only), SKIP_IMAGES=1 (don't start the image pipelines).
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; }

[[ "$(uname)" == "Darwin" ]] || die "The app stores settings in the macOS Keychain, so it runs on macOS only."
need node "Install Node 22+ (brew install node)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || die "Node 22+ required."
need pnpm "Install pnpm (corepack enable pnpm, or brew install pnpm)."
need aws "Install the AWS CLI v2 (brew install awscli)."
need session-manager-plugin "Install it (brew install --cask session-manager-plugin)."
command -v gh >/dev/null || echo "note: gh not found; GitHub repo pickers need 'gh auth login'."
command -v claude >/dev/null || echo "note: claude not found; you'll need a token from 'claude setup-token' for Settings."

REGIONS="${CODESPACE_AWS_REGIONS:-us-east-1,us-east-2,us-west-2}"
HOME_REGION="${REGIONS%%,*}"

say "Installing app dependencies"
pnpm install --frozen-lockfile

if [[ -z "${SKIP_INFRA:-}" ]]; then
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" \
    || die "No AWS credentials. Run 'aws configure sso' / 'aws sso login' and set AWS_PROFILE."
  say "Deploying to account $ACCOUNT, regions $REGIONS (home $HOME_REGION)"
  (
    cd infra
    pnpm install --frozen-lockfile
    targets=(); IFS=, read -ra rs <<<"$REGIONS"
    for r in "${rs[@]}"; do targets+=("aws://$ACCOUNT/$r"); done
    pnpm exec cdk bootstrap "${targets[@]}"
    pnpm exec cdk deploy --all --require-approval never -c account="$ACCOUNT" -c regions="$REGIONS"
  )

  if [[ -z "${SKIP_IMAGES:-}" ]]; then
    say "Starting image builds in $HOME_REGION (20-40 min each; copied to every region)"
    for v in cpu-arm64 cpu-x86 gpu-arm64 gpu-x86; do
      arn=$(aws imagebuilder list-image-pipelines --region "$HOME_REGION" \
        --filters name=name,values="codespace-$v" --query 'imagePipelineList[0].arn' --output text)
      aws imagebuilder start-image-pipeline-execution --region "$HOME_REGION" --image-pipeline-arn "$arn" >/dev/null
      echo "  started $v"
    done
  fi
fi

say "Building the app"
pnpm build

cat <<EOF

Done. Start the app:   pnpm start    (http://localhost:4100)
Then open Settings and enter your AWS profile${AWS_PROFILE:+ ($AWS_PROFILE)}, regions ($REGIONS),
and a Claude token from 'claude setup-token'. Settings shows when the images are ready.
EOF
