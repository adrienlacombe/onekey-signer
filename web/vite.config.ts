import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { isSimulatorEnabled, onekeySimulatorPlugin } from './dev/onekeySimulator';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const simulatorEnabled = isSimulatorEnabled(env.VITE_ONEKEY_SIMULATOR);

  return {
    plugins: [
      react(),
      tailwindcss(),
      nodePolyfills({ include: ['buffer', 'stream', 'events', 'process'] }),
      onekeySimulatorPlugin({
        enabled: simulatorEnabled,
        apiBase: env.VITE_ONEKEY_SIMULATOR_API_BASE || '/__onekey_simulator__',
        containerName: env.VITE_ONEKEY_SIMULATOR_CONTAINER || 'onekey-emu-1s',
      }),
    ],
    server: { port: 5173 },
  };
});
