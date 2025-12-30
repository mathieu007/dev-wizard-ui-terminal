import { describe, expect, it, vi } from "vitest";

vi.mock("@clack/core", () => {
	const instances: MockTextPrompt[] = [];

	class MockTextPrompt {
		public value = "";
		public state: "initial" | "active" | "submit" | "cancel" | "error" = "initial";
		public rl = {
			write: vi.fn((chunk: unknown, key?: { ctrl?: boolean; name?: string }) => {
				if (chunk === null && key?.ctrl && key?.name === "u") {
					this.value = "";
					return;
				}

				if (typeof chunk === "string") {
					this.value = chunk;
				}
			}),
		};
		private handlers = new Map<string, (payload?: unknown) => void>();
		private resolve?: (value: string | symbol) => void;

		constructor(_options: unknown) {
			instances.push(this);
		}

		on(event: string, handler: (payload?: unknown) => void) {
			this.handlers.set(event, handler);
		}

		emit(event: string, payload?: unknown) {
			const handler = this.handlers.get(event);
			handler?.call(this, payload);
		}

		prompt(): Promise<string | symbol> {
			return new Promise((resolve) => {
				this.resolve = resolve;
			});
		}

		submit(value: string | symbol) {
			this.resolve?.(value);
		}
	}

	return {
		TextPrompt: MockTextPrompt,
		__getLastPromptInstance: () => instances[instances.length - 1],
	};
});

describe("createTextPromptWithHistory", () => {
	it("replays prompt history entries with arrow keys and restores the draft on exit", async () => {
		const { createTextPromptWithHistory } = await import("../runtime/textPrompt.js");
		const promptPromise = createTextPromptWithHistory({
			message: "Enter input",
			history: ["first", "second", "third"],
		});

		const coreModule = (await import("@clack/core")) as unknown as {
			__getLastPromptInstance: () => {
				value: string;
				rl: { write: ReturnType<typeof vi.fn> };
				emit(event: string, payload?: unknown): void;
				submit(value: string | symbol): void;
			};
		};
		const prompt = coreModule.__getLastPromptInstance();
		expect(prompt).toBeDefined();

		prompt.emit("cursor", "up");
		expect(prompt.rl.write).toHaveBeenNthCalledWith(1, null, { ctrl: true, name: "u" });
		expect(prompt.rl.write).toHaveBeenNthCalledWith(2, "third");

		prompt.emit("cursor", "up");
		expect(prompt.rl.write).toHaveBeenNthCalledWith(3, null, { ctrl: true, name: "u" });
		expect(prompt.rl.write).toHaveBeenNthCalledWith(4, "second");

		prompt.emit("down", "unused"); // unrelated event should be ignored
		expect(prompt.rl.write).toHaveBeenCalledTimes(4);

		prompt.emit("cursor", "down");
		expect(prompt.rl.write).toHaveBeenNthCalledWith(5, null, { ctrl: true, name: "u" });
		expect(prompt.rl.write).toHaveBeenNthCalledWith(6, "third");

		prompt.emit("cursor", "down");
		expect(prompt.rl.write).toHaveBeenNthCalledWith(7, null, { ctrl: true, name: "u" });
		expect(prompt.value).toBe("");

		prompt.emit("finalize");
		prompt.submit("done");
		await expect(promptPromise).resolves.toBe("done");
	});
});
