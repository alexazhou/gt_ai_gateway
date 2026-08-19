import { Context } from "hono";
import { UserType } from "../constants";
import userManager from "../manager/userManager";
import userService from "../service/userService";
import { createListResponse, parsePaginationQuery } from "../util/paginationUtil";
import maskUtil from "../util/maskUtil";

async function listUsers(c: Context) {
    const query = c.req.query();
    const { pageSize, offset } = parsePaginationQuery(query);

    const { list: users, total } = await userManager.list({
        type: query.type,
        keyword: query.keyword,
        pageSize,
        offset,
    });
    return c.json(createListResponse(users, total));
}

async function getUser(c: Context) {
    const id = c.req.param("id");
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const user = await userManager.findById(userId);

    if (!user) {
        return c.json({ error: "User not found" }, 404);
    }

    return c.json(user);
}

async function getUsersByIds(c: Context) {
    const body = await c.req.json();
    const ids = body.ids;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return c.json([]);
    }

    const idList = ids.map(id => parseInt(String(id), 10)).filter(id => !isNaN(id));
    if (idList.length === 0) {
        return c.json([]);
    }

    const users = await userManager.getByIds(idList);
    return c.json(users);
}

async function createUser(c: Context) {
    try {
        const body = await c.req.json();
        let { name, token, type } = body;

        if (token === null || token === undefined || token === "") {
            token = crypto.randomUUID();
        }

        // token 掩码进日志（前 4 位 + *），避免明文
        console.log("[userController] Creating user:", { name, type, token: maskUtil.maskToken(token) });

        const instance = await userManager.create({
            name,
            token,
            type: type || UserType.NORMAL,
        });

        console.log("[userController] User created successfully:", { id: instance.id, name: instance.name, type: instance.type, token: maskUtil.maskToken(instance.token) });
        return c.json(instance);
    } catch (error) {
        console.error("[userController] Error creating user:", error);
        return c.json(
            { error: "Failed to create user", message: String(error) },
            500,
        );
    }
}

async function updateUser(c: Context) {
    const id = c.req.param("id");
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const user = await userManager.findById(userId);

    if (!user) {
        return c.json({ error: "User not found" }, 404);
    }

    const body = await c.req.json();
    const { name, token, status } = body;

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) {
        updateData.name = name;
    }
    if (token !== undefined) {
        updateData.token = token === null || token === "" ? crypto.randomUUID() : token;
    }
    if (status !== undefined) {
        updateData.status = status;
    }

    if (Object.keys(updateData).length === 0) {
        return c.json(user);
    }

    const updatedUser = await userManager.update(userId, updateData);
    return c.json(updatedUser);
}

async function adjustBalance(c: Context) {
    const id = c.req.param("id");
    const userId = parseInt(id, 10);

    if (isNaN(userId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const body = await c.req.json();
    const { amount, type, remark } = body;

    if (typeof amount !== "number") {
        return c.json({ error: "Invalid amount" }, 400);
    }

    if (!type || (type !== "recharge" && type !== "adjustment")) {
        return c.json({ error: "Invalid type, must be 'recharge' or 'adjustment'" }, 400);
    }

    const updatedUser = await userService.adjustBalance(userId, amount, type, remark);
    return c.json(updatedUser);
}

export default {
    listUsers,
    getUser,
    getUsersByIds,
    createUser,
    updateUser,
    adjustBalance,
};
