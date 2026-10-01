import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/launchsignal/',
  build: {
    outDir: '../docs',
    emptyOutDir: true,
  },
});
