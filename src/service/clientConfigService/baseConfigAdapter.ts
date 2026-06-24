import type {
    ApplyClientConfigParams,
    ClientConfigStatus,
    ClientName,
    ConfigAdapter,
    FileSystemApi,
    PathApi,
} from "./types";
import configAdapterUtils from "./configAdapterUtils";


abstract class BaseConfigAdapter implements ConfigAdapter {
    // 注入 fs 和 path 的目的是为了跨环境兼容（例如在 Node.js 和 Tauri 前端直连时可能采用不同的 API实现）
    protected fs: FileSystemApi;
    protected path: PathApi;
    readonly client: ClientName;
    readonly displayName: string;
    readonly configPath: string;
    readonly backupPath: string;

    constructor(fs: FileSystemApi, path: PathApi, client: ClientName, displayName: string, configPath: string) {
        this.fs = fs;
        this.path = path;
        this.client = client;
        this.displayName = displayName;
        this.configPath = configPath;
        this.backupPath = `${configPath}.gt-ai-gateway.bak`;
    }


    protected async isInstalled(): Promise<boolean> {
        return await configAdapterUtils.pathExists(this.fs, this.path.dirname(this.configPath));
    }


    protected async readConfigFile(): Promise<string> {
        if (!(await configAdapterUtils.pathExists(this.fs, this.configPath))) {
            return "";
        }

        return await this.fs.readFile(this.configPath, "utf-8");
    }


    protected async writeConfigFile(content: string): Promise<void> {
        await this.fs.mkdir(this.path.dirname(this.configPath), { recursive: true });
        await configAdapterUtils.ensureBackup(this.fs, this.configPath, this.backupPath);
        await this.fs.writeFile(this.configPath, content, "utf-8");
    }


    abstract getStatus(): Promise<ClientConfigStatus>;


    abstract apply(params: ApplyClientConfigParams): Promise<ClientConfigStatus>;


    async restore(): Promise<ClientConfigStatus> {
        if (!(await configAdapterUtils.pathExists(this.fs, this.backupPath))) {
            throw new Error(`${this.displayName} backup file not found`);
        }

        await this.fs.copyFile(this.backupPath, this.configPath);
        return await this.getStatus();
    }
}


export default BaseConfigAdapter;
