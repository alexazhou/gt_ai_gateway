import { Context } from "hono";
import ormService from "../service/ormService";

function welcome(c: Context) {
    const message =
        ormService.mode === "cloud"
            ? "Hello, welcome to serverless ai gateway!"
            : "Hello, welcome to serverless ai gateway (local mode)!";
    return c.text(message);
}

export default {
    welcome,
};
