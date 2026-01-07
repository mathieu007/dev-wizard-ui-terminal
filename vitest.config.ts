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
				find: /^@ScaffoldStack/dev-wizard-engine$/,
				replacement: path.join(engineRoot, "index.ts"),
			},
			{
				find: /^@ScaffoldStack/dev-wizard-engine\/(.*)$/,
				replacement: `${engineRoot}/$1`,
			},
		],
	},
	test: {
		deps: {
			inline: ["execa", /^@ScaffoldStack/dev-wizard-engine/],
		},
		setupFiles: ["./vitest.setup.ts"],
	},
});
