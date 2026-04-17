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

  // Mutable reference populated after all queues are built. Consumer closures
  // execute at message-processing time (after createSQSClient returns), so the
  // map is fully populated by the time any handler runs.
  const allQueues: Record<string, SQSEnhancedQueue> = {};

  const queues = await Promise.all(
    // eslint-disable-next-line max-len
    all.map(([name, q]) => getQueue(context, endpoints, name, q as SQSQueueConfiguration, allQueues)),
  );

  const queuesMap = queues.reduce((acc, q) => {
    acc[q.name] = q;
    return acc;
  }, {} as Record<string, SQSEnhancedQueue>);

  // Populate the shared reference so DLQ routing can look up sibling queues
  Object.assign(allQueues, queuesMap);

  return {
    queues: queuesMap,
    endpoints,
  };
}

export * from './types/index';
