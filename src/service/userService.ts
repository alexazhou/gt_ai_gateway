import { SgUser } from "../model/sgUser";

async function getUser(token: string): Promise<SgUser | null> {
    console.log("getUser", token);
    if (token == null) return null;

    return await SgUser.query().where("token", token).first();
}

export default {
    getUser,
};
