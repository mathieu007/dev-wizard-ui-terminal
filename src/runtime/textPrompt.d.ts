export interface TextPromptWithHistoryOptions {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    initialValue?: string;
    validate?: (value: string) => string | void;
    history?: readonly string[];
}
export declare function createTextPromptWithHistory(options: TextPromptWithHistoryOptions): Promise<string | symbol>;
