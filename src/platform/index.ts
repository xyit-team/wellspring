/*
 * 平台层入口
 *
 * 平台识别、目录解析与文件落盘；上层经本层读取 process.platform 与系统目录
 */

export * from "./clipboard.ts"
export * from "./exec.ts"
export * from "./file.ts"
export * from "./executable.ts"
export * from "./notification.ts"
export * from "./open-external.ts"
export * from "./os.ts"
export * from "./path.ts"
