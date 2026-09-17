module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2020: true },
  rules: {
    '@typescript-eslint/no-non-null-assertion': 'error'
  },
  overrides: [
    {
      files: ['src/tests/**', 'scripts/**'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off'
      }
    }
  ]
};
