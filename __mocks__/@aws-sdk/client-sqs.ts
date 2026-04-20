/**
 * Jest manual mock for @aws-sdk/client-sqs.
 * Placed in __mocks__/@aws-sdk/client-sqs.ts — Jest picks it up automatically
 * when tests call jest.mock('@aws-sdk/client-sqs').
 *
 * All tests share the same mockSend jest.fn(). Use mockSqsSend() to override
 * per-test and resetSqsMock() in afterEach to restore defaults.
 */

const mockSend = jest.fn().mockResolvedValue({ MessageId: 'mock-id' });

export const SQSClient = jest.fn().mockImplementation(() => ({ send: mockSend }));

// Pass-through command constructors — tests inspect .input directly on the
// instance passed to send(), no real AWS logic needed.
export const SendMessageCommand = jest.fn().mockImplementation((input) => ({ input }));
export const ReceiveMessageCommand = jest.fn().mockImplementation((input) => ({ input }));
export const DeleteMessageCommand = jest.fn().mockImplementation((input) => ({ input }));

/** Override send() for a single test. */
export function mockSqsSend(impl: jest.Mock | ((cmd: any) => any)): void {
  mockSend.mockImplementation(impl);
}

/** Reset send() back to the default success stub. */
export function resetSqsMock(): void {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ MessageId: 'mock-id' });
  SQSClient.mockClear();
  SendMessageCommand.mockClear();
  ReceiveMessageCommand.mockClear();
  DeleteMessageCommand.mockClear();
}

/** Exposed so tests can assert on call arguments directly. */
export { mockSend };
