import { Model, HasUniqueIds } from 'sutando';
import { v4 as uuid } from 'uuid';

const BaseModel = HasUniqueIds(Model) as typeof Model;

class User extends BaseModel {
    table = 'user';

    id!: string;
    name!: string;
    token!: string;
    created_at!: Date;
    updated_at!: Date;

    newUniqueId(): string {
        return uuid();
    }
}


export {
    User
}