# Dev Wizard Terminal UI

Terminal prompt driver and interactive runner for Dev Wizard. This package supplies the `runDevWizard` entry point and the `ClackPromptDriver` implementation, layering terminal UX on top of `@ScaffoldStack/dev-wizard-engine`.

## Usage

```ts
import { runDevWizard } from "@ScaffoldStack/ui-terminal";

const result = await runDevWizard({
  configPath: ["dev-wizard-config/index.yaml"],
  scenario: "hello-world",
  stdout: process.stdout,
  stderr: process.stderr,
});

if (result.exitCode !== 0) {
  // handle failures
}
```

Prefer `@ScaffoldStack/dev-wizard-engine` for non-interactive tooling or custom UIs.

## Publishing

The terminal UI package is versioned and released alongside `@ScaffoldStack/dev-wizard-engine` and `@ScaffoldStack/dev-wizard-cli`.
