import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface WebStackProps extends StackProps {
  /** Apex for the landing page, e.g. `grogan.codes`. Omit to use the CloudFront domain. */
  readonly siteDomain?: string;
  /** Host for the app, e.g. `app.grogan.codes`. Omit to use the CloudFront domain. */
  readonly appDomain?: string;
  /** ACM certificate in us-east-1 covering both domains. Required when either domain is set. */
  readonly certificateArn?: string;
}

/** Landing page and app shell: two private buckets, each behind its own distribution. */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    if ((props.siteDomain ?? props.appDomain) && !props.certificateArn) {
      throw new Error("certificateArn (us-east-1) is required when siteDomain or appDomain is set");
    }
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)
      : undefined;

    const site = new StaticSite(this, "Site", {
      sourceDir: join(repoRoot, "apps", "site"),
      spa: false,
      domainName: props.siteDomain,
      certificate,
      connectSrc: [],
    });

    const app = new StaticSite(this, "App", {
      sourceDir: join(repoRoot, "apps", "ui", "dist"),
      spa: true,
      domainName: props.appDomain,
      certificate,
      connectSrc: [],
    });

    new CfnOutput(this, "SiteUrl", { value: site.url });
    new CfnOutput(this, "AppUrl", { value: app.url });

    // BucketDeployment's upload function is a CDK-owned singleton; its role
    // and runtime aren't configurable from here.
    const uploader = this.node.children.find((child) =>
      child.node.id.startsWith("Custom::CDKBucketDeployment"),
    );
    if (uploader) {
      const bucketArn = (bucket: s3.Bucket) =>
        `<${this.getLogicalId(bucket.node.defaultChild as s3.CfnBucket)}.Arn>/*`;
      const wildcards = [
        "Action::s3:Abort*",
        "Action::s3:DeleteObject*",
        "Action::s3:GetBucket*",
        "Action::s3:GetObject*",
        "Action::s3:List*",
        "Resource::*",
        `Resource::${bucketArn(site.bucket)}`,
        `Resource::${bucketArn(app.bucket)}`,
        `Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`,
      ];
      Validations.of(uploader).acknowledge(
        {
          id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
          reason: "CDK-managed deployment function uses AWSLambdaBasicExecutionRole for logs.",
        },
        ...wildcards.map((finding) => ({
          id: `AwsSolutions-IAM5[${finding}]`,
          reason: "CDK-managed deployment function copies assets into the site buckets and invalidates CloudFront.",
        })),
        { id: "AwsSolutions-L1", reason: "Runtime is pinned by aws-cdk-lib; upgrading the library upgrades it." },
      );
    }
  }
}

interface StaticSiteProps {
  readonly sourceDir: string;
  /** Serve `index.html` for unknown paths so the client router can handle them. */
  readonly spa: boolean;
  readonly domainName?: string;
  readonly certificate?: acm.ICertificate;
  readonly connectSrc: string[];
}

class StaticSite extends Construct {
  readonly url: string;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    const indexPath = join(props.sourceDir, "index.html");
    if (!existsSync(indexPath)) {
      throw new Error(`${indexPath} is missing. Build it first (apps/ui: trunk build --release).`);
    }

    const bucket = (this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    }));

    const headers = new cloudfront.ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: contentSecurityPolicy(readFileSync(indexPath, "utf8"), props.connectSrc),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate: props.domainName ? props.certificate : undefined,
      minimumProtocolVersion: props.domainName
        ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
        : undefined,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      errorResponses: props.spa
        ? [403, 404].map((httpStatus) => ({
            httpStatus,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(0),
          }))
        : undefined,
    });

    // Hashed assets are immutable; index.html must always revalidate so a
    // deploy takes effect without waiting for edge caches to expire.
    const assets = new s3deploy.BucketDeployment(this, "Assets", {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(props.sourceDir, { exclude: ["index.html"] })],
      cacheControl: [
        s3deploy.CacheControl.fromString(
          props.spa ? "public, max-age=31536000, immutable" : "public, max-age=3600",
        ),
      ],
      prune: false,
    });
    const index = new s3deploy.BucketDeployment(this, "Index", {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(props.sourceDir, { exclude: ["*", "!index.html"] })],
      cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
      prune: false,
      distribution,
      distributionPaths: ["/index.html", "/"],
    });
    index.node.addDependency(assets);

    this.url = `https://${props.domainName ?? distribution.distributionDomainName}`;

    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason: "Static public assets only; CloudFront is the sole reader. Access logging adds cost without audit value here.",
    });
    Validations.of(distribution).acknowledge(
      {
        id: "AwsSolutions-CFR1",
        reason: "Public marketing site and app shell are intentionally served worldwide.",
      },
      {
        id: "AwsSolutions-CFR2",
        reason: "WAF comes from the CloudFront flat-rate plan, attached at the account level when the custom domain goes live.",
      },
      {
        id: "AwsSolutions-CFR3",
        reason: "Standard logs are off until there is a log bucket in the log-archive account.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason: "Without a custom domain the default CloudFront certificate is used, which pins TLSv1. A custom domain enforces TLSv1.2_2021.",
      },
    );
  }
}

/** Builds a CSP that allows only this origin plus the inline scripts actually present in `html`. */
function contentSecurityPolicy(html: string, connectSrc: string[]): string {
  const inlineHashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? "")
    .filter((body) => body.trim().length > 0)
    .map((body) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`);

  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineHashes.join(" ")}`.trim(),
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src ${["'self'", ...connectSrc].join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
