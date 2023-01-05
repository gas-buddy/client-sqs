import { SQSClientConfiguration, SQSClientContext } from './types/index';

export async function createSQSClient(context: SQSClientContext, config: SQSClientConfiguration) {
  const endpoints = await buildEndpoints(config.en)
  const queues = await getQueues(context, config.queues);
}
