import {User} from "../model/user";


async function getUser(token:string):Promise<User | null> {

    console.log("getUser",token);

    if(token != null){
        //let user:User = new User();

        const user = await User.query().where('token', token).first();
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
