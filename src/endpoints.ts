
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { SQSClient } from '@aws-sdk/client-sqs';
import mapValues from 'lodash.mapvalues';
import { SQSClientConfiguration, SQSEndpointConfiguration } from './types/index';

let identityPromise: Promise<{ region: string; accountId: string }> | undefined;

async function getIdentityInfo() {
  if (!identityPromise) {
    identityPromise = (async () => {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2500);

        const identityUrl = 'http://169.254.169.254/latest/dynamic/instance-identity/document';
        const response = await fetch(identityUrl, { method: 'get', signal: controller.signal });
        clearTimeout(id);
        const body = await response.text();
        const { accountId, region } = JSON.parse(body);
        return { accountId, region };
      } catch (error) {
        throw new Error(
          'Unable to fetch instance identity document for automatic SQS configuration',
        );
      }
    })();
  }
  return identityPromise;
}

const defaultConfig: SQSEndpointConfiguration = {
  endpoint: 'testEndpoint',
  config: {},
};

export async function buildEndpoints(
  endpointConfig: SQSClientConfiguration['endpoints'],
) {
  const epConfig: Record<string, SQSEndpointConfiguration> = endpointConfig || {
    default: defaultConfig,
  };
  const needsLocalInfo = Object.values(epConfig).find((c) => !c.accountId || !c.config.region);
  const self = needsLocalInfo ? await getIdentityInfo() : undefined;

  const roles = Object.values(epConfig)
    .filter((c) => c.requiredRole)
    .reduce((acc, c) => {
      acc.add(c.requiredRole!);
      return acc;
    }, new Set<string>());
  if (roles.size) {
    const sts = new STSClient({ apiVersion: '2011-06-15' });
    const { Arn: actualRoleArn } = await sts.send(new GetCallerIdentityCommand({}));
    await Promise.all(
      [...roles].map(async (role) => {
        if (!actualRoleArn?.includes(role)) {
          throw new Error(`Role is ${actualRoleArn} but required to contain ${role}`);
        }
      }),
    );
  }
  return mapValues(endpointConfig, ({ config, accountId }) => {
    const awsContext = {
      accountId: accountId || self!.region,
      region: config.region || self!.region,
    };
    const sqs = new SQSClient(config);
    return { ...awsContext, sqs };
  });
}
