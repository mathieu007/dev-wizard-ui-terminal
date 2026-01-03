import type { DevWizardRunResult } from "@dev-wizard/engine";
import {
	createMaintenanceOptions,
	createProjectsOrchestratorOptions,
	createWorkspaceOptions,
	type MaintenanceWizardOptions,
	type ProjectsOrchestratorOptions,
	type WorkspaceWizardOptions,
} from "@dev-wizard/engine";
import { runDevWizard } from "./runDevWizard.js";

export async function runProjectsOrchestrator(
	options?: ProjectsOrchestratorOptions,
): Promise<DevWizardRunResult> {
	const wizardOptions = await createProjectsOrchestratorOptions(options);
	return runDevWizard(wizardOptions);
}

export async function runMaintenanceWizard(
	options?: MaintenanceWizardOptions,
): Promise<DevWizardRunResult> {
	const wizardOptions = await createMaintenanceOptions(options);
	return runDevWizard(wizardOptions);
}

export async function runWorkspaceWizard(
	options?: WorkspaceWizardOptions,
): Promise<DevWizardRunResult> {
	const wizardOptions = await createWorkspaceOptions(options);
	return runDevWizard(wizardOptions);
}
