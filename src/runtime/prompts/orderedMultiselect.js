import { MultiSelectPrompt } from "@clack/core";
import pc from "picocolors";
export async function orderedMultiselect(options) {
    const prompt = new MultiSelectPrompt({
        options: options.options,
        initialValues: options.initialValues,
        cursorAt: options.cursorAt,
        required: options.required ?? true,
        validate(value) {
            if ((options.required ?? true) && value.length === 0) {
                return "Select at least one option.";
            }
            return undefined;
        },
        render() {
            return renderOrderedPrompt(this, options.message);
        },
    });
    const result = (await prompt.prompt());
    return result;
}
function renderOrderedPrompt(prompt, message) {
    const header = `${pc.gray("│")}
${formatState(prompt.state)}  ${message}
`;
    if (prompt.state === "submit") {
        return (header +
            `${pc.gray("│")}  ` +
            formatSubmission(prompt.value, prompt.options));
    }
    if (prompt.state === "cancel") {
        return header + `${pc.gray("│")}  ${pc.strikethrough("selection cancelled")}\n`;
    }
    const lines = prompt.options.map((option, index) => renderOption(prompt, option, index));
    const body = lines
        .map((line) => `${pc.cyan("│")}  ${line}`)
        .join("\n");
    if (prompt.state === "error" && prompt.error) {
        const errorBlock = `${pc.yellow("│")}  ${pc.yellow(prompt.error)}`;
        return `${header}${body}\n${errorBlock}\n`;
    }
    return `${header}${body}\n${pc.cyan("└")}\n`;
}
function renderOption(prompt, option, index) {
    const baseLabel = option.label ?? String(option.value);
    const selectedIndex = prompt.value.indexOf(option.value);
    const isSelected = selectedIndex !== -1;
    const pointer = prompt.cursor === index ? pc.cyan("❯") : " ";
    const orderBadge = isSelected
        ? pc.green(`[${selectedIndex + 1}]`)
        : pc.dim("[ ]");
    const labelColor = prompt.cursor === index ? (isSelected ? pc.white : pc.cyan) : pc.dim;
    const label = labelColor(baseLabel);
    const hint = option.hint ? ` ${pc.dim(`(${option.hint})`)}` : "";
    return `${pointer} ${orderBadge} ${label}${hint}`;
}
function formatSubmission(values, options) {
    if (values.length === 0) {
        return pc.dim("none selected");
    }
    const lookup = new Map(options.map((opt) => [opt.value, opt.label ?? opt.value]));
    return values
        .map((value, index) => pc.dim(`${index + 1}. ${lookup.get(value) ?? value}`))
        .join(pc.dim(", "));
}
function formatState(state) {
    switch (state) {
        case "submit":
            return pc.green("◇");
        case "cancel":
            return pc.red("■");
        case "error":
            return pc.yellow("▲");
        default:
            return pc.cyan("◆");
    }
}
//# sourceMappingURL=orderedMultiselect.js.map