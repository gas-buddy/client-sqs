import type { BaseLogger } from 'pino';
import { mockClient } from 'aws-sdk-client-mock';

import { SQSClientConfiguration, SQSClientContext } from '../src/types/index';
import { createSQSClient } from '../src';

import 'aws-sdk-client-mock-jest';

const sqsHost = process.env.SQS_HOST || '127.0.0.1';
const sqsPort = process.env.SQS_PORT || 4566;

const qConfig: SQSClientConfiguration<'testQueue'> = {
  region: 'us-east-1',
  endpoints: {
    default: {
      accountId: process.env.SQS_ACCOUNT_ID || '000000000000',
      config: {
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
    const message = await sqs.queues.testQueue.publish({ foo: 'bar' });
    expect(message.MessageId).toBeTruthy();
  });
});
