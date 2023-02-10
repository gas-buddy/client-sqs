import { SendMessageCommand, SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { SQSClientContext, SQSEnhancedQueue, SQSQueueConfiguration } from './types/index';
import { RawSqsEndpoint } from './types/internal';

export async function getQueue(
  context: SQSClientContext,
  endpoints: Record<string, RawSqsEndpoint>,
  localName: string,
  config: SQSQueueConfiguration,
): Promise<SQSEnhancedQueue> {
  const name = config.name || localName;
  const { endpoint } = config;

  return {
    name: localName,
    async publish<T extends {}>(message: T, options?: Partial<SendMessageCommandInput>) {
      const ep = endpoints[endpoint || 'default'];
      const qurl = (ep.config.endpoint as string) || `http://${ep.region}.queue.amazonaws.com`;
      const fullUrl = `${qurl}${qurl.endsWith('/') ? '' : '/'}${ep.accountId}/${name}`;
      const command = new SendMessageCommand({
        ...options,
        QueueUrl: fullUrl,
        MessageBody: JSON.stringify(message),
      });
      return ep.sqs.send(command);
    },
  };
}
