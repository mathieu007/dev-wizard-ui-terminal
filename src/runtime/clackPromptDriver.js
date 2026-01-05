import { confirm, isCancel, multiselect, select, text, } from "@clack/prompts";
import { PromptCancelledError } from "@ScaffoldStack/dev-wizard-engine/runtime/promptDriver.js";
import { createTextPromptWithHistory } from "./textPrompt.js";
import { orderedMultiselect } from "./prompts/orderedMultiselect.js";
import { selectWithShortcuts } from "./shortcutPrompts.js";
export class ClackPromptDriver {
    async text(options) {
        const result = await text({
            message: options.message,
            initialValue: options.initialValue,
            placeholder: options.placeholder,
            validate: options.validate,
        });
        if (isCancel(result)) {
            throw new PromptCancelledError();
        }
        return result;
    }
    async textWithHistory(options) {
        const result = await createTextPromptWithHistory({
            message: options.message,
            initialValue: options.initialValue,
            validate: options.validate,
            history: options.history,
        });
        if (isCancel(result)) {
            throw new PromptCancelledError();
        }
        return result;
    }
    async confirm(options) {
        const result = await confirm({
            message: options.message,
            initialValue: options.initialValue,
        });
        if (isCancel(result)) {
            throw new PromptCancelledError();
        }
        return Boolean(result);
    }
    async select(options) {
        const selectOptions = options.options.map((option) => ({
            value: option.value,
            label: option.label ?? String(option.value),
            hint: option.hint,
        }));
        const result = (await select({
            message: options.message,
            options: selectOptions,
            initialValue: options.initialValue,
            maxItems: options.maxItems,
        }));
        if (isCancel(result)) {
            throw new PromptCancelledError();
        }
        return result;
    }
    async multiselect(options) {
        if (options.showSelectionOrder) {
            const result = await orderedMultiselect({
                message: options.message,
                options: options.options,
                initialValues: options.initialValues,
                required: options.required,
            });
            if (isCancel(result)) {
                throw new PromptCancelledError();
            }
            return result;
        }
        const multiSelectOptions = options.options.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
            hint: option.hint,
        }));
        const result = (await multiselect({
            message: options.message,
            options: multiSelectOptions,
            initialValues: options.initialValues,
            required: options.required,
            maxItems: options.maxItems,
        }));
        if (isCancel(result)) {
            throw new PromptCancelledError();
        }
        return result;
    }
    async selectWithShortcuts(options) {
        const result = await selectWithShortcuts({
            message: options.message,
            options: options.options,
            initialValue: options.initialValue,
            maxItems: options.maxItems,
            shortcuts: options.shortcuts,
            onShortcut: options.onShortcut,
        });
        if (isCancel(result)) {
            throw new PromptCancelledError();
        }
        return result;
    }
}
//# sourceMappingURL=clackPromptDriver.js.map