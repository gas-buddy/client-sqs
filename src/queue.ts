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
  allQueues: Record<string, SQSEnhancedQueue>,
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
        region: ep.region,
        queueUrl: fullUrl,
        sqs: ep.sqs,
        async handleMessage(message) {
          let parsed: T;
          try {
            parsed = JSON.parse(message.Body!) as T;
          } catch (e) {
            context.logger.error(e, 'Invalid JSON in SQS message');
            throw e;
          }
          try {
            await handler(context, parsed, message);
            // Returning message causes sqs-consumer to delete (ack) it
            return message;
          } catch (error) {
            const err = error as any;
            if (err.deadLetter) {
              const dlqName: string | undefined = err.deadLetter === true
                ? config.deadLetter : err.deadLetter;
              if (!dlqName || !allQueues[dlqName]) {
                context.logger.error(
                  err,
                  'SQS deadLetter error, but no deadLetter queue configured',
                );
              } else {
                try {
                  // Forward the raw body and original attributes, adding ErrorDetail
                  const dlqCommand = new SendMessageCommand({
                    QueueUrl: allQueues[dlqName].url,
                    MessageBody: message.Body!,
                    MessageAttributes: {
                      ...message.MessageAttributes,
                      ErrorDetail: {
                        DataType: 'String',
                        StringValue: String(err.message ?? err),
                      },
                    },
                  });
                  await ep.sqs.send(dlqCommand);
                  // ACK original by returning message
                  return message;
                } catch (sqsError) {
                  context.logger.error(sqsError, 'Failed to publish to configured DLQ');
                  throw sqsError;
                }
              }
            }
            context.logger.error(err, 'SQS Consumer handler error');
            throw err;
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
