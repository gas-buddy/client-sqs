import { SendMessageCommand, SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { Consumer } from 'sqs-consumer';
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

  const ep = endpoints[endpoint || 'default'];
  const qurl = (ep.config.endpoint as string) || `http://${ep.region}.queue.amazonaws.com`;
  const fullUrl = `${qurl}${qurl.endsWith('/') ? '' : '/'}${ep.accountId}/${name}`;

  return {
    name: localName,
    async publish<T extends {}>(message: T, options?: Partial<SendMessageCommandInput>) {
      const command = new SendMessageCommand({
        ...options,
        QueueUrl: fullUrl,
        MessageBody: JSON.stringify(message),
      });
      return ep.sqs.send(command);
    },
    createConsumer(ctx, handler, options) {
      const consumer = new Consumer({
        ...options,
        queueUrl: fullUrl,
        sqs: ep.sqs,
        async handleMessage(message) {
          try {
            await handler(ctx, JSON.parse(message.Body!), message);
          } catch (error) {
            ctx.logger.error(error, 'SQS Consumer handler error');
            throw error;
          }
        },
      });
      consumer.on('error', (err) => {
        ctx.logger.error(err, 'SQS Consumer error');
      });
      consumer.on('processing_error', (err) => {
        ctx.logger.error(err, 'SQS Consumer processing error', err);
      });

      consumer.on('timeout_error', (err) => {
        ctx.logger.error(err, 'SQS Timeout error');
      });
      return consumer;
    },
  };
}
