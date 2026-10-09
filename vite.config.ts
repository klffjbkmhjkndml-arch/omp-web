import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.OMP_WEB_PORT ?? 30190);

export default defineConfig({
	root: "web",
	plugins: [react()],
	build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
	server: {
		host: "127.0.0.1",
		port: 5190,
		strictPort: true,
		proxy: {
			"/api": `http://127.0.0.1:${apiPort}`,
			"/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
		},
	},
});
