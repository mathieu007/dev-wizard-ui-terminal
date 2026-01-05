import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevWizardConfig } from "@ScaffoldStack/dev-wizard-engine/loader/types.js";
import type { WizardLogEvent } from "@ScaffoldStack/dev-wizard-engine/runtime/logWriter.js";
import type { WizardState } from "@ScaffoldStack/dev-wizard-engine/runtime/state.js";
let buildScenarioPlanImpl!: typeof import("@ScaffoldStack/dev-wizard-engine/runtime/executor.js").buildScenarioPlan;
let executeScenarioImpl!: typeof import("@ScaffoldStack/dev-wizard-engine/runtime/executor.js").executeScenario;
let SKIP_STEP_OPTION_VALUE!: string;
let createPromptPersistenceManager!: typeof import("@ScaffoldStack/dev-wizard-engine/runtime/promptPersistence.js").createPromptPersistenceManager;
let sanitizePersistenceSegment!: typeof import("@ScaffoldStack/dev-wizard-engine/runtime/promptPersistence.js").sanitizePersistenceSegment;
let ClackPromptDriver!: typeof import("../index.js").ClackPromptDriver;
let runDevWizard!: typeof import("../index.js").runDevWizard;

const promptMocks = vi.hoisted(() => {
	const log = {
		info: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	return {
		intro: vi.fn(),
		outro: vi.fn(),
		confirm: vi.fn(async (_options?: unknown) => true),
		isCancel: () => false,
		multiselect: vi.fn(async (_options?: unknown) => []),
		note: vi.fn(),
		select: vi.fn(
			async (options: { options: Array<{ value: string }>; message?: string }) => {
				return options.options[0]?.value ?? "";
			},
		),
		text: vi.fn(async (_options?: unknown) => "Alice"),
		log,
	};
});

vi.mock("@clack/prompts", () => promptMocks);

const textPromptMock = vi.hoisted(() => ({
	createTextPromptWithHistory: vi.fn(async (_options?: unknown) => "Alice"),
}));

vi.mock("../runtime/textPrompt.js", () => textPromptMock);

vi.mock("../runtime/prompts/orderedMultiselect.js", () => ({
	orderedMultiselect: vi.fn(
		async (options: { options: Array<{ value: string }>; message?: string }) =>
			promptMocks.multiselect(options),
	),
}));

vi.mock("../runtime/shortcutPrompts.js", () => ({
	selectWithShortcuts: vi.fn(
		async (options: { options: Array<{ value: string }>; message?: string }) =>
			promptMocks.select(options),
	),
}));

type ExecaMocks = {
	createProcess: (overrides?: {
		exitCode?: number;
		stdout?: string;
		stderr?: string;
		streamStdout?: NodeJS.ReadableStream;
	}) => Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}> & {
		stdout?: NodeJS.ReadableStream;
		stderr?: undefined;
	};
	createFailure: (overrides?: {
		exitCode?: number;
		stdout?: string;
		stderr?: string;
		message?: string;
		streamStdout?: NodeJS.ReadableStream;
		timedOut?: boolean;
	}) => Promise<never> & {
		stdout?: NodeJS.ReadableStream;
		stderr?: undefined;
	};
	execaCommand: ReturnType<typeof vi.fn>;
	execa: ReturnType<typeof vi.fn>;
};

const execaMocks = (globalThis as typeof globalThis & { __execaMocks?: ExecaMocks })
	.__execaMocks;

if (!execaMocks) {
	throw new Error("Missing execa mocks. Ensure vitest.setup.ts is configured.");
}

let tmpDir = "";

beforeAll(async () => {
	const engine = await import("@ScaffoldStack/dev-wizard-engine/runtime/executor.js");
	buildScenarioPlanImpl = engine.buildScenarioPlan;
	executeScenarioImpl = engine.executeScenario;
	SKIP_STEP_OPTION_VALUE = engine.SKIP_STEP_OPTION_VALUE;

	const promptPersistence = await import(
		"@ScaffoldStack/dev-wizard-engine/runtime/promptPersistence.js"
	);
	createPromptPersistenceManager = promptPersistence.createPromptPersistenceManager;
	sanitizePersistenceSegment = promptPersistence.sanitizePersistenceSegment;

	const ui = await import("../index.js");
	ClackPromptDriver = ui.ClackPromptDriver;
	runDevWizard = ui.runDevWizard;
});

const testDriver = () => new ClackPromptDriver();

type ExecutorContext = Parameters<typeof executeScenarioImpl>[0];

type ExecutorContextInput = Omit<ExecutorContext, "promptDriver"> & {
	promptDriver?: ExecutorContext["promptDriver"];
};

async function executeScenario(
	context: ExecutorContextInput,
	options?: Parameters<typeof executeScenarioImpl>[1],
): Promise<WizardState> {
	return executeScenarioImpl(
		{
			...context,
			promptDriver: context.promptDriver ?? testDriver(),
		} as ExecutorContext,
		options,
	);
}

async function buildScenarioPlan(
	context: ExecutorContextInput,
	options?: Parameters<typeof buildScenarioPlanImpl>[1],
): Promise<Awaited<ReturnType<typeof buildScenarioPlanImpl>>> {
	return buildScenarioPlanImpl(
		{
			...context,
			promptDriver: context.promptDriver ?? testDriver(),
		} as ExecutorContext,
		options,
	);
}

function createCapturedStreams(): {
	stdout: PassThrough;
	stderr: PassThrough;
	getStdout: () => string;
	getStderr: () => string;
} {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let stdoutBuffer = "";
	let stderrBuffer = "";

	stdout.on("data", (chunk) => {
		stdoutBuffer += chunk.toString();
	});
	stderr.on("data", (chunk) => {
		stderrBuffer += chunk.toString();
	});

	return {
		stdout,
		stderr,
		getStdout: () => stdoutBuffer,
		getStderr: () => stderrBuffer,
	};
}

async function clearScenarioAnswers(scenarioId: string): Promise<void> {
	const answersRoot = path.join(process.cwd(), ".dev-wizard", "answers");
	await fs.rm(path.join(answersRoot, scenarioId), { recursive: true, force: true });
	await fs.rm(path.join(answersRoot, `${scenarioId}.json`), { force: true });
}

async function writeScenarioAnswersSnapshot(
	scenarioId: string,
	answers: Record<string, unknown>,
): Promise<void> {
	const answersRoot = path.join(process.cwd(), ".dev-wizard", "answers");
	const sanitizedScenario = sanitizePersistenceSegment(scenarioId);
	const filePath = path.join(answersRoot, `${sanitizedScenario}.json`);
	const payload = {
		meta: { scenarioId },
		scenario: answers,
	};
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeIdentitySnapshot(
	scenarioId: string,
	segments: Array<{ id: string; value: string; label?: string }>,
	scenarioAnswers?: Record<string, unknown>,
): Promise<void> {
	const answersRoot = path.join(process.cwd(), ".dev-wizard", "answers");
	const sanitizedScenario = sanitizePersistenceSegment(scenarioId);
	const sanitizedSegments = segments.map((segment) => sanitizePersistenceSegment(segment.value));
	const directorySegments = [
		sanitizedScenario,
		...sanitizedSegments.slice(0, Math.max(sanitizedSegments.length - 1, 0)),
	].filter((segment) => segment.length > 0);
	const fileNameSegment = sanitizedSegments[sanitizedSegments.length - 1] || "answers";
	const filePath = path.join(answersRoot, ...directorySegments, `${fileNameSegment}.json`);
	const payload = {
		meta: {
			scenarioId,
			identity: {
				slug: segments.map((segment) => segment.value).join("/"),
				segments,
			},
		},
		scenario: scenarioAnswers ?? {},
	};
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function stubInteractiveTty(): () => void {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const originalStdinIsTTY = stdin.isTTY;
	const originalStdoutIsTTY = stdout.isTTY;
	stdin.isTTY = true;
	stdout.isTTY = true;
	return () => {
		if (originalStdinIsTTY === undefined) {
			Reflect.deleteProperty(stdin, "isTTY");
		} else {
			stdin.isTTY = originalStdinIsTTY;
		}
		if (originalStdoutIsTTY === undefined) {
			Reflect.deleteProperty(stdout, "isTTY");
		} else {
			stdout.isTTY = originalStdoutIsTTY;
		}
	};
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dev-wizard-run-"));
	promptMocks.text.mockReset();
	promptMocks.confirm.mockReset();
	promptMocks.select.mockReset();
	promptMocks.multiselect.mockReset();
	promptMocks.note.mockReset();
	promptMocks.intro.mockReset();
	promptMocks.outro.mockReset();
	promptMocks.log.info.mockReset();
	promptMocks.log.success.mockReset();
	promptMocks.log.warn.mockReset();
	promptMocks.log.error.mockReset();
	textPromptMock.createTextPromptWithHistory.mockReset();
	execaMocks.execaCommand.mockReset();
	execaMocks.execa.mockReset();
	execaMocks.execaCommand.mockImplementation(() => execaMocks.createProcess());
	promptMocks.text.mockImplementation(async () => "Alice");
	promptMocks.confirm.mockImplementation(async () => true);
	promptMocks.select.mockImplementation(
		async (options: { options: Array<{ value: string }>; message?: string }) => {
			return options.options[0]?.value ?? "";
		},
	);
	promptMocks.multiselect.mockImplementation(async () => []);
	textPromptMock.createTextPromptWithHistory.mockImplementation(async () => "Alice");
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});
describe("runDevWizard", () => {
	it("summarises policy decisions in the final note", async () => {
		const configPath = path.join(tmpDir, "policy-summary.yaml");
		await fs.writeFile(
			configPath,
			[
				"meta:",
				"  name: Policy Summary",
				"  version: 1.0.0",
				"scenarios:",
				"  - id: policy",
				"    label: Policy",
				"    flow: main",
				"flows:",
				"  main:",
				"    id: main",
				"    steps:",
				"      - id: warn-step",
				"        type: command",
				"        commands:",
				"          - run: echo \"policy\"",
				"policies:",
				"  defaultLevel: allow",
				"  rules:",
				"    - id: warn-step",
				"      level: warn",
				"      match:",
				"        step: warn-step",
				"      note: Check command context",
			].join("\n"),
		);

		const result = await runDevWizard({
			configPath,
			scenario: "policy",
			dryRun: true,
			logFile: undefined,
			quiet: false,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		expect(result.exitCode).toBe(0);
		expect(result.state?.policyDecisions).toEqual(
			expect.arrayContaining([
				{
					ruleId: "warn-step",
					ruleLevel: "warn",
					enforcedLevel: "warn",
					acknowledged: false,
					flowId: "main",
					stepId: "warn-step",
					command: "echo \"policy\"",
					note: "Check command context",
				},
			]),
		);

		const summaryCall = promptMocks.note.mock.calls.find(
			([message, title]) =>
				typeof title === "string" &&
				title.includes("Wizard Summary") &&
				typeof message === "string",
		);

		expect(summaryCall).toBeDefined();
		const summaryMessage = summaryCall?.[0];
		expect(summaryMessage).toContain("policy decisions:");
		expect(summaryMessage).toContain("warn-step (warn)");
	});

	it("prints summary note and writes log file", async () => {
		const configPath = path.join(tmpDir, "wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:\n  name: Test\n  version: 1.0.0\nscenarios:\n  - id: demo\n    label: Demo\n    flow: main\nflows:\n  main:\n    id: main\n    steps:\n      - id: greet\n        type: prompt\n        mode: input\n        prompt: What is your name?\n        storeAs: name\n      - id: run-command\n        type: command\n        commands:\n          - run: echo \\\"hello\\\"\n`,
		);

		const logPath = path.join(tmpDir, "summary.log");
		const restoreTty = stubInteractiveTty();

		try {
			const result = await runDevWizard({
				configPath,
				scenario: "demo",
				dryRun: true,
				logFile: logPath,
				quiet: false,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});

			expect(result.exitCode).toBe(0);
			expect(result.state?.flowRuns).toHaveLength(1);

			expect(
				promptMocks.note.mock.calls.some(
					([message, title]) =>
						typeof title === "string" &&
						title.includes("Wizard Summary") &&
						typeof message === "string" &&
						message.includes("2 steps") &&
						message.includes("duration:") &&
						message.includes("flow timeline:") &&
						message.includes("Flow | Duration"),
				),
			).toBe(true);
			expect(
				promptMocks.outro.mock.calls.some(
					([message]) =>
						typeof message === "string" && message.includes("Wizard complete."),
				),
			).toBe(true);

			const logContents = await fs.readFile(logPath, "utf8");
			expect(logContents).toContain("scenario.complete");
		} finally {
			restoreTty();
		}
	});

	it("returns a non-zero exit code when a command fails", async () => {
		const configPath = path.join(tmpDir, "fail.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:\n  name: Fail\n  version: 1.0.0\nscenarios:\n  - id: fail\n    label: Fail\n    flow: main\nflows:\n  main:\n    id: main\n    steps:\n      - id: failing\n        type: command\n        commands:\n          - run: pnpm boom\n`,
		);

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createFailure({
				message: "boom",
				exitCode: 1,
			}),
		);

		const result = await runDevWizard({
			configPath,
			scenario: "fail",
			dryRun: false,
			logFile: undefined,
			quiet: false,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		expect(result.exitCode).toBe(1);
		expect(result.state?.failedSteps).toBeGreaterThan(0);
		expect(result.state?.exitedEarly).toBe(true);
		expect(
			promptMocks.note.mock.calls.some(
				([message]) =>
					typeof message === "string" &&
					(message.includes("failure") || message.includes("status: exited early")),
			),
		).toBe(true);
		expect(
			promptMocks.outro.mock.calls.some(
				([message]) =>
					typeof message === "string" && message.includes("Wizard failed."),
			),
		).toBe(true);
	});

	it("captures a manifest without executing commands", async () => {
		const configPath = path.join(tmpDir, "manifest.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:\n  name: Manifest\n  version: 1.0.0\nscenarios:\n  - id: demo\n    label: Demo\n    flow: main\nflows:\n  main:\n    id: main\n    steps:\n      - id: name\n        type: prompt\n        mode: input\n        prompt: Who are you?\n        storeAs: name\n      - id: run\n        type: command\n        commands:\n          - run: echo manifest\n`,
		);
		const manifestPath = path.join(tmpDir, "demo.manifest.json");

		execaMocks.execaCommand.mockClear();
		await clearScenarioAnswers("identity-demo");
		await clearScenarioAnswers("identity-reroute");

		const restoreTty = stubInteractiveTty();
		try {
			await runDevWizard({
				configPath,
				scenario: "demo",
				registerManifestPath: manifestPath,
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
		} finally {
			restoreTty();
		}

		expect(execaMocks.execaCommand).not.toHaveBeenCalled();
		const manifestRaw = await fs.readFile(manifestPath, "utf8");
		const manifest = JSON.parse(manifestRaw) as {
			scenarioId: string;
			answers: Record<string, unknown>;
			plan: unknown;
		};
		expect(manifest.scenarioId).toBe("demo");
		expect(manifest.answers.name).toBe("Alice");
		expect(manifest.plan).toBeDefined();
	});

	it("executes a manifest without prompting", async () => {
		const configPath = path.join(tmpDir, "manifest-run.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:\n  name: Manifest Run\n  version: 1.0.0\nscenarios:\n  - id: demo\n    label: Demo\n    flow: main\nflows:\n  main:\n    id: main\n    steps:\n      - id: name\n        type: prompt\n        mode: input\n        prompt: Who are you?\n        storeAs: name\n      - id: run\n        type: command\n        commands:\n          - run: echo manifest\n`,
		);
		const manifestPath = path.join(tmpDir, "demo-manifest.json");

		await clearScenarioAnswers("identity-custom");

		const restoreTty = stubInteractiveTty();
		try {
			await runDevWizard({
				configPath,
				scenario: "demo",
				registerManifestPath: manifestPath,
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
		} finally {
			restoreTty();
		}

		promptMocks.text.mockClear();
		promptMocks.confirm.mockClear();
		execaMocks.execaCommand.mockClear();

		await runDevWizard({
			executeManifestPath: manifestPath,
			quiet: true,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		expect(promptMocks.text).not.toHaveBeenCalled();
		expect(execaMocks.execaCommand).toHaveBeenCalled();
	});

	it("applies persisted answers without requiring --answers", async () => {
		const configPath = path.join(tmpDir, "persisted-auto.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:\n  name: Persisted\n  version: 1.0.0\nscenarios:\n  - id: cached\n    label: Cached\n    flow: main\nflows:\n  main:\n    id: main\n    steps:\n      - id: ask-name\n        type: prompt\n        mode: input\n        prompt: Who are you?\n        storeAs: name\n        persist: true\n      - id: echo\n        type: command\n        commands:\n          - run: echo cached\n`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		try {
			const persistence = await createPromptPersistenceManager({
				repoRoot: tmpDir,
				scenarioId: "cached",
			});
			persistence.set({ scope: "scenario", key: "name" }, "Cache Me");
			await persistence.save();
			textPromptMock.createTextPromptWithHistory.mockClear();

			const result = await runDevWizard({
				configPath,
				scenario: "cached",
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});

			expect(result.exitCode).toBe(0);
			expect(result.state?.answers.name).toBe("Cache Me");
			expect(textPromptMock.createTextPromptWithHistory).not.toHaveBeenCalled();
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("reuses a stored identity slug when rerunning without --answers-identity", async () => {
		const configPath = path.join(tmpDir, "identity.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Demo
  version: 1.0.0
scenarios:
  - id: identity-demo
    label: Identity Demo
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Maintenance
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
          allowCustom: true
flows:
  main:
    id: main
    steps:
      - id: collect
        type: prompt
        mode: input
        prompt: What is your favorite tool?
        storeAs: favoriteTool
        persist: true
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("identity-demo");
		await writeIdentitySnapshot(
			"identity-demo",
			[
				{ id: "category", value: "maintenance", label: "Maintenance" },
				{ id: "cadence", value: "daily", label: "Daily" },
			],
			{ favoriteTool: "Alice" },
		);

		textPromptMock.createTextPromptWithHistory.mockClear();
		const restoreTty = stubInteractiveTty();
		const originalSelectImplementation = promptMocks.select.getMockImplementation();
		promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }>; message?: string }) => {
			if (options.options.some((option) => option.value === "reuse")) {
				return "reuse";
			}
			return options.options[0]?.value ?? "";
		});

		try {
			const result = await runDevWizard({
				configPath,
				scenario: "identity-demo",
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});

			expect(result.exitCode).toBe(0);
			expect(textPromptMock.createTextPromptWithHistory).not.toHaveBeenCalled();
		} finally {
			restoreTty();
			if (originalSelectImplementation) {
				promptMocks.select.mockImplementation(originalSelectImplementation);
			} else {
				promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }> }) => {
					return options.options[0]?.value ?? "";
				});
			}
			process.chdir(originalCwd);
		}
	});

	it("accepts answers identity segments without prompting", async () => {
		const configPath = path.join(tmpDir, "identity-flags.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Flags
  version: 1.0.0
scenarios:
  - id: identity-flags
    label: Identity Flags
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Maintenance
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
          allowCustom: true
flows:
  main:
    id: main
    steps:
      - id: noop
        type: message
        text: Ready
`,
		);

		await runDevWizard({
			configPath,
			scenario: "identity-flags",
			answersIdentitySegments: { category: "maintenance", cadence: "daily" },
			quiet: true,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		expect(promptMocks.select).not.toHaveBeenCalled();
	});

		it("allows changing identity segments when a cached slug exists", async () => {
			const configPath = path.join(tmpDir, "identity-reroute.wizard.yaml");
			await fs.writeFile(
				configPath,
			`meta:
  name: Identity Reroute
  version: 1.0.0
scenarios:
  - id: identity-reroute
    label: Identity Reroute
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Maintenance
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
            - label: Weekly
              value: weekly
flows:
  main:
    id: main
    steps:
      - id: collect
        type: prompt
        mode: input
        prompt: What is your favorite tool?
        storeAs: favoriteTool
        persist: true
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("identity-reroute");
		await writeIdentitySnapshot("identity-reroute", [
			{ id: "category", value: "maintenance", label: "Maintenance" },
			{ id: "cadence", value: "daily", label: "Daily" },
		]);

			const restoreTty = stubInteractiveTty();

			const originalSelectImplementation = promptMocks.select.getMockImplementation();
			promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }>; message?: string }) => {
				if (options.options.some((option) => option.value === "maintenance")) {
					return "maintenance";
				}
				if (options.options.some((option) => option.value === "weekly")) {
				return "weekly";
			}
			return options.options[0]?.value ?? "";
		});

		try {
			const result = await runDevWizard({
				configPath,
				scenario: "identity-reroute",
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
					stderr: new PassThrough(),
				});

				expect(result.persistedAnswers?.identitySlug).toBe("maintenance/weekly");
			} finally {
				restoreTty();
			if (originalSelectImplementation) {
				promptMocks.select.mockImplementation(originalSelectImplementation);
			} else {
				promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }> }) => {
					return options.options[0]?.value ?? "";
				});
			}
			process.chdir(originalCwd);
			}
		});

		it("accepts custom identity segment values when cached answers exist", async () => {
			const configPath = path.join(tmpDir, "identity-custom.wizard.yaml");
			await fs.writeFile(
				configPath,
				`meta:
  name: Identity Custom
  version: 1.0.0
scenarios:
  - id: identity-custom
    label: Identity Custom
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Maintenance
              value: maintenance
        - id: task
          prompt: Select a task
          options:
            - label: Upgrade dependencies
              value: upgrade
            - label: Sweep
              value: sweep
          allowCustom: true
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
            - label: Weekly
              value: weekly
flows:
  main:
    id: main
    steps:
      - id: collect
        type: prompt
        mode: input
        prompt: What is your favorite tool?
        storeAs: favoriteTool
        persist: true
`,
			);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("identity-custom");
		await writeIdentitySnapshot("identity-custom", [
			{ id: "category", value: "maintenance", label: "Maintenance" },
			{ id: "task", value: "upgrade", label: "Upgrade dependencies" },
			{ id: "cadence", value: "daily", label: "Daily" },
		]);

			const restoreTty = stubInteractiveTty();

			const originalSelectImplementation = promptMocks.select.getMockImplementation();
			const originalTextImplementation = promptMocks.text.getMockImplementation();
			promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }>; message?: string }) => {
				if (options.message === "Select a task" && options.options.some((option) => option.value === "__custom__")) {
					return "__custom__";
				}
				if (options.options.some((option) => option.value === "weekly")) {
					return "weekly";
				}
				return options.options[0]?.value ?? "";
			});
			promptMocks.text.mockImplementation(async (...args: unknown[]) => {
				const [options] = args as Array<{ message?: string } | undefined>;
				if (options?.message === "Select a task") {
					return "custom-weekly";
				}
				return "Alice";
			});

			try {
				const result = await runDevWizard({
					configPath,
					scenario: "identity-custom",
					quiet: true,
					verbose: false,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				});
				expect(result.persistedAnswers?.identitySlug).toBe("maintenance/custom-weekly/weekly");
			} finally {
				restoreTty();
				if (originalSelectImplementation) {
					promptMocks.select.mockImplementation(originalSelectImplementation);
				} else {
					promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }> }) => {
						return options.options[0]?.value ?? "";
					});
				}
				if (originalTextImplementation) {
					promptMocks.text.mockImplementation(originalTextImplementation);
				} else {
					promptMocks.text.mockImplementation(async () => "Alice");
				}
				process.chdir(originalCwd);
			}
		});

	it("fails fast when identity overrides omit segments in non-interactive runs", async () => {
		const configPath = path.join(tmpDir, "identity-partial.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Partial
  version: 1.0.0
scenarios:
  - id: partial-identity
    label: Partial Identity
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Maintenance
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
            - label: Weekly
              value: weekly
flows:
  main:
    id: main
    steps:
      - id: noop
        type: message
        text: Ready
`,
		);

		const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		try {
			await expect(
				runDevWizard({
					configPath,
					scenario: "partial-identity",
					answersIdentitySegments: { category: "maintenance" },
					quiet: true,
					verbose: false,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				}),
			).rejects.toThrow(/cadence/);
		} finally {
			process.chdir(originalCwd);
		}

		if (stdinDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
		} else {
			Reflect.deleteProperty(process.stdin, "isTTY");
		}
		if (stdoutDescriptor) {
			Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	it("allows reviewing persisted answers before overwriting them", async () => {
		const configPath = path.join(tmpDir, "persisted-review.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Persisted Review
  version: 1.0.0
scenarios:
  - id: persisted-review
    label: Persisted Review
    flow: main
flows:
  main:
    id: main
    steps:
      - id: collect
        type: prompt
        mode: input
        prompt: What is your favorite tool?
        storeAs: favoriteTool
        persist: true
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("persisted-review");
		await writeScenarioAnswersSnapshot("persisted-review", {
			favoriteTool: "hammer",
		});

		const restoreTty = stubInteractiveTty();
		const selectImplementation = promptMocks.select.getMockImplementation();
		let strategyPromptSeen = false;
		promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }> }) => {
			if (options.options.some((option) => option.value === "review")) {
				strategyPromptSeen = true;
				return "review";
			}
			if (selectImplementation) {
				return selectImplementation(options);
			}
			return options.options[0]?.value ?? "";
		});
		textPromptMock.createTextPromptWithHistory.mockImplementationOnce(async () => "plane");

		try {
			const result = await runDevWizard({
				configPath,
				scenario: "persisted-review",
				loadPersistedAnswers: true,
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			expect(strategyPromptSeen).toBe(true);
			expect(result.persistedAnswers?.filePath).toContain("persisted-review");
			const snapshotRaw = await fs.readFile(result.persistedAnswers!.filePath, "utf8");
			const snapshot = JSON.parse(snapshotRaw) as {
				scenario?: Record<string, unknown>;
			};
			expect(snapshot.scenario?.favoriteTool).toBe("plane");
			expect(result.state?.answers.favoriteTool).toBe("plane");
		} finally {
			restoreTty();
			process.chdir(originalCwd);
		}
	});

	it("supports resetting persisted answers before prompting", async () => {
		const configPath = path.join(tmpDir, "persisted-reset.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Persisted Reset
  version: 1.0.0
scenarios:
  - id: persisted-reset
    label: Persisted Reset
    flow: main
flows:
  main:
    id: main
    steps:
      - id: collect
        type: prompt
        mode: input
        prompt: What is your favorite tool?
        storeAs: favoriteTool
        persist: true
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("persisted-reset");
		await writeScenarioAnswersSnapshot("persisted-reset", {
			favoriteTool: "hammer",
		});

		const restoreTty = stubInteractiveTty();
		const selectImplementation = promptMocks.select.getMockImplementation();
		let strategyPromptSeen = false;
		promptMocks.select.mockImplementation(async (options: { options: Array<{ value: string }> }) => {
			if (options.options.some((option) => option.value === "reset")) {
				strategyPromptSeen = true;
				return "reset";
			}
			if (selectImplementation) {
				return selectImplementation(options);
			}
			return options.options[0]?.value ?? "";
		});
		textPromptMock.createTextPromptWithHistory.mockImplementationOnce(async () => "chisel");

		try {
			const result = await runDevWizard({
				configPath,
				scenario: "persisted-reset",
				loadPersistedAnswers: true,
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			expect(strategyPromptSeen).toBe(true);
			expect(result.persistedAnswers?.filePath).toContain("persisted-reset");
			const snapshotRaw = await fs.readFile(result.persistedAnswers!.filePath, "utf8");
			const snapshot = JSON.parse(snapshotRaw) as {
				scenario?: Record<string, unknown>;
			};
			expect(snapshot.scenario?.favoriteTool).toBe("chisel");
			expect(result.state?.answers.favoriteTool).toBe("chisel");
		} finally {
			restoreTty();
			process.chdir(originalCwd);
		}
	});

	it("persists identity segment metadata when overrides include cadence details", async () => {
		const configPath = path.join(tmpDir, "identity-metadata.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Metadata
  version: 1.0.0
scenarios:
  - id: identity-metadata
    label: Identity Metadata
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Maintenance
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
flows:
  main:
    id: main
    steps:
      - id: collect
        type: prompt
        mode: input
        prompt: What is your favorite tool?
        storeAs: favoriteTool
        persist: true
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		let result: Awaited<ReturnType<typeof runDevWizard>>;
		try {
				result = await runDevWizard({
					configPath,
					scenario: "identity-metadata",
					overrides: {
						favoriteTool: "chisel",
					},
					answersIdentitySegments: {
						category: "maintenance",
					cadence: "daily",
				},
			answersIdentitySegmentDetails: {
				cadence: {
					label: "custom cadence (0 2 * * * @ UTC)",
					details: {
						cron: "0 2 * * *",
						timezone: "UTC",
						},
					},
				},
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
		} finally {
			process.chdir(originalCwd);
		}

		expect(result.persistedAnswers?.filePath).toBeTruthy();
		const snapshotRaw = await fs.readFile(
			result.persistedAnswers!.filePath,
			"utf8",
		);
		const snapshot = JSON.parse(snapshotRaw) as {
			meta?: {
				identity?: {
					segments?: Array<Record<string, unknown>>;
				};
			};
		};
		expect(snapshot.meta?.identity?.segments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "cadence",
					value: "daily",
					details: {
						cron: "0 2 * * *",
						timezone: "UTC",
					},
				}),
			]),
		);
	});

		it("exposes identity selections to templates so flows can skip prompts", async () => {
		const configPath = path.join(tmpDir, "identity-routing.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Routing
  version: 1.0.0
scenarios:
  - id: identity-routing
    label: Identity Routing
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Projects
              value: projects
        - id: task
          prompt: Select a workflow focus
          options:
            - label: Maintenance workflows
              value: maintenance
            - label: Custom
              value: custom
flows:
  main:
    id: main
    steps:
      - id: workflow-routing
        type: branch
        branches:
          - when: "{{ and (not state.answers.desiredWorkflows) (eq (lookup (lookup state.identityById 'task') 'value') 'maintenance') }}"
            next: set-workflows
        defaultNext:
          next: choose-workflows
      - id: set-workflows
        type: command
        defaults:
          quiet: true
        commands:
          - name: set-maintenance
            run: |
              bash -lc 'printf "[\\"maintenance\\"]"'
            parseJson: true
            storeStdoutAs: desiredWorkflows
        onSuccess:
          next: confirm-selection
      - id: choose-workflows
        type: prompt
        mode: multiselect
        prompt: Select workflows to run
        storeAs: desiredWorkflows
        persist: true
        options:
          - value: maintenance
            label: Maintenance
      - id: confirm-selection
        type: message
        text: "selected workflows: {{ json state.answers.desiredWorkflows }}"
`,
		);

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({
				stdout: "[\"maintenance\"]",
			}),
		);

		promptMocks.multiselect.mockImplementation(() => {
			throw new Error("Workflow prompt should be skipped when identity selects the workflow.");
		});

		const result = await runDevWizard({
			configPath,
			scenario: "identity-routing",
			answersIdentity: "projects/maintenance",
			quiet: true,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

			expect(result.exitCode).toBe(0);
			expect(promptMocks.multiselect).not.toHaveBeenCalled();
			expect(result.state?.answers.desiredWorkflows).toEqual(["maintenance"]);
		});

		it("prompts for identity segments (with persisted values as defaults) before persisted-answers decisions", async () => {
			const configPath = path.join(tmpDir, "identity-persisted-defaults.wizard.yaml");
			await fs.writeFile(
				configPath,
				`meta:
  name: Identity Persisted Defaults
  version: 1.0.0
scenarios:
  - id: identity-persisted-defaults
    label: Identity Persisted Defaults
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select category
          options:
            - label: Projects
              value: projects
        - id: task
          prompt: Select task
          options:
            - label: Maintenance workflows
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
        - id: window
          prompt: Name this window
          allowCustom: true
flows:
  main:
    id: main
    steps:
      - id: noop
        type: message
        text: Ready
`,
			);

			const originalCwd = process.cwd();
			process.chdir(tmpDir);
			const restoreTty = stubInteractiveTty();
			promptMocks.select.mockClear();
			promptMocks.text.mockClear();
			await clearScenarioAnswers("identity-persisted-defaults");
			await writeIdentitySnapshot("identity-persisted-defaults", [
				{ id: "category", value: "projects", label: "Projects" },
				{ id: "task", value: "maintenance", label: "Maintenance workflows" },
				{ id: "cadence", value: "daily", label: "Daily" },
				{ id: "window", value: "daily-maintenance", label: "daily-maintenance" },
			]);

			const originalTextImplementation = promptMocks.text.getMockImplementation();
			let windowInitialValue: string | undefined;
			promptMocks.text.mockImplementation(async (...args: unknown[]) => {
				const [options] = args as Array<{ initialValue?: string } | undefined>;
				if (windowInitialValue === undefined) {
					windowInitialValue = options?.initialValue;
				}
				if (options?.initialValue) {
					return options.initialValue;
				}
				if (originalTextImplementation) {
					return originalTextImplementation();
				}
				return "daily-maintenance";
			});

			try {
				await runDevWizard({
					configPath,
					scenario: "identity-persisted-defaults",
					quiet: true,
					verbose: false,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				});

				const firstSelectCall = promptMocks.select.mock.calls[0]?.[0] as
					| { message?: string }
					| undefined;
				expect(firstSelectCall?.message).toBe("Select category");
				expect(windowInitialValue).toBe("daily-maintenance");
				expect(
					promptMocks.select.mock.calls.some(
						([options]) =>
							typeof options?.message === "string" &&
							options.message.includes("Saved answers identity"),
					),
				).toBe(false);
			} finally {
				restoreTty();
				if (originalTextImplementation) {
					promptMocks.text.mockImplementation(originalTextImplementation);
				} else {
					promptMocks.text.mockImplementation(async () => "Alice");
				}
				process.chdir(originalCwd);
			}
		});

			it("prompts to choose an existing identity when multiple identity snapshots exist", async () => {
				const configPath = path.join(tmpDir, "identity-persisted-multiple.wizard.yaml");
				await fs.writeFile(
					configPath,
				`meta:
  name: Identity Persisted Multiple
  version: 1.0.0
scenarios:
  - id: identity-persisted-multiple
    label: Identity Persisted Multiple
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select category
          options:
            - label: Projects
              value: projects
        - id: task
          prompt: Select task
          options:
            - label: Maintenance workflows
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Daily
              value: daily
        - id: window
          prompt: Name this window
          allowCustom: true
flows:
  main:
    id: main
    steps:
      - id: noop
        type: message
        text: Ready
`,
			);

			const originalCwd = process.cwd();
			process.chdir(tmpDir);
			const restoreTty = stubInteractiveTty();
			promptMocks.select.mockClear();
			promptMocks.text.mockClear();
			await clearScenarioAnswers("identity-persisted-multiple");
			await writeIdentitySnapshot("identity-persisted-multiple", [
				{ id: "category", value: "projects", label: "Projects" },
				{ id: "task", value: "maintenance", label: "Maintenance workflows" },
				{ id: "cadence", value: "daily", label: "Daily" },
				{ id: "window", value: "window-a", label: "window-a" },
			]);
			await writeIdentitySnapshot("identity-persisted-multiple", [
				{ id: "category", value: "projects", label: "Projects" },
				{ id: "task", value: "maintenance", label: "Maintenance workflows" },
				{ id: "cadence", value: "daily", label: "Daily" },
				{ id: "window", value: "window-b", label: "window-b" },
			]);

			try {
				await runDevWizard({
					configPath,
					scenario: "identity-persisted-multiple",
					quiet: true,
					verbose: false,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				});

				const firstCall = promptMocks.select.mock.calls[0]?.[0] as
					| { message?: string }
					| undefined;
				const secondCall = promptMocks.select.mock.calls[1]?.[0] as
					| { message?: string }
					| undefined;
				expect(firstCall?.message).toBe(
					"Select an existing answers identity (or create a new one):",
				);
				expect(secondCall?.message).toBe("Select category");
			} finally {
				restoreTty();
				process.chdir(originalCwd);
				}
			});

			it("hydrates identity from --answers metadata so identity-based routing stays non-interactive", async () => {
				const configPath = path.join(tmpDir, "identity-external-answers.wizard.yaml");
				await fs.writeFile(
					configPath,
					`meta:
  name: Identity External Answers
  version: 1.0.0
scenarios:
  - id: identity-external-answers
    label: Identity External Answers
    identity:
      segments:
        - id: task
          prompt: Select task
          options:
            - label: Maintenance
              value: maintenance
    flow: main
flows:
  main:
    id: main
    steps:
      - id: route
        type: branch
        branches:
          - when: "{{ eq (lookup (lookup state.identityById 'task') 'value') 'maintenance' }}"
            next: ran-maintenance
        defaultNext:
          next: prompt-task
      - id: ran-maintenance
        type: command
        onSuccess:
          next: exit
        commands:
          - name: ok
            run: echo maintenance
      - id: prompt-task
        type: prompt
        mode: select
        prompt: Select task
        storeAs: task
        options:
          - value: maintenance
            label: Maintenance
`,
				);

				const answersPath = path.join(tmpDir, "identity-external-answers.json");
				await fs.writeFile(
					answersPath,
					JSON.stringify(
						{
							meta: {
								scenarioId: "identity-external-answers",
								identity: {
									slug: "maintenance",
									segments: [
										{ id: "task", value: "maintenance", label: "Maintenance" },
									],
								},
							},
							scenario: {},
							projects: {},
						},
						null,
						2,
					),
					"utf8",
				);

				execaMocks.execaCommand.mockClear();
				promptMocks.select.mockClear();

				await runDevWizard({
					configPath,
					scenario: "identity-external-answers",
					loadPersistedAnswers: true,
					answersPathUsed: answersPath,
					quiet: true,
					verbose: false,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				});

				expect(promptMocks.select).not.toHaveBeenCalled();
				expect(execaMocks.execaCommand).toHaveBeenCalledTimes(1);
				expect(execaMocks.execaCommand.mock.calls[0]?.[0]).toContain("echo maintenance");
			});

			it("does not prompt for onError actions when running with --answers", async () => {
				const restoreTty = stubInteractiveTty();
				const configPath = path.join(tmpDir, "answers-disable-onerror-actions.yaml");
				await fs.writeFile(
					configPath,
					[
						"meta:",
						"  name: Answers Disable onError Actions",
						"  version: 1.0.0",
						"scenarios:",
						"  - id: fail",
						"    label: Fail",
						"    flow: main",
						"flows:",
						"  main:",
						"    id: main",
						"    steps:",
						"      - id: boom",
						"        type: command",
						"        commands:",
						"          - run: pnpm exec nope",
						"        onError:",
						"          actions:",
						"            - label: Continue anyway",
						"              next: after",
						"          defaultNext:",
						"            next: exit",
						"      - id: after",
						"        type: message",
						"        text: continued",
						"",
					].join("\n"),
				);

				const answersPath = path.join(tmpDir, "answers-disable-onerror-actions.json");
				await fs.writeFile(
					answersPath,
					JSON.stringify({ scenario: {}, projects: {} }, null, 2),
					"utf8",
				);

				execaMocks.execaCommand.mockImplementationOnce(() =>
					execaMocks.createFailure({ message: "boom" }),
				);
				promptMocks.select.mockClear();

				try {
					const result = await runDevWizard({
						configPath,
						scenario: "fail",
						loadPersistedAnswers: true,
						answersPathUsed: answersPath,
						quiet: true,
						verbose: false,
						stdout: new PassThrough(),
						stderr: new PassThrough(),
					});
					expect(result.exitCode).toBe(1);
					expect(promptMocks.select).not.toHaveBeenCalled();
				} finally {
					restoreTty();
				}
			});

		it("prefills identity window prompt using cadence defaults", async () => {
		const configPath = path.join(tmpDir, "identity-window-default.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Window Defaults
  version: 1.0.0
scenarios:
  - id: identity-window-default
    label: Identity Window Defaults
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select a category
          options:
            - label: Projects
              value: projects
        - id: task
          prompt: Select a task
          options:
            - label: Maintenance workflows
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Weekly
              value: weekly
        - id: window
          prompt: Name this window
          allowCustom: true
          placeholder: weekly-maintenance
          defaultValue: "{{cadence}}-maintenance"
flows:
  main:
    id: main
    steps:
      - id: noop
        type: message
        text: Ready
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("identity-window-default");
		const restoreTty = stubInteractiveTty();
		const originalTextImplementation = promptMocks.text.getMockImplementation();
		let windowInitialValue: string | undefined;
		promptMocks.text.mockImplementation(async (...args: unknown[]) => {
			const [options] = args as Array<{ initialValue?: string } | undefined>;
			if (!windowInitialValue) {
				windowInitialValue = options?.initialValue;
			}
			if (options?.initialValue) {
				return options.initialValue;
			}
			if (originalTextImplementation) {
				return originalTextImplementation();
			}
			return "Alice";
		});
		try {
			const result = await runDevWizard({
				configPath,
				scenario: "identity-window-default",
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			const windowSegmentConfig = result.state?.scenario.identity?.segments.find(
				(segment) => segment.id === "window",
			);
			expect(windowSegmentConfig?.defaultValue).toBe("{{cadence}}-maintenance");
			expect(windowInitialValue).toBe("weekly-maintenance");
			expect(result.state?.identity?.segments.find((segment) => segment.id === "window")?.value).toBe("weekly-maintenance");
		} finally {
			restoreTty();
			if (originalTextImplementation) {
				promptMocks.text.mockImplementation(originalTextImplementation);
			} else {
				promptMocks.text.mockImplementation(async () => "Alice");
			}
			process.chdir(originalCwd);
		}
	});

	it("exposes identity window segments to templates and answers aliases", async () => {
		const configPath = path.join(tmpDir, "identity-window.wizard.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Identity Window
  version: 1.0.0
scenarios:
  - id: identity-window
    label: Identity Window
    flow: main
    identity:
      segments:
        - id: category
          prompt: Select category
          options:
            - label: Projects
              value: projects
        - id: task
          prompt: Select task
          options:
            - label: Maintenance workflows
              value: maintenance
        - id: cadence
          prompt: Select cadence
          options:
            - label: Weekly
              value: weekly
        - id: window
          prompt: Name this window
          allowCustom: true
          placeholder: weekly-maintenance
flows:
  main:
    id: main
    steps:
      - id: record-alias-base
        type: command
        defaults:
          quiet: true
        commands:
          - name: write-alias-base
            run: |
              printf '%s' {{ json state.answersFileBase }}
            storeStdoutAs: aliasBase
      - id: record-window
        type: command
        defaults:
          quiet: true
        commands:
          - name: write-window
            run: |
              printf '%s' {{ json (lookup (lookup state.identityById 'window') 'value') }}
            storeStdoutAs: windowValue
`,
		);

		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		await clearScenarioAnswers("identity-window");
		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: "weekly-maintenance" }),
		);
		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: "weekly-maintenance" }),
		);

		try {
			const result = await runDevWizard({
				configPath,
				scenario: "identity-window",
				answersIdentitySegments: {
					category: "projects",
					task: "maintenance",
					cadence: "weekly",
					window: "weekly-maintenance",
				},
				quiet: true,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});

			const relativePath = path.relative(
				tmpDir,
				result.persistedAnswers?.filePath ?? "",
			);
			expect(relativePath).toBe(
				path.join(
					".dev-wizard",
					"answers",
					"identity-window",
					"projects",
					"maintenance",
					"weekly",
					"weekly-maintenance.json",
				),
			);
			expect(result.state?.answers.aliasBase).toBe("weekly-maintenance");
			expect(result.state?.answers.windowValue).toBe("weekly-maintenance");
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("summarises captured stdout snippets in summary", async () => {
		const configPath = path.join(tmpDir, "captured.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Captured
  version: 1.0.0
scenarios:
  - id: capture
    label: Capture
    flow: main
flows:
  main:
    id: main
    steps:
      - id: capture-command
        type: command
        commands:
          - run: echo "captured"
            captureStdout: true
`,
		);

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({
				stdout: "build succeeded\nall good",
			}),
		);

		await runDevWizard({
			configPath,
			scenario: "capture",
			dryRun: false,
			logFile: undefined,
			quiet: false,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		const noteCall = promptMocks.note.mock.calls.at(-1);
		expect(noteCall).toBeDefined();
		const [message] = noteCall!;
		if (typeof message !== "string") {
			throw new Error("Expected summary note message to be a string");
		}
		expect(message).toContain("captured output:");
		expect(message).toContain("capture-command");
		expect(message).toContain("build succeeded");
	});

	it("includes long-running commands in the summary", async () => {
		const configPath = path.join(tmpDir, "long-running.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Long Running
  version: 1.0.0
commandPresets:
  shell:
    shell: true
scenarios:
  - id: long
    label: Long
    flow: main
flows:
  main:
    id: main
    steps:
      - id: slow
        type: command
        defaults:
          preset: shell
          warnAfterMs: 0
        commands:
          - run: echo "slow"
`,
		);

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: "slow" }),
		);

		await runDevWizard({
			configPath,
			scenario: "long",
			dryRun: false,
			logFile: undefined,
			quiet: false,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		const noteCall = promptMocks.note.mock.calls.at(-1);
		expect(noteCall).toBeDefined();
		const [message] = noteCall!;
		if (typeof message !== "string") {
			throw new Error("Expected summary note message to be a string");
		}
		expect(message).toContain("long-running commands:");
	});

	it("includes timed-out commands in the summary", async () => {
		const configPath = path.join(tmpDir, "timed-out.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Timeout
  version: 1.0.0
scenarios:
  - id: timeout
    label: Timeout
    flow: main
flows:
  main:
    id: main
    steps:
      - id: timeout-step
        type: command
        commands:
          - run: pnpm timeout
            timeoutMs: 10
`,
		);

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createFailure({ message: "timed out", timedOut: true }),
		);

		const result = await runDevWizard({
			configPath,
			scenario: "timeout",
			dryRun: false,
			logFile: undefined,
			quiet: false,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		expect(result.exitCode).toBe(1);
		const noteCall = promptMocks.note.mock.calls.at(-1);
		expect(noteCall).toBeDefined();
		const [message] = noteCall!;
		if (typeof message !== "string") {
			throw new Error("Expected summary note message to be a string");
		}
		expect(message).toContain("timed-out commands:");
	});

	it("records retries and skips for the sample wizard flow", async () => {
		const originalCwd = process.cwd();
		const sampleConfigPath = path.resolve(
			originalCwd,
			"../dev-wizard-core/examples/sample.wizard.yaml",
		);

		execaMocks.execaCommand
			.mockImplementationOnce(() => execaMocks.createProcess({ stdout: "hello" }))
			.mockImplementationOnce(() =>
				execaMocks.createFailure({
					message: "failure",
					exitCode: 1,
				}),
			)
			.mockImplementationOnce(() =>
				execaMocks.createFailure({
					message: "failure-again",
					exitCode: 1,
				}),
			)
			.mockImplementationOnce(() =>
				execaMocks.createProcess({ stdout: "post-run" }),
			);

		textPromptMock.createTextPromptWithHistory.mockResolvedValueOnce("Casey");
		promptMocks.select
			.mockImplementationOnce(async () => "retry")
			.mockImplementationOnce(async () => "finish");

		const restoreTty = stubInteractiveTty();
		process.chdir(tmpDir);
		try {
			const result = await runDevWizard({
				configPath: sampleConfigPath,
				scenario: "hello-world",
				dryRun: false,
				logFile: undefined,
				quiet: false,
				verbose: false,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});

			expect(result.exitCode).toBe(1);
			expect(result.state).toBeDefined();
			const state = result.state!;
			expect(state.retries.length).toBeGreaterThan(0);
			expect(state.autoActionCounts["hello-flow:failing-command"]).toBe(2);
			expect(state.skippedSteps.length).toBe(0);
			expect(promptMocks.select).not.toHaveBeenCalled();

			const summaryCall = promptMocks.note.mock.calls.find(
				([message, title]) =>
					typeof title === "string" &&
					title.includes("Wizard Summary") &&
					typeof message === "string",
			);

			expect(summaryCall).toBeDefined();

			const summaryMessage = summaryCall?.[0] as string | undefined;
			expect(summaryMessage).toContain("retries: failing-command");
		} finally {
			process.chdir(originalCwd);
			restoreTty();
		}
	});

	it("includes actionable commands and links in recommendation notes", async () => {
		const configPath = path.join(tmpDir, "auto-links.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Links
  version: 1.0.0
scenarios:
  - id: links
    label: Links
    flow: main
flows:
  main:
    id: main
    steps:
      - id: failing
        type: command
        commands:
          - run: pnpm failure
        onError:
          recommendation: Review the troubleshooting steps.
          commands:
            - label: Fix deployment
              command: pnpm fix
          links:
            - label: Failure guide
              url: https://example.com/failure
          actions:
            - label: Abort
              next: exit
`,
		);

			execaMocks.execaCommand.mockImplementationOnce(() =>
				execaMocks.createFailure({ message: "boom" }),
			);
			promptMocks.select.mockImplementationOnce(async () => "exit");
			const streams = createCapturedStreams();

			const result = await runDevWizard({
				configPath,
				scenario: "links",
				dryRun: false,
				logFile: undefined,
				quiet: false,
				verbose: false,
				stdout: streams.stdout,
				stderr: streams.stderr,
			});

			expect(result.exitCode).toBe(1);

			const stderr = streams.getStderr();
			expect(stderr).toContain("Recommendation:");
			expect(stderr).toContain("Review the troubleshooting steps.");
			expect(stderr).toContain("Commands:");
			expect(stderr).toContain("Fix deployment: pnpm fix");
			expect(stderr).toContain("Links:");
			expect(stderr).toContain("Failure guide: https://example.com/failure");
	});

		it("records a skip when the skip action option is selected", async () => {
			const restoreTty = stubInteractiveTty();
			const configPath = path.join(tmpDir, "skip-action.yaml");
			await fs.writeFile(
				configPath,
				[
					"meta:",
					"  name: Skip Action",
					"  version: 1.0.0",
					"scenarios:",
					"  - id: skip",
					"    label: Skip Action",
					"    flow: main",
					"flows:",
					"  main:",
					"    id: main",
					"    steps:",
					"      - id: failing",
					"        type: command",
					"        commands:",
					"          - run: pnpm exec nope",
					"        onError:",
					"          actions:",
					"            - label: Continue anyway",
					"              next: cleanup",
					"      - id: cleanup",
					"        type: message",
					"        text: Done",
					"",
				].join("\n"),
			);

			execaMocks.execaCommand.mockImplementationOnce(() =>
				execaMocks.createFailure({ message: "boom" }),
			);
			promptMocks.select.mockResolvedValueOnce(SKIP_STEP_OPTION_VALUE);

			let result: Awaited<ReturnType<typeof runDevWizard>>;
			try {
				result = await runDevWizard({
					configPath,
					scenario: "skip",
					dryRun: false,
					logFile: undefined,
					quiet: false,
					verbose: false,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
				});
			} finally {
				restoreTty();
			}

			expect(result.exitCode).toBe(1);
			expect(result.state?.skippedSteps).toHaveLength(1);
			expect(result.state?.skippedSteps[0]?.stepId).toBe("failing");
			const summaryCall = promptMocks.note.mock.calls.find(
			([summary, title]) =>
				typeof title === "string" &&
				title.includes("Wizard Summary") &&
				typeof summary === "string",
		);
		expect(summaryCall).toBeDefined();
		const summaryMessage = summaryCall?.[0] as string | undefined;
		expect(summaryMessage).toContain("skips: failing");
	});

	it("hides captured stdout snippets in quiet mode", async () => {
		const configPath = path.join(tmpDir, "captured-quiet.yaml");
		await fs.writeFile(
			configPath,
			`meta:
  name: Captured Quiet
  version: 1.0.0
scenarios:
  - id: capture
    label: Capture
    flow: main
flows:
  main:
    id: main
    steps:
      - id: capture-command
        type: command
        commands:
          - run: echo "captured"
            captureStdout: true
`,
		);

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({
				stdout: "quiet mode output",
			}),
		);

		await runDevWizard({
			configPath,
			scenario: "capture",
			dryRun: false,
			logFile: undefined,
			quiet: true,
			verbose: false,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});

		const noteCall = promptMocks.note.mock.calls.at(-1);
		expect(noteCall).toBeDefined();
		const [message] = noteCall!;
		if (typeof message !== "string") {
			throw new Error("Expected summary note message to be a string");
		}
		expect(message).toContain("captured output stored for 1 command");
		expect(message).toContain("hidden in quiet mode");
		expect(message).not.toContain("quiet mode output");
	});

	it("rejects when quiet and verbose flags are combined", async () => {
		const configPath = path.join(tmpDir, "quiet-verbose.yaml");
		await fs.writeFile(
			configPath,
			`meta:\n  name: Test\n  version: 1.0.0\nscenarios:\n  - id: demo\n    label: Demo\n    flow: main\nflows:\n  main:\n    id: main\n    steps:\n      - id: noop\n        type: message\n        level: info\n        text: noop\n`,
		);

		await expect(
			runDevWizard({
				configPath,
				scenario: "demo",
				dryRun: false,
				logFile: undefined,
				quiet: true,
				verbose: true,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			}),
		).rejects.toThrow(/quiet and verbose/i);
	});
});

describe("git-worktree-guard step", () => {
	it("skips guard when the working tree is clean", async () => {
		const config: DevWizardConfig = {
			meta: { name: "git-guard", version: "1.0.0" },
			scenarios: [{ id: "guard", label: "Guard", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "guard",
							type: "git-worktree-guard",
						},
					],
				},
			},
		};

		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: "" }),
		);

		const plan = await buildScenarioPlan(
			{
				config,
				scenarioId: "guard",
				repoRoot: tmpDir,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				dryRun: false,
				quiet: false,
				verbose: false,
				overrides: {},
				logWriter: undefined,
				promptOptionsCache: new Map(),
				checkpoint: undefined,
			},
			{},
		);

	const guardPlan = plan.flows[0]!.steps[0] as any;
	expect(guardPlan.kind).toBe("git-worktree-guard");
	expect(guardPlan.status).toBe("clean");
	expect(plan.pendingPromptCount).toBe(0);

	execaMocks.execaCommand.mockImplementationOnce(() =>
	execaMocks.createProcess({ stdout: "" }),
);

		await executeScenario({
			config,
			scenarioId: "guard",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {},
		});

		expect(execaMocks.execa).not.toHaveBeenCalled();
	});

	it("commits and pushes when the strategy override requests commit+push", async () => {
		const config: DevWizardConfig = {
			meta: { name: "git-guard", version: "1.0.0" },
			scenarios: [{ id: "guard", label: "Guard", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "guard",
							type: "git-worktree-guard",
							storeStrategyAs: "guardStrategy",
							storeCommitMessageAs: "guardCommitMessage",
						},
					],
				},
			},
		};

		const gitCalls: string[] = [];
		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: " M package.json" }),
		);
		execaMocks.execa.mockImplementation((...callArgs: unknown[]) => {
			const [cmd, args] = callArgs as [string, string[]];
			gitCalls.push(`${cmd} ${args.join(" ")}`);
			return execaMocks.createProcess();
		});

		await executeScenario({
			config,
			scenarioId: "guard",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {
				guardStrategy: "commit-push",
				guardCommitMessage: "automation cleanup",
			},
		});

		expect(gitCalls).toEqual([
			"git add -A",
			"git commit -m automation cleanup",
			"git push",
		]);
	});

	it("sets the upstream when commit+push strategy runs on a branch without upstream", async () => {
		const config: DevWizardConfig = {
			meta: { name: "git-guard", version: "1.0.0" },
			scenarios: [{ id: "guard", label: "Guard", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "guard",
							type: "git-worktree-guard",
							storeStrategyAs: "guardStrategy",
							storeCommitMessageAs: "guardCommitMessage",
						},
					],
				},
			},
		};

		const gitCalls: string[] = [];
		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: " M package.json" }),
		);
		execaMocks.execa.mockImplementation((...callArgs: unknown[]) => {
			const [cmd, args] = callArgs as [string, string[]];
			const commandText = `${cmd} ${args.join(" ")}`.trim();
			gitCalls.push(commandText);
			if (commandText === "git push") {
				return execaMocks.createFailure({
					message: "fatal: The current branch feature/automation has no upstream branch.",
				});
			}
			if (commandText === "git rev-parse --abbrev-ref HEAD") {
				return execaMocks.createProcess({ stdout: "feature/automation\n" });
			}
			if (commandText === "git config --get branch.feature/automation.remote") {
				return execaMocks.createFailure({ message: "fatal: no such section" });
			}
			if (commandText === "git remote") {
				return execaMocks.createProcess({ stdout: "origin\n" });
			}
			return execaMocks.createProcess();
		});

		await executeScenario({
			config,
			scenarioId: "guard",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {
				guardStrategy: "commit-push",
				guardCommitMessage: "automation cleanup",
			},
		});

		expect(gitCalls).toEqual([
			"git add -A",
			"git commit -m automation cleanup",
			"git push",
			"git rev-parse --abbrev-ref HEAD",
			"git config --get branch.feature/automation.remote",
			"git remote",
			"git push --set-upstream origin feature/automation",
		]);
	});

	it("stashes changes when the user selects the stash strategy", async () => {
		const config: DevWizardConfig = {
			meta: { name: "git-guard", version: "1.0.0" },
			scenarios: [{ id: "guard", label: "Guard", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "guard",
							type: "git-worktree-guard",
							storeStrategyAs: "guardStrategy",
							storeStashMessageAs: "guardStashMessage",
						},
					],
				},
			},
		};

		const gitCalls: string[] = [];
		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: " M package.json" }),
		);
		execaMocks.execa.mockImplementation((...callArgs: unknown[]) => {
			const [cmd, args] = callArgs as [string, string[]];
			gitCalls.push(`${cmd} ${args.join(" ")}`);
			return execaMocks.createProcess();
		});
		promptMocks.select.mockImplementationOnce(async () => "stash");
		textPromptMock.createTextPromptWithHistory.mockImplementationOnce(async () => "stash guard");

		await executeScenario({
			config,
			scenarioId: "guard",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {},
		});

		expect(gitCalls).toEqual([
			"git stash push --include-untracked -m stash guard",
		]);
	});

	it("creates a branch and commits when the strategy override requests branch", async () => {
		const config: DevWizardConfig = {
			meta: { name: "git-guard", version: "1.0.0" },
			scenarios: [{ id: "guard", label: "Guard", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "guard",
							type: "git-worktree-guard",
							allowBranch: true,
							storeStrategyAs: "guardStrategy",
							storeBranchNameAs: "guardBranchName",
							storeCommitMessageAs: "guardCommitMessage",
						},
					],
				},
			},
		};

		const gitCalls: string[] = [];
		execaMocks.execaCommand.mockImplementationOnce(() =>
			execaMocks.createProcess({ stdout: " M package.json" }),
		);
		execaMocks.execa.mockImplementation((...callArgs: unknown[]) => {
			const [cmd, args] = callArgs as [string, string[]];
			gitCalls.push(`${cmd} ${args.join(" ")}`);
			return execaMocks.createProcess();
		});

		await executeScenario({
			config,
			scenarioId: "guard",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {
				guardStrategy: "branch",
				guardBranchName: "feature/automation",
				guardCommitMessage: "automation cleanup",
			},
		});

		expect(gitCalls).toEqual([
			"git switch -c feature/automation",
			"git add -A",
			"git commit -m automation cleanup",
			"git push",
		]);
	});

	it("prefills persisted answers but still prompts interactively", async () => {
		const config: DevWizardConfig = {
			meta: { name: "persisted-prompts", version: "1.0.0" },
			scenarios: [{ id: "persisted", label: "Persisted", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "ask-name",
							type: "prompt",
							mode: "input",
							prompt: "What is your name?",
							storeAs: "name",
							persist: true,
						},
					],
				},
			},
		};

		const initialPersistence = await createPromptPersistenceManager({
			repoRoot: tmpDir,
			scenarioId: "persisted",
		});

		await executeScenario({
			config,
			scenarioId: "persisted",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {
				name: "Alice",
			},
			promptPersistence: initialPersistence,
		});
		await initialPersistence.save();

		textPromptMock.createTextPromptWithHistory.mockClear();
	textPromptMock.createTextPromptWithHistory.mockImplementationOnce(
		async (...args: unknown[]) => {
			const [options] = args as Array<{ initialValue?: string } | undefined>;
			expect(options?.initialValue).toBe("Alice");
			return options?.initialValue ?? "Bob";
		},
	);

		const reloadedPersistence = await createPromptPersistenceManager({
			repoRoot: tmpDir,
			scenarioId: "persisted",
		});

		await executeScenario({
			config,
			scenarioId: "persisted",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {},
			promptPersistence: reloadedPersistence,
		});
		await reloadedPersistence.save();

		expect(textPromptMock.createTextPromptWithHistory).toHaveBeenCalledTimes(1);
	});

	it("emits prompt persistence hit events when cached answers are applied", async () => {
		const config: DevWizardConfig = {
			meta: { name: "persisted-prompts", version: "1.0.0" },
			scenarios: [{ id: "persisted", label: "Persisted", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "ask-name",
							type: "prompt",
							mode: "input",
							prompt: "What is your name?",
							storeAs: "name",
							persist: true,
						},
					],
				},
			},
		};

		const persistence = await createPromptPersistenceManager({
			repoRoot: tmpDir,
			scenarioId: "persisted",
		});
		persistence.set({ scope: "scenario", key: "name" }, "Alice");

		const events: WizardLogEvent[] = [];

		await executeScenario({
			config,
			scenarioId: "persisted",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {},
			promptPersistence: persistence,
			usePromptPersistenceAnswers: true,
			logWriter: {
				write(event: WizardLogEvent) {
					events.push(event);
				},
				async close() {},
			},
		});

		const persistenceEvent = events.find(
			(event): event is Extract<WizardLogEvent, { type: "prompt.persistence" }> =>
				event.type === "prompt.persistence",
		);
		expect(persistenceEvent).toBeDefined();
		expect(persistenceEvent).toMatchObject({
			type: "prompt.persistence",
			key: "name",
			scope: "scenario",
			status: "hit",
			applied: true,
		});
	});

	it("emits prompt persistence miss events when no cached answer exists", async () => {
		const config: DevWizardConfig = {
			meta: { name: "persisted-prompts", version: "1.0.0" },
			scenarios: [{ id: "persisted", label: "Persisted", flow: "main" }],
			flows: {
				main: {
					id: "main",
					steps: [
						{
							id: "ask-name",
							type: "prompt",
							mode: "input",
							prompt: "What is your name?",
							storeAs: "name",
							persist: true,
						},
					],
				},
			},
		};

		const persistence = await createPromptPersistenceManager({
			repoRoot: tmpDir,
			scenarioId: "persisted",
		});

		const events: WizardLogEvent[] = [];
		textPromptMock.createTextPromptWithHistory.mockResolvedValueOnce("Bob");

		await executeScenario({
			config,
			scenarioId: "persisted",
			repoRoot: tmpDir,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			dryRun: false,
			quiet: false,
			verbose: false,
			overrides: {},
			promptPersistence: persistence,
			usePromptPersistenceAnswers: true,
			logWriter: {
				write(event: WizardLogEvent) {
					events.push(event);
				},
				async close() {},
			},
		});

		const persistenceEvent = events.find(
			(event): event is Extract<WizardLogEvent, { type: "prompt.persistence" }> =>
				event.type === "prompt.persistence",
		);
		expect(persistenceEvent).toBeDefined();
		expect(persistenceEvent).toMatchObject({
			type: "prompt.persistence",
			status: "miss",
			scope: "scenario",
			key: "name",
		});
		expect(persistenceEvent).not.toHaveProperty("applied");
	});
});
