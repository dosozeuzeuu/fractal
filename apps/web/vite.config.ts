import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// bb.js proves with WebAssembly threads, which need a cross-origin isolated page.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: {
    exclude: ['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/acvm_js', '@noir-lang/noirc_abi'],
    esbuildOptions: { target: 'esnext' },
  },
  build: { target: 'esnext' },
  worker: { format: 'es' },
});
