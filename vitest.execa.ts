type ExecaMocks = {
	execaCommand: (...args: unknown[]) => unknown;
	execa: (...args: unknown[]) => unknown;
};

const execaMocks = (globalThis as typeof globalThis & { __execaMocks?: ExecaMocks })
	.__execaMocks;

if (!execaMocks) {
	throw new Error("Missing execa mocks. Ensure vitest.setup.ts is configured.");
}

export const execaCommand = execaMocks.execaCommand;
export const execa = execaMocks.execa;
export default execaMocks.execa;
