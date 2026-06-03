import { defineConfig } from 'vite';

// A fresh build id every `vite build`. It's injected into the app (__BUILD_ID__)
// and written to dist/version.json, so a running client can poll version.json and
// notice when a newer build has been deployed (→ "refresh to update" banner).
const BUILD_ID = String(Date.now());

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    {
      name: 'aq-version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
      },
    },
  ],
});
