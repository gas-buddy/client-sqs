import { ConsumerOptions } from 'sqs-consumer';
import type { BaseLogger as pinoBaseLogger} from 'pino';

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

export interface SubscriptionOptions {
}

export interface SQSEndpointConfiguration {
  endpoint: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  // AWS account id
  accountId?: string;
  // Role to verify when connecting to SQS. If you don't have this role,
  // the queue configuration will throw an exception
  requiredRole?: string;
  config?: any;
}

export interface Subscriptions {
  waitTimeSeconds?: number;
}

export interface SQSClientConfiguration {
  // AWS region
  region?: string;
  queues: Record<string, SQSQueueConfiguration>;
  // Configure named endpoints to be assigned to queues
  endpoints?: Record<string, SQSEndpointConfiguration>;
  endpoint?: SQSEndpointConfiguration;
  subscriptions: Subscriptions;
  contextFunction?: any;
}

export interface SQSClientContext {
  logger: pinoBaseLogger;
  headers?: any;
  service: any;
}

export interface ConfiguredSQSClient {
  // The configuration
  config: any;
  // The true name of the queue on the endpoint
  assumedRole: string;
  // How many readers to spin up when subscribing to this queue
  readers?: number;
  // An endpoint in the set of configured endpoints for this queue to use
  endpoint?: string;
  subscribe: Function;
}

export interface SqsQueueType {
}

export interface CallInfo {
  operationName: string,
  message: any;
  error?: any;
}

export interface GbConsumerOptions extends ConsumerOptions {
  readers?: number;
}

export type BaseLogger = pinoBaseLogger;