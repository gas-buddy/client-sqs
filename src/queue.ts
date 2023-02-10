import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SendMessageCommandInput,
} from '@aws-sdk/client-sqs';
import { Consumer, ConsumerOptions } from 'sqs-consumer';
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
    url: fullUrl,
    async publish<T extends {}>(message: T, options?: Partial<SendMessageCommandInput>) {
      const command = new SendMessageCommand({
        ...options,
        QueueUrl: fullUrl,
        MessageBody: JSON.stringify(message),
      });
      return ep.sqs.send(command);
    },
    createConsumer<T extends {}>(
      handler: (context: SQSClientContext, message: T, original: Message) => Promise<void> | void,
      options: ConsumerOptions,
    ) {
      const consumer = new Consumer({
        ...options,
        queueUrl: fullUrl,
        sqs: ep.sqs,
        async handleMessage(message) {
          try {
            let parsed: T | undefined;
            try {
              parsed = JSON.parse(message.Body!) as T;
            } catch (e) {
              context.logger.error(e, 'Invalid JSON in SQS message');
            }
            if (parsed) {
              await handler(context, parsed, message);
            }
            // This is what causes it to ack the message
            return message;
          } catch (error) {
            if ((error as any).deadLetter) {
              if (!config.deadLetter) {
                context.logger.error(
                  error,
                  'SQS deadLetter error, but no deadLetter queue configured',
                );
              }
              // TODO dead letter handling
            }
            context.logger.error(error, 'SQS Consumer handler error');
            throw error;
          }
        },
      });
      consumer.on('error', (err) => {
        context.logger.error(err, 'SQS Consumer error');
      });
      consumer.on('processing_error', (err) => {
        context.logger.error(err, 'SQS Consumer processing error', err);
      });

      consumer.on('timeout_error', (err) => {
        context.logger.error(err, 'SQS Timeout error');
      });
      return consumer;
    },
    async receive(options) {
      const { noParse, ...rest } = options;
      const command = new ReceiveMessageCommand({
        ...rest,
        QueueUrl: fullUrl,
      });
      const result = await ep.sqs.send(command);

      if (noParse) {
        return result.Messages?.map((original) => ({ message: undefined, original })) || [];
      }

      return (
        result.Messages?.map((original) => {
          try {
            return { message: JSON.parse(original.Body!), original };
          } catch (e) {
            context.logger.warn(e, 'Invalid JSON in SQS message');
            return { message: undefined, original };
          }
        }) || []
      );
    },
    async ack(message) {
      const command = new DeleteMessageCommand({
        QueueUrl: fullUrl,
        ReceiptHandle: message.ReceiptHandle!,
      });
      await ep.sqs.send(command);
    },
  };
}
