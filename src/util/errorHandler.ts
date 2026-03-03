import { Context } from "hono";


export class AppError extends Error {
    constructor(
        public message: string,
        public statusCode: number = 500,
        public code?: string,
    ) {
        super(message);
        this.name = "AppError";
    }
}


export class ValidationError extends AppError {
    constructor(message: string, code?: string) {
        super(message, 400, code || "VALIDATION_ERROR");
        this.name = "ValidationError";
    }
}


export class NotFoundError extends AppError {
    constructor(message: string) {
        super(message, 404, "NOT_FOUND");
        this.name = "NotFoundError";
    }
}


export class ConflictError extends AppError {
    constructor(message: string) {
        super(message, 409, "CONFLICT");
        this.name = "ConflictError";
    }
}


export class DuplicateError extends AppError {
    constructor(message: string) {
        super(message, 409, "DUPLICATE");
        this.name = "DuplicateError";
    }
}


export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}


export const errorHandler = async (c: Context, next: () => Promise<void>) => {
    try {
        await next();
    } catch (error) {
        console.error("[ErrorHandler] Error caught:", error);

        if (isAppError(error)) {
            return c.json(
                {
                    error: error.message,
                    code: error.code,
                },
                error.statusCode,
            );
        }

        // 处理未知错误
        return c.json(
            {
                error: "Internal server error",
                message: String(error),
            },
            500,
        );
    }
};