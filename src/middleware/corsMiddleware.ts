import { cors } from "hono/cors";

const allowCors = cors({
    origin: (origin) => {
        if (!origin) return "*";
        if (
            origin.startsWith("tauri://") ||
            origin.startsWith("http://tauri.localhost") ||
            origin.startsWith("http://localhost") ||
            origin.startsWith("http://127.0.0.1")
        ) {
            return origin;
        }
        return null;
    },
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
});

export default { allowCors };
