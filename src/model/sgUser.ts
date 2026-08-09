import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { UserType, UserStatus } from "../constants";

class SgUser extends Model {
    table = "user";

    id!: number;
    name!: string;
    token!: string;
    type!: UserType;
    balance!: number; // 整数微元（0.000001 元 = 1 单位）；API 返回时换算为"元"
    status!: UserStatus;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgUser };
