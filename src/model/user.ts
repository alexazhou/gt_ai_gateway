import { Model } from 'sutando';
import { v4 as uuid } from 'uuid';


class User extends Model {
    table = 'user';

    id!: number;
    name!: string;
    token!: string;

    created_at!: Date;
    updated_at!: Date;

}


export {
    User
}