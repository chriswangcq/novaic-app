import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  
  // Prevent vite from obscuring rust errors
  clearScreen: false,
  
  // Tauri expects a fixed port
  server: {
    port: 1420,
    strictPort: true,
    // Allow importing ESM sources from repo root (e.g. vm/novnc submodule)
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    // Proxy API and WebSocket requests to Gateway
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:19999',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:19999',
        ws: true,
      },
    },
  },
  
  // Env variables starting with TAURI_ will be available
  envPrefix: ['VITE_', 'TAURI_'],
  
  build: {
    // 支持 top-level await (noVNC 需要)
    target: 'esnext',
    // Don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
    // 调整 chunk size 警告阈值（桌面应用可以接受较大的 bundle）
    chunkSizeWarningLimit: 1000,
  },
  
  // 优化依赖处理
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 使用 src/lib 下的 noVNC ESM 源码
      'novnc-rfb': path.resolve(__dirname, './src/lib/novnc/rfb.js'),
    },
  },
});
