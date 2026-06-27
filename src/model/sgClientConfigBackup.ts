import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { ClientName } from "../constants";


import { ClientConfigFields } from "../service/clientConfigService/types";

type ClientConfigContent = ClientConfigFields | Record<string, string>;


class SgClientConfigBackup extends Model {
    table = "client_config_backup";

    id!: number;
    client!: ClientName;
    name!: string;
    configContent!: ClientConfigContent;
    enabled!: boolean;

    casts = {
        configContent: "json",
    };

    created_at!: Date;
    updated_at!: Date;


    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}


export default SgClientConfigBackup;
export type { ClientConfigContent };
