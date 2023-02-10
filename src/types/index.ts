import type { BaseLogger } from 'pino';
import {
  Message,
  SendMessageCommandInput,
  SendMessageCommandOutput,
  SQSClientConfig,
} from '@aws-sdk/client-sqs';
import type { Consumer, ConsumerOptions } from 'sqs-consumer';

export interface SQSQueueConfiguration {
  // The true name of the queue on the endpoint, else uses the name in the queue configuration
  // dictionary
  name?: string;
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

export interface SQSClientConfiguration<Q extends string, Endpoints extends 'default' = 'default'> {
  // AWS region
  region?: string;
  queues: Record<Q, SQSQueueConfiguration>;
  // Configure named endpoints to be assigned to queues
  endpoints?: Record<Endpoints, SQSEndpointConfiguration>;
}

export interface SQSClientContext {
  logger: BaseLogger;
}

export interface SQSEnhancedQueue {
  name: string;
  publish<T extends {}>(
    message: T,
    options?: SendMessageCommandInput,
  ): Promise<SendMessageCommandOutput>;
  createConsumer<T extends {} = {}, CTX extends SQSClientContext = SQSClientContext>(
    context: CTX,
    handler: (context: CTX, message: T, original: Message) => Promise<void> | void,
    options?: ConsumerOptions,
  ): Consumer;
}

export interface SQSEnhancedQueueClient<Q extends string, Endpoints extends 'default'> {
  queues: Record<Q, SQSEnhancedQueue>;
  endpoints: Record<Endpoints, any>;
}
