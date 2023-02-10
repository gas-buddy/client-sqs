import { SQSClient } from '@aws-sdk/client-sqs';
import { SQSEndpointConfiguration } from './index';

export interface RawSqsEndpoint {
  sqs: SQSClient;
  config: SQSEndpointConfiguration['config'],
  region: string,
  accountId: string,
}
