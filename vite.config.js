import { defineConfig } from 'vite';

export default defineConfig({
  base: '/gpu-paint/', 
  server: {
    port: 3000,
    strictPort: true
  }
});