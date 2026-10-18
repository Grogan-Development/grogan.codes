# EC2 for workspaces: research notes

Researched 2026-10-18. Prices come from the AWS Price List API and `describe-spot-price-history` (us-east-1, Linux), and from the AWS Spot Advisor data (`spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json`). Spot prices move hourly, so the tables below are a snapshot.

## Why EC2 instead of Modal

| | Modal Sandbox | EC2 instance |
|---|---|---|
| CPU price | $0.142 per physical core-hr + $0.024/GiB-hr (Sandbox rates are about 3× Functions rates) | m8g.xlarge (4 vCPU / 16 GiB) $0.18/hr on-demand, ~$0.07 spot |
| Stop | Filesystem snapshot then terminate. Processes are lost. Snapshots expire after 30 days by default. | Stop keeps the EBS disk. Hibernate also keeps RAM (CPU families only). |
| Lifetime | 24h hard cap | None |
| GPUs | Per-GPU pricing, cheap A100 and above | On-demand is cheaper or equal for T4/L4/A10G/L40S. A100/H200/B200 come only as 8-GPU instances. |
| Ports | Connect tokens on a public proxy | No inbound ports. SSH and port forwards travel over SSM. |

## Single-GPU instance types (us-east-1)

| GPU | Types | On-demand $/hr | Spot $/hr (2026-10-18) | Interruptions/month |
|---|---|---|---|---|
| ⅛–½ L4 | g6f.large → g6f.4xlarge, gr6f.4xlarge | 0.20–1.07 | 0.08–0.35 | <5% (large) to >20% |
| T4G (arm64) | g5g.xlarge → 8xlarge | 0.42–1.37 | 0.12–0.68 | 5–10% |
| T4 | g4dn.xlarge → 16xlarge | 0.53–4.35 | 0.29–1.18 | 10–15% (xlarge), else >20% |
| L4 | g6.xlarge → 16xlarge, gr6.4/8xlarge | 0.80–3.40 | 0.45–1.18 | mostly >20% |
| A10G (prev gen) | g5.xlarge → 16xlarge | 1.01–4.10 | 0.43–1.28 | mostly >20% |
| RTX PRO 4500 | g7.2/4/8xlarge | 2.52–4.09 | 0.61–0.74 | no data yet (new) |
| L40S | g6e.xlarge → 16xlarge | 1.86–7.58 | 1.70–2.65 (small sizes barely discounted) | 5–20%+ |
| RTX PRO 6000 | g7e.2/4/8xlarge | 3.36–5.27 | 1.45–3.61 | 10–20% |
| H100 | p5.4xlarge | 6.88 | 3.92 (us-west-2 2.63) | <5% |

None of these support hibernation. They stop and start with their disk kept.

**Spot prices don't follow size.** For example g6.4xlarge spot ($0.45) was cheaper than g6.xlarge ($0.51).

**Price and availability diverge by region.** The Spot Placement Score API (1–10) gave:
- p5.4xlarge: 9 in us-east-2, 1 in us-east-1 and us-west-2.
- g6e.xlarge: the reverse.

## Spot behaviour that matters

- A persistent spot request with interruption behaviour `stop`/`hibernate` keeps the EBS volume. The 2-minute warning appears at IMDS `spot/instance-action`.
- The EBS volume is bound to one AZ. Restarting elsewhere needs a snapshot and restore.
- Terminating a persistent spot instance without cancelling its request relaunches it.

## Account facts (2026-10-18)

- The vCPU quotas for G/VT and P instances are **0** for both on-demand and spot in us-east-1, us-east-2 and us-west-2. Standard instances allow 16 on-demand and 32 spot vCPUs.
- The `default` CLI profile is the root user. The app should use the `CodespaceApp` policy instead.

## Infra as code

- **AWS CDK (TypeScript)** was chosen. It's the same language as the app, AWS-only, and CloudFormation holds the state.
- **Alternatives:**
  - Pulumi (TypeScript, and could also manage Tailscale/GitHub).
  - OpenTofu/Terraform (HCL, portable).
  - SST targets serverless, so it doesn't fit.
  - CDK for Terraform was archived on 2025-12-10.
- **AMIs:** EC2 Image Builder, defined in the CDK stack, distributing to SSM parameters. Packer (BSL license) is the alternative.

## Hibernation prerequisites

- Linux RAM under 150 GiB.
- An encrypted EBS root volume (gp2/gp3/io1/io2) large enough for RAM plus usage.
- Enabled at launch only.
- Ubuntu 22.04 or 20.04, AL2023, or AL2. Ubuntu 24.04 isn't listed yet.
- Supported families include M/C/R 6–9 and T2/T3/T4g/T8i, Graviton included. **No G or P families.**
