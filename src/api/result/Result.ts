export class Result<T = unknown> {
    private readonly data: T | null
    private readonly success: boolean
    private readonly code: string | null

    private constructor(data: T | null, success: boolean, code: string | null) {
        if (!success && code == null) throw new Error('当 success === false 时，code 不允许为 null')
        this.data = data
        this.success = success
        this.code = code
    }

    public getData(): T | null {
        return this.data
    }

    public isSuccess(): boolean {
        return this.success
    }

    public getCode(): string | null {
        return this.code
    }

    public static of<T>(data: T | null, success: boolean, code: string | null): Result<T> {
        return new Result<T>(data, success, code)
    }

    public static success<T = void>(): Result<T> {
        return Result.of<T>(null, true, null)
    }

    public static successWithCode<T = void>(code: string | null): Result<T> {
        return Result.of<T>(null, true, code)
    }

    public static successWithData<T>(data: T | null): Result<T> {
        return Result.of<T>(data, true, null)
    }

    public static successWithDataAndCode<T>(data: T | null, code: string | null): Result<T> {
        return Result.of<T>(data, true, code)
    }

    public static error<T = void>(code: string): Result<T> {
        return Result.of<T>(null, false, code)
    }

    public static errorWithData<T>(data: T | null, code: string): Result<T> {
        return Result.of<T>(data, false, code)
    }
}
