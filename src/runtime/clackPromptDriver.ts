import {
	confirm,
	isCancel,
	multiselect,
	select,
	text,
} from "@clack/prompts";

import type { PromptDriver } from "@ScaffoldStack/dev-wizard-engine/runtime/promptDriver.js";
import { PromptCancelledError } from "@ScaffoldStack/dev-wizard-engine/runtime/promptDriver.js";
import { createTextPromptWithHistory } from "./textPrompt.js";
import { orderedMultiselect } from "./prompts/orderedMultiselect.js";
import { selectWithShortcuts } from "./shortcutPrompts.js";

export class ClackPromptDriver implements PromptDriver {
	async text(options: {
		message: string;
		initialValue?: string;
		placeholder?: string;
		validate?: (value: string) => string | undefined;
	}): Promise<string> {
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

	async textWithHistory(options: {
		message: string;
		initialValue?: string;
		validate?: (value: string) => string | undefined;
		history: readonly string[];
	}): Promise<string> {
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

	async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean> {
		const result = await confirm({
			message: options.message,
			initialValue: options.initialValue,
		});
		if (isCancel(result)) {
			throw new PromptCancelledError();
		}
		return Boolean(result);
	}

	async select<Value extends string>(options: {
		message: string;
		options: Array<{ value: Value; label?: string; hint?: string }>;
		initialValue?: Value;
		maxItems?: number;
	}): Promise<Value> {
		const selectOptions = options.options.map((option) => ({
			value: option.value,
			label: option.label ?? String(option.value),
			hint: option.hint,
		}));
		const result = (await select({
			message: options.message,
			options: selectOptions as any,
			initialValue: options.initialValue,
			maxItems: options.maxItems,
		})) as Value | symbol;
		if (isCancel(result)) {
			throw new PromptCancelledError();
		}
		return result as Value;
	}

	async multiselect(options: {
		message: string;
		options: Array<{ value: string; label?: string; hint?: string }>;
		initialValues?: string[];
		required?: boolean;
		showSelectionOrder?: boolean;
		maxItems?: number;
	}): Promise<string[]> {
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
			return result as string[];
		}

		const multiSelectOptions = options.options.map((option) => ({
			value: option.value,
			label: option.label ?? option.value,
			hint: option.hint,
		}));
		const result = (await multiselect({
			message: options.message,
			options: multiSelectOptions as any,
			initialValues: options.initialValues,
			required: options.required,
			maxItems: options.maxItems,
		})) as string[] | symbol;
		if (isCancel(result)) {
			throw new PromptCancelledError();
		}
		return result as string[];
	}

	async selectWithShortcuts<Value extends string>(options: {
		message: string;
		options: Array<{ value: Value; label?: string; hint?: string }>;
		initialValue?: Value;
		maxItems?: number;
		shortcuts?: Array<{ key: string; value: Value; action: string }>;
		onShortcut?: (action: string) => void;
	}): Promise<Value> {
		const result = await selectWithShortcuts({
			message: options.message,
			options: options.options,
			initialValue: options.initialValue,
			maxItems: options.maxItems,
			shortcuts: options.shortcuts as any,
			onShortcut: options.onShortcut as any,
		});
		if (isCancel(result)) {
			throw new PromptCancelledError();
		}
		return result as Value;
	}
}
