/*
 * 平台层入口。
 * 平台识别、目录解析与文件落盘；上层不直接读取 process.platform 或拼接系统目录。
 */

export * from "./clipboard.ts"
export * from "./exec.ts"
export * from "./file.ts"
export * from "./notification.ts"
export * from "./open-external.ts"
export * from "./os.ts"
export * from "./path.ts"
