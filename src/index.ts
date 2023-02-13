import { buildEndpoints } from './endpoints';
import { getQueue } from './queue';
import {
  SQSClientConfiguration,
  SQSClientContext,
  SQSEnhancedQueue,
  SQSEnhancedQueueClient,
  SQSQueueConfiguration,
} from './types/index';

export async function createSQSClient<Q extends string, T extends 'default', CTX extends SQSClientContext = SQSClientContext>(
  context: CTX,
  config: SQSClientConfiguration<Q, T>,
): Promise<SQSEnhancedQueueClient<Q, T>> {
  const endpoints = await buildEndpoints(context, config.endpoints!);
  const all = Object.entries(config.queues);
  const queues = await Promise.all(
    all.map(([name, q]) => getQueue(context, endpoints, name, q as SQSQueueConfiguration)),
  );
  return {
    queues: queues.reduce((acc, q) => {
      acc[q.name] = q;
      return acc;
    }, {} as Record<string, SQSEnhancedQueue>),
    endpoints,
  };
}

export * from './types/index';
