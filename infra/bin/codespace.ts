#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { CodespaceStack } from "../lib/codespace-stack";

/**
 * One CodespaceStack per region, named Codespace-<region>. The first region is home: only its
 * stack has the Image Builder pipelines (which distribute to every region) and the account-global
 * IAM policy/user and budget. `cdk deploy --all` deploys them all.
 *
 * Context (pass with `-c key=value`):
 *   regions           comma-separated, home first (default us-east-1,us-east-2,us-west-2)
 *   account           target account (default: CDK_DEFAULT_ACCOUNT from your credentials)
 *   azs.<region>      comma-separated AZ names for that region; skips its AZ lookup
 *   policyName        managed policy name (default CodespaceApp)
 *   appUser           "true" to create IAM user codespace-app with the policy (no keys)
 *   ebsEncryption     "false" to leave the account's EBS-encryption-by-default setting alone
 *   imageSchedule     "manual" (default) or "weekly"
 *   budgetEmail       turn on a monthly cost budget alert to this address
 *   budgetUsd         budget amount (default 100)
 */
const DEFAULT_REGIONS = ["us-east-1", "us-east-2", "us-west-2"];

const app = new App();
const ctx = (key: string): string | undefined => {
  const v = app.node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? undefined : String(v);
};
const flag = (key: string, fallback: boolean) => {
  const v = ctx(key);
  return v === undefined ? fallback : v === "true" || v === "1";
};
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const regions = [...new Set(list(ctx("regions")))];
if (!regions.length) regions.push(...DEFAULT_REGIONS);
for (const r of regions) if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(r)) throw new Error(`Not a region name: ${r}`);
const [home] = regions;

const account = ctx("account") ?? process.env.CDK_DEFAULT_ACCOUNT;
const schedule = ctx("imageSchedule") ?? "manual";
if (schedule !== "manual" && schedule !== "weekly") throw new Error(`imageSchedule must be manual or weekly, got ${schedule}`);
const budgetEmail = ctx("budgetEmail");

for (const region of regions) {
  const isHome = region === home;
  new CodespaceStack(app, `Codespace-${region}`, {
    env: { region, account },
    description: `Codespace ${isHome ? "home region" : "region"} ${region}: network, launch templates${isHome ? ", Image Builder pipelines, IAM" : ""}`,
    availabilityZones: list(ctx(`azs.${region}`)),
    images: isHome,
    distributionRegions: regions,
    createIam: isHome,
    policyName: ctx("policyName") ?? "CodespaceApp",
    createAppUser: isHome && flag("appUser", false),
    enableEbsEncryptionByDefault: flag("ebsEncryption", true),
    imageSchedule: schedule,
    budget: isHome && budgetEmail ? { email: budgetEmail, usd: Number(ctx("budgetUsd") ?? 100) } : undefined,
  });
}
