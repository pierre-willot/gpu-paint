import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Tells Vite where the app lives on GitHub Pages/your server
  base: '/gpu-paint/', 

  // Plugin to handle your @core, @renderer, etc. aliases
  plugins: [tsconfigPaths()],

  build: {
    // Advanced minification to protect your code
    minify: 'terser', 
    terserOptions: {
      compress: {
        drop_console: true, 
        drop_debugger: true,
      },
      mangle: true, // Scrambles function and variable names
    },
    target: 'esnext', // Optimization for modern browsers + WebGPU
    sourcemap: false, // Ensures people can't see your original TS in the browser
  }
});