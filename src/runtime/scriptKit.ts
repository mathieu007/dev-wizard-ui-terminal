import type { DevWizardRunResult } from "@dev-wizard/engine";
import {
	createMaintenanceOptions,
	createProjectsOrchestratorOptions,
	type MaintenanceWizardOptions,
	type ProjectsOrchestratorOptions,
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
