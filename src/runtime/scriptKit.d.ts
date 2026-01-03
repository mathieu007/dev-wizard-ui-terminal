import type { DevWizardRunResult } from "@dev-wizard/engine";
import { type MaintenanceWizardOptions, type ProjectsOrchestratorOptions, type WorkspaceWizardOptions } from "@dev-wizard/engine";
export declare function runProjectsOrchestrator(options?: ProjectsOrchestratorOptions): Promise<DevWizardRunResult>;
export declare function runMaintenanceWizard(options?: MaintenanceWizardOptions): Promise<DevWizardRunResult>;
export declare function runWorkspaceWizard(options?: WorkspaceWizardOptions): Promise<DevWizardRunResult>;
