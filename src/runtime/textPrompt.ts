import { TextPrompt } from "@clack/core";
import process from "node:process";
import color from "picocolors";

export interface TextPromptWithHistoryOptions {
	message: string;
	placeholder?: string;
	defaultValue?: string;
	initialValue?: string;
	validate?: (value: string) => string | void;
	history?: readonly string[];
}

const isUnicodeSupported = detectUnicodeSupport();

const STEP_SYMBOL_ACTIVE = isUnicodeSupported ? "◆" : "*";
const STEP_SYMBOL_CANCEL = isUnicodeSupported ? "■" : "x";
const STEP_SYMBOL_ERROR = isUnicodeSupported ? "▲" : "x";
const STEP_SYMBOL_SUBMIT = isUnicodeSupported ? "◇" : "o";

const BAR_SYMBOL = isUnicodeSupported ? "│" : "|";
const BAR_END_SYMBOL = isUnicodeSupported ? "└" : "—";

const STATE_SYMBOLS = {
	initial: color.cyan(STEP_SYMBOL_ACTIVE),
	active: color.cyan(STEP_SYMBOL_ACTIVE),
	cancel: color.red(STEP_SYMBOL_CANCEL),
	error: color.yellow(STEP_SYMBOL_ERROR),
	submit: color.green(STEP_SYMBOL_SUBMIT),
} as const;

function detectUnicodeSupport(): boolean {
	if (process.platform !== "win32") {
		return process.env.TERM !== "linux";
	}

	if (process.env.CI) return true;
	if (process.env.WT_SESSION) return true;
	if (process.env.TERMINUS_SUBLIME) return true;
	if (process.env.ConEmuTask === "{cmd::Cmder}") return true;
	if (process.env.TERM_PROGRAM === "Terminus-Sublime") return true;
	if (process.env.TERM_PROGRAM === "vscode") return true;
	if (process.env.TERM === "xterm-256color") return true;
	if (process.env.TERM === "alacritty") return true;
	if (process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;

	return false;
}

function buildPlaceholder(placeholder?: string): string {
	if (!placeholder || placeholder.length === 0) {
		return color.inverse(color.hidden("_"));
	}

	return (
		color.inverse(placeholder[0] ?? "") + color.dim(placeholder.slice(1))
	);
}

function clearLine(prompt: TextPrompt) {
	const rl = (prompt as unknown as { rl?: { write: (chunk: unknown, key?: unknown) => void } }).rl;
	if (!rl?.write) {
		return;
	}

	rl.write(null, { ctrl: true, name: "u" });
}

function writeLine(prompt: TextPrompt, value: string) {
	const rl = (prompt as unknown as { rl?: { write: (chunk: unknown, key?: unknown) => void } }).rl;
	if (!rl?.write) {
		return;
	}

	if (value.length > 0) {
		rl.write(value);
	}
}

export function createTextPromptWithHistory(
	options: TextPromptWithHistoryOptions,
): Promise<string | symbol> {
	const historyEntries = [...(options.history ?? [])];
	let historyIndex: number | undefined;
	let draftValue: string | undefined;

	const prompt = new TextPrompt({
		validate: options.validate
			? (value) => options.validate?.(String(value)) ?? undefined
			: undefined,
		placeholder: options.placeholder,
		defaultValue: options.defaultValue,
		initialValue: options.initialValue,
		render() {
			const state = this.state as keyof typeof STATE_SYMBOLS;
			const header = `${color.gray(BAR_SYMBOL)}
${STATE_SYMBOLS[state]}  ${options.message}
`;
			const placeholder = buildPlaceholder(options.placeholder);
			const currentValue = this.value ? this.valueWithCursor : placeholder;

			switch (this.state) {
				case "error":
					return (
						`${header.trim()}\n` +
						`${color.yellow(BAR_SYMBOL)}  ${currentValue}\n` +
						`${color.yellow(BAR_END_SYMBOL)}  ${color.yellow(this.error)}\n`
					);
				case "submit":
					return (
						header +
						`${color.gray(BAR_SYMBOL)}  ${color.dim(this.value || options.placeholder || "")}`
					);
				case "cancel": {
					const value = this.value ?? "";
					const suffix = value.trim().length > 0 ? `\n${color.gray(BAR_SYMBOL)}` : "";
					return (
						header +
						`${color.gray(BAR_SYMBOL)}  ${color.strikethrough(
							color.dim(value),
						)}${suffix}`
					);
				}
				default:
					return (
						header +
						`${color.cyan(BAR_SYMBOL)}  ${currentValue}\n` +
						`${color.cyan(BAR_END_SYMBOL)}\n`
					);
			}
		},
	});

	const applyHistoryValue = (value: string) => {
		clearLine(prompt);
		writeLine(prompt, value);
	};

	prompt.on("cursor", (direction?: string) => {
		if (direction !== "up" && direction !== "down") {
			return;
		}

		if (historyEntries.length === 0) {
			return;
		}

		if (direction === "up") {
			if (historyIndex === undefined) {
				draftValue = prompt.value ?? "";
				historyIndex = historyEntries.length - 1;
			} else if (historyIndex > 0) {
				historyIndex -= 1;
			}

			const nextValue = historyEntries[historyIndex];
			if (typeof nextValue === "string") {
				applyHistoryValue(nextValue);
			}
			return;
		}

		// direction === "down"
		if (historyIndex === undefined) {
			return;
		}

		if (historyIndex < historyEntries.length - 1) {
			historyIndex += 1;
			const nextValue = historyEntries[historyIndex];
			if (typeof nextValue === "string") {
				applyHistoryValue(nextValue);
			}
			return;
		}

		historyIndex = undefined;
		applyHistoryValue(draftValue ?? "");
	});

	prompt.on("finalize", () => {
		historyIndex = undefined;
		draftValue = undefined;
	});

	return prompt.prompt();
}
