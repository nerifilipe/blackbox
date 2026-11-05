import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
 plugins: [react()],
 server: { proxy: { '/api': { target: 'http://127.0.0.1:9090', changeOrigin: true, configure: proxy => { proxy.on('proxyReq', req => req.removeHeader('origin')); } } } },
});
