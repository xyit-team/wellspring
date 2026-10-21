/** 入参错误码，退出码统一为 2 */
export const USAGE_CODES = {
    unknownCommand: "usage.unknown-command",
    unknownOption: "usage.unknown-option",
    unknownSubcommand: "usage.unknown-subcommand",
    missingValue: "usage.missing-value",
    invalidValue: "usage.invalid-value",
    missingContext: "usage.missing-context",
    invalidSessionId: "usage.invalid-session-id",
    unknownConfigKey: "usage.unknown-config-key",
    conflictingOptions: "usage.conflicting-options",
    missingConfirmation: "usage.missing-confirmation",
} as const

export function usageCode(code: string, detail?: string): string {
    return detail === undefined || detail === "" ? code : `${code}:${detail}`
}

export function isUsageCode(code: string | null): boolean {
    return code !== null && code.startsWith("usage.")
}
