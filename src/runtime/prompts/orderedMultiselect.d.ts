export interface OrderedMultiSelectOption {
    value: string;
    label?: string;
    hint?: string;
    disabled?: boolean;
}
export interface OrderedMultiSelectPromptOptions {
    message: string;
    options: OrderedMultiSelectOption[];
    initialValues?: string[];
    required?: boolean;
    cursorAt?: string;
}
export declare function orderedMultiselect(options: OrderedMultiSelectPromptOptions): Promise<string[] | symbol>;
