module.exports = {
  root: true,
  extends: 'gasbuddy',
  parserOptions: {
    project: './tsconfig.json'
  },
  overrides: [
    {
      // Test and mock files: relax rules that conflict with Jest patterns
      files: ['__tests__/**/*.ts', '__mocks__/**/*.ts'],
      env: {
        jest: true,
      },
      rules: {
        // jest.mock() must appear before imports (hoisting); import/first rejects this pattern
        'import/first': 'off',
        // require() is used to access the Jest module registry for mock helpers
        'global-require': 'off',
        // sqs-consumer exposes internal options via _sqsOptions
        'no-underscore-dangle': 'off',
        // Unused handler params prefixed with _ are intentional in test stubs
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      },
    },
  ],
};
