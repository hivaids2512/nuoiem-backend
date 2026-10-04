import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack.js';

const app = new cdk.App();

// Account/region come from the CLI credentials; region defaults to Singapore (design §1, Vietnam market).
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-1',
};

new ApiStack(app, 'NuoiemStaging', {
  env,
  stage: 'staging',
  desiredCount: 1,
  // Set both to serve over HTTPS on your domain (ACM cert must be in the same region).
  certificateArn: app.node.tryGetContext('certificateArn'),
  domainName: app.node.tryGetContext('domainName'),
});

// Production stack is added once staging is proven (design §7: 2+ tasks across 2 AZs).
