import {Model} from "sutando";


class ModelConfig extends Model {
    table = 'model_config';

    id!: number;

    name:string | null = null;
    vendor:string | null = null;  // vendor impl class
    url:string | null = null;

    created_at!: Date;
    updated_at!: Date;

}

export {
    ModelConfig
}