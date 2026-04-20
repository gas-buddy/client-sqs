/**
 * Type augmentation for the Jest manual mock at __mocks__/@aws-sdk/client-sqs.ts.
 * These exports are only present when Jest replaces the real module with the mock.
 */
import 'jest';

declare module '@aws-sdk/client-sqs' {
  /** The shared jest.fn() that backs every SQSClient instance's .send() in tests. */
  export const mockSend: jest.Mock;
  /** Override send() for a single test. */
  export function mockSqsSend(impl: jest.Mock | ((cmd: unknown) => unknown)): void;
  /** Reset send() back to the default success stub and clear all mock instances. */
  export function resetSqsMock(): void;
}
