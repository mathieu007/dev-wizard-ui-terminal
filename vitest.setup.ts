import { vi } from "vitest";

const execaMocks = (() => {
	const createProcess = (overrides?: {
		exitCode?: number;
		stdout?: string;
		stderr?: string;
		streamStdout?: NodeJS.ReadableStream;
	}) => {
		const result = Promise.resolve({
			exitCode: overrides?.exitCode ?? 0,
			stdout: overrides?.stdout ?? "ok",
			stderr: overrides?.stderr ?? "",
		});
		return Object.assign(result, {
			stdout: overrides?.streamStdout,
			stderr: undefined,
		});
	};

	const createFailure = (overrides?: {
		exitCode?: number;
		stdout?: string;
		stderr?: string;
		message?: string;
		streamStdout?: NodeJS.ReadableStream;
		timedOut?: boolean;
	}) => {
		const error = Object.assign(
			new Error(overrides?.message ?? "command failed"),
			{
				exitCode: overrides?.exitCode ?? 1,
				stdout: overrides?.stdout,
				stderr: overrides?.stderr,
				timedOut: overrides?.timedOut ?? false,
			},
		);
		const result = Promise.reject(error);
		return Object.assign(result, {
			stdout: overrides?.streamStdout,
			stderr: undefined,
		});
	};

	return {
		createProcess,
		createFailure,
		execaCommand: vi.fn((..._args: unknown[]) => createProcess()),
		execa: vi.fn((..._args: unknown[]) => createProcess()),
	};
})();

(globalThis as typeof globalThis & { __execaMocks?: typeof execaMocks }).__execaMocks = execaMocks;
