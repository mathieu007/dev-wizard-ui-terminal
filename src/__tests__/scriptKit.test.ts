import { describe, expect, test, vi } from "vitest";
import type { DevWizardOptions, DevWizardRunResult } from "@dev-wizard/engine";

const engineMocks = vi.hoisted(() => ({
	createProjectsOrchestratorOptions: vi.fn(async () => ({
		configPath: "/repo/projects.yaml",
		scenario: "multi-project-orchestration",
		overrides: { selectedProjects: ["packages/app"] },
	} as DevWizardOptions)),
	createMaintenanceOptions: vi.fn(async () => ({
		configPath: "/repo/maintenance.yaml",
		scenario: "maintenance-window",
		overrides: { maintenanceTasks: ["clean-cache"] },
	} as DevWizardOptions)),
}));

vi.mock("@dev-wizard/engine", () => ({
	createProjectsOrchestratorOptions: engineMocks.createProjectsOrchestratorOptions,
	createMaintenanceOptions: engineMocks.createMaintenanceOptions,
}));

const runDevWizardMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime/runDevWizard.js", () => ({
	runDevWizard: runDevWizardMock,
}));

import {
	runMaintenanceWizard,
	runProjectsOrchestrator,
} from "../runtime/scriptKit.js";

describe("ui terminal script kit", () => {
	test("runProjectsOrchestrator delegates to runDevWizard", async () => {
		runDevWizardMock.mockResolvedValue({ exitCode: 0 } as DevWizardRunResult);

		await runProjectsOrchestrator({ projects: ["packages/app"] });

		expect(engineMocks.createProjectsOrchestratorOptions).toHaveBeenCalled();
		expect(runDevWizardMock).toHaveBeenCalledWith(
			expect.objectContaining({
				configPath: "/repo/projects.yaml",
				scenario: "multi-project-orchestration",
				overrides: { selectedProjects: ["packages/app"] },
			}),
		);
	});

	test("runMaintenanceWizard delegates to runDevWizard", async () => {
		runDevWizardMock.mockResolvedValue({ exitCode: 0 } as DevWizardRunResult);

		await runMaintenanceWizard({ overrides: { maintenanceTasks: ["clean-cache"] } });

		expect(engineMocks.createMaintenanceOptions).toHaveBeenCalled();
		expect(runDevWizardMock).toHaveBeenCalledWith(
			expect.objectContaining({
				configPath: "/repo/maintenance.yaml",
				scenario: "maintenance-window",
				overrides: { maintenanceTasks: ["clean-cache"] },
			}),
		);
	});
});
