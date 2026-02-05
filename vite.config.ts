import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    allowedHosts: ['sheathier-jayla-sacral.ngrok-free.dev'],
    // opcional, pero útil cuando accedes desde fuera:
    host: true,
  },
});
