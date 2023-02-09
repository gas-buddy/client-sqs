import { GetCallerIdentityCommand, STS } from '@aws-sdk/client-sts';

export async function assumeRole(role?: string) {
  if (!role) {
    return undefined;
  }
  const sts = new STS({ apiVersion: '2011-06-15' });
  const { Arn: actualRoleArn } = await sts.send(new GetCallerIdentityCommand({}));
  if (!actualRoleArn?.includes(role)) {
    throw new Error(`Role is ${actualRoleArn} expecting to contain ${role}`);
  }
  return actualRoleArn;
}
