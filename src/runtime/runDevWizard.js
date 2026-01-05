import { intro, outro, log, select, isCancel, cancel, note, confirm, text, } from "@clack/prompts";
import chalk from "chalk";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { loadConfig } from "@ScaffoldStack/dev-wizard-engine/loader/configLoader.js";
import { INDEX_FILENAMES, ROOT_CONFIG_CANDIDATES, resolveConfigPaths, } from "@ScaffoldStack/dev-wizard-engine/loader/configResolver.js";
import { buildScenarioPlan, executeScenario, WizardExecutionError, } from "@ScaffoldStack/dev-wizard-engine/runtime/executor.js";
import { ClackPromptDriver } from "./clackPromptDriver.js";
import { NonInteractivePromptDriver } from "@ScaffoldStack/dev-wizard-engine/runtime/promptDriver.js";
import { createLogWriter, createStreamLogWriter } from "@ScaffoldStack/dev-wizard-engine/runtime/logWriter.js";
import { createOtlpLogWriter } from "@ScaffoldStack/dev-wizard-engine/runtime/telemetry/otlpExporter.js";
import { createPolicyEngine } from "@ScaffoldStack/dev-wizard-engine/runtime/policyEngine.js";
import { createCheckpointManager, loadCheckpoint, } from "@ScaffoldStack/dev-wizard-engine/runtime/checkpoints.js";
import { formatScenarioPlanNdjson, formatScenarioPlanJson, formatScenarioPlanPretty, } from "@ScaffoldStack/dev-wizard-engine/runtime/planFormatter.js";
import { loadPlugins } from "@ScaffoldStack/dev-wizard-engine/runtime/plugins.js";
import { createPromptHistoryManager } from "@ScaffoldStack/dev-wizard-engine/runtime/promptHistory.js";
import { createPromptPersistenceManager, sanitizePersistenceSegment, } from "@ScaffoldStack/dev-wizard-engine/runtime/promptPersistence.js";
import { summarizeCapturedOutput } from "@ScaffoldStack/dev-wizard-engine/runtime/capturedOutput.js";
import { readManifest, writeManifest, } from "@ScaffoldStack/dev-wizard-engine/runtime/manifest.js";
import corePackage from "../../package.json" with { type: "json" };
const CORE_VERSION = typeof corePackage.version === "string" ? corePackage.version : "0.0.0";
export async function runDevWizard(options) {
    intro(chalk.cyan("Dev Wizard"));
    const interactiveTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    let repoRoot = process.cwd();
    const registerManifestPath = options.registerManifestPath
        ? path.isAbsolute(options.registerManifestPath)
            ? options.registerManifestPath
            : path.resolve(repoRoot, options.registerManifestPath)
        : undefined;
    const executeManifestPath = options.executeManifestPath
        ? path.isAbsolute(options.executeManifestPath)
            ? options.executeManifestPath
            : path.resolve(repoRoot, options.executeManifestPath)
        : undefined;
    if (registerManifestPath && executeManifestPath) {
        handleFatalError(new Error("Cannot register and execute a manifest in the same run."), "Invalid manifest options");
        return { exitCode: 1 };
    }
    let manifestRecord;
    if (executeManifestPath) {
        try {
            manifestRecord = await readManifest(executeManifestPath);
        }
        catch (error) {
            handleFatalError(error instanceof Error ? error : new Error(String(error)), "Failed to read manifest");
            return { exitCode: 1 };
        }
        options.scenario = manifestRecord.scenarioId;
        const manifestConfigPaths = manifestRecord.configPaths.map((entry) => path.isAbsolute(entry) ? entry : path.resolve(manifestRecord.repoRoot, entry));
        options.configPath = manifestConfigPaths;
        if (!options.environment && manifestRecord.environment) {
            options.environment = manifestRecord.environment;
        }
        if (manifestRecord.answers && Object.keys(manifestRecord.answers).length > 0) {
            const manifestOverrides = structuredClone(manifestRecord.answers);
            options.overrides = options.overrides
                ? Object.assign({}, manifestOverrides, options.overrides)
                : manifestOverrides;
        }
        options.loadPersistedAnswers = true;
        options.answersPathUsed = manifestRecord.filePath;
    }
    if (manifestRecord) {
        const recordedRoot = path.resolve(manifestRecord.repoRoot);
        if (!options.manifestForce && recordedRoot !== repoRoot) {
            handleFatalError(new Error(`Manifest was recorded from ${recordedRoot}, but the current working directory is ${repoRoot}. Run from the original root or pass --force to override.`), "Manifest validation failed");
            return { exitCode: 1 };
        }
    }
    const manifestMode = registerManifestPath
        ? "register"
        : manifestRecord
            ? "manifest"
            : undefined;
    const executionMode = manifestMode ?? "standard";
    const isRegisterMode = executionMode === "register";
    if (isRegisterMode) {
        if (options.plan || options.planOnly || options.dryRun) {
            log.warn("Manifest registration ignores --plan, --plan-only, and --dry-run flags because commands are never executed during capture.");
        }
    }
    let config;
    let logWriter;
    let scenario;
    let result;
    let configResolution;
    let resumeState;
    let checkpointManager;
    let promptPersistence;
    const effectiveEnvironment = options.environment ?? process.env.DEV_WIZARD_ENV;
    try {
        configResolution = await resolveConfigPaths({
            cwd: repoRoot,
            explicitPaths: options.configPath,
            environment: effectiveEnvironment,
        });
    }
    catch (error) {
        handleFatalError(error instanceof Error ? error : new Error(String(error)), "Failed to resolve configuration");
        throw error;
    }
    if (configResolution.errors.length > 0) {
        handleFatalError(new Error(configResolution.errors.join("\n")), "Configuration resolution failed");
        return { exitCode: 1 };
    }
    if (configResolution.paths.length === 0 &&
        !options.configPath &&
        !interactiveTty) {
        const defaultSelection = await resolveDefaultConfigPathWithFallback(repoRoot);
        if (defaultSelection) {
            repoRoot = defaultSelection.repoRoot;
            options.configPath = defaultSelection.path;
            log.info(`Using ${chalk.cyan(relativeToRepo(repoRoot, defaultSelection.path))} for this run.`);
            configResolution = await resolveConfigPaths({
                cwd: repoRoot,
                explicitPaths: options.configPath,
                environment: effectiveEnvironment,
            });
        }
    }
    if (configResolution.paths.length === 0) {
        if (!interactiveTty) {
            handleFatalError(new Error("No Dev Wizard configuration files were found. Add a config file or provide --config <path>."), "No configuration found");
            return { exitCode: 1 };
        }
        try {
            const selection = await resolveConfigPathWithFallback(repoRoot);
            if (!selection) {
                handleFatalError(new Error("No Dev Wizard configuration files were found. Add a config file or provide --config <path>."), "No configuration found");
                return { exitCode: 1 };
            }
            repoRoot = selection.repoRoot;
            options.configPath = selection.path;
            configResolution = await resolveConfigPaths({
                cwd: repoRoot,
                explicitPaths: options.configPath,
                environment: effectiveEnvironment,
            });
        }
        catch (error) {
            if (error instanceof ConfigPickerCancelledError) {
                return { exitCode: 0 };
            }
            handleFatalError(error instanceof Error ? error : new Error(String(error)), "Failed to resolve configuration");
            return { exitCode: 1 };
        }
        if (configResolution.errors.length > 0) {
            handleFatalError(new Error(configResolution.errors.join("\n")), "Configuration resolution failed");
            return { exitCode: 1 };
        }
    }
    if (options.explainConfig) {
        const details = formatConfigResolution(configResolution, repoRoot);
        note(details, "Configuration resolution");
    }
    if (configResolution.paths.length === 0) {
        handleFatalError(new Error("No Dev Wizard configuration files were found. Add a config file or provide --config <path>."), "No configuration found");
        return { exitCode: 1 };
    }
    const relativeConfigPaths = configResolution.paths.map((entry) => relativeToRepo(repoRoot, entry));
    const configWarnings = [];
    try {
        config = await loadConfig({
            configPaths: configResolution.paths,
            cwd: repoRoot,
            onWarning: (warning) => {
                configWarnings.push(warning);
            },
        });
    }
    catch (error) {
        handleFatalError(error instanceof Error ? error : new Error(String(error)), "Failed to load configuration");
        throw error;
    }
    const configHash = createConfigHash(config);
    for (const warning of configWarnings) {
        log.warn(warning);
    }
    if (manifestRecord) {
        const mismatches = [];
        if (manifestRecord.configHash !== configHash) {
            mismatches.push(`Config hash changed (expected ${manifestRecord.configHash}, found ${configHash}).`);
        }
        if (manifestRecord.coreVersion &&
            manifestRecord.coreVersion !== CORE_VERSION) {
            mismatches.push(`Core version changed (expected ${manifestRecord.coreVersion}, found ${CORE_VERSION}).`);
        }
        if (manifestRecord.cliVersion &&
            options.clientVersion &&
            manifestRecord.cliVersion !== options.clientVersion) {
            mismatches.push(`CLI version changed (expected ${manifestRecord.cliVersion}, found ${options.clientVersion}).`);
        }
        if (mismatches.length > 0) {
            if (options.manifestForce) {
                for (const mismatch of mismatches) {
                    log.warn(`${mismatch} Continuing due to --force.`);
                }
            }
            else {
                handleFatalError(new Error(`Manifest no longer matches the workspace. ${mismatches.join(" ")}`), "Manifest validation failed");
                return { exitCode: 1 };
            }
        }
    }
    if (effectiveEnvironment) {
        log.info(`Environment overlay: ${chalk.cyan(effectiveEnvironment)}`);
    }
    let pluginRegistryResult;
    try {
        pluginRegistryResult = await loadPlugins(config.plugins, { repoRoot });
    }
    catch (error) {
        handleFatalError(error instanceof Error ? error : new Error(String(error)), "Failed to load Dev Wizard plugins");
        throw error;
    }
    for (const warning of pluginRegistryResult.warnings) {
        log.warn(warning);
    }
    if (options.resumeFrom) {
        try {
            const resume = await loadCheckpoint({
                repoRoot,
                identifier: options.resumeFrom,
            });
            resumeState = resume.state;
            if (options.scenario && options.scenario !== resumeState.scenario.id) {
                handleFatalError(new Error(`Resume checkpoint scenario (${resumeState.scenario.id}) does not match requested scenario (${options.scenario}).`), "Checkpoint scenario mismatch");
                return { exitCode: 1 };
            }
            options.scenario = resumeState.scenario.id;
        }
        catch (error) {
            handleFatalError(error instanceof Error ? error : new Error(String(error)), "Failed to load checkpoint");
            throw error;
        }
    }
    if (options.listScenarios) {
        listScenarios(config);
        outro(chalk.green("Scenarios listed."));
        return { exitCode: 0 };
    }
    if (options.quiet && options.verbose) {
        handleFatalError(new Error("Cannot enable --quiet and --verbose at the same time."), "Invalid flag combination");
        throw new Error("Invalid CLI flags: quiet and verbose are mutually exclusive.");
    }
    const logWriters = [];
    try {
        if (options.logFile) {
            try {
                logWriters.push(createLogWriter(options.logFile));
            }
            catch (error) {
                handleFatalError(error instanceof Error ? error : new Error(String(error)), "Unable to open log file");
                throw error;
            }
        }
        if (options.logNdjson) {
            logWriters.push(createStreamLogWriter(options.stdout ?? process.stdout, {
                redactPromptValues: true,
                redactCommandOutput: true,
            }));
        }
        if (options.logOtlpEndpoint) {
            logWriters.push(createOtlpLogWriter({
                endpoint: options.logOtlpEndpoint,
                headers: options.logOtlpHeaders,
                serviceName: options.logOtlpServiceName,
                scopeName: options.logOtlpScopeName,
                resourceAttributes: options.logOtlpResourceAttributes,
            }));
        }
        if (logWriters.length === 1) {
            logWriter = logWriters[0];
        }
        else if (logWriters.length > 1) {
            logWriter = {
                write(event) {
                    for (const writer of logWriters) {
                        writer.write(event);
                    }
                },
                async close() {
                    let firstError;
                    for (const writer of logWriters) {
                        try {
                            await writer.close();
                        }
                        catch (error) {
                            if (!firstError) {
                                firstError = error;
                            }
                        }
                    }
                    if (firstError) {
                        throw firstError;
                    }
                },
            };
        }
        scenario = await resolveScenario(config, options);
    }
    catch (error) {
        handleFatalError(error instanceof Error ? error : new Error(String(error)), "Unable to select scenario");
        await logWriter?.close().catch(() => undefined);
        throw error;
    }
    log.info(`Running scenario ${chalk.cyan(scenario.label)} ${chalk.gray(`(${scenario.id})`)}.`);
    const resolvedOverrides = options.overrides
        ? structuredClone(options.overrides)
        : {};
    const policyEngine = createPolicyEngine({
        config: config.policies,
        acknowledgedRuleIds: options.policyAcks,
    });
    const promptHistory = createPromptHistoryManager({
        storagePath: path.join(repoRoot, ".dev-wizard", "prompt-history.json"),
    });
    let identitySelection;
    const resolvedAnswersPath = options.answersPathUsed && options.answersPathUsed !== "-"
        ? path.isAbsolute(options.answersPathUsed)
            ? options.answersPathUsed
            : path.resolve(repoRoot, options.answersPathUsed)
        : undefined;
    try {
        identitySelection = await resolveWizardIdentitySelection({
            repoRoot,
            scenario,
            providedSlug: options.answersIdentity,
            providedSegments: options.answersIdentitySegments,
            providedSegmentDetails: options.answersIdentitySegmentDetails,
            usingExternalAnswers: Boolean(options.loadPersistedAnswers),
            interactive: interactiveTty,
        });
    }
    catch (error) {
        if (error instanceof IdentityPromptCancelledError) {
            await logWriter?.close().catch(() => undefined);
            await promptHistory.close().catch(() => undefined);
            return { exitCode: 0 };
        }
        throw error;
    }
    if (identitySelection) {
        log.info(`Using answers identity ${chalk.cyan(identitySelection.slug)} for this run.`);
    }
    let answersAlias = scenario.id;
    let persistencePath;
    const persistenceMetadata = {
        scenarioId: scenario.id,
    };
    const executionMetadata = resolveExecutionMetadata(options);
    if (executionMetadata) {
        persistenceMetadata.execution = executionMetadata;
    }
    if (identitySelection) {
        persistenceMetadata.identity = {
            slug: identitySelection.slug,
            segments: identitySelection.segments.map((segment) => ({
                id: segment.id,
                value: segment.value,
                label: segment.label,
                details: segment.details ? { ...segment.details } : undefined,
            })),
        };
    }
    if (resolvedAnswersPath) {
        persistencePath = resolvedAnswersPath;
        const derivedAlias = path.basename(resolvedAnswersPath, path.extname(resolvedAnswersPath));
        if (derivedAlias && derivedAlias.trim().length > 0) {
            answersAlias = derivedAlias.trim();
        }
    }
    else if (identitySelection) {
        answersAlias = `${scenario.id}/${identitySelection.slug}`;
        persistencePath = buildIdentityAnswersPath(repoRoot, scenario.id, identitySelection);
    }
    else if (!options.loadPersistedAnswers) {
        if (interactiveTty) {
            const selectedAlias = await text({
                message: "Name for the answers file (stored under .dev-wizard/answers/<name>.json):",
                initialValue: scenario.id,
                placeholder: scenario.id,
            });
            if (isCancel(selectedAlias)) {
                cancel("Execution cancelled before collecting answers.");
                await logWriter?.close().catch(() => undefined);
                await promptHistory.close().catch(() => undefined);
                return { exitCode: 0 };
            }
            const trimmed = selectedAlias.trim();
            if (trimmed.length > 0) {
                answersAlias = trimmed;
            }
        }
        else {
            log.info(`Using default answers file name ${chalk.cyan(answersAlias)} (interactive prompt disabled).`);
        }
    }
    promptPersistence = await createPromptPersistenceManager({
        repoRoot,
        scenarioId: answersAlias,
        filePath: persistencePath,
        metadata: persistenceMetadata,
    });
    if (!identitySelection &&
        scenario.identity &&
        scenario.identity.segments.length > 0) {
        const identityMeta = promptPersistence.getMetadata()?.identity;
        if (identityMeta?.segments &&
            identityMeta.segments.length === scenario.identity.segments.length) {
            const slug = typeof identityMeta.slug === "string" &&
                identityMeta.slug.trim().length > 0
                ? identityMeta.slug.trim()
                : identityMeta.segments.map((segment) => segment.value).join("/");
            identitySelection = {
                slug,
                segments: identityMeta.segments.map((segment) => ({
                    id: segment.id,
                    value: segment.value,
                    label: segment.label,
                    details: segment.details ? { ...segment.details } : undefined,
                    source: "cli",
                })),
            };
        }
    }
    const answersAliasSegments = answersAlias
        .split("/")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    const answersFileBase = answersAliasSegments[answersAliasSegments.length - 1] ?? answersAlias;
    let usePromptPersistenceAnswers = Boolean(promptPersistence);
    if (promptPersistence &&
        promptPersistence.didLoadExistingSnapshot() &&
        interactiveTty &&
        !options.answersPathUsed) {
        try {
            const persistedAnswersStrategy = await promptForPersistedAnswersStrategy({
                filePath: promptPersistence.getFilePath(),
            });
            if (persistedAnswersStrategy === "review") {
                usePromptPersistenceAnswers = false;
                log.info("Persisted answers will be used as defaults — prompts will run before overwriting the file.");
            }
            else if (persistedAnswersStrategy === "reset") {
                promptPersistence.resetAllAnswers();
                usePromptPersistenceAnswers = false;
                log.info("Persisted answers cleared — prompts will run and the file will be replaced.");
            }
        }
        catch (error) {
            if (error instanceof PersistedAnswersStrategyCancelledError) {
                await logWriter?.close().catch(() => undefined);
                await promptHistory.close().catch(() => undefined);
                return { exitCode: 0 };
            }
            throw error;
        }
    }
    if (options.loadPersistedAnswers) {
        if (options.answersPathUsed) {
            log.info(`Loaded prompt overrides from ${chalk.cyan(options.answersPathUsed)}.`);
        }
        else {
            log.info("Loaded prompt overrides from stdin (--answers -).");
        }
    }
    if (promptPersistence.didLoadExistingSnapshot()) {
        log.warn(`Answers file ${chalk.cyan(promptPersistence.getFilePath())} already exists and will be overwritten after this run.`);
    }
    else {
        log.info(`Capturing prompt answers to ${chalk.cyan(promptPersistence.getFilePath())}. Edit this file or pass --answers <path> to reuse the values later.`);
    }
    const nonInteractive = options.phase === "execute"
        ? true
        : options.phase === "collect"
            ? false
            : Boolean(options.loadPersistedAnswers) || !interactiveTty;
    const promptDriver = nonInteractive
        ? new NonInteractivePromptDriver()
        : new ClackPromptDriver();
    const executorContext = {
        config,
        scenarioId: scenario.id,
        repoRoot,
        stdout: options.stdout ?? process.stdout,
        stderr: options.stderr ?? process.stderr,
        dryRun: isRegisterMode ? false : options.dryRun ?? false,
        quiet: options.quiet ?? false,
        verbose: options.verbose ?? false,
        phase: options.phase,
        nonInteractive,
        promptDriver,
        overrides: resolvedOverrides,
        answersFileName: answersAlias,
        answersFileBase,
        logWriter,
        promptOptionsCache: new Map(),
        promptHistory,
        promptPersistence,
        usePromptPersistenceAnswers,
        checkpoint: undefined,
        policy: policyEngine,
        plugins: pluginRegistryResult.registry,
        executionMode,
    };
    const planRequested = Boolean(options.plan) && !isRegisterMode;
    if (planRequested) {
        const planFormat = options.planFormat ?? ((options.quiet ?? false) ? "ndjson" : "pretty");
        const scenarioPlan = await buildScenarioPlan(executorContext, {
            initialState: resumeState,
        });
        const stdoutStream = options.stdout ?? process.stdout;
        const stdinStream = process.stdin;
        applyPlanExpandSections(scenarioPlan, options.planExpand);
        const interactiveStreams = resolveInteractivePlanPreviewStreams(planFormat, options, stdoutStream, stdinStream);
        if (interactiveStreams) {
            const updatedSections = await runInteractivePlanPreview({
                plan: scenarioPlan,
                stdout: interactiveStreams.stdout,
                stdin: interactiveStreams.stdin,
            });
            options.planExpand =
                updatedSections.length > 0 ? updatedSections : undefined;
        }
        else {
            options.planExpand = getPlanExpandSectionsFromPreferences(scenarioPlan.preferences);
        }
        await emitScenarioPlan(scenarioPlan, planFormat, {
            stdout: stdoutStream,
            outputPath: options.planOutputPath,
            quiet: options.quiet ?? false,
        });
        const planOnly = !isRegisterMode &&
            Boolean(options.planOnly || (options.dryRun ?? false));
        if (planOnly) {
            outro(chalk.green("Preview generated."));
            await logWriter?.close().catch(() => undefined);
            await promptPersistence?.save().catch((error) => {
                log.warn(`Failed to save prompt answers: ${String(error)}`);
            });
            await promptHistory.close().catch(() => undefined);
            return { exitCode: 0 };
        }
        if (!options.quiet && interactiveTty && !nonInteractive) {
            const proceed = await confirm({
                message: "Proceed with execution?",
                initialValue: true,
            });
            if (isCancel(proceed) || proceed === false) {
                cancel("Execution skipped after preview.");
                await logWriter?.close().catch(() => undefined);
                await promptHistory.close().catch(() => undefined);
                return { exitCode: 0 };
            }
        }
    }
    try {
        checkpointManager = await createCheckpointManager({
            repoRoot,
            scenarioId: scenario.id,
            scenarioLabel: scenario.label,
            runId: resumeState?.runId,
            dryRun: options.dryRun ?? false,
            interval: options.checkpointInterval,
            retention: options.checkpointRetention,
        });
        executorContext.checkpoint = checkpointManager;
        const finalState = await executeScenario(executorContext, {
            initialState: resumeState,
            checkpoint: checkpointManager,
            identity: identitySelection,
        });
        await checkpointManager?.finalize(finalState, "completed");
        if (promptPersistence && finalState.answers.policies !== undefined) {
            promptPersistence.set({ scope: "scenario", key: "policies" }, finalState.answers.policies);
        }
        const exitCode = determineExitCode(finalState);
        if (registerManifestPath && exitCode === 0) {
            const answersSnapshot = structuredClone(finalState.answers ?? {});
            const manifestPlanContext = {
                ...executorContext,
                dryRun: false,
                quiet: true,
                verbose: false,
                overrides: answersSnapshot,
                logWriter: undefined,
                promptOptionsCache: new Map(),
                promptPersistence: undefined,
                checkpoint: undefined,
                executionMode: "standard",
            };
            const manifestPlan = await buildScenarioPlan(manifestPlanContext);
            const manifestPayload = {
                schemaVersion: 1,
                scenarioId: scenario.id,
                scenarioLabel: scenario.label,
                scenarioDescription: scenario.description,
                createdAt: new Date().toISOString(),
                repoRoot,
                configPaths: relativeConfigPaths,
                configHash,
                cliVersion: options.clientVersion,
                coreVersion: CORE_VERSION,
                environment: effectiveEnvironment,
                plan: manifestPlan,
                answers: answersSnapshot,
                registerArgs: options.args,
            };
            await writeManifest(registerManifestPath, manifestPayload);
            const relativeManifestPath = relativeToRepo(repoRoot, registerManifestPath);
            log.success(`Manifest captured at ${chalk.cyan(relativeManifestPath)}. Re-run later with "dev-wizard execute --manifest ${relativeManifestPath}".`);
        }
        const summaryLines = buildSummaryLines(finalState, options);
        if (options.logFile) {
            summaryLines.push(`log file: ${path.resolve(options.logFile)}`);
        }
        const summaryTitle = finalState.failedSteps > 0
            ? chalk.red("❌ Wizard Summary")
            : exitCode === 0
                ? chalk.green("✅ Wizard Summary")
                : chalk.yellow("⚠️ Wizard Summary");
        note(summaryLines.join("\n"), summaryTitle);
        const outroMessage = finalState.failedSteps > 0
            ? chalk.red("Wizard failed.")
            : finalState.exitedEarly
                ? chalk.yellow("Wizard exited early. Review the summary above.")
                : exitCode === 0
                    ? chalk.green("Wizard complete.")
                    : chalk.yellow("Wizard finished with warnings.");
        outro(outroMessage);
        result = {
            exitCode,
            state: finalState,
        };
        if (promptPersistence) {
            result.persistedAnswers = {
                filePath: promptPersistence.getFilePath(),
                scenarioId: scenario.id,
                identitySlug: identitySelection?.slug,
            };
        }
    }
    catch (error) {
        if (error instanceof WizardExecutionError) {
            await checkpointManager?.finalize(error.state, "failed");
        }
        handleFatalError(error instanceof Error ? error : new Error(String(error)), "Wizard failed");
        throw error;
    }
    finally {
        await logWriter?.close().catch((error) => {
            log.warn(`Failed to close log file: ${String(error)}`);
        });
        await promptPersistence?.save().catch((error) => {
            log.warn(`Failed to save prompt answers: ${String(error)}`);
        });
        await promptHistory.close().catch(() => undefined);
    }
    return result ?? { exitCode: 0 };
}
function resolveExecutionMetadata(options) {
    const envSandbox = process.env.DEV_WIZARD_SANDBOX;
    const envSandboxSlug = process.env.DEV_WIZARD_SANDBOX_SLUG;
    const envSandboxEnabled = typeof envSandbox === "string" &&
        envSandbox.length > 0 &&
        envSandbox !== "0" &&
        envSandbox.toLowerCase() !== "false";
    const sandboxChoice = typeof options.executionSandbox === "boolean"
        ? options.executionSandbox
        : envSandboxEnabled
            ? true
            : undefined;
    const sandboxSlug = typeof options.executionSandboxSlug === "string" &&
        options.executionSandboxSlug.trim().length > 0
        ? options.executionSandboxSlug.trim()
        : typeof envSandboxSlug === "string" && envSandboxSlug.trim().length > 0
            ? envSandboxSlug.trim()
            : undefined;
    if (sandboxChoice === undefined && !sandboxSlug) {
        return undefined;
    }
    const metadata = {};
    if (sandboxChoice !== undefined) {
        metadata.sandbox = sandboxChoice;
    }
    if (sandboxSlug) {
        metadata.sandboxSlug = sandboxSlug;
    }
    return metadata;
}
function listScenarios(config) {
    const rows = config.scenarios.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        description: scenario.description,
    }));
    if (rows.length === 0) {
        log.warn("No scenarios are defined in the provided configuration.");
        return;
    }
    note(rows
        .map((row) => `${chalk.cyan(row.label)} ${chalk.gray(`(${row.id})`)}${row.description ? `\n${chalk.gray(row.description)}` : ""}`)
        .join("\n\n"), "Available scenarios");
}
function determineExitCode(state) {
    if (state.failedSteps > 0) {
        return 1;
    }
    if (state.exitedEarly) {
        return 1;
    }
    return 0;
}
async function resolveWizardIdentitySelection(options) {
    const identityConfig = options.scenario.identity;
    const providedSegments = normalizeIdentitySegmentOverrides(options.providedSegments);
    const providedSegmentDetails = normalizeIdentitySegmentMetadata(options.providedSegmentDetails);
    const hasSegmentOverrides = providedSegments && Object.keys(providedSegments).length > 0;
    if (!identityConfig || identityConfig.segments.length === 0) {
        const hasSegmentOverrides = (providedSegments && Object.keys(providedSegments).length > 0) ||
            (providedSegmentDetails &&
                Object.keys(providedSegmentDetails).length > 0);
        if (options.providedSlug || hasSegmentOverrides) {
            throw new Error(`Scenario ${options.scenario.id} does not define identity metadata, but identity overrides were provided.`);
        }
        return undefined;
    }
    if (options.providedSlug) {
        return parseIdentitySlug(options.providedSlug, identityConfig.segments);
    }
    const persistedIdentities = options.usingExternalAnswers
        ? undefined
        : await collectPersistedIdentitySelections({
            repoRoot: options.repoRoot,
            scenarioId: options.scenario.id,
            segments: identityConfig.segments,
        });
    const persistedIdentity = persistedIdentities && persistedIdentities.length === 1
        ? persistedIdentities[0]
        : undefined;
    if (persistedIdentities &&
        persistedIdentities.length > 1 &&
        !options.providedSlug &&
        !hasSegmentOverrides &&
        options.interactive &&
        !options.usingExternalAnswers) {
        return promptForExistingIdentitySelection({
            existing: persistedIdentities,
            segments: identityConfig.segments,
            metadataOverrides: providedSegmentDetails,
        });
    }
    const resolution = buildIdentitySelectionFromSources(identityConfig.segments, providedSegments, providedSegmentDetails, persistedIdentity);
    if (resolution.selection) {
        if (persistedIdentity &&
            !options.providedSlug &&
            !hasSegmentOverrides &&
            options.interactive &&
            !options.usingExternalAnswers) {
            return promptForIdentitySegments(identityConfig.segments, {
                metadataOverrides: providedSegmentDetails,
                defaults: toIdentitySegmentDefaults(persistedIdentity),
            });
        }
        return resolution.selection;
    }
    if (options.usingExternalAnswers) {
        return undefined;
    }
    if (!options.interactive) {
        const missingSuffix = resolution.missingSegmentIds.length > 0
            ? ` (${resolution.missingSegmentIds.join(", ")})`
            : "";
        throw new Error(`Scenario ${options.scenario.id} requires an answers identity${missingSuffix}. Re-run with --answers-identity <segment/...> or supply every segment via --answers-segment <id>=<value>.`);
    }
    return promptForIdentitySegments(identityConfig.segments, {
        provided: providedSegments,
        metadataOverrides: providedSegmentDetails,
        defaults: persistedIdentity
            ? toIdentitySegmentDefaults(persistedIdentity)
            : undefined,
    });
}
function parseIdentitySlug(slug, segments) {
    const parts = slug
        .split("/")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    if (parts.length !== segments.length) {
        throw new Error(`--answers-identity requires ${segments.length} segment(s) but received ${parts.length}.`);
    }
    const selections = segments.map((segment, index) => {
        const value = parts[index];
        return buildWizardIdentitySegmentSelection(segment, value, "cli", undefined, { acceptUnlistedValues: true });
    });
    return {
        slug: selections.map((selection) => selection.value).join("/"),
        segments: selections,
    };
}
async function promptForIdentitySegments(segments, options) {
    const selections = [];
    const selectionMap = new Map();
    for (const segment of segments) {
        const overrideValue = options?.provided?.[segment.id];
        if (overrideValue) {
            const selection = buildWizardIdentitySegmentSelection(segment, overrideValue, "cli", options?.metadataOverrides?.[segment.id]);
            selections.push(selection);
            selectionMap.set(segment.id, selection);
            continue;
        }
        const selection = await promptForIdentitySegment(segment, selectionMap, options?.metadataOverrides?.[segment.id], options?.defaults?.[segment.id]);
        selections.push(selection);
        selectionMap.set(segment.id, selection);
    }
    return {
        slug: selections.map((selection) => selection.value).join("/"),
        segments: selections,
    };
}
async function promptForIdentitySegment(segment, selectionMap, metadataOverride, defaultValue) {
    if (segment.options && segment.options.length > 0) {
        const options = segment.options.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
            hint: option.hint,
        }));
        const allowCustom = Boolean(segment.allowCustom);
        if (allowCustom) {
            options.push({
                value: "__custom__",
                label: "Custom value",
                hint: "Enter a custom value",
            });
        }
        if (defaultValue) {
            const existing = options.find((option) => option.value === defaultValue);
            if (existing) {
                options.splice(options.indexOf(existing), 1);
                options.unshift(existing);
            }
            else if (allowCustom) {
                options.unshift({
                    value: "__saved__",
                    label: defaultValue,
                    hint: "Saved value",
                });
            }
        }
        const choice = await select({
            message: segment.prompt,
            options,
        });
        if (isCancel(choice)) {
            cancel("Execution cancelled before selecting an answers identity.");
            throw new IdentityPromptCancelledError();
        }
        if (typeof choice !== "string") {
            throw new Error(`Identity segment "${segment.id}" returned a non-string selection.`);
        }
        if (choice === "__saved__") {
            return buildWizardIdentitySegmentSelection(segment, defaultValue ?? "", "cli", metadataOverride, { acceptUnlistedValues: true });
        }
        if (choice === "__custom__") {
            const customValue = await promptForCustomIdentityValue(segment, selectionMap, defaultValue);
            return buildWizardIdentitySegmentSelection(segment, customValue, "custom", metadataOverride);
        }
        const option = segment.options.find((entry) => entry.value === choice);
        return buildWizardIdentitySegmentSelection(segment, choice, option ? "option" : "cli", metadataOverride);
    }
    if (!segment.allowCustom) {
        throw new Error(`Identity segment "${segment.id}" must define options or set allowCustom: true.`);
    }
    const customValue = await promptForCustomIdentityValue(segment, selectionMap, defaultValue);
    return buildWizardIdentitySegmentSelection(segment, customValue, "custom", metadataOverride);
}
async function promptForCustomIdentityValue(segment, selectionMap, initialValueOverride) {
    const initialValue = initialValueOverride
        ? initialValueOverride
        : segment.defaultValue
            ? renderIdentityDefaultTemplate(segment.defaultValue, selectionMap)
            : undefined;
    const response = await text({
        message: segment.prompt,
        placeholder: segment.placeholder,
        initialValue,
    });
    if (isCancel(response)) {
        cancel("Execution cancelled before selecting an answers identity.");
        throw new IdentityPromptCancelledError();
    }
    const trimmed = response.trim();
    if (trimmed.length === 0) {
        throw new Error(`Identity segment "${segment.id}" requires a value.`);
    }
    return trimmed;
}
async function promptForExistingIdentitySelection(options) {
    while (true) {
        const response = await select({
            message: "Select an existing answers identity (or create a new one):",
            options: [
                ...options.existing.map((selection) => ({
                    value: selection.slug,
                    label: selection.slug,
                    hint: selection.segments.map((segment) => `${segment.id}=${segment.value}`).join(", "),
                })),
                {
                    value: "__new__",
                    label: "Create a new identity",
                    hint: "Answer the identity prompts before continuing.",
                },
            ],
        });
        if (isCancel(response)) {
            cancel("Execution cancelled before selecting an answers identity.");
            throw new IdentityPromptCancelledError();
        }
        if (response === "__new__") {
            return promptForIdentitySegments(options.segments, {
                metadataOverrides: options.metadataOverrides,
            });
        }
        const selected = options.existing.find((entry) => entry.slug === response);
        if (selected) {
            return promptForIdentitySegments(options.segments, {
                metadataOverrides: options.metadataOverrides,
                defaults: toIdentitySegmentDefaults(selected),
            });
        }
    }
}
async function promptForPersistedAnswersStrategy(options) {
    while (true) {
        const response = await select({
            message: `Saved answers file ${chalk.cyan(options.filePath)} already exists. How should Dev Wizard proceed?`,
            options: [
                {
                    value: "reuse",
                    label: "Reuse saved answers",
                    hint: "Skip prompts and keep the existing values for this run.",
                },
                {
                    value: "review",
                    label: "Review and update answers",
                    hint: "Use saved answers as defaults, but run every prompt again.",
                },
                {
                    value: "reset",
                    label: "Start from scratch",
                    hint: "Clear saved answers before prompting and capture new values.",
                },
            ],
        });
        if (isCancel(response)) {
            cancel("Execution cancelled before confirming how to use the saved answers file.");
            throw new PersistedAnswersStrategyCancelledError();
        }
        if (response === "reuse" ||
            response === "review" ||
            response === "reset") {
            return response;
        }
    }
}
function buildIdentityAnswersPath(repoRoot, scenarioId, selection) {
    const baseDir = path.join(repoRoot, ".dev-wizard", "answers");
    const sanitizedScenario = sanitizePersistenceSegment(scenarioId);
    const sanitizedSegments = selection.segments.map((segment) => sanitizePersistenceSegment(segment.value));
    const directorySegments = [
        sanitizedScenario,
        ...sanitizedSegments.slice(0, Math.max(sanitizedSegments.length - 1, 0)),
    ].filter((segment) => segment.length > 0);
    const fileNameSegment = sanitizedSegments[sanitizedSegments.length - 1] || "answers";
    return path.join(baseDir, ...directorySegments, `${fileNameSegment}.json`);
}
function normalizeIdentitySegmentOverrides(overrides) {
    if (!overrides) {
        return undefined;
    }
    const normalized = {};
    for (const [key, value] of Object.entries(overrides)) {
        const trimmedKey = key.trim();
        const trimmedValue = value.trim();
        if (!trimmedKey || !trimmedValue) {
            continue;
        }
        normalized[trimmedKey] = trimmedValue;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function normalizeIdentitySegmentMetadata(metadata) {
    if (!metadata) {
        return undefined;
    }
    const normalized = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (!value || typeof value !== "object") {
            continue;
        }
        const trimmedKey = key.trim();
        if (!trimmedKey) {
            continue;
        }
        const entry = {};
        if (typeof value.label === "string") {
            const trimmedLabel = value.label.trim();
            if (trimmedLabel) {
                entry.label = trimmedLabel;
            }
        }
        if (value.details && typeof value.details === "object") {
            const cloned = { ...value.details };
            if (Object.keys(cloned).length > 0) {
                entry.details = cloned;
            }
        }
        if (entry.label === undefined &&
            entry.details === undefined) {
            continue;
        }
        normalized[trimmedKey] = entry;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
function renderIdentityDefaultTemplate(template, selectionMap) {
    if (!template) {
        return undefined;
    }
    const rendered = template.replace(/{{\s*([\w-]+)\s*}}/g, (_match, segmentId) => {
        const selection = selectionMap.get(segmentId);
        return selection?.value ?? "";
    });
    const trimmed = rendered.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function buildIdentitySelectionFromSources(segments, provided, providedMetadata, fallback) {
    const selections = [];
    const fallbackMap = new Map();
    if (fallback) {
        for (const entry of fallback.segments) {
            fallbackMap.set(entry.id, entry);
        }
    }
    const missing = [];
    for (const segment of segments) {
        const overrideValue = provided?.[segment.id];
        if (overrideValue) {
            selections.push(buildWizardIdentitySegmentSelection(segment, overrideValue, "cli", providedMetadata?.[segment.id]));
            continue;
        }
        const fallbackEntry = fallbackMap.get(segment.id);
        if (fallbackEntry) {
            selections.push({ ...fallbackEntry });
            continue;
        }
        missing.push(segment.id);
    }
    if (missing.length === 0) {
        return {
            selection: {
                slug: selections.map((selection) => selection.value).join("/"),
                segments: selections,
            },
            missingSegmentIds: [],
        };
    }
    return {
        missingSegmentIds: missing,
    };
}
function buildWizardIdentitySegmentSelection(segment, value, source, metadataOverride, options) {
    const option = segment.options?.find((candidate) => candidate.value === value);
    let selection;
    if (option) {
        selection = {
            id: segment.id,
            value: option.value,
            label: option.label ?? option.value,
            source,
        };
    }
    else if (segment.allowCustom || options?.acceptUnlistedValues) {
        selection = {
            id: segment.id,
            value,
            label: value,
            source,
        };
    }
    if (!selection) {
        throw new Error(`Identity segment "${segment.id}" does not allow custom values. Valid options: ${segment.options?.map((entry) => entry.value).join(", ") ?? "n/a"}.`);
    }
    if (metadataOverride) {
        if (typeof metadataOverride.label === "string") {
            selection.label = metadataOverride.label;
        }
        if (metadataOverride.details && typeof metadataOverride.details === "object") {
            selection.details = { ...metadataOverride.details };
        }
    }
    return selection;
}
function applyIdentityMetadataOverrides(selection, metadataOverrides) {
    if (!metadataOverrides) {
        return selection;
    }
    const segments = selection.segments.map((segment) => {
        const override = metadataOverrides[segment.id];
        if (!override) {
            return segment;
        }
        const next = { ...segment };
        if (typeof override.label === "string") {
            next.label = override.label;
        }
        if (override.details && typeof override.details === "object") {
            next.details = { ...override.details };
        }
        return next;
    });
    return {
        slug: selection.slug,
        segments,
    };
}
async function collectPersistedIdentitySelections(options) {
    if (options.segments.length === 0) {
        return [];
    }
    const scenarioDir = path.join(options.repoRoot, ".dev-wizard", "answers", sanitizePersistenceSegment(options.scenarioId));
    const files = await collectIdentityAnswerFiles(scenarioDir);
    if (files.length === 0) {
        return [];
    }
    const selections = new Map();
    for (const filePath of files) {
        const selection = await readIdentitySelectionSnapshot(filePath, options.segments);
        if (!selection) {
            continue;
        }
        if (!selections.has(selection.slug)) {
            selections.set(selection.slug, selection);
        }
    }
    return Array.from(selections.values());
}
function toIdentitySegmentDefaults(selection) {
    const defaults = {};
    for (const segment of selection.segments) {
        if (!segment.id || !segment.value) {
            continue;
        }
        defaults[segment.id] = segment.value;
    }
    return defaults;
}
async function collectIdentityAnswerFiles(dir) {
    let entries;
    try {
        entries = await readDirents(dir);
    }
    catch (error) {
        if (error.code === "ENOENT" ||
            error.code === "ENOTDIR") {
            return [];
        }
        throw error;
    }
    const files = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await collectIdentityAnswerFiles(entryPath);
            files.push(...nested);
        }
        else if (entry.isFile() && entry.name.endsWith(".json")) {
            files.push(entryPath);
        }
    }
    return files;
}
async function readIdentitySelectionSnapshot(filePath, expectedSegments) {
    let raw;
    try {
        raw = await readFile(filePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error instanceof Error ? error : new Error(String(error));
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed)) {
        return undefined;
    }
    const meta = isRecord(parsed.meta) ? parsed.meta : undefined;
    const identity = meta && isRecord(meta.identity)
        ? meta.identity
        : undefined;
    if (!identity) {
        return undefined;
    }
    const slug = typeof identity.slug === "string" ? identity.slug : undefined;
    const segmentsValue = Array.isArray(identity.segments)
        ? identity.segments
        : undefined;
    if (!slug || !segmentsValue || segmentsValue.length !== expectedSegments.length) {
        return undefined;
    }
    const selections = [];
    for (let index = 0; index < expectedSegments.length; index += 1) {
        const stored = segmentsValue[index];
        if (!isRecord(stored) || typeof stored.value !== "string") {
            return undefined;
        }
        const id = typeof stored.id === "string"
            ? stored.id
            : expectedSegments[index]?.id ?? `segment-${index + 1}`;
        const label = typeof stored.label === "string" ? stored.label : stored.value;
        const details = isRecord(stored.details) ? { ...stored.details } : undefined;
        selections.push({
            id,
            value: stored.value,
            label,
            source: "cli",
            details,
        });
    }
    return {
        slug,
        segments: selections,
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
class IdentityPromptCancelledError extends Error {
}
class PersistedAnswersStrategyCancelledError extends Error {
}
class ConfigPickerCancelledError extends Error {
}
function buildSummaryLines(state, options) {
    const lines = [
        `${state.completedSteps} step${state.completedSteps === 1 ? "" : "s"} executed`,
        options.dryRun ? "mode: dry-run" : "mode: live",
        options.verbose ? "verbosity: verbose" : "verbosity: normal",
        `duration: ${formatDuration(getScenarioDurationMs(state))}`,
    ];
    if (options.quiet) {
        const flowSummary = buildFlowSummary(state.flowRuns);
        if (flowSummary) {
            lines.push(flowSummary);
        }
    }
    else {
        const flowTable = renderFlowSummaryTable(state.flowRuns);
        if (flowTable) {
            lines.push("flow timeline:");
            lines.push(flowTable);
        }
        else {
            const flowSummary = buildFlowSummary(state.flowRuns);
            if (flowSummary) {
                lines.push(flowSummary);
            }
        }
    }
    if (state.failedSteps > 0) {
        lines.push(`${state.failedSteps} failure${state.failedSteps === 1 ? "" : "s"} encountered`);
    }
    else if (state.exitedEarly) {
        lines.push("status: exited early");
    }
    const retrySummary = collectRetrySummary(state);
    if (retrySummary) {
        lines.push(retrySummary);
    }
    const skipSummary = collectSkipSummary(state);
    if (skipSummary) {
        lines.push(skipSummary);
    }
    const timeoutSummary = collectTimeoutSummary(state);
    if (timeoutSummary) {
        lines.push(timeoutSummary);
    }
    const longRunningSummary = collectLongRunningSummary(state);
    if (longRunningSummary) {
        lines.push(longRunningSummary);
    }
    const capturedLines = collectCapturedOutputSummary(state, options);
    if (capturedLines) {
        lines.push(...capturedLines);
    }
    const policySummary = collectPolicyDecisionSummary(state);
    if (policySummary) {
        lines.push(policySummary);
    }
    return lines;
}
function collectPolicyDecisionSummary(state) {
    const decisions = state.policyDecisions ?? [];
    if (decisions.length === 0) {
        return undefined;
    }
    const summaries = new Set();
    for (const decision of decisions) {
        const enforcedLabel = decision.ruleLevel === decision.enforcedLevel
            ? decision.enforcedLevel
            : `${decision.ruleLevel}->${decision.enforcedLevel}`;
        const acknowledgement = decision.acknowledged ? ", acknowledged" : "";
        summaries.add(`${decision.ruleId} (${enforcedLabel}${acknowledgement})`);
    }
    return `policy decisions: ${Array.from(summaries).join("; ")}`;
}
function buildFlowSummary(flowRuns) {
    if (!flowRuns || flowRuns.length === 0) {
        return undefined;
    }
    const formatted = flowRuns.map((run) => {
        const durationLabel = formatDuration(run.durationMs);
        const exitSuffix = run.exitedEarly ? " [exit]" : "";
        return `${run.flowId} (${durationLabel})${exitSuffix}`;
    });
    return flowRuns.length === 1
        ? `flow: ${formatted[0]}`
        : `flows: ${formatted.join(" → ")}`;
}
function getScenarioDurationMs(state) {
    const end = state.endedAt ?? new Date();
    return Math.max(0, end.getTime() - state.startedAt.getTime());
}
function formatDuration(durationMs) {
    if (durationMs < 1000) {
        return `${durationMs}ms`;
    }
    const totalSeconds = Math.floor(durationMs / 1000);
    if (totalSeconds < 60) {
        const preciseSeconds = totalSeconds < 10 ? (durationMs / 1000).toFixed(1) : Math.round(durationMs / 1000).toString();
        return `${preciseSeconds}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60) {
        return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
    }
    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
}
function renderFlowSummaryTable(flowRuns) {
    if (!flowRuns || flowRuns.length === 0) {
        return undefined;
    }
    const headers = ["Flow", "Duration", "Status"];
    const rows = flowRuns.map((run) => [
        run.flowId,
        formatDuration(run.durationMs),
        run.exitedEarly ? "exit" : "ok",
    ]);
    const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
    const formatRow = (row) => row
        .map((cell, index) => cell.padEnd(widths[index], " "))
        .join(" | ");
    const separator = widths.map((width) => "-".repeat(width)).join("-+-");
    return [
        formatRow(headers),
        separator,
        ...rows.map((row) => formatRow(row)),
    ].join("\n");
}
function collectCapturedOutputSummary(state, options) {
    if (options.dryRun) {
        return undefined;
    }
    const captures = state.history.filter((record) => Boolean(record.stdout?.trim()));
    if (captures.length === 0) {
        return undefined;
    }
    if (options.quiet) {
        return [
            `captured output stored for ${captures.length} command${captures.length === 1 ? "" : "s"} (hidden in quiet mode)`,
        ];
    }
    const maxEntries = 3;
    const lines = ["captured output:"];
    const recentCaptures = captures.slice(-maxEntries);
    for (const record of recentCaptures) {
        const label = record.stepLabel ?? record.stepId;
        const snippet = summarizeCapturedOutput(record.stdout ?? "", {
            hardLimit: 240,
        });
        if (snippet.includes("\n")) {
            const [firstLine, ...rest] = snippet.split("\n");
            lines.push(`- ${label}: ${firstLine}`);
            for (const continuation of rest) {
                lines.push(`  ${continuation}`);
            }
        }
        else {
            lines.push(`- ${label}: ${snippet}`);
        }
    }
    if (captures.length > maxEntries) {
        lines.push("  …");
    }
    return lines;
}
function collectRetrySummary(state) {
    const retries = state.retries ?? [];
    if (retries.length === 0) {
        return undefined;
    }
    const counts = new Map();
    for (const entry of retries) {
        const key = `${entry.flowId}:${entry.stepId}`;
        const label = entry.stepLabel ?? entry.stepId;
        const current = counts.get(key);
        if (current) {
            current.count += 1;
        }
        else {
            counts.set(key, { count: 1, label });
        }
    }
    const formatted = Array.from(counts.values()).map((item) => item.count === 1 ? item.label : `${item.label} (x${item.count})`);
    if (formatted.length === 0) {
        return undefined;
    }
    return `retries: ${formatted.join(", ")}`;
}
function collectSkipSummary(state) {
    const skips = state.skippedSteps ?? [];
    if (skips.length === 0) {
        return undefined;
    }
    const counts = new Map();
    for (const entry of skips) {
        const stepLabel = entry.stepLabel ?? entry.stepId;
        const actionSuffix = entry.actionLabel
            ? ` -> ${entry.actionLabel}`
            : entry.reason === "default"
                ? " (default)"
                : entry.reason === "policy"
                    ? " (policy)"
                    : "";
        const label = `${stepLabel}${actionSuffix}`;
        const current = counts.get(label);
        if (current) {
            current.count += 1;
        }
        else {
            counts.set(label, { count: 1, label });
        }
    }
    const formatted = Array.from(counts.values()).map((item) => item.count === 1 ? item.label : `${item.label} (x${item.count})`);
    if (formatted.length === 0) {
        return undefined;
    }
    return `skips: ${formatted.join(", ")}`;
}
async function emitScenarioPlan(plan, format, options) {
    if (format === "ndjson") {
        const lines = formatScenarioPlanNdjson(plan);
        const payload = `${lines.join("\n")}\n`;
        options.stdout.write(payload);
        if (options.outputPath) {
            await writeFile(path.resolve(options.outputPath), payload);
        }
        return;
    }
    if (format === "json") {
        const payload = formatScenarioPlanJson(plan);
        options.stdout.write(payload);
        if (options.outputPath) {
            await writeFile(path.resolve(options.outputPath), payload);
        }
        return;
    }
    const pretty = formatScenarioPlanPretty(plan);
    const trimmed = pretty.trimEnd();
    if (!options.quiet) {
        note(trimmed, "Dry-Run Preview");
    }
    else {
        options.stdout.write(`${trimmed}\n`);
    }
    if (options.outputPath) {
        await writeFile(path.resolve(options.outputPath), pretty);
    }
}
function resolveInteractivePlanPreviewStreams(format, options, stdout, stdin) {
    if (format !== "pretty" ||
        (options.quiet ?? false) ||
        !isWritableTTY(stdout) ||
        !isReadableTTY(stdin)) {
        return undefined;
    }
    return {
        stdout: stdout,
        stdin: stdin,
    };
}
async function runInteractivePlanPreview({ plan, stdout, stdin, }) {
    if (typeof stdin.setRawMode !== "function") {
        return getPlanExpandSectionsFromPreferences(plan.preferences);
    }
    const instructions = "Hotkeys: [e] env, [t] templates, [b] branches, [a] all, [n] none, [enter] continue, [q] skip";
    const wasPaused = stdin.isPaused();
    const previousRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    const render = () => {
        clearInteractivePreview(stdout);
        const summary = `env: ${plan.preferences.expandEnv ? "on" : "off"} | templates: ${plan.preferences.expandTemplates ? "on" : "off"} | branches: ${plan.preferences.expandBranches ? "on" : "off"}`;
        stdout.write(`${chalk.cyan("Dry-Run Preview (interactive)")}\n`);
        stdout.write(`${chalk.gray(summary)}\n\n`);
        stdout.write(formatScenarioPlanPretty(plan));
        stdout.write(`\n${chalk.gray(instructions)}\n`);
    };
    return await new Promise((resolve) => {
        const finish = () => {
            stdin.removeListener("data", onData);
            stdin.setRawMode(previousRaw);
            if (wasPaused) {
                stdin.pause();
            }
            clearInteractivePreview(stdout);
            resolve(getPlanExpandSectionsFromPreferences(plan.preferences));
        };
        const resetPreferences = (value) => {
            plan.preferences.expandEnv = value;
            plan.preferences.expandTemplates = value;
            plan.preferences.expandBranches = value;
        };
        const toggleSection = (section) => {
            switch (section) {
                case "env":
                    plan.preferences.expandEnv = !plan.preferences.expandEnv;
                    break;
                case "templates":
                    plan.preferences.expandTemplates = !plan.preferences.expandTemplates;
                    break;
                case "branches":
                    plan.preferences.expandBranches = !plan.preferences.expandBranches;
                    break;
            }
        };
        const onData = (chunk) => {
            if (!chunk) {
                return;
            }
            const input = chunk.toString("utf8");
            if (input === "\u0003") {
                stdin.removeListener("data", onData);
                stdin.setRawMode(previousRaw);
                if (wasPaused) {
                    stdin.pause();
                }
                clearInteractivePreview(stdout);
                process.kill(process.pid, "SIGINT");
                return;
            }
            const normalized = input.toLowerCase();
            if (normalized === "\r" || normalized === "\n" || normalized === "q") {
                finish();
                return;
            }
            switch (normalized) {
                case "e":
                    toggleSection("env");
                    render();
                    return;
                case "t":
                    toggleSection("templates");
                    render();
                    return;
                case "b":
                    toggleSection("branches");
                    render();
                    return;
                case "a":
                    resetPreferences(true);
                    render();
                    return;
                case "n":
                    resetPreferences(false);
                    render();
                    return;
                default:
                    return;
            }
        };
        stdin.on("data", onData);
        render();
    });
}
function applyPlanExpandSections(plan, sections) {
    const preferences = {
        expandEnv: false,
        expandTemplates: false,
        expandBranches: false,
    };
    if (sections) {
        for (const section of sections) {
            switch (section) {
                case "env":
                    preferences.expandEnv = true;
                    break;
                case "templates":
                    preferences.expandTemplates = true;
                    break;
                case "branches":
                    preferences.expandBranches = true;
                    break;
                default:
                    break;
            }
        }
    }
    plan.preferences = preferences;
}
function getPlanExpandSectionsFromPreferences(preferences) {
    const sections = [];
    if (preferences.expandEnv) {
        sections.push("env");
    }
    if (preferences.expandTemplates) {
        sections.push("templates");
    }
    if (preferences.expandBranches) {
        sections.push("branches");
    }
    return sections;
}
function clearInteractivePreview(stream) {
    stream.write("\u001b[2J\u001b[H");
}
function isWritableTTY(stream) {
    return Boolean(stream && stream.isTTY);
}
function isReadableTTY(stream) {
    return Boolean(stream && stream.isTTY);
}
function collectTimeoutSummary(state) {
    const timeouts = state.history.filter((record) => record.timedOut);
    if (timeouts.length === 0) {
        return undefined;
    }
    return `timed-out commands: ${formatCommandList(timeouts)}`;
}
function collectLongRunningSummary(state) {
    const longRunning = state.history.filter((record) => record.longRunning);
    if (longRunning.length === 0) {
        return undefined;
    }
    return `long-running commands: ${formatCommandList(longRunning)}`;
}
function formatCommandList(records) {
    const formatted = records.slice(0, 3).map((record) => {
        const label = getCommandDisplayName(record);
        return `${label} (${formatDuration(record.durationMs)})`;
    });
    if (records.length > formatted.length) {
        formatted.push("…");
    }
    return formatted.join(", ");
}
function getCommandDisplayName(record) {
    return (record.rendered.name ??
        record.stepLabel ??
        record.rendered.run ??
        record.stepId);
}
function formatConfigResolution(resolution, repoRoot) {
    const lines = resolution.diagnostics.length
        ? [...resolution.diagnostics]
        : ["No configuration locations were evaluated."];
    lines.push("");
    if (resolution.entries.length === 0) {
        lines.push("Selected config files: (none)");
    }
    else {
        lines.push("Selected config files:");
        for (const entry of resolution.entries) {
            lines.push(`- ${relativeToRepo(repoRoot, entry.path)} [${entry.source}]`);
        }
    }
    if (resolution.errors.length > 0) {
        lines.push("");
        lines.push("Errors:");
        for (const error of resolution.errors) {
            lines.push(`- ${error}`);
        }
    }
    return lines.join("\n");
}
async function resolveScenario(config, options) {
    if (options.scenario) {
        const match = config.scenarios.find((scenario) => scenario.id === options.scenario);
        if (!match) {
            throw new Error(`Scenario "${options.scenario}" not found. Use --list-scenarios to inspect available options.`);
        }
        return match;
    }
    if (config.scenarios.length === 1) {
        return config.scenarios[0];
    }
    if (config.scenarios.length === 0) {
        throw new Error("No scenarios are defined in the loaded configuration.");
    }
    const choice = await select({
        message: "Select the scenario to run",
        options: config.scenarios.map((scenario) => ({
            value: scenario.id,
            label: scenario.label,
            hint: scenario.description,
        })),
    });
    if (isCancel(choice)) {
        cancel("Scenario selection cancelled.");
        throw new Error("User cancelled scenario selection.");
    }
    const selected = config.scenarios.find((scenario) => scenario.id === choice);
    if (!selected) {
        throw new Error(`Selected scenario "${choice}" was not found.`);
    }
    return selected;
}
function handleFatalError(error, message) {
    log.error(`${message}: ${error.message}`);
    outro(chalk.red("Wizard exited with errors."));
}
function createConfigHash(config) {
    const normalized = normalizeForHash(config);
    const serialized = JSON.stringify(normalized);
    return createHash("sha256").update(serialized).digest("hex");
}
function normalizeForHash(value) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeForHash(entry));
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        const normalized = {};
        for (const [key, entryValue] of entries) {
            normalized[key] = normalizeForHash(entryValue);
        }
        return normalized;
    }
    return value;
}
function relativeToRepo(repoRoot, target) {
    const relative = path.relative(repoRoot, target);
    return relative && !relative.startsWith("..") ? relative : target;
}
const CONFIG_PICKER_IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    ".dev-wizard",
    ".reports",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".next",
    ".cache",
    "out",
    "tmp",
]);
const DEFAULT_CONFIG_DIRS = [
    "dev-wizard-config",
    path.join("packages", "dev-wizard-presets", "dev-wizard-config"),
];
const WIZARD_CONFIG_EXTENSIONS = [".yaml", ".yml", ".json", ".json5"];
async function selectConfigPath(repoRoot) {
    const candidates = await collectConfigPickerCandidates(repoRoot);
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        log.info(`Using ${chalk.cyan(candidates[0]?.label ?? candidates[0].path)} for this run.`);
        return candidates[0].path;
    }
    const choice = await select({
        message: "Select a configuration file to run",
        options: candidates.map((candidate) => ({
            value: candidate.path,
            label: candidate.label,
            hint: candidate.hint,
        })),
    });
    if (isCancel(choice)) {
        cancel("Configuration selection cancelled.");
        throw new ConfigPickerCancelledError();
    }
    if (typeof choice !== "string") {
        throw new Error("Configuration selection returned a non-string value.");
    }
    return choice;
}
async function resolveConfigPathWithFallback(repoRoot) {
    const primary = await selectConfigPath(repoRoot);
    if (primary) {
        return { path: primary, repoRoot };
    }
    const fallbackRoot = await findWorkspaceRoot(repoRoot);
    if (!fallbackRoot || fallbackRoot === repoRoot) {
        return null;
    }
    const fallback = await selectConfigPath(fallbackRoot);
    if (!fallback) {
        return null;
    }
    return { path: fallback, repoRoot: fallbackRoot };
}
async function resolveDefaultConfigPathWithFallback(repoRoot) {
    const primary = await findDefaultConfigPath(repoRoot);
    if (primary) {
        return { path: primary, repoRoot };
    }
    const fallbackRoot = await findWorkspaceRoot(repoRoot);
    if (!fallbackRoot || fallbackRoot === repoRoot) {
        return null;
    }
    const fallback = await findDefaultConfigPath(fallbackRoot);
    if (!fallback) {
        return null;
    }
    return { path: fallback, repoRoot: fallbackRoot };
}
async function findWorkspaceRoot(start) {
    let current = path.resolve(start);
    const root = path.parse(current).root;
    let fallbackGitDir;
    while (true) {
        if (await isWorkspaceRoot(current)) {
            return current;
        }
        if (!fallbackGitDir && (await pathExists(path.join(current, ".git")))) {
            fallbackGitDir = current;
        }
        if (current === root) {
            break;
        }
        current = path.dirname(current);
    }
    return fallbackGitDir;
}
async function findDefaultConfigPath(repoRoot) {
    for (const dir of DEFAULT_CONFIG_DIRS) {
        for (const filename of INDEX_FILENAMES) {
            const candidate = path.join(repoRoot, dir, filename);
            if (await pathExists(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
async function isWorkspaceRoot(dir) {
    if (await pathExists(path.join(dir, "pnpm-workspace.yaml"))) {
        return true;
    }
    if (await pathExists(path.join(dir, "pnpm-workspace.yml"))) {
        return true;
    }
    if (await pathExists(path.join(dir, "workspace.repos.json"))) {
        return true;
    }
    if (await pathExists(path.join(dir, "dev-wizard-config"))) {
        return true;
    }
    for (const candidate of ROOT_CONFIG_CANDIDATES) {
        if (await pathExists(path.join(dir, candidate))) {
            return true;
        }
    }
    const presetsRoot = path.join(dir, "packages", "dev-wizard-presets");
    return pathExists(presetsRoot);
}
async function collectConfigPickerCandidates(repoRoot) {
    const candidates = new Map();
    const addCandidate = (filePath, hint) => {
        const label = relativeToRepo(repoRoot, filePath);
        candidates.set(filePath, { path: filePath, label, hint });
    };
    for (const candidate of ROOT_CONFIG_CANDIDATES) {
        const absolute = path.join(repoRoot, candidate);
        if (await pathExists(absolute)) {
            addCandidate(absolute, "root config");
        }
    }
    for (const candidate of ROOT_CONFIG_CANDIDATES) {
        const localCandidate = candidate.replace("dev-wizard.config", "dev-wizard.config.local");
        const absolute = path.join(repoRoot, localCandidate);
        if (await pathExists(absolute)) {
            addCandidate(absolute, "local config");
        }
    }
    const configDir = path.join(repoRoot, "dev-wizard-config");
    if (await pathExists(configDir)) {
        const indexFiles = await findIndexConfigs(configDir, 3);
        for (const file of indexFiles) {
            addCandidate(file, "config overlay");
        }
    }
    const presetConfigs = await findPresetIndexConfigs(repoRoot);
    for (const file of presetConfigs) {
        addCandidate(file, "preset config");
    }
    const wizardConfigs = await findWizardConfigs(repoRoot);
    for (const file of wizardConfigs) {
        addCandidate(file, "wizard config");
    }
    return Array.from(candidates.values()).sort((a, b) => a.label.localeCompare(b.label));
}
async function findPresetIndexConfigs(repoRoot) {
    const presetsRoot = path.join(repoRoot, "packages", "dev-wizard-presets");
    if (!(await pathExists(presetsRoot))) {
        return [];
    }
    const entries = await readDirents(presetsRoot);
    const results = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        for (const filename of INDEX_FILENAMES) {
            const candidate = path.join(presetsRoot, entry.name, filename);
            if (await pathExists(candidate)) {
                results.push(candidate);
            }
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
}
async function findIndexConfigs(rootDir, maxDepth) {
    const results = [];
    const queue = [{ dir: rootDir, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            continue;
        }
        const { dir, depth } = current;
        let entries;
        try {
            entries = await readDirents(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (CONFIG_PICKER_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
                    continue;
                }
                if (depth + 1 <= maxDepth) {
                    queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
                }
                continue;
            }
            if (entry.isFile() && INDEX_FILENAMES.includes(entry.name)) {
                results.push(path.join(dir, entry.name));
            }
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
}
async function findWizardConfigs(repoRoot) {
    const results = [];
    const queue = [{ dir: repoRoot, depth: 0 }];
    const maxDepth = 6;
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
            continue;
        }
        const { dir, depth } = current;
        let entries;
        try {
            entries = await readDirents(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (CONFIG_PICKER_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) {
                    continue;
                }
                if (depth + 1 <= maxDepth) {
                    queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
                }
                continue;
            }
            if (entry.isFile() && isWizardConfigFile(entry.name)) {
                results.push(path.join(dir, entry.name));
            }
        }
    }
    return results.sort((a, b) => a.localeCompare(b));
}
function isWizardConfigFile(fileName) {
    return WIZARD_CONFIG_EXTENSIONS.some((extension) => fileName.endsWith(`.wizard${extension}`));
}
async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function readDirents(dir) {
    const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    return entries;
}
//# sourceMappingURL=runDevWizard.js.map
