import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import { WebStack } from "../lib/web-stack.ts";

const app = new App();

const context = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

new WebStack(app, "GroganCodeWeb", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: context("region") ?? "us-west-2",
  },
  siteDomain: context("siteDomain"),
  appDomain: context("appDomain"),
  certificateArn: context("certificateArn"),
});

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
