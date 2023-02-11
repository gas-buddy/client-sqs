import type { BaseLogger } from 'pino';
import { Message } from '@aws-sdk/client-sqs';

import { SQSClientConfiguration, SQSClientContext } from '../src/types/index';
import { createSQSClient } from '../src';

const sqsHost = process.env.SQS_HOST || '127.0.0.1';
const sqsPort = process.env.SQS_PORT || 4566;

const qConfig: SQSClientConfiguration<'testQueue'> = {
  endpoints: {
    default: {
      accountId: process.env.SQS_ACCOUNT_ID || '000000000000',
      config: {
        region: 'us-east-1',
        endpoint: `http://${sqsHost}:${sqsPort}`,
        credentials: {
          accessKeyId: 'key',
          secretAccessKey: 'secret',
        },
      },
    },
  },
  queues: {
    testQueue: {
      name: 'sample-queue',
    },
  },
};

const fakeContext: SQSClientContext = {
  logger: console as unknown as BaseLogger,
};

describe('SQS Client', () => {
  const oldFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        text: () => Promise.resolve('{"region":"foobar"}'),
      }),
    ) as any;
  });

  afterEach(() => {
    global.fetch = oldFetch;
  });

  test('Basic function', async () => {
    const sqs = await createSQSClient(fakeContext, qConfig);
    expect(sqs).toBeTruthy();

    const message = { foo: Date.now() };
    let signal: (m: [typeof message, Message]) => void;
    const promise = new Promise((accept) => {
      signal = accept;
    }) as Promise<[typeof message, Message]>;
    const consumer = sqs.queues.testQueue.createConsumer<typeof message>((ctx, m, o) => {
      // Allow some overlap of test runs w/o failing.
      if (m.foo === message.foo) {
        signal([m, o]);
      }
    });
    consumer.start();

    let result = await sqs.queues.testQueue.publish(message);
    expect(result.MessageId).toBeTruthy();

    const [receivedMessage, original] = await promise;
    expect(receivedMessage).toBeTruthy();
    expect(receivedMessage.foo).toBe(message.foo);
    expect(original.MessageId).toEqual(result.MessageId);

    consumer.stop();

    message.foo = Date.now();
    result = await sqs.queues.testQueue.publish(message);
    const receive = await sqs.queues.testQueue.receive<typeof message>({
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 3,
    });
    expect(receive.length).toBe(1);
    expect(receive[0].original.MessageId).toEqual(result.MessageId);
    expect(receive[0].message?.foo).toEqual(message.foo);
    await sqs.queues.testQueue.ack(receive[0].original);
  });
});
