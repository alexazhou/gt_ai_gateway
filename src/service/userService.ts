import {SgUser} from "../model/sgUser";


async function getUser(token:string):Promise<SgUser | null> {

    console.log("getUser",token);

    if(token != null){
        //let user:SgUser = new SgUser();

        const user = await SgUser.query().where('token', token).first();
        console.log("user:", user);

        //user.name = "default";
        //user.token = token;

        return user;
    }

    return null;
}

export default {
    getUser
}
