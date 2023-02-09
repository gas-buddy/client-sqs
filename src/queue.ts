import { v4 as uuid } from 'uuid';
import { Consumer, ConsumerOptions } from 'sqs-consumer';
import { SQSQueueConfiguration, CallInfo, GbConsumerOptions } from './types/index';
import { ALREADY_LOGGED, compressMessage, messageHandlerFunc, safeEmit } from './util';
import { SQSClient } from '@aws-sdk/client-sqs';

export async function getQueue(config: SQSQueueConfiguration) {
  const { name } = config;
  const localName = config.logicalName || name;

}

export default class SqsQueue {
  consumers: any[] = [];
  config: any;
  queueClient: any;
  sqs: any;
  started: boolean;

  constructor(queueClient: any, sqs: any, config: any) {
    Object.assign(this, { queueClient, sqs, config });
    this.started = false;
  }

  async createConsumer(queueClient: any, context: any, handleMessage: Function, options: ConsumerOptions) {
    const { messageAttributeNames = [], ...consumerOptions } = options;
    const withCorrelation = ['CorrelationId', 'ErrorDetail', 'Content-Encoding', ...messageAttributeNames];
    console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% Creating');
    console.log(`queueClient.sqs keys = ${JSON.stringify(Object.keys(queueClient.sqs))}`);
    const consumer = Consumer.create(<ConsumerOptions>{
      attributeNames: ['All'],
      messageAttributeNames: withCorrelation,
      ...consumerOptions,
      queueUrl: queueClient.config.queueUrl,
      handleMessage,
    });
    const errorArgs = { queueUrl: queueClient.config.queueUrl, logicalName: queueClient.config.logicalName };
    consumer.on('error', async (error: any) => {
      if (error.code === 'ExpiredToken') {
        this.sqs = await queueClient.reconnect(context, this.sqs);
      } else if (error.code === 'AccessDenied') {
        context.logger.error('Missing permission', context.service.wrapError(error, errorArgs));
        consumer.stop();
      } else if (error.code === 'AWS.SimpleQueueService.NonExistentQueue') {
        context.logger.error('Misconfigured queue', context.service.wrapError(error, errorArgs));
        consumer.stop();
      } else {
        context.logger.error('SQS error', context.service.wrapError(error, errorArgs));
        console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%');
        console.log(`errorArgs = ${JSON.stringify(errorArgs)}`);
        console.log(`error = ${JSON.stringify(error)}`);
        console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%');
        throw error;
      }
    });
    consumer.on('processing_error', (error: any) => {
      if (!error[ALREADY_LOGGED]) {
        context.logger.error('SQS processing error', context.service.wrapError(error, errorArgs));
      }
    });
    consumer.on('timeout_error', (error: any) => {
      context.logger.error('SQS processing timeout', context.service.wrapError(error, errorArgs));
    });
    console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% Pre-Starting');
    console.log(`queueClient.started = ${JSON.stringify(queueClient.started)}`);
    this.consumers.push(consumer);
    if (queueClient.started) {
      console.log('%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%% Starting');
      consumer.start();
      
      return new Promise((resolve, reject) => {
        let time: number = 10;
        let intrvl: any;
        intrvl = setInterval(() => {
          time--;
          if (time <= 0) {
            clearInterval(intrvl);
            reject('SQS subscribe timeout');
          }
          else if (consumer.isRunning) {
            clearInterval(intrvl);
            resolve(consumer);
          }
        }, 100); 
      });
    } else {
      return consumer;
    }
  }

  async publish(context: any, message: any, options: any = {}) {
    const { MessageAttributes = {}, correlationid, compression, publishRaw, ...restOfOptions } = options;
    const correlationId = correlationid || context.headers?.correlationid || uuid();
    let msgBody = message;
    if (!publishRaw) {
      msgBody = JSON.stringify(msgBody);
      let additionalAttr: any = {};
      if (compression) {
        ({ body: msgBody, headers: additionalAttr } = await compressMessage(msgBody, compression));
      }
      Object.keys(additionalAttr).forEach((k) => {
        MessageAttributes[k] = {
          DataType: 'String',
          StringValue: additionalAttr[k],
        };
      });
    }
    const attributes = {
      ...MessageAttributes,
      CorrelationId: {
        DataType: 'String',
        StringValue: correlationId,
      },
    };

    const finalMessage = {
      MessageBody: msgBody,
      MessageAttributes: attributes,
      ...restOfOptions,
      QueueUrl: this.config.queueUrl,
    };
    const callInfo: CallInfo = { operationName: 'publish', message: finalMessage };
    this.queueClient.emit('start', callInfo);
    try {
      const retVal = await this.sqs.sendMessage(finalMessage).promise();
      this.queueClient.emit('finish', callInfo);
      return retVal;
    } catch (error) {
      callInfo.error = error;
      safeEmit(this.queueClient, 'error', callInfo);
      throw error;
    }
  }

  async subscribe(context: any, handler: Function, options: GbConsumerOptions = {}) {
    const { readers = this.config.readers || 1, ...consumerOptions } = options;
    const handleMessage = messageHandlerFunc(context, this, handler);
    await Promise.all(new Array(readers).fill(0).map(async () => {
      this.consumers.push(await this.createConsumer(this, context, handleMessage, consumerOptions));
    }));
    context.logger.info('Subscribed to SQS queue', { readers, logicalName: this.config.logicalName });
  }

  async start() {
    if (!this.started) {
      if (this.consumers.length) {
        await Promise.all(this.consumers.map(c => c.start()));
      }
      this.started = true;
    }
  }

  async stop() {
    if (this.consumers) {
      await Promise.all(this.consumers.map(c => c.stop()));
      this.consumers = [];
    }
    this.started = false;
  }
}
