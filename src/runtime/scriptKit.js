import { createMaintenanceOptions, createProjectsOrchestratorOptions, createWorkspaceOptions, } from "@dev-wizard/engine";
import { runDevWizard } from "./runDevWizard.js";
export async function runProjectsOrchestrator(options) {
    const wizardOptions = await createProjectsOrchestratorOptions(options);
    return runDevWizard(wizardOptions);
}
export async function runMaintenanceWizard(options) {
    const wizardOptions = await createMaintenanceOptions(options);
    return runDevWizard(wizardOptions);
}
export async function runWorkspaceWizard(options) {
    const wizardOptions = await createWorkspaceOptions(options);
    return runDevWizard(wizardOptions);
}
//# sourceMappingURL=scriptKit.js.map