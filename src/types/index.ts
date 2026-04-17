import type { BaseLogger } from 'pino';
import {
  Message,
  ReceiveMessageCommandInput,
  SendMessageCommandInput,
  SendMessageCommandOutput,
  SQSClientConfig,
} from '@aws-sdk/client-sqs';
import type { Consumer, ConsumerOptions } from 'sqs-consumer';

export interface SQSQueueConfiguration {
  // The true name of the queue on the endpoint, else uses the name in the queue configuration
  // dictionary
  name?: string;
  // Identify a queue to receive rejected messages (SQS queue name, not a config key)
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
  queues: Record<Q, SQSQueueConfiguration>;
  // Configure named endpoints to be assigned to queues
  endpoints?: Record<Endpoints, SQSEndpointConfiguration>;
}

export interface SQSClientContext {
  logger: BaseLogger;
}

export interface SQSEnhancedQueue<CTX extends SQSClientContext = SQSClientContext> {
  name: string;
  url: string;

  publish<T extends {}>(
    message: T,
    options?: Partial<SendMessageCommandInput>,
  ): Promise<SendMessageCommandOutput>;
  createConsumer<T extends {} = {}>(
    handler: (context: CTX, message: T, original: Message) => Promise<void> | void,
    options?: Omit<ConsumerOptions, 'queueUrl'>,
  ): Consumer;
  receive<T extends {} = {}>(
    options: Omit<ReceiveMessageCommandInput, 'QueueUrl'> & { noParse?: boolean },
  ): Promise<{ message?: T; original: Message }[]>;
  ack(message: Message): Promise<void>;
  /**
   * Throw a dead-letter error. The message will be routed to the configured
   * `deadLetter` queue with the reason set as the `ErrorDetail` attribute.
   * Equivalent to: `throw Object.assign(new Error(reason), { deadLetter: true })`
   */
  reject(reason: string): never;
}

export interface SQSEnhancedQueueClient<
  Q extends string,
  Endpoints extends 'default' = 'default',
  CTX extends SQSClientContext = SQSClientContext,
> {
  queues: Record<Q, SQSEnhancedQueue<CTX>>;
  endpoints: Record<Endpoints, any>;
}
