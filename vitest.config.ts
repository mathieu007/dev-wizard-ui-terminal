import path from "node:path";
import { defineConfig } from "vitest/config";

const engineRoot = path.resolve(__dirname, "../dev-wizard-engine/src");
const execaMock = path.resolve(__dirname, "vitest.execa.ts");

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^execa$/,
				replacement: execaMock,
			},
			{
				find: /^@dev-wizard\/engine$/,
				replacement: path.join(engineRoot, "index.ts"),
			},
			{
				find: /^@dev-wizard\/engine\/(.*)$/,
				replacement: `${engineRoot}/$1`,
			},
		],
	},
	test: {
		deps: {
			inline: ["execa", /^@dev-wizard\/engine/],
		},
		setupFiles: ["./vitest.setup.ts"],
	},
});
