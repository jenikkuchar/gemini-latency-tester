import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';

// Vše se sbalí do jediného index.html, který pak StatiCrypt zašifruje celý.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
});
