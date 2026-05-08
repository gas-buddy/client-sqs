jest.mock('@aws-sdk/client-sqs');

import type { BaseLogger } from 'pino';
import {
  Message,
  SQSClient,
  mockSend,
  mockSqsSend,
  resetSqsMock,
} from '@aws-sdk/client-sqs';
import { getQueue } from '../src/queue';
import { SQSClientContext, SQSEnhancedQueue } from '../src/types/index';
import { RawSqsEndpoint } from '../src/types/internal';

function makeContext(): SQSClientContext {
  return {
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn(),
    } as unknown as BaseLogger,
  };
}

function makeEndpoint(): Record<string, RawSqsEndpoint> {
  return {
    default: {
      sqs: new (SQSClient as any)(),
      region: 'us-east-1',
      accountId: '123456789',
      config: { endpoint: 'http://localhost:4566', region: 'us-east-1' },
    },
  };
}

async function buildQueue(
  context: SQSClientContext,
  endpoints: Record<string, RawSqsEndpoint>,
  config = {},
): Promise<SQSEnhancedQueue> {
  return getQueue(context, endpoints, 'payment_dwolla_webhooks', {
    name: 'payment_dwolla_webhooks',
    ...config,
  });
}

function getInternalHandle(consumer: any): ((msg: Message) => Promise<Message | void>) | undefined {
  // sqs-consumer exposes options via internal properties depending on version
  // eslint-disable-next-line no-underscore-dangle
  return consumer._sqsOptions?.handleMessage
    ?? consumer.sqsOptions?.handleMessage
    ?? consumer.options?.handleMessage;
}

afterEach(() => {
  (resetSqsMock as any)();
});

describe('JSON parse error (no DLQ configured)', () => {
  it('rethrows on invalid JSON so the message is NOT acked when no deadLetter configured', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    const consumer = queue.createConsumer(jest.fn());
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    const badMsg: Message = { Body: 'not-json', MessageId: 'msg-1', ReceiptHandle: 'rh-1' };
    await expect(handle(badMsg)).rejects.toThrow();
    expect(ctx.logger.error).toHaveBeenCalled();
    consumer.stop();
  });

  it('does NOT call the handler when Body is unparseable', async () => {
    const ctx = makeContext();
    const handler = jest.fn();
    const queue = await buildQueue(ctx, makeEndpoint());

    const consumer = queue.createConsumer(handler);
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    await expect(handle({ Body: '{bad', MessageId: 'x', ReceiptHandle: 'y' })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    consumer.stop();
  });
});

describe('Parse failure DLQ routing', () => {
  it('routes unparseable body to configured DLQ with ErrorDetail and ACKs source', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint(), {
      deadLetter: 'payment_dwolla_webhooks_unprocessable',
    });

    const handler = jest.fn();
    const consumer = queue.createConsumer(handler);
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    const badMsg: Message = {
      Body: 'not-json-at-all-}{broken',
      MessageId: 'orig-id',
      ReceiptHandle: 'orig-rh',
    };

    const result = await handle(badMsg);
    expect(result).toEqual(badMsg);
    expect(handler).not.toHaveBeenCalled();

    const dlqCall = (mockSend as jest.Mock).mock.calls.find(
      (call: any[]) => call[0]?.input?.QueueUrl?.includes('payment_dwolla_webhooks_unprocessable'),
    );
    expect(dlqCall).toBeDefined();
    const { input } = dlqCall![0];
    expect(input.MessageBody).toBe(badMsg.Body);
    expect(input.MessageAttributes.ErrorDetail.DataType).toBe('String');
    expect(input.MessageAttributes.ErrorDetail.StringValue).toMatch(/^Invalid JSON: /);
    consumer.stop();
  });

  it('preserves original CorrelationId on the DLQ message when parse fails', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint(), {
      deadLetter: 'payment_dwolla_webhooks_unprocessable',
    });

    const consumer = queue.createConsumer(jest.fn());
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    const badMsg: Message = {
      Body: '{notvalid',
      MessageId: 'orig-id',
      ReceiptHandle: 'orig-rh',
      MessageAttributes: {
        CorrelationId: { DataType: 'String', StringValue: 'corr-parse-fail' },
      },
    };

    await handle(badMsg);

    const dlqCall = (mockSend as jest.Mock).mock.calls.find(
      (call: any[]) => call[0]?.input?.QueueUrl?.includes('payment_dwolla_webhooks_unprocessable'),
    );
    expect(dlqCall).toBeDefined();
    const { input } = dlqCall![0];
    expect(input.MessageAttributes.CorrelationId.StringValue).toBe('corr-parse-fail');
    expect(input.MessageAttributes.ErrorDetail).toBeDefined();
    consumer.stop();
  });

  it('logs and rethrows when DLQ publish itself fails on parse-failure path', async () => {
    const ctx = makeContext();
    (mockSqsSend as any)(jest.fn().mockRejectedValue(new Error('SQS down')));
    const queue = await buildQueue(ctx, makeEndpoint(), {
      deadLetter: 'payment_dwolla_webhooks_unprocessable',
    });

    const consumer = queue.createConsumer(jest.fn());
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    await expect(
      handle({ Body: 'not-json', MessageId: 'i', ReceiptHandle: 'r' }),
    ).rejects.toThrow('SQS down');
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to publish parse-failure to configured DLQ',
    );
    consumer.stop();
  });
});

describe('DLQ routing (payment-serv config pattern)', () => {
  it('publishes to DLQ by queue name and ACKs original when deadLetter=true', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint(), {
      deadLetter: 'payment_dwolla_webhooks_unprocessable',
    });

    const consumer = queue.createConsumer(async () => {
      const e = new Error('payment failed');
      (e as any).deadLetter = true;
      throw e;
    });
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    const testMsg: Message = {
      Body: '{"amount":100}',
      MessageId: 'orig-id',
      ReceiptHandle: 'orig-rh',
      MessageAttributes: {
        CorrelationId: { DataType: 'String', StringValue: 'corr-abc' },
      },
    };

    const result = await handle(testMsg);
    expect(result).toEqual(testMsg);

    const dlqCall = (mockSend as jest.Mock).mock.calls.find(
      (call: any[]) => call[0]?.input?.QueueUrl?.includes('payment_dwolla_webhooks_unprocessable'),
    );
    expect(dlqCall).toBeDefined();
    const { input } = dlqCall![0];
    expect(input.MessageBody).toBe(testMsg.Body);
    expect(input.MessageAttributes.ErrorDetail.StringValue).toBe('payment failed');
    expect(input.MessageAttributes.CorrelationId.StringValue).toBe('corr-abc');
    consumer.stop();
  });

  it('logs and rethrows when deadLetter=true but no deadLetter configured on queue', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    const consumer = queue.createConsumer(async () => {
      const e = new Error('reject me');
      (e as any).deadLetter = true;
      throw e;
    });
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    await expect(handle({ Body: '{"x":1}', MessageId: 'id-1', ReceiptHandle: 'rh-1' })).rejects.toThrow('reject me');
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'SQS deadLetter error, but no deadLetter queue configured',
    );
    consumer.stop();
  });

  it('logs and rethrows when DLQ publish itself fails', async () => {
    const ctx = makeContext();
    (mockSqsSend as any)(jest.fn().mockRejectedValue(new Error('SQS down')));
    const queue = await buildQueue(ctx, makeEndpoint(), {
      deadLetter: 'payment_dwolla_webhooks_unprocessable',
    });

    const consumer = queue.createConsumer(async () => {
      const e = new Error('handler error');
      (e as any).deadLetter = true;
      throw e;
    });
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    await expect(handle({ Body: '{"x":1}', MessageId: 'i', ReceiptHandle: 'r' })).rejects.toThrow('SQS down');
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.anything(),
      'Failed to publish to configured DLQ',
    );
    consumer.stop();
  });

  it('routes to explicit queue name when deadLetter is a string on the error', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    const consumer = queue.createConsumer(async () => {
      const e = new Error('explicit route');
      (e as any).deadLetter = 'some_other_dlq';
      throw e;
    });
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    const result = await handle({ Body: '{"x":1}', MessageId: 'i', ReceiptHandle: 'r' });
    expect(result).toBeDefined();
    const dlqCall = (mockSend as jest.Mock).mock.calls.find(
      (call: any[]) => call[0]?.input?.QueueUrl?.includes('some_other_dlq'),
    );
    expect(dlqCall).toBeDefined();
    consumer.stop();
  });
});

describe('Consumer message attribute names', () => {
  it('always includes CorrelationId and ErrorDetail in messageAttributeNames', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    const consumer = queue.createConsumer(jest.fn()) as any;
    // eslint-disable-next-line no-underscore-dangle
    const opts = consumer._sqsOptions ?? consumer.sqsOptions ?? consumer;
    expect(opts?.messageAttributeNames).toContain('CorrelationId');
    expect(opts?.messageAttributeNames).toContain('ErrorDetail');
    consumer.stop();
  });

  it('merges caller-provided messageAttributeNames without dropping library defaults', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    const consumer = queue.createConsumer(jest.fn(), {
      messageAttributeNames: ['CustomAttr'],
    }) as any;
    // eslint-disable-next-line no-underscore-dangle
    const opts = consumer._sqsOptions ?? consumer.sqsOptions ?? consumer;
    expect(opts?.messageAttributeNames).toContain('CorrelationId');
    expect(opts?.messageAttributeNames).toContain('ErrorDetail');
    expect(opts?.messageAttributeNames).toContain('CustomAttr');
    consumer.stop();
  });
});

describe('publish() CorrelationId pass-through', () => {
  it('forwards CorrelationId when provided in MessageAttributes', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    await queue.publish({ event: 'test' }, {
      MessageAttributes: {
        CorrelationId: { DataType: 'String', StringValue: 'corr-xyz' },
      },
    });

    const { input } = (mockSend as jest.Mock).mock.calls[0][0];
    expect(input.MessageAttributes.CorrelationId.StringValue).toBe('corr-xyz');
  });

  it('does NOT inject CorrelationId when caller omits it', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    await queue.publish({ event: 'test' });

    const { input } = (mockSend as jest.Mock).mock.calls[0][0];
    expect(input.MessageAttributes).toBeUndefined();
  });
});

describe('reject()', () => {
  it('throws with deadLetter=true and the provided reason as message', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint());

    try {
      queue.reject('bad message format');
      fail('should have thrown');
    } catch (e: any) {
      expect(e.message).toBe('bad message format');
      expect(e.deadLetter).toBe(true);
    }
  });

  it('integrates with DLQ routing — reject() in a handler routes to configured DLQ', async () => {
    const ctx = makeContext();
    const queue = await buildQueue(ctx, makeEndpoint(), {
      deadLetter: 'payment_dwolla_webhooks_unprocessable',
    });

    const consumer = queue.createConsumer(async () => {
      queue.reject('cannot process');
    });
    const handle = getInternalHandle(consumer);
    if (!handle) { consumer.stop(); return; }

    const result = await handle({ Body: '{"amount":50}', MessageId: 'i', ReceiptHandle: 'r' });
    expect(result).toBeDefined();
    const dlqCall = (mockSend as jest.Mock).mock.calls.find(
      (call: any[]) => call[0]?.input?.QueueUrl?.includes('payment_dwolla_webhooks_unprocessable'),
    );
    expect(dlqCall).toBeDefined();
    expect(dlqCall![0].input.MessageAttributes.ErrorDetail.StringValue).toBe('cannot process');
    consumer.stop();
  });
});
