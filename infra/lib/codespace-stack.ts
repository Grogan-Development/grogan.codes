import { createHash } from "node:crypto";
import * as path from "node:path";
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps, Tags } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as imagebuilder from "aws-cdk-lib/aws-imagebuilder";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { Arch, BUILD_INSTANCE_TYPES, IMAGE_VARIANTS, ImageVariant, PARAM_PREFIX, PARAMS, TAG_APP, VARIANTS } from "./names";

export type CodespaceStackProps = StackProps & {
  /** Explicit AZ names. When omitted, CDK looks up the region's AZs (needs a concrete account). */
  availabilityZones?: string[];
  /** Create the account-global IAM pieces: the CodespaceApp managed policy (and optional user). */
  createIam: boolean;
  /** Name of the managed policy. */
  policyName: string;
  /** Also create IAM user `codespace-app` with the policy attached. Never creates access keys. */
  createAppUser: boolean;
  /** Turn on account+region EBS encryption by default. */
  enableEbsEncryptionByDefault: boolean;
  /** "manual" (default) or "weekly" pipeline runs. */
  imageSchedule: "manual" | "weekly";
  /** Monthly cost budget alert; off unless an email is given. */
  budget?: { email: string; usd: number };
};

/** Root device name of both Ubuntu 22.04 and the DLAMI. The app reads the real one from the AMI. */
const ROOT_DEVICE = "/dev/sda1";
/** Root volume of the CPU images. Workspaces get their real size from the app at launch. */
const CPU_IMAGE_ROOT_GB = 16;

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

export class CodespaceStack extends Stack {
  private readonly explicitAzs?: string[];

  constructor(scope: Construct, id: string, props: CodespaceStackProps) {
    super(scope, id, props);
    this.explicitAzs = props.availabilityZones?.length ? props.availabilityZones : undefined;

    const appTag = { key: TAG_APP.Key, value: TAG_APP.Value };
    const logGroup = (id: string) => new logs.LogGroup(this, id, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });

    // ---- Network ----------------------------------------------------------------------------
    // Public subnets only, one per AZ, no NAT. Instances get a public IPv4 at launch and reach
    // the internet (and SSM) directly; nothing can reach them because the SG has no ingress.
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.70.0.0/16"),
      maxAzs: 6,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20, mapPublicIpOnLaunch: true }],
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
    });
    // Gateway endpoints for S3 are free; this keeps apt mirrors on S3 (and CDK assets) off the
    // public path.
    vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    Tags.of(vpc).add(TAG_APP.Key, TAG_APP.Value);

    const sg = new ec2.SecurityGroup(this, "WorkspaceSg", {
      vpc,
      description: "Codespace workspaces: no inbound (SSH arrives through SSM), all outbound",
      allowAllOutbound: true,
    });
    Tags.of(sg).add(TAG_APP.Key, TAG_APP.Value);
    Tags.of(sg).add("Name", "codespace-workspace");

    // ---- Workspace instance role ------------------------------------------------------------
    // Path /codespace/ lets the region-agnostic app policy scope iam:PassRole to these roles.
    const instanceRole = new iam.Role(this, "InstanceRole", {
      path: "/codespace/",
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Codespace workspace instances (SSM Session Manager)",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    const instanceProfile = new iam.InstanceProfile(this, "InstanceProfile", { role: instanceRole, path: "/codespace/" });

    // ---- EBS encryption by default ----------------------------------------------------------
    // Account+region-wide switch. Launch templates and the app already ask for encrypted volumes;
    // this also covers anything else (Image Builder build volumes, hand launches). Left enabled on
    // stack deletion, since turning it off could surprise other workloads.
    if (props.enableEbsEncryptionByDefault) {
      const call: cr.AwsSdkCall = {
        service: "EC2",
        action: "EnableEbsEncryptionByDefault",
        physicalResourceId: cr.PhysicalResourceId.of(`ebs-encryption-by-default-${this.region}`),
      };
      new cr.AwsCustomResource(this, "EbsEncryptionByDefault", {
        onCreate: call,
        onUpdate: call,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ["ec2:EnableEbsEncryptionByDefault"], resources: ["*"] }),
        ]),
        installLatestAwsSdk: false,
        logGroup: logGroup("EbsEncryptionByDefaultLogs"),
      });
    }

    // ---- AMI parameters (bootstrap) ---------------------------------------------------------
    // Launch templates resolve the AMI from /codespace/ami/<variant> at launch, so the parameter
    // must exist before any template is created, but only an Image Builder run writes the real
    // value. A custom resource seeds each parameter with its parent AMI if (and only if) it's
    // missing. CloudFormation never owns the value, so redeploys don't clobber built AMIs.
    const amiParamArn = (v: ImageVariant) => this.formatArn({ service: "ssm", resource: "parameter", resourceName: PARAMS.amiId(v).slice(1) });
    const seedFn = new lambda.Function(this, "AmiParamSeedFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: Duration.minutes(5),
      description: "Seeds /codespace/ami/* with the parent AMI until Image Builder writes a real one",
      code: lambda.Code.fromInline(SEED_HANDLER),
      logGroup: logGroup("AmiParamSeedLogs"),
    });
    seedFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameters"],
        resources: IMAGE_VARIANTS.map(amiParamArn),
      }),
    );
    seedFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:${this.partition}:ssm:${this.region}::parameter/aws/service/*`],
      }),
    );
    // aws:ec2:image parameters are validated against EC2 with the caller's credentials.
    seedFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["ec2:DescribeImages"], resources: ["*"] }));
    const seedProvider = new cr.Provider(this, "AmiParamSeedProvider", {
      onEventHandler: seedFn,
      logGroup: logGroup("AmiParamSeedProviderLogs"),
    });
    const amiSeed = new CustomResource(this, "AmiParamSeed", {
      serviceToken: seedProvider.serviceToken,
      resourceType: "Custom::CodespaceAmiParams",
      properties: {
        Params: IMAGE_VARIANTS.map((v) => ({ name: PARAMS.amiId(v), parent: VARIANTS[v].parentParam })),
      },
    });

    // ---- Image Builder ----------------------------------------------------------------------
    const buildRole = new iam.Role(this, "ImageBuildInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Codespace Image Builder build instances",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("EC2InstanceProfileForImageBuilder"),
      ],
    });
    const buildProfile = new iam.InstanceProfile(this, "ImageBuildInstanceProfile", { role: buildRole });

    // The service-linked role may only write parameters under /imagebuilder/, so the pipelines run
    // with an execution role that may also write /codespace/ami/*.
    const executionRole = new iam.Role(this, "ImageBuilderExecutionRole", {
      assumedBy: new iam.ServicePrincipal("imagebuilder.amazonaws.com"),
      description: "Codespace Image Builder pipelines (build + distribute to /codespace/ami/*)",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("EC2ImageBuilderExecutionPolicy")],
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: IMAGE_VARIANTS.map(amiParamArn) }),
    );

    const setupScript = new Asset(this, "SetupScript", { path: path.join(__dirname, "..", "image", "setup.sh") });
    setupScript.grantRead(buildRole);

    const componentDoc = [
      "name: codespace-setup",
      "description: Installs and configures everything a Codespace workspace needs (infra/image/setup.sh).",
      "schemaVersion: 1.0",
      "parameters:",
      "  - Variant:",
      "      type: string",
      "      default: cpu-x86",
      "      description: Image variant (cpu-arm64, cpu-x86, gpu-arm64, gpu-x86).",
      "phases:",
      "  - name: build",
      "    steps:",
      "      - name: Download",
      "        action: S3Download",
      "        inputs:",
      `          - source: s3://${setupScript.s3BucketName}/${setupScript.s3ObjectKey}`,
      "            destination: /var/tmp/codespace-setup.sh",
      "      - name: Setup",
      "        action: ExecuteBash",
      "        timeoutSeconds: 5400",
      "        inputs:",
      "          commands:",
      "            - CODESPACE_VARIANT='{{ Variant }}' bash /var/tmp/codespace-setup.sh",
      "",
    ].join("\n");
    // Components and recipes are immutable per name+version, so content changes get a new name.
    const componentName = `codespace-setup-${short(setupScript.assetHash + COMPONENT_DOC_REVISION)}`;
    const component = new imagebuilder.CfnComponent(this, "SetupComponent", {
      name: componentName,
      version: "1.0.0",
      platform: "Linux",
      description: "Codespace workspace setup (infra/image/setup.sh)",
      changeDescription: `setup.sh ${setupScript.assetHash.slice(0, 12)}`,
      data: componentDoc,
      tags: { app: TAG_APP.Value },
    });

    const subnetIds = vpc.publicSubnets.map((s) => s.subnetId);
    const infraConfigs = {} as Record<Arch, imagebuilder.CfnInfrastructureConfiguration>;
    for (const arch of ["x86_64", "arm64"] as Arch[]) {
      infraConfigs[arch] = new imagebuilder.CfnInfrastructureConfiguration(this, `BuildInfra-${arch}`, {
        name: `codespace-build-${arch}`,
        description: `Codespace image builds (${arch})`,
        instanceTypes: BUILD_INSTANCE_TYPES[arch],
        instanceProfileName: buildProfile.instanceProfileName,
        subnetId: subnetIds[0],
        securityGroupIds: [sg.securityGroupId],
        terminateInstanceOnFailure: true,
        instanceMetadataOptions: { httpTokens: "required", httpPutResponseHopLimit: 2 },
        resourceTags: { "codespace-build": "true" },
        tags: { app: TAG_APP.Value },
      });
    }

    const pipelines: Record<string, imagebuilder.CfnImagePipeline> = {};
    for (const v of IMAGE_VARIANTS) {
      const spec = VARIANTS[v];
      const parentImage = `ssm:${spec.parentParam}`;
      const blockDeviceMappings: imagebuilder.CfnImageRecipe.InstanceBlockDeviceMappingProperty[] = [
        {
          deviceName: ROOT_DEVICE,
          // The DLAMI keeps its own (larger) root size; the CPU images stay small.
          ebs: { volumeType: "gp3", encrypted: true, deleteOnTermination: true, ...(spec.gpu ? {} : { volumeSize: CPU_IMAGE_ROOT_GB }) },
        },
      ];
      const recipeName = `codespace-${v}-${short(JSON.stringify({ parentImage, componentName, blockDeviceMappings }))}`;
      const recipe = new imagebuilder.CfnImageRecipe(this, `Recipe-${v}`, {
        name: recipeName,
        version: "1.0.0",
        description: `Codespace ${v} workspace image`,
        parentImage,
        components: [{ componentArn: component.attrArn, parameters: [{ name: "Variant", value: [v] }] }],
        blockDeviceMappings,
        workingDirectory: "/var/tmp",
        additionalInstanceConfiguration: { systemsManagerAgent: { uninstallAfterBuild: false } },
        tags: { app: TAG_APP.Value, variant: v },
      });

      const distribution = new imagebuilder.CfnDistributionConfiguration(this, `Distribution-${v}`, {
        name: `codespace-${v}`,
        description: `Codespace ${v}: AMI in this region, ID written to ${PARAMS.amiId(v)}`,
        distributions: [
          {
            region: this.region,
            // Untyped JSON in the L1, so CloudFormation's PascalCase keys.
            amiDistributionConfiguration: {
              Name: `codespace-${v}-{{ imagebuilder:buildDate }}`,
              Description: `Codespace ${v} workspace image`,
              AmiTags: { [TAG_APP.Key]: TAG_APP.Value, variant: v },
            },
            ssmParameterConfigurations: [{ parameterName: PARAMS.amiId(v), dataType: "aws:ec2:image" }],
          },
        ],
        tags: { app: TAG_APP.Value },
      });
      // Image Builder checks an existing parameter's type when the distribution is created.
      distribution.node.addDependency(amiSeed);

      pipelines[v] = new imagebuilder.CfnImagePipeline(this, `Pipeline-${v}`, {
        name: `codespace-${v}`,
        description: `Codespace ${v} workspace image (${spec.arch}${spec.gpu ? ", NVIDIA" : ""})`,
        imageRecipeArn: recipe.attrArn,
        infrastructureConfigurationArn: infraConfigs[spec.arch].attrArn,
        distributionConfigurationArn: distribution.attrArn,
        executionRole: executionRole.roleArn,
        imageTestsConfiguration: { imageTestsEnabled: false, timeoutMinutes: 60 },
        enhancedImageMetadataEnabled: true,
        status: "ENABLED",
        ...(props.imageSchedule === "weekly"
          ? { schedule: { scheduleExpression: "cron(0 9 ? * mon *)", pipelineExecutionStartCondition: "EXPRESSION_MATCH_ONLY" } }
          : {}),
        tags: { app: TAG_APP.Value, variant: v },
      });
      pipelines[v].node.addDependency(executionRole);
    }

    // ---- Launch templates -------------------------------------------------------------------
    // Instance type, market, hibernation, subnet, root size and user data come from the app.
    for (const v of IMAGE_VARIANTS) {
      const launchTemplateData: ec2.CfnLaunchTemplate.LaunchTemplateDataProperty = {
        // Plain EC2 syntax (no braces): resolved by EC2 at every launch, not by CloudFormation.
        imageId: `resolve:ssm:${PARAMS.amiId(v)}`,
        iamInstanceProfile: { arn: instanceProfile.instanceProfileArn },
        // Top-level SecurityGroupIds (not NetworkInterfaces): the app passes SubnetId itself.
        securityGroupIds: [sg.securityGroupId],
        metadataOptions: { httpEndpoint: "enabled", httpTokens: "required", httpPutResponseHopLimit: 2 },
        blockDeviceMappings: [{ deviceName: ROOT_DEVICE, ebs: { volumeType: "gp3", encrypted: true, deleteOnTermination: true } }],
        tagSpecifications: [
          { resourceType: "instance", tags: [appTag] },
          { resourceType: "volume", tags: [appTag] },
        ],
      };
      // The app launches `$Default`, and CloudFormation can't move the default version when the
      // data changes (it only adds versions). So the name carries a hash of the data: any change
      // replaces the template (new ID, version 1 = default) and the parameter follows.
      const ltHash = short(JSON.stringify(this.resolve(launchTemplateData)));
      const lt = new ec2.CfnLaunchTemplate(this, `LaunchTemplate-${v}`, {
        launchTemplateName: `codespace-${v}-${ltHash}`,
        versionDescription: `Codespace ${v}`,
        launchTemplateData,
        tagSpecifications: [{ resourceType: "launch-template", tags: [appTag, { key: "variant", value: v }] }],
      });
      lt.node.addDependency(amiSeed);

      new ssm.StringParameter(this, `LaunchTemplateParam-${v}`, {
        parameterName: PARAMS.launchTemplateId(v),
        stringValue: lt.ref,
        description: `Codespace ${v} launch template ID`,
      });
    }

    // ---- Parameters the app reads -----------------------------------------------------------
    new ssm.StringListParameter(this, "SubnetIdsParam", {
      parameterName: PARAMS.subnetIds,
      stringListValue: subnetIds,
      description: "Codespace public subnets, one per AZ",
    });
    new ssm.StringParameter(this, "SecurityGroupIdParam", {
      parameterName: PARAMS.securityGroupId,
      stringValue: sg.securityGroupId,
      description: "Codespace workspace security group (no inbound)",
    });
    new ssm.StringParameter(this, "InstanceProfileArnParam", {
      parameterName: PARAMS.instanceProfileArn,
      stringValue: instanceProfile.instanceProfileArn,
      description: "Codespace workspace instance profile (AmazonSSMManagedInstanceCore)",
    });

    // ---- App policy (account-global) --------------------------------------------------------
    if (props.createIam) {
      const policy = new iam.ManagedPolicy(this, "AppPolicy", {
        managedPolicyName: props.policyName,
        description: "What the Codespace app needs to run workspaces on EC2 (any region with CodespaceStack)",
        document: appPolicyDocument(this.partition, this.account),
      });
      new CfnOutput(this, "AppPolicyArn", { value: policy.managedPolicyArn });
      if (props.createAppUser) {
        const user = new iam.User(this, "AppUser", { userName: "codespace-app", managedPolicies: [policy] });
        new CfnOutput(this, "AppUserName", { value: user.userName, description: "Create an access key by hand if you use this user" });
      }
    }

    // ---- Budget (optional, account-global) --------------------------------------------------
    if (props.budget) {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: "codespace-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.budget.usd, unit: "USD" },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
            subscribers: [{ subscriptionType: "EMAIL", address: props.budget.email }],
          },
          {
            notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
            subscribers: [{ subscriptionType: "EMAIL", address: props.budget.email }],
          },
        ],
      });
    }

    new CfnOutput(this, "PipelineArns", {
      value: IMAGE_VARIANTS.map((v) => pipelines[v].attrArn).join(","),
      description: "Run each once after the first deploy (see infra/README.md)",
    });
    new CfnOutput(this, "ParamPrefix", { value: PARAM_PREFIX });
  }

  /** `-c azs=...` replaces the AZ lookup (which needs credentials and a concrete account). */
  get availabilityZones(): string[] {
    return this.explicitAzs ?? super.availabilityZones;
  }
}

/** Bump when the component YAML above changes without setup.sh changing. */
const COMPONENT_DOC_REVISION = "1";

/**
 * The app's permissions. Region-agnostic (one policy serves every region the stack is deployed
 * to) and scoped by the `app=codespace` tag wherever EC2/SSM support it.
 */
export function appPolicyDocument(partition: string, account: string): iam.PolicyDocument {
  const ec2Arn = (resource: string) => `arn:${partition}:ec2:*:${account}:${resource}`;
  const tagged = { StringEquals: { [`aws:ResourceTag/${TAG_APP.Key}`]: TAG_APP.Value } };
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({ sid: "Identity", actions: ["sts:GetCallerIdentity"], resources: ["*"] }),
      new iam.PolicyStatement({
        sid: "Ec2Read",
        actions: ["ec2:Describe*", "ec2:GetSpotPlacementScores", "ec2:DescribeSpotPriceHistory"],
        resources: ["*"],
      }),
      // RunInstances authorizes every resource it touches. New instances, volumes and spot
      // requests must carry app=codespace in the request.
      new iam.PolicyStatement({
        sid: "RunInstancesTaggedOnCreate",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*"), ec2Arn("spot-instances-request/*")],
        conditions: { StringEquals: { [`aws:RequestTag/${TAG_APP.Key}`]: TAG_APP.Value } },
      }),
      // Existing resources it launches into: only the stack's subnets, SG and launch templates.
      new iam.PolicyStatement({
        sid: "RunInstancesIntoStackResources",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("subnet/*"), ec2Arn("security-group/*"), ec2Arn("launch-template/*")],
        conditions: tagged,
      }),
      // The ENI RunInstances creates (the app doesn't tag it) and AMIs (account-owned AMI ARNs have
      // no account field; the placeholder before the first build is a public parent AMI).
      new iam.PolicyStatement({
        sid: "RunInstancesUntaggable",
        actions: ["ec2:RunInstances"],
        resources: [ec2Arn("network-interface/*"), `arn:${partition}:ec2:*::image/*`, `arn:${partition}:ec2:*::snapshot/*`],
      }),
      new iam.PolicyStatement({
        sid: "TagOnCreate",
        actions: ["ec2:CreateTags"],
        resources: [ec2Arn("instance/*"), ec2Arn("volume/*"), ec2Arn("spot-instances-request/*"), ec2Arn("network-interface/*")],
        conditions: { StringEquals: { "ec2:CreateAction": "RunInstances" } },
      }),
      new iam.PolicyStatement({
        sid: "InstanceLifecycle",
        actions: ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute"],
        resources: [ec2Arn("instance/*")],
        conditions: tagged,
      }),
      new iam.PolicyStatement({
        sid: "CancelSpot",
        actions: ["ec2:CancelSpotInstanceRequests"],
        resources: [ec2Arn("spot-instances-request/*")],
        conditions: tagged,
      }),
      new iam.PolicyStatement({
        sid: "PassInstanceRole",
        actions: ["iam:PassRole"],
        resources: [`arn:${partition}:iam::${account}:role/codespace/*`],
        conditions: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      }),
      new iam.PolicyStatement({
        sid: "ReadParams",
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [
          `arn:${partition}:ssm:*:${account}:parameter${PARAM_PREFIX}`,
          `arn:${partition}:ssm:*:${account}:parameter${PARAM_PREFIX}/*`,
          `arn:${partition}:ssm:*::parameter/aws/service/*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "StartSessionOnWorkspaces",
        actions: ["ssm:StartSession"],
        resources: [ec2Arn("instance/*")],
        conditions: { StringEquals: { [`ssm:resourceTag/${TAG_APP.Key}`]: TAG_APP.Value } },
      }),
      new iam.PolicyStatement({
        sid: "StartSessionSshDocument",
        actions: ["ssm:StartSession"],
        resources: [`arn:${partition}:ssm:*::document/AWS-StartSSHSession`],
      }),
      // Own sessions only. Session IDs start with the caller's name for IAM users; for assumed
      // roles (SSO) they start with the role session name, so the AWS-supplied session-id tag
      // (role-id:session-name, i.e. aws:userid) is what identifies them.
      new iam.PolicyStatement({
        sid: "OwnSessionsById",
        actions: ["ssm:TerminateSession", "ssm:ResumeSession", "ssmmessages:OpenDataChannel"],
        resources: [
          `arn:${partition}:ssm:*:${account}:session/\${aws:userid}-*`,
          `arn:${partition}:ssm:*:${account}:session/\${aws:username}-*`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "OwnSessionsByTag",
        actions: ["ssm:TerminateSession", "ssm:ResumeSession", "ssmmessages:OpenDataChannel"],
        resources: [`arn:${partition}:ssm:*:${account}:session/*`],
        conditions: { StringLike: { "ssm:resourceTag/aws:ssmmessages:session-id": "${aws:userid}*" } },
      }),
    ],
  });
}

/** Provider onEvent handler for Custom::CodespaceAmiParams (Node 22, bundled AWS SDK v3). */
const SEED_HANDLER = `
const { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParametersCommand } = require("@aws-sdk/client-ssm");
const ssm = new SSMClient({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(name) {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter;
  } catch (err) {
    if (err.name === "ParameterNotFound") return undefined;
    throw err;
  }
}

exports.handler = async (event) => {
  const params = event.ResourceProperties.Params || [];
  const id = "codespace-ami-params";
  if (event.RequestType === "Delete") {
    if (params.length) await ssm.send(new DeleteParametersCommand({ Names: params.map((p) => p.name) }));
    return { PhysicalResourceId: event.PhysicalResourceId || id };
  }
  for (const p of params) {
    if (await get(p.name)) continue; // never overwrite: Image Builder owns the value after its first run
    const parent = await get(p.parent);
    if (!parent) throw new Error("Parent AMI parameter not found: " + p.parent);
    try {
      await ssm.send(new PutParameterCommand({
        Name: p.name,
        Type: "String",
        DataType: "aws:ec2:image",
        Value: parent.Value,
        Overwrite: false,
        Description: "Placeholder (parent AMI) until the Codespace image pipeline runs",
      }));
    } catch (err) {
      if (err.name !== "ParameterAlreadyExists") throw err;
    }
  }
  // aws:ec2:image values are validated asynchronously; wait until each one is readable.
  for (const p of params) {
    let ok = false;
    for (let i = 0; i < 90 && !ok; i++) {
      ok = Boolean(await get(p.name));
      if (!ok) await sleep(2000);
    }
    if (!ok) throw new Error("Parameter " + p.name + " did not become available (AMI validation failed?)");
  }
  return { PhysicalResourceId: id };
};
`;
