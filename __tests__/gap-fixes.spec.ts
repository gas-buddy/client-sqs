/**
 * Unit tests for @gasbuddy/client-sqs gap fixes.
 * No localstack required — SQSClient.send is mocked via jest.fn().
 *
 * Verified against real payment-serv config pattern:
 *   "payment_dwolla_webhooks": {
 *     "name": "payment_dwolla_webhooks",
 *     "deadLetter": "payment_dwolla_webhooks_unprocessable"
 *   }
 * The deadLetter value is the SQS queue name directly — no separate config
 * entry is required in the queues map.
 */
import type { BaseLogger } from 'pino';
import { Message } from '@aws-sdk/client-sqs';
import { getQueue } from '../src/queue';
import { SQSClientContext, SQSEnhancedQueue } from '../src/types/index';
import { RawSqsEndpoint } from '../src/types/internal';

function makeContext(overrides?: Partial<BaseLogger>): SQSClientContext {
  return {
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn(),
      ...overrides,
    } as unknown as BaseLogger,
  };
}

function makeEndpoint(sendImpl?: jest.Mock): { endpoints: Record<string, RawSqsEndpoint>; sendMock: jest.Mock } {
  const sendMock = sendImpl ?? jest.fn().mockResolvedValue({ MessageId: 'mock-id' });
  const endpoints: Record<string, RawSqsEndpoint> = {
    default: {
      sqs: { send: sendMock } as any,
      region: 'us-east-1',
      accountId: '123456789',
      config: { endpoint: 'http://localhost:4566', region: 'us-east-1' },
    },
  };
  return { endpoints, sendMock };
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

/** Extract the internal handleMessage closure from a Consumer instance */
function getInternalHandle(consumer: any): ((msg: Message) => Promise<Message | void>) | undefined {
  return consumer._sqsOptions?.handleMessage
    ?? consumer.sqsOptions?.handleMessage
    ?? consumer.options?.handleMessage;
}

describe('gap-fixes — unit tests (no localstack)', () => {
  // ──────────────────────────────────────────────────
  // SC-001: JSON parse error rethrows (no silent ack)
  // ──────────────────────────────────────────────────
  describe('SC-001: JSON parse error rethrows', () => {
    it('rethrows on invalid JSON so the message is NOT acked', async () => {
      const ctx = makeContext();
      const { endpoints } = makeEndpoint();
      const queue = await buildQueue(ctx, endpoints);

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
      const { endpoints } = makeEndpoint();
      const handler = jest.fn();
      const queue = await buildQueue(ctx, endpoints);

      const consumer = queue.createConsumer(handler);
      const handle = getInternalHandle(consumer);
      if (!handle) { consumer.stop(); return; }

      await expect(handle({ Body: '{bad', MessageId: 'x', ReceiptHandle: 'y' })).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
      consumer.stop();
    });
  });

  // ──────────────────────────────────────────────────
  // SC-002 + SC-003: DLQ routing — payment-serv pattern
  // deadLetter is the queue name directly, no separate config entry
  // ──────────────────────────────────────────────────
  describe('SC-002 + SC-003: DLQ routing (payment-serv config pattern)', () => {
    it('publishes to DLQ by queue name and ACKs original when deadLetter=true', async () => {
      const ctx = makeContext();
      const sendMock = jest.fn().mockResolvedValue({ MessageId: 'dlq-id' });
      const { endpoints } = makeEndpoint(sendMock);

      // payment-serv style: deadLetter is the SQS queue name, no separate config entry needed
      const queue = await buildQueue(ctx, endpoints, {
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
      // Original message is ACKed
      expect(result).toEqual(testMsg);

      // DLQ SendMessageCommand was issued
      const dlqCall = sendMock.mock.calls.find(
        (call: any[]) => call[0]?.input?.QueueUrl?.includes('payment_dwolla_webhooks_unprocessable'),
      );
      expect(dlqCall).toBeDefined();
      const input = dlqCall![0].input;

      // Body forwarded verbatim
      expect(input.MessageBody).toBe(testMsg.Body);
      // ErrorDetail added
      expect(input.MessageAttributes.ErrorDetail.StringValue).toBe('payment failed');
      // Original CorrelationId preserved
      expect(input.MessageAttributes.CorrelationId.StringValue).toBe('corr-abc');
      consumer.stop();
    });

    it('logs and rethrows when deadLetter=true but no deadLetter configured on queue', async () => {
      const ctx = makeContext();
      const { endpoints } = makeEndpoint();
      // No deadLetter in config
      const queue = await buildQueue(ctx, endpoints);

      const consumer = queue.createConsumer(async () => {
        const e = new Error('reject me');
        (e as any).deadLetter = true;
        throw e;
      });
      const handle = getInternalHandle(consumer);
      if (!handle) { consumer.stop(); return; }

      const testMsg: Message = { Body: '{"x":1}', MessageId: 'id-1', ReceiptHandle: 'rh-1' };
      await expect(handle(testMsg)).rejects.toThrow('reject me');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.anything(),
        'SQS deadLetter error, but no deadLetter queue configured',
      );
      consumer.stop();
    });

    it('logs and rethrows when DLQ publish itself fails', async () => {
      const ctx = makeContext();
      const sendMock = jest.fn().mockRejectedValue(new Error('SQS down'));
      const { endpoints } = makeEndpoint(sendMock);
      const queue = await buildQueue(ctx, endpoints, {
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
      const sendMock = jest.fn().mockResolvedValue({ MessageId: 'dlq-id' });
      const { endpoints } = makeEndpoint(sendMock);
      const queue = await buildQueue(ctx, endpoints);

      const consumer = queue.createConsumer(async () => {
        const e = new Error('explicit route');
        (e as any).deadLetter = 'some_other_dlq';
        throw e;
      });
      const handle = getInternalHandle(consumer);
      if (!handle) { consumer.stop(); return; }

      const result = await handle({ Body: '{"x":1}', MessageId: 'i', ReceiptHandle: 'r' });
      expect(result).toBeDefined(); // ACKed
      const dlqCall = sendMock.mock.calls.find(
        (call: any[]) => call[0]?.input?.QueueUrl?.includes('some_other_dlq'),
      );
      expect(dlqCall).toBeDefined();
      consumer.stop();
    });
  });

  // ──────────────────────────────────────────────────
  // SC-004: Consumer requests CorrelationId + All attrs
  // ──────────────────────────────────────────────────
  describe('SC-004: Consumer message attribute names', () => {
    it('always includes CorrelationId and ErrorDetail in messageAttributeNames', async () => {
      const ctx = makeContext();
      const { endpoints } = makeEndpoint();
      const queue = await buildQueue(ctx, endpoints);

      const consumer = queue.createConsumer(jest.fn()) as any;
      const opts = consumer._sqsOptions ?? consumer.sqsOptions ?? consumer;
      expect(opts?.messageAttributeNames).toContain('CorrelationId');
      expect(opts?.messageAttributeNames).toContain('ErrorDetail');
      consumer.stop();
    });

    it('merges caller-provided messageAttributeNames without dropping library defaults', async () => {
      const ctx = makeContext();
      const { endpoints } = makeEndpoint();
      const queue = await buildQueue(ctx, endpoints);

      const consumer = queue.createConsumer(jest.fn(), {
        messageAttributeNames: ['CustomAttr'],
      }) as any;
      const opts = consumer._sqsOptions ?? consumer.sqsOptions ?? consumer;
      expect(opts?.messageAttributeNames).toContain('CorrelationId');
      expect(opts?.messageAttributeNames).toContain('ErrorDetail');
      expect(opts?.messageAttributeNames).toContain('CustomAttr');
      consumer.stop();
    });
  });

  // ──────────────────────────────────────────────────
  // SC-005: publish() CorrelationId pass-through
  // ──────────────────────────────────────────────────
  describe('SC-005: publish() CorrelationId pass-through', () => {
    it('forwards CorrelationId when provided in MessageAttributes', async () => {
      const ctx = makeContext();
      const sendMock = jest.fn().mockResolvedValue({ MessageId: 'pub-id' });
      const { endpoints } = makeEndpoint(sendMock);
      const queue = await buildQueue(ctx, endpoints);

      await queue.publish({ event: 'test' }, {
        MessageAttributes: {
          CorrelationId: { DataType: 'String', StringValue: 'corr-xyz' },
        },
      });

      const input = sendMock.mock.calls[0][0].input;
      expect(input.MessageAttributes.CorrelationId.StringValue).toBe('corr-xyz');
    });

    it('does NOT inject CorrelationId when caller omits it', async () => {
      const ctx = makeContext();
      const sendMock = jest.fn().mockResolvedValue({ MessageId: 'pub-id' });
      const { endpoints } = makeEndpoint(sendMock);
      const queue = await buildQueue(ctx, endpoints);

      await queue.publish({ event: 'test' });

      const input = sendMock.mock.calls[0][0].input;
      expect(input.MessageAttributes).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────
  // SC-006: reject() method
  // ──────────────────────────────────────────────────
  describe('SC-006: reject()', () => {
    it('throws with deadLetter=true and the provided reason as message', async () => {
      const ctx = makeContext();
      const { endpoints } = makeEndpoint();
      const queue = await buildQueue(ctx, endpoints);

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
      const sendMock = jest.fn().mockResolvedValue({ MessageId: 'dlq-id' });
      const { endpoints } = makeEndpoint(sendMock);
      const queue = await buildQueue(ctx, endpoints, {
        deadLetter: 'payment_dwolla_webhooks_unprocessable',
      });

      const consumer = queue.createConsumer(async (_ctx, _msg, _orig) => {
        queue.reject('cannot process');
      });
      const handle = getInternalHandle(consumer);
      if (!handle) { consumer.stop(); return; }

      const result = await handle({ Body: '{"amount":50}', MessageId: 'i', ReceiptHandle: 'r' });
      expect(result).toBeDefined(); // ACKed
      const dlqCall = sendMock.mock.calls.find(
        (call: any[]) => call[0]?.input?.QueueUrl?.includes('payment_dwolla_webhooks_unprocessable'),
      );
      expect(dlqCall).toBeDefined();
      expect(dlqCall![0].input.MessageAttributes.ErrorDetail.StringValue).toBe('cannot process');
      consumer.stop();
    });
  });
});
