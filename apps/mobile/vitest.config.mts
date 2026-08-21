import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `expo/fetch` is a Metro entry that points at TypeScript source. Node's
      // externalized CommonJS resolver cannot load it directly; unit tests
      // inject transports, so use a side-effect-free compatibility shim while
      // production continues to bundle the official native module.
      'expo/fetch': fileURLToPath(new URL('./src/testing/expo-fetch.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
});
