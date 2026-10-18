#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { CodespaceStack } from "../lib/codespace-stack";

/**
 * Context (pass with `-c key=value`):
 *   region            target region (default: CDK_DEFAULT_REGION, else us-east-1)
 *   account           target account (default: CDK_DEFAULT_ACCOUNT from your credentials)
 *   azs               comma-separated AZ names; skips the AZ lookup (default: every AZ, max 6)
 *   iam               "false" to skip the account-global CodespaceApp policy (2nd+ region)
 *   policyName        managed policy name (default CodespaceApp)
 *   appUser           "true" to create IAM user codespace-app with the policy (no keys)
 *   ebsEncryption     "false" to leave the account's EBS-encryption-by-default setting alone
 *   imageSchedule     "manual" (default) or "weekly"
 *   budgetEmail       turn on a monthly cost budget alert to this address
 *   budgetUsd         budget amount (default 100)
 */
const app = new App();
const ctx = (key: string): string | undefined => {
  const v = app.node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? undefined : String(v);
};
const flag = (key: string, fallback: boolean) => {
  const v = ctx(key);
  return v === undefined ? fallback : v === "true" || v === "1";
};

const region = ctx("region") ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1";
const account = ctx("account") ?? process.env.CDK_DEFAULT_ACCOUNT;
const schedule = ctx("imageSchedule") ?? "manual";
if (schedule !== "manual" && schedule !== "weekly") throw new Error(`imageSchedule must be manual or weekly, got ${schedule}`);
const budgetEmail = ctx("budgetEmail");

new CodespaceStack(app, "CodespaceStack", {
  env: { region, account },
  description: "Codespace: network, IAM, Image Builder pipelines and launch templates for EC2 workspaces",
  availabilityZones: ctx("azs")?.split(",").map((s) => s.trim()).filter(Boolean),
  createIam: flag("iam", true),
  policyName: ctx("policyName") ?? "CodespaceApp",
  createAppUser: flag("appUser", false),
  enableEbsEncryptionByDefault: flag("ebsEncryption", true),
  imageSchedule: schedule,
  budget: budgetEmail ? { email: budgetEmail, usd: Number(ctx("budgetUsd") ?? 100) } : undefined,
});
