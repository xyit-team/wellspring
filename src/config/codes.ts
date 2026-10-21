/** 配置错误码。字段级错误格式为 `${invalid}:<path>`，path 为英文点分路径 */
export const CONFIG_CODES = {
    readFailed: "config.read-failed",
    parseFailed: "config.parse-failed",
    invalid: "config.invalid",
    versionUnsupported: "config.version-unsupported",
    writeFailed: "config.write-failed",
} as const

export type ConfigCode = (typeof CONFIG_CODES)[keyof typeof CONFIG_CODES]

/** 字段级错误码，例如 config.invalid:logger.level */
export function invalidCode(path: string): string {
    return `${CONFIG_CODES.invalid}:${path}`
}
