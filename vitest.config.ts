import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Live tests cost money and need an API key, so they're opt-in only.
		// Run them with: npm run test:live
		testTimeout: process.env.PI_AUTO_LIVE_TESTS ? 60_000 : 10_000,
	},
});
