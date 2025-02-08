import { Model } from 'sutando';
import { v4 as uuid } from 'uuid';


class SgVendor extends Model {
    table = 'vendor';

    id!: number;
    type!: string;
    name!: string;
    token!: string;
    url!: string;

    created_at!: Date;
    updated_at!: Date;
}


export {
    SgVendor
}