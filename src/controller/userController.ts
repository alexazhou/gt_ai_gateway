import { Context } from "hono";
import { SgUser } from "../model/sgUser";

async function listUsers(c: Context) {
    const users = await SgUser.query().get();
    return c.json(users);
}

async function getUser(c: Context) {
    const { id } = c.req.param();

    const user = await SgUser.query().find(id);

    if (!user) {
        return c.json({ error: "User not found" }, 404);
    }

    return c.json(user);
}

async function createUser(c: Context) {
    try {
        const body = await c.req.json();
        let { name, token } = body;

        if (token === null || token === undefined || token === "") {
            token = crypto.randomUUID();
        }

        console.log("[userController] Creating user:", { name, token });

        const instance = await SgUser.query().create({
            name,
            token,
        });

        console.log("[userController] User created successfully:", instance);
        return c.json(instance);
    } catch (error) {
        console.error("[userController] Error creating user:", error);
        return c.json(
            { error: "Failed to create user", message: String(error) },
            500,
        );
    }
}

export default {
    listUsers,
    getUser,
    createUser,
};
