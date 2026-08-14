const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  ...expoConfig,
  {
    ignores: ['.expo/**', 'dist/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'expo-image-picker',
              message:
                'Use the system-image-picker wrapper; camera, video, and broad-library flows are prohibited.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/platform/image-picker-policy.ts',
      'src/platform/system-image-picker.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]);
