import { SelectPrompt } from "@clack/core";
import process from "node:process";
import pc from "picocolors";

export type ShortcutAction = "skip-step" | "replay-command" | "safe-abort";

export interface ShortcutConfig<Value> {
	key: string;
	value: Value;
	action: ShortcutAction;
}

export interface ShortcutSelectOption<Value> {
	value: Value;
	label?: string;
	hint?: string;
}

export interface ShortcutSelectOptions<Value> {
	message: string;
	options: ShortcutSelectOption<Value>[];
	initialValue?: Value;
	maxItems?: number;
	shortcuts?: ShortcutConfig<Value>[];
	onShortcut?: (action: ShortcutAction) => void;
}

const unicodeSupported = detectUnicodeSupport();
const pickUnicode = (unicode: string, fallback: string) =>
	unicodeSupported ? unicode : fallback;

const ICON_PRIMARY = pickUnicode("♦", "*");
const ICON_WARN = pickUnicode("■", "x");
const ICON_ERROR = pickUnicode("▲", "x");
const ICON_SUCCESS = pickUnicode("◇", "o");
const FRAME_TOP = pickUnicode("┌", "T");
const FRAME_SIDE = pickUnicode("│", "|");
const FRAME_BOTTOM = pickUnicode("└", "—");
const OPTION_ACTIVE = pickUnicode("●", ">");
const OPTION_INACTIVE = pickUnicode("○", " ");

function detectUnicodeSupport(): boolean {
	if (process.platform !== "win32") {
		return process.env.TERM !== "linux";
	}
	return Boolean(process.env.CI) ||
		Boolean(process.env.WT_SESSION) ||
		Boolean(process.env.TERMINUS_SUBLIME) ||
		process.env.ConEmuTask === "{cmd::Cmder}" ||
		process.env.TERM_PROGRAM === "Terminus-Sublime" ||
		process.env.TERM_PROGRAM === "vscode" ||
		process.env.TERM === "xterm-256color" ||
		process.env.TERM === "alacritty" ||
		process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}

function formatStateIcon(state: "initial" | "active" | "cancel" | "submit" | "error"): string {
	switch (state) {
		case "cancel":
			return pc.red(ICON_WARN);
		case "submit":
			return pc.green(ICON_SUCCESS);
		case "error":
			return pc.yellow(ICON_ERROR);
		default:
			return pc.cyan(ICON_PRIMARY);
	}
}

function formatOption<Value>(
	option: ShortcutSelectOption<Value>,
	state: "active" | "inactive" | "selected" | "cancelled",
): string {
	const label = option.label ?? String(option.value);
	const hint = option.hint ? ` ${pc.dim(`(${option.hint})`)}` : "";

	switch (state) {
		case "active":
			return `${pc.green(OPTION_ACTIVE)} ${label}${hint}`;
		case "selected":
			return `${pc.dim(label)}${hint}`;
		case "cancelled":
			return `${pc.strikethrough(pc.dim(label))}${hint}`;
		default:
			return `${pc.dim(OPTION_INACTIVE)} ${pc.dim(label)}${hint}`;
	}
}

export async function selectWithShortcuts<Value>({
	message,
	options,
	initialValue,
	maxItems,
	shortcuts,
	onShortcut,
}: ShortcutSelectOptions<Value>): Promise<Value | symbol> {
	let windowStart = 0;
	const visibleRows = typeof maxItems === "number" ? Math.max(maxItems, 5) : undefined;
	const shortcutMap = new Map<string, ShortcutConfig<Value>>();

	if (shortcuts) {
		for (const shortcut of shortcuts) {
			shortcutMap.set(shortcut.key, shortcut);
		}
	}

	const prompt = new SelectPrompt<ShortcutSelectOption<Value>>({
		options,
		initialValue,
		render() {
			const header = `${pc.gray(FRAME_SIDE)}
${formatStateIcon(this.state)}  ${message}
`;

			if (this.state === "submit") {
				return `${header}${pc.gray(FRAME_SIDE)}  ${formatOption(this.options[this.cursor], "selected")}`;
			}

			if (this.state === "cancel") {
				return `${header}${pc.gray(FRAME_SIDE)}  ${formatOption(this.options[this.cursor], "cancelled")}
${pc.gray(FRAME_SIDE)}`;
			}

			const pageSize = visibleRows ?? Infinity;
			if (this.cursor >= windowStart + pageSize - 3) {
				windowStart = Math.max(
					Math.min(this.cursor - pageSize + 3, this.options.length - pageSize),
					0,
				);
			} else if (this.cursor < windowStart + 2) {
				windowStart = Math.max(this.cursor - 2, 0);
			}

			const hasWindow = pageSize < this.options.length;
			const showAbove = hasWindow && windowStart > 0;
			const showBelow = hasWindow && windowStart + pageSize < this.options.length;
			const list = this.options
				.slice(windowStart, windowStart + pageSize)
				.map((option, index, array) => {
					if (index === 0 && showAbove) {
						return pc.dim("...");
					}
					if (index === array.length - 1 && showBelow) {
						return pc.dim("...");
					}
					const globalIndex = index + windowStart;
					return formatOption(
						option,
						globalIndex === this.cursor ? "active" : "inactive",
					);
				})
				.join(`\n${pc.cyan(FRAME_SIDE)}  `);

			return `${header}${pc.cyan(FRAME_SIDE)}  ${list}
${pc.cyan(FRAME_BOTTOM)}`;
		},
	});

	if (shortcutMap.size > 0) {
		prompt.on("key", (keyValue?: string) => {
			if (!keyValue) {
				return;
			}
			const shortcut = shortcutMap.get(keyValue);
			if (!shortcut || prompt.state === "submit") {
				return;
			}
			prompt.value = shortcut.value;
			onShortcut?.(shortcut.action);
			prompt.state = "submit";
			prompt.emit("finalize");
			prompt.emit("submit", shortcut.value);
			(prompt as unknown as { close(): void }).close();
		});
	}

	return prompt.prompt() as Promise<Value | symbol>;
}
