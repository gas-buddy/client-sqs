import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export async function assumeRole(role?: string) {
  if (!role) {
    return undefined;
  }
  const sts = new STSClient({ apiVersion: '2011-06-15' });
  const { Arn: actualRoleArn } = await sts.send(new GetCallerIdentityCommand({}));
  if (!actualRoleArn?.includes(role)) {
    throw new Error(`Role is ${actualRoleArn} expecting to contain ${config.assumedRole}`);
  }
  return actualRoleArn;
}
