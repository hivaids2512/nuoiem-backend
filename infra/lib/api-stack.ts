import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  stage: 'staging' | 'production';
  desiredCount: number;
  certificateArn?: string;
  domainName?: string;
}

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const isProd = props.stage === 'production';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // One NAT in staging to save cost; one per AZ in production.
      natGateways: isProd ? 2 : 1,
    });
    // Keep image pulls and log/secret traffic off the NAT gateway.
    vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    const repo = new ecr.Repository(this, 'Repo', {
      repositoryName: `nuoiem-server-${props.stage}`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 20 }],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
    });

    // Created empty — put the Atlas connection string in it after the first deploy:
    //   aws secretsmanager put-secret-value --secret-id <MongoUriSecretName output> --secret-string '<uri>'
    const mongoUri = new secrets.Secret(this, 'MongoUri', {
      secretName: `nuoiem/${props.stage}/MONGODB_URI`,
      description: 'MongoDB Atlas connection string',
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      family: `nuoiem-api-${props.stage}`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDef.addContainer('api', {
      // Placeholder until CI pushes the first image; the deploy workflow swaps in the real tag.
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      portMappings: [{ containerPort: 3000 }],
      environment: { NODE_ENV: 'production', PORT: '3000', LOG_LEVEL: 'info' },
      secrets: { MONGODB_URI: ecs.Secret.fromSecretsManager(mongoUri) },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup }),
      stopTimeout: cdk.Duration.seconds(30),
      readonlyRootFilesystem: true,
      // PID 1 init (tini) so SIGTERM reaches node and zombies are reaped; local: `docker run --init`.
      linuxParameters: new ecs.LinuxParameters(this, 'Linux', { initProcessEnabled: true }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health/live || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      },
    });

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)
      : undefined;

    const service = new patterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      taskDefinition: taskDef,
      serviceName: `nuoiem-api-${props.stage}`,
      desiredCount: props.desiredCount,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(30),
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      certificate,
      // Without a certificate the ALB serves plain HTTP — acceptable for first staging bring-up only.
      protocol: certificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      redirectHTTP: !!certificate,
      domainName: props.domainName,
    });

    service.targetGroup.configureHealthCheck({
      path: '/health/live',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(15),
    });
    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');

    const scaling = service.service.autoScaleTaskCount({
      minCapacity: props.desiredCount,
      maxCapacity: isProd ? 6 : 2,
    });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });
    scaling.scaleOnRequestCount('Requests', {
      requestsPerTarget: 500,
      targetGroup: service.targetGroup,
    });

    // GitHub Actions deploy role (OIDC). Create the provider once per account, then pass its ARN via context.
    const oidcArn = this.node.tryGetContext('githubOidcProviderArn') as string | undefined;
    const repoSlug = this.node.tryGetContext('githubRepo') as string | undefined; // e.g. owner/nuoiem-server
    if (oidcArn && repoSlug) {
      const deployRole = new iam.Role(this, 'GithubDeployRole', {
        assumedBy: new iam.WebIdentityPrincipal(oidcArn, {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${repoSlug}:*` },
        }),
      });
      repo.grantPullPush(deployRole);
      deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecr:GetAuthorizationToken', 'ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition'],
          resources: ['*'],
        }),
      );
      deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
          resources: [service.service.serviceArn],
        }),
      );
      deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [taskDef.taskRole.roleArn, taskDef.executionRole!.roleArn],
        }),
      );
      new cdk.CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
    }

    new cdk.CfnOutput(this, 'EcrRepository', { value: repo.repositoryName });
    new cdk.CfnOutput(this, 'EcsCluster', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'EcsService', { value: service.service.serviceName });
    new cdk.CfnOutput(this, 'TaskFamily', { value: taskDef.family });
    new cdk.CfnOutput(this, 'LoadBalancerDns', { value: service.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'MongoUriSecretName', { value: mongoUri.secretName });
  }
}
