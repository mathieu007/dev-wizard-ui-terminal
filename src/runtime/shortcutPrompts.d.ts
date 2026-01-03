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
export declare function selectWithShortcuts<Value>({ message, options, initialValue, maxItems, shortcuts, onShortcut, }: ShortcutSelectOptions<Value>): Promise<Value | symbol>;
