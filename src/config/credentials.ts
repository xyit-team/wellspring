/*
 * API Key 凭据（支持多个模型供应商）
 *
 * 与 app-setting.json 分开存放，文件为 <configDir>/credentials.json，权限 0600
 * v2 结构按供应商分槽，v1 只有 openai 槽
 * 读取顺序：显式参数 > 供应商指定的环境变量（内置为 OPENAI_API_KEY）> 本地凭据
 * 明文只进请求，界面与日志一律用掩码
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Result } from "../api/result/result.ts"
import { CONFIG_CODES } from "./codes.ts"
import { readJsonIfExists, writeJsonAtomic } from "../platform/file.ts"
import { readEnv } from "../platform/os.ts"
import { getPaths } from "../platform/path.ts"

/** 凭据文件在 config 根目录下的文件名 */
export const CREDENTIALS_FILE_NAME = "credentials.json"

/** 凭据文件结构版本；v2 增加 providers 分槽，v1 只认 openai */
export const CREDENTIALS_VERSION = 2

/** 单个 key 的长度上限 */
export const MAX_API_KEY_CHARS = 4096

/** 内置供应商的 id；它的 key 放在 openai 槽，兼容 v1 与 OPENAI_API_KEY */
export const BUILTIN_PROVIDER_ID = "openai"

/** 凭据文件结构；缺失的槽视为未配置 */
interface CredentialsFile {
    readonly version: number
    readonly openai?: { readonly apiKey?: string | null } | null
    readonly providers?: Readonly<Record<string, string | null>> | null
}

/** key 的来源：环境变量或本地凭据文件 */
export type ApiKeySource = "env" | "credentials"

export interface ResolvedApiKey {
    readonly apiKey: string
    readonly source: ApiKeySource
}

export interface ApiKeyStatus {
    readonly configured: boolean
    /** 当前生效来源；未配置为 null */
    readonly source: ApiKeySource | null
    /** 掩码后的 key，例如 `sk-…abcd`；未配置为 null */
    readonly masked: string | null
    /** 凭据文件路径 */
    readonly file: string
    /** 环境变量是否设置（设置时优先于文件） */
    readonly envOverride: boolean
    /** 本地凭据文件是否有 key；环境变量覆盖时仍为 true */
    readonly stored: boolean
}

/** 单个供应商的 Key 状态 */
export interface ProviderKeyStatus extends ApiKeyStatus {
    /** 供应商自己的环境变量名；内置为 OPENAI_API_KEY */
    readonly envVar: string | null
}

/** 供应商凭据来源描述（只用于解析，不含明文） */
export interface ProviderKeyRef {
    readonly id: string
    readonly apiKeyEnv: string | null
}

/** 默认凭据路径；测试/多环境时可显式传 configDir */
export function credentialsFile(configDir: string = getPaths().configDir): string {
    return join(configDir, CREDENTIALS_FILE_NAME)
}

/** 列表展示用的掩码；短 key 直接全遮 */
export function maskApiKey(apiKey: string): string {
    const trimmed = apiKey.trim()
    if (trimmed.length <= 8) {
        return "••••"
    }
    const head = trimmed.slice(0, 3)
    return `${head}…${trimmed.slice(-4)}`
}

/** 校验并规范化用户输入的 key；空白、含控制字符或超长都视为非法 */
export function normalizeApiKey(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null
    }
    const trimmed = raw.trim()
    if (trimmed === "" || trimmed.length > MAX_API_KEY_CHARS) {
        return null
    }
    if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
        return null
    }
    return trimmed
}

function parseCredentials(value: unknown): CredentialsFile | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null
    }
    const record = value as Record<string, unknown>
    const openaiRaw = record["openai"]
    const openai =
        typeof openaiRaw === "object" && openaiRaw !== null
            ? (openaiRaw as Record<string, unknown>)
            : null
    const providersRaw = record["providers"]
    const providers: Record<string, string | null> = {}
    if (typeof providersRaw === "object" && providersRaw !== null) {
        for (const [id, raw] of Object.entries(providersRaw as Record<string, unknown>)) {
            providers[id] = normalizeApiKey(raw)
        }
    }
    return {
        version: typeof record["version"] === "number" ? record["version"] : 1,
        openai: openai === null ? null : { apiKey: normalizeApiKey(openai["apiKey"]) },
        providers,
    }
}

function readFileValue(file: string): CredentialsFile | null {
    let text: string
    try {
        text = readFileSync(file, "utf8")
    } catch {
        return null
    }
    try {
        return parseCredentials(JSON.parse(text))
    } catch {
        return null
    }
}

async function readFileValueAsync(file: string): Promise<CredentialsFile | null> {
    try {
        return parseCredentials(await readJsonIfExists<unknown>(file))
    } catch {
        return null
    }
}

function storedKey(value: CredentialsFile | null, providerId: string): string | null {
    if (value === null) {
        return null
    }
    if (providerId === BUILTIN_PROVIDER_ID) {
        return normalizeApiKey(value.openai?.apiKey)
    }
    return normalizeApiKey(value.providers?.[providerId])
}

function envKey(provider: ProviderKeyRef): { apiKey: string; envVar: string } | null {
    const envVar =
        provider.apiKeyEnv ?? (provider.id === BUILTIN_PROVIDER_ID ? "OPENAI_API_KEY" : null)
    if (envVar === null) {
        return null
    }
    const raw = normalizeApiKey(readEnv(envVar))
    return raw === null ? null : { apiKey: raw, envVar }
}

/** 某个供应商本地保存的 key（同步） */
export function readProviderApiKeySync(
    providerId: string,
    file: string = credentialsFile(),
): string | null {
    return storedKey(readFileValue(file), providerId)
}

/** 某个供应商本地保存的 key（异步） */
export async function readProviderApiKey(
    providerId: string,
    file: string = credentialsFile(),
): Promise<string | null> {
    return storedKey(await readFileValueAsync(file), providerId)
}

/** 默认（内置 openai）供应商本地保存的 key */
export function readStoredApiKeySync(file: string = credentialsFile()): string | null {
    return readProviderApiKeySync(BUILTIN_PROVIDER_ID, file)
}

export async function readStoredApiKey(file: string = credentialsFile()): Promise<string | null> {
    return await readProviderApiKey(BUILTIN_PROVIDER_ID, file)
}

/** 解析某个供应商的 key：环境变量优先于本地凭据 */
export function resolveProviderApiKeySync(
    provider: ProviderKeyRef,
    file: string = credentialsFile(),
): ResolvedApiKey | null {
    const fromEnv = envKey(provider)
    if (fromEnv !== null) {
        return { apiKey: fromEnv.apiKey, source: "env" }
    }
    const stored = readProviderApiKeySync(provider.id, file)
    return stored === null ? null : { apiKey: stored, source: "credentials" }
}

/** 解析默认供应商的 key：OPENAI_API_KEY 优先于本地凭据 */
export function resolveApiKeySync(file: string = credentialsFile()): ResolvedApiKey | null {
    return resolveProviderApiKeySync({ id: BUILTIN_PROVIDER_ID, apiKeyEnv: null }, file)
}

/** 默认供应商的 Key 状态 */
export function apiKeyStatusSync(file: string = credentialsFile()): ApiKeyStatus {
    return providerKeyStatusSync({ id: BUILTIN_PROVIDER_ID, apiKeyEnv: null }, file)
}

/** 指定供应商的 Key 状态（掩码） */
export function providerKeyStatusSync(
    provider: ProviderKeyRef,
    file: string = credentialsFile(),
): ProviderKeyStatus {
    const resolved = resolveProviderApiKeySync(provider, file)
    const envVar =
        provider.apiKeyEnv ?? (provider.id === BUILTIN_PROVIDER_ID ? "OPENAI_API_KEY" : null)
    return {
        configured: resolved !== null,
        source: resolved?.source ?? null,
        masked: resolved === null ? null : maskApiKey(resolved.apiKey),
        file,
        envOverride: envKey(provider) !== null,
        stored: readProviderApiKeySync(provider.id, file) !== null,
        envVar,
    }
}

async function writeCredentials(file: string, value: CredentialsFile): Promise<Result<void>> {
    try {
        await writeJsonAtomic(file, value, { mode: 0o600 })
    } catch {
        return Result.error(CONFIG_CODES.credentialsWriteFailed)
    }
    return Result.success()
}

/** 保存某个供应商的 key；providerId=openai 时写内置槽 */
export async function saveProviderApiKey(
    providerId: string,
    raw: unknown,
    file: string = credentialsFile(),
): Promise<Result<void>> {
    const apiKey = normalizeApiKey(raw)
    if (apiKey === null) {
        return Result.error(CONFIG_CODES.invalidApiKey)
    }
    const current = readFileValue(file)
    if (providerId === BUILTIN_PROVIDER_ID) {
        return await writeCredentials(file, {
            version: CREDENTIALS_VERSION,
            openai: { apiKey },
            providers: current?.providers ?? {},
        })
    }
    return await writeCredentials(file, {
        version: CREDENTIALS_VERSION,
        openai: current?.openai ?? { apiKey: null },
        providers: { ...(current?.providers ?? {}), [providerId]: apiKey },
    })
}

/** 清除某个供应商的 key；内置槽清除后 OPENAI_API_KEY 仍可能生效 */
export async function clearProviderApiKey(
    providerId: string,
    file: string = credentialsFile(),
): Promise<Result<void>> {
    const current = readFileValue(file)
    if (providerId === BUILTIN_PROVIDER_ID) {
        return await writeCredentials(file, {
            version: CREDENTIALS_VERSION,
            openai: { apiKey: null },
            providers: current?.providers ?? {},
        })
    }
    const providers: Record<string, string | null> = { ...(current?.providers ?? {}) }
    delete providers[providerId]
    return await writeCredentials(file, {
        version: CREDENTIALS_VERSION,
        openai: current?.openai ?? { apiKey: null },
        providers,
    })
}

/** 保存默认供应商的 key（兼容旧调用） */
export async function saveStoredApiKey(
    raw: unknown,
    file: string = credentialsFile(),
): Promise<Result<void>> {
    return await saveProviderApiKey(BUILTIN_PROVIDER_ID, raw, file)
}

/** 清除默认供应商的本地 key（兼容旧调用） */
export async function clearStoredApiKey(file: string = credentialsFile()): Promise<Result<void>> {
    return await clearProviderApiKey(BUILTIN_PROVIDER_ID, file)
}
