import type { PromptDriver } from "@ScaffoldStack/dev-wizard-engine/runtime/promptDriver.js";
export declare class ClackPromptDriver implements PromptDriver {
    text(options: {
        message: string;
        initialValue?: string;
        placeholder?: string;
        validate?: (value: string) => string | undefined;
    }): Promise<string>;
    textWithHistory(options: {
        message: string;
        initialValue?: string;
        validate?: (value: string) => string | undefined;
        history: readonly string[];
    }): Promise<string>;
    confirm(options: {
        message: string;
        initialValue?: boolean;
    }): Promise<boolean>;
    select<Value extends string>(options: {
        message: string;
        options: Array<{
            value: Value;
            label?: string;
            hint?: string;
        }>;
        initialValue?: Value;
        maxItems?: number;
    }): Promise<Value>;
    multiselect(options: {
        message: string;
        options: Array<{
            value: string;
            label?: string;
            hint?: string;
        }>;
        initialValues?: string[];
        required?: boolean;
        showSelectionOrder?: boolean;
        maxItems?: number;
    }): Promise<string[]>;
    selectWithShortcuts<Value extends string>(options: {
        message: string;
        options: Array<{
            value: Value;
            label?: string;
            hint?: string;
        }>;
        initialValue?: Value;
        maxItems?: number;
        shortcuts?: Array<{
            key: string;
            value: Value;
            action: string;
        }>;
        onShortcut?: (action: string) => void;
    }): Promise<Value>;
}
