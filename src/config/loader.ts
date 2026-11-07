/*
 * 配置读写
 *
 * 路径为配置目录下的 app-setting.json；缺文件时写入默认值
 * 失败时 code 说明原因，getData() 返回默认配置，由调用方决定是否继续启动
 */

import { join } from "node:path"

import { Result } from "../api/result/result.ts"
import { readTextIfExists, writeJsonAtomic } from "../platform/file.ts"
import { getPaths } from "../platform/path.ts"
import { CONFIG_CODES } from "./codes.ts"
import { DEFAULT_SETTINGS } from "./defaults.ts"
import type { AppSetting } from "./types.ts"
import { validateSettings } from "./validate.ts"

/** 配置文件在 config 根目录下的文件名 */
export const SETTING_FILE_NAME = "app-setting.json"

/** 默认配置路径 */
export function settingsFile(): string {
    return join(getPaths().configDir, SETTING_FILE_NAME)
}

/** 读取配置；文件不存在时创建默认配置 */
export async function loadSettings(file: string = settingsFile()): Promise<Result<AppSetting>> {
    let text: string | null
    try {
        text = await readTextIfExists(file)
    } catch {
        return Result.errorWithData<AppSetting>(DEFAULT_SETTINGS, CONFIG_CODES.readFailed)
    }

    if (text === null) {
        return await writeDefaults(file)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        // 解析失败保留原文件
        return Result.errorWithData<AppSetting>(DEFAULT_SETTINGS, CONFIG_CODES.parseFailed)
    }

    const validated = validateSettings(parsed)
    if (!validated.isSuccess()) {
        return Result.errorWithData<AppSetting>(
            DEFAULT_SETTINGS,
            validated.getCode() ?? CONFIG_CODES.invalid,
        )
    }
    return validated
}

/** 校验后原子写回；字段不合法时不落盘 */
export async function saveSettings(
    settings: AppSetting,
    file: string = settingsFile(),
): Promise<Result<void>> {
    const validated = validateSettings(settings)
    if (!validated.isSuccess()) {
        return Result.error(validated.getCode() ?? CONFIG_CODES.invalid)
    }
    try {
        await writeJsonAtomic(file, validated.getData())
    } catch {
        return Result.error(CONFIG_CODES.writeFailed)
    }
    return Result.success()
}

async function writeDefaults(file: string): Promise<Result<AppSetting>> {
    try {
        await writeJsonAtomic(file, DEFAULT_SETTINGS)
    } catch {
        return Result.errorWithData<AppSetting>(DEFAULT_SETTINGS, CONFIG_CODES.writeFailed)
    }
    return Result.successWithData<AppSetting>(DEFAULT_SETTINGS)
}
