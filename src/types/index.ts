import type { BaseLogger } from 'pino';
import { SQSClientConfig } from '@aws-sdk/client-sqs';

export interface SQSQueueConfiguration {
  // The true name of the queue on the endpoint
  name: string;
  // If a different local name is desired, specify it here
  logicalName?: string;
  // Identify a queue to receive rejected messages
  deadLetter?: string;
  // How many readers to spin up when subscribing to this queue
  readers?: number;
  // An endpoint in the set of configured endpoints for this queue to use
  endpoint?: string;
}

export interface SQSEndpointConfiguration {
  // AWS account id
  accountId?: string;
  // Role to verify when connecting to SQS. If you don't have this role,
  // the queue configuration will throw an exception
  requiredRole?: string;
  config: SQSClientConfig;
}

export interface SQSClientConfiguration<Endpoints extends 'default'> {
  // AWS region
  region?: string;
  queues: SQSQueueConfiguration[];
  // Configure named endpoints to be assigned to queues
  endpoints?: Record<Endpoints, SQSEndpointConfiguration>;
}

export interface SQSClientContext {
  logger: BaseLogger;
}
