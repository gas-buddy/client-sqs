import helloWorld from '../src';

test('Basic function', () => {
  expect(helloWorld).toBeTruthy(); // Should export something
  expect(typeof helloWorld).toBe('function'); // Should export a function.
  helloWorld('');
});
