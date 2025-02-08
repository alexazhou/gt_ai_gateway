import {Model} from "sutando";


class SgModel extends Model {
    table = 'model';

    id!: number;

    name:string | null = null;
    vendor_id:string | null = null;  // vendor id

    created_at!: Date;
    updated_at!: Date;

}

export {
    SgModel
}