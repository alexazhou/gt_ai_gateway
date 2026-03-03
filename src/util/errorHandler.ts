import { Context } from "hono";


export class AppError extends Error {
    constructor(
        public message: string,
        public statusCode: number = 400,
        public code?: string,
    ) {
        super(message);
        this.name = "AppError";
    }
}


export class NotFoundError extends AppError {
    constructor(message: string) {
        super(message, 404, "NOT_FOUND");
        this.name = "NotFoundError";
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