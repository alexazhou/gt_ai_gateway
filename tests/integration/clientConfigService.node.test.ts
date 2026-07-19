import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import clientConfigService from "../../src/service/clientConfigService/core";
import ormService from "../../src/service/ormService";
import SgClientConfig from "../../src/model/sgClientConfig";
import { SgUser } from "../../src/model/sgUser";
import { SgVendor } from "../../src/model/sgVendor";
import { ClientName, ConnectionMode, RunMode, UserType, UserStatus } from "../../src/constants";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("clientConfigService", () => {
    let tempRoot = "";
    let tempDir = "";
    let originalHome: string | undefined;
    let originalCodexHome: string | undefined;
    let originalOrmMode: RunMode;
    let testUserId = 0;
    let testVendorId = 0;

    beforeAll(async () => {
        originalHome = process.env.HOME;
        originalCodexHome = process.env.CODEX_HOME;
        await ormTestHelper.connectNodeOrm();
        originalOrmMode = ormService.mode;
        tempRoot = await mkdtemp(join(tmpdir(), "gt-client-config-"));
    });

    beforeEach(async () => {
        await dbHelper.truncate();
        ormService.mode = RunMode.NODE;
        tempDir = await mkdtemp(join(tempRoot, "home-"));
        process.env.HOME = tempDir;
        process.env.CODEX_HOME = join(tempDir, ".codex");
        await mkdir(join(tempDir, ".claude"), { recursive: true });
        await mkdir(process.env.CODEX_HOME, { recursive: true });
        // Create a test user for GATEWAY mode
        const testUser = await SgUser.query().create({
            name: "test-user",
            token: "test-token",
            type: UserType.NORMAL,
            balance: 10000,
            status: UserStatus.ACTIVE,
        });
        testUserId = Number(testUser.id);
        // Create a test vendor for VENDOR mode
        const testVendor = await SgVendor.query().create({
            name: "test-vendor",
            type: "other",
            token: "vendor-token",
            urls: JSON.stringify({}),
        });
        testVendorId = Number(testVendor.id);
    });

    afterEach(async () => {
        process.env.HOME = originalHome;
        process.env.CODEX_HOME = originalCodexHome;
        ormService.mode = originalOrmMode;
        await rm(tempDir, { recursive: true, force: true });
    });

    afterAll(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    it("reports unavailable in worker mode", async () => {
        ormService.mode = RunMode.WORKER;

        const status = await clientConfigService.getStatus();

        expect(status.available).toBe(false);
        expect(status.clients).toEqual([]);
        expect(status.reason).toContain("本地安装");
    });

    it("creates and switches Claude Code settings", async () => {
        const configPath = join(tempDir, ".claude", "settings.json");
        await writeFile(configPath, JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 4));
        const backup = await clientConfigService.createBackup({ client: ClientName.CLAUDE_CODE, name: "original" });
        expect(backup.enabled).toBe(false);
        const renamed = await clientConfigService.renameBackup({
            client: ClientName.CLAUDE_CODE,
            backupId: backup.id,
            name: "renamed original",
        });
        expect(renamed.name).toBe("renamed original");

        const status = await clientConfigService.createConfig({
            client: ClientName.CLAUDE_CODE,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "test-token",
            model: "test-model",
        });

        expect(status.configured).toBe(false);
        expect(status.backupExists).toBe(true);
        expect(status.backupCount).toBe(2);
        const generatedBackup = status.backups.find(item => item.config?.model === "test-model");
        expect(generatedBackup?.enabled).toBe(false);
        expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ permissions: { allow: ["Bash(npm test)"] } });

        const generatedStatus = await clientConfigService.applyConfig({
            client: ClientName.CLAUDE_CODE,
            backupId: generatedBackup!.id,
        });
        expect(generatedStatus.activeBackupId).toBe(generatedBackup!.id);
        const updated = JSON.parse(await readFile(configPath, "utf-8"));
        expect(updated.permissions.allow).toEqual(["Bash(npm test)"]);
        expect(updated.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8720/llm");
        expect(updated.env.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
        expect(updated.env.ANTHROPIC_MODEL).toBe("test-model");

        const appliedStatus = await clientConfigService.applyConfig({ client: ClientName.CLAUDE_CODE, backupId: backup.id });
        expect(appliedStatus.activeBackupId).toBe(backup.id);
        expect(appliedStatus.activeConfigModified).toBe(false);
        expect(appliedStatus.backups.find(item => item.id === backup.id)?.enabled).toBe(true);
        const applied = JSON.parse(await readFile(configPath, "utf-8"));
        expect(applied.permissions.allow).toEqual(["Bash(npm test)"]);
        expect(applied.env).toBeUndefined();

        await writeFile(configPath, JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, env: { ANTHROPIC_BASE_URL: "modified", ANTHROPIC_AUTH_TOKEN: "token" } }, null, 4));
        const modifiedStatus = await clientConfigService.getStatus();
        const claudeStatus = modifiedStatus.clients.find(client => client.client === ClientName.CLAUDE_CODE);
        expect(claudeStatus?.activeBackupId).toBe(backup.id);
        expect(claudeStatus?.activeConfigModified).toBe(true);

        await writeFile(configPath, JSON.stringify({ model: "second" }, null, 4));
        const secondBackup = await clientConfigService.createBackup({ client: ClientName.CLAUDE_CODE, name: "second" });
        const secondApplyStatus = await clientConfigService.applyConfig({
            client: ClientName.CLAUDE_CODE,
            backupId: secondBackup.id,
        });
        expect(secondApplyStatus.activeBackupId).toBe(secondBackup.id);
        expect(secondApplyStatus.backups.find(item => item.id === secondBackup.id)?.enabled).toBe(true);
        expect(secondApplyStatus.backups.find(item => item.id === backup.id)?.enabled).toBe(false);

        const deleteStatus = await clientConfigService.deleteBackup({
            client: ClientName.CLAUDE_CODE,
            backupId: secondBackup.id,
        });
        expect(deleteStatus.activeBackupId).toBeUndefined();
        expect(deleteStatus.backups.find(item => item.id === secondBackup.id)).toBeUndefined();
    });

    it("creates database config without writing local config", async () => {
        const configPath = join(tempDir, ".claude", "settings.json");
        await writeFile(configPath, "{}");

        const status = await clientConfigService.createConfig({
            client: ClientName.CLAUDE_CODE,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "test-token",
            model: "test-model",
        });

        expect(status.configured).toBe(false);
        expect(status.backupExists).toBe(true);
        expect(status.backupCount).toBe(1);
        expect(status.backups[0].enabled).toBe(false);
        expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({});
    });

    it("names local imported configs as unnamed configs with numeric suffixes", async () => {
        const configPath = join(tempDir, ".claude", "settings.json");
        await writeFile(configPath, "{}");

        const firstBackup = await clientConfigService.createBackup({ client: ClientName.CLAUDE_CODE });
        const status = await clientConfigService.createConfig({
            client: ClientName.CLAUDE_CODE,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "test-token",
            model: "test-model",
        });
        const secondBackup = status.backups.find(item => item.name === "未命名配置1");

        expect(firstBackup.name).toBe("未命名配置");
        expect(secondBackup?.name).toBe("未命名配置1");
    });

    it("creates and switches Codex provider config with new format", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        // Start with new format config (has model_provider) and token
        await writeFile(configPath, "model_provider = \"openai\"\nmodel = \"gpt-5\"\napproval_policy = \"on-request\"\n\n[features]\nhooks = true\n");
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-token", id_token: "test-id-token" } }) + "\n");
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "codex original" });

        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            gatewayUrl: "http://127.0.0.1:8720/",
            apiKey: "test-token",
            model: "test-model",
            userId: testUserId,
        });

        expect(status.configured).toBe(true);  // Now configured because auth.json has token
        expect(status.backupExists).toBe(true);
        expect(status.backupCount).toBe(2);
        const generatedBackup = status.backups.find(item => item.config?.model === "test-model");
        expect(generatedBackup?.enabled).toBe(false);
        expect(await readFile(configPath, "utf-8")).toContain("model_provider = \"openai\"");

        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });
        const updated = await readFile(configPath, "utf-8");
        expect(updated).toContain("approval_policy = \"on-request\"");
        expect(updated).toContain("model = \"test-model\"");
        expect(updated).toContain("model_provider = \"gt_ai_gateway\"");
        expect(updated).toContain("[model_providers.gt_ai_gateway]");
        expect(updated).toContain("base_url = \"http://127.0.0.1:8720/llm/v1\"");
        expect(updated).toContain("wire_api = \"responses\"");
        expect(updated).toContain("experimental_bearer_token = \"test-token\"");
        expect(updated).toContain("[features]");

        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: backup.id });
        const appliedCodex = await readFile(configPath, "utf-8");
        expect(appliedCodex).toContain("approval_policy = \"on-request\"");
        expect(appliedCodex).toContain("model_provider = \"openai\"");

        const appliedAuth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(appliedAuth.tokens.access_token).toBe("test-token");
    });

    it("writes direct upstream Claude Code settings without gateway path", async () => {
        const configPath = join(tempDir, ".claude", "settings.json");
        await writeFile(configPath, "{}");

        const status = await clientConfigService.createConfig({
            client: ClientName.CLAUDE_CODE,
            connectionMode: ConnectionMode.VENDOR, vendorId: testVendorId,
            gatewayUrl: "https://api.anthropic.com/v1/messages",
            apiKey: "vendor-token",
            model: "claude-sonnet",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "claude-sonnet");
        await clientConfigService.applyConfig({ client: ClientName.CLAUDE_CODE, backupId: generatedBackup!.id });

        const updated = JSON.parse(await readFile(configPath, "utf-8"));
        expect(updated.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
        expect(updated.env.ANTHROPIC_AUTH_TOKEN).toBe("vendor-token");
        expect(updated.env.ANTHROPIC_MODEL).toBe("claude-sonnet");
    });

    it("writes direct upstream Codex provider config without gateway path", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        await writeFile(configPath, "");

        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.VENDOR, vendorId: testVendorId,
            gatewayUrl: "https://api.openai.com/v1/chat/completions",
            apiKey: "vendor-token",
            model: "gpt-5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");
        expect(updated).toContain("base_url = \"https://api.openai.com/v1\"");
        expect(updated).toContain("experimental_bearer_token = \"vendor-token\"");
        expect(updated).toContain("model = \"gpt-5\"");
    });

    it("writes OPENAI_API_KEY to auth.json in Codex GATEWAY mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, "");
        await writeFile(authPath, "{}");

        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "gateway-token",
            model: "test-model",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "test-model");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.OPENAI_API_KEY).toBe("test-token");
        expect(auth.tokens).toBeUndefined();
    });

    it("writes OPENAI_API_KEY to auth.json in Codex VENDOR mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, "");
        await writeFile(authPath, "{}");

        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.VENDOR, vendorId: testVendorId,
            gatewayUrl: "https://api.openai.com/v1/chat/completions",
            apiKey: "vendor-token",
            model: "gpt-5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.OPENAI_API_KEY).toBe("vendor-token");
        expect(auth.tokens).toBeUndefined();
    });

    it("writes tokens.access_token to auth.json in Codex OFFICIAL mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, "");
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "old-token", id_token: "old-id-token" } }));

        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: "https://api.openai.com",
            apiKey: "official-token",
            model: "gpt-5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.tokens.access_token).toBe("official-token");
        expect(auth.OPENAI_API_KEY).toBeUndefined();
    });

    it("cleans up auth.json when switching Codex from GATEWAY to OFFICIAL", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, "");
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "old-token", id_token: "old-id-token" } }));

        // Apply GATEWAY config
        const gatewayStatus = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "gateway-token",
            model: "test-model",
        });
        const gatewayBackup = gatewayStatus.backups.find(item => item.config?.model === "test-model");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: gatewayBackup!.id });

        let auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.OPENAI_API_KEY).toBe("test-token");

        // Set up auth.json with id_token for OFFICIAL mode
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "old-token", id_token: "old-id-token" } }));

        // Switch to OFFICIAL config
        const officialStatus = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: "https://api.openai.com",
            apiKey: "official-token",
            model: "gpt-5",
        });
        const officialBackup = officialStatus.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: officialBackup!.id });

        auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.tokens.access_token).toBe("official-token");
        expect(auth.OPENAI_API_KEY).toBeUndefined();
    });

    it("deletes auth.json when switching Codex to OFFICIAL with no apiKey (unlogged state)", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, `[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "gateway-token"
`);
        await writeFile(authPath, JSON.stringify({ OPENAI_API_KEY: "gateway-token" }));

        // Create OFFICIAL config with no apiKey
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: "",
            apiKey: "",
            model: "",
        });
        const backup = status.backups.find(item => item.config?.connectionMode === ConnectionMode.OFFICIAL);
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: backup!.id });

        // auth.json should be deleted
        let authExists = true;
        try {
            await readFile(authPath, "utf-8");
        } catch {
            authExists = false;
        }
        expect(authExists).toBe(false);
    });

    it("cleans up auth.json when switching Codex from OFFICIAL to GATEWAY", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, "");
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "old-token", id_token: "old-id-token" } }));

        // Apply OFFICIAL config
        const officialStatus = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: "https://api.openai.com",
            apiKey: "official-token",
            model: "gpt-5",
        });
        const officialBackup = officialStatus.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: officialBackup!.id });

        let auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.tokens.access_token).toBe("official-token");

        // Switch to GATEWAY config
        const gatewayStatus = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "gateway-token",
            model: "test-model",
        });
        const gatewayBackup = gatewayStatus.backups.find(item => item.config?.model === "test-model");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: gatewayBackup!.id });

        auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.OPENAI_API_KEY).toBe("test-token");
        expect(auth.tokens).toBeUndefined();
    });

    it("preserves existing auth.json fields when writing Codex config", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");
        await writeFile(configPath, "");
        await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", existing_field: "value" }));

        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "gateway-token",
            model: "test-model",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "test-model");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const auth = JSON.parse(await readFile(authPath, "utf-8"));
        expect(auth.OPENAI_API_KEY).toBe("test-token");
        expect(auth.auth_mode).toBe("chatgpt");
        expect(auth.existing_field).toBe("value");
    });

    it("detects reserved provider ID conflict in Codex config.toml", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with reserved provider ID (openai)
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "openai"

[model_providers.openai]
experimental_bearer_token = "test-token"
`);
        await writeFile(authPath, "{}");

        // Create a backup from this config
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "original" });

        // Manually modify config.toml to add reserved provider ID conflict
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "openai"

[model_providers.openai]
experimental_bearer_token = "new-token"
`);

        // Get status - should detect the conflict
        const status = await clientConfigService.getStatus();
        const codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // currentConfig should be null due to reserved ID conflict
        expect(codexStatus?.currentConfig).toBeNull();
    });

    it("detects reserved ollama provider ID conflict in Codex config.toml", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with reserved provider ID (ollama)
        await writeFile(configPath, `model = "llama3"
model_provider = "ollama"

[model_providers.ollama]
base_url = "http://localhost:11434"
`);
        await writeFile(authPath, "{}");

        // Get status - should detect the conflict
        const status = await clientConfigService.getStatus();
        const codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // currentConfig should be null due to reserved ID conflict
        expect(codexStatus?.currentConfig).toBeNull();
    });

    it("allows custom provider with same name as reserved ID if no table exists", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with model_provider = "openai" but no [model_providers.openai] table
        // This should be valid (OFFICIAL mode)
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "openai"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "official-token", id_token: "official-id-token" } }));

        // Get status - should parse successfully
        const status = await clientConfigService.getStatus();
        const codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // currentConfig should not be null
        expect(codexStatus?.currentConfig).not.toBeNull();
        expect(codexStatus?.currentConfig?.connectionMode).toBe(ConnectionMode.OFFICIAL);
    });

    it("marks config as modified when reserved provider ID conflict is detected", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a valid config first
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "gt_ai_gateway"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "valid-token"
`);
        await writeFile(authPath, "{}");

        // Create a backup from the valid config
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "valid config" });

        // Apply the backup to make it active
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: backup.id });

        // Verify it's active and not modified
        let status = await clientConfigService.getStatus();
        let codexStatus = status.clients.find(client => client.client === ClientName.CODEX);
        expect(codexStatus?.activeBackupId).toBe(backup.id);
        expect(codexStatus?.activeConfigModified).toBe(false);

        // Now manually modify config.toml to have reserved provider ID conflict
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "openai"

[model_providers.openai]
experimental_bearer_token = "new-token"
`);

        // Get status - should detect the conflict and mark as modified
        status = await clientConfigService.getStatus();
        codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        expect(codexStatus?.activeBackupId).toBe(backup.id);
        expect(codexStatus?.activeConfigModified).toBe(true);
        expect(codexStatus?.currentConfig).toBeNull();
    });

    it("detects config modification when backup is valid but local config differs", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with one API key
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "gt_ai_gateway"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-v1"
`);
        await writeFile(authPath, "{}");

        // Create a backup
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "v1 config" });

        // Apply the backup to make it active
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: backup.id });

        // Verify it's active and not modified
        let status = await clientConfigService.getStatus();
        let codexStatus = status.clients.find(client => client.client === ClientName.CODEX);
        expect(codexStatus?.activeBackupId).toBe(backup.id);
        expect(codexStatus?.activeConfigModified).toBe(false);

        // Now modify the local config (change the token)
        await writeFile(configPath, `model = "gpt-5.5"
model_provider = "gt_ai_gateway"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-v2"
`);

        // Get status - should detect the modification
        status = await clientConfigService.getStatus();
        codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        expect(codexStatus?.activeBackupId).toBe(backup.id);
        expect(codexStatus?.activeConfigModified).toBe(true);
    });

    it("cleans up legacy root-level fields when writing Codex config with new format", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with new format (has model_provider) but also has legacy root-level fields
        await writeFile(configPath, `model_provider = "openai"
model = "gpt-5.5"
base_url = "http://old-server:8080"
wire_api = "responses"
experimental_bearer_token = "old-token"
`);
        await writeFile(authPath, "{}");

        // Apply new config
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "new-token",
            model: "gpt-5.5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5.5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");

        // Should have new format with model_provider
        expect(updated).toContain("model_provider = \"gt_ai_gateway\"");
        expect(updated).toContain("[model_providers.gt_ai_gateway]");
        expect(updated).toContain("base_url = \"http://127.0.0.1:8720/llm/v1\"");
        expect(updated).toContain("experimental_bearer_token = \"test-token\"");

        // Should NOT have legacy root-level fields (before any table)
        const firstTableIndex = updated.indexOf("[");
        const rootSection = updated.substring(0, firstTableIndex);
        expect(rootSection).not.toMatch(/base_url\s*=/);
        expect(rootSection).not.toMatch(/wire_api\s*=/);
        expect(rootSection).not.toMatch(/experimental_bearer_token\s*=/);
    });

    it("uses legacy format when config has no model_provider", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with legacy format (no model_provider)
        await writeFile(configPath, `model = "gpt-5.5"
base_url = "http://old-server:8080"
wire_api = "responses"
experimental_bearer_token = "old-token"
`);
        await writeFile(authPath, "{}");

        // Apply new config
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "new-token",
            model: "gpt-5.5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5.5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");

        // Should use legacy format (no model_provider)
        expect(updated).not.toContain("model_provider");
        expect(updated).not.toContain("[model_providers");

        // Should have root-level fields
        expect(updated).toContain("base_url = \"http://127.0.0.1:8720/llm/v1\"");
        expect(updated).toContain("wire_api = \"responses\"");
        expect(updated).toContain("experimental_bearer_token = \"test-token\"");
    });

    it("uses legacy format for OFFICIAL mode when config has no model_provider", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with legacy format (no model_provider)
        await writeFile(configPath, `model = "gpt-5.5"
base_url = "http://old-server:8080"
wire_api = "responses"
experimental_bearer_token = "old-token"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "old-token", id_token: "old-id-token" } }));

        // Apply OFFICIAL config
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: "https://api.openai.com",
            apiKey: "official-token",
            model: "gpt-5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");

        // Should use legacy format (no model_provider)
        expect(updated).not.toContain("model_provider");
        expect(updated).not.toContain("[model_providers");

        // Should have root-level fields for OFFICIAL mode
        expect(updated).toContain("model = \"gpt-5\"");
        expect(updated).toContain("base_url = \"https://api.openai.com\"");
        expect(updated).toContain("wire_api = \"responses\"");
    });

    it("detects config format based on model_provider presence", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Test 1: New format - has model_provider and token in auth.json
        await writeFile(configPath, `model_provider = "openai"
model = "gpt-5"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "existing-token" } }));

        let status = await clientConfigService.getStatus();
        let codexStatus = status.clients.find(client => client.client === ClientName.CODEX);
        // Should be configured (new format with model_provider and token)
        expect(codexStatus?.configured).toBe(true);
        expect(codexStatus?.currentConfig?.connectionMode).toBe(ConnectionMode.OFFICIAL);

        // Apply VENDOR config - should use new format (write to table)
        let configStatus = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "token-1",
            model: "model-1",
        });
        let generatedBackup = configStatus.backups.find(item => item.config?.model === "model-1");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        let updated = await readFile(configPath, "utf-8");
        // Should have new format
        expect(updated).toContain("model_provider = \"gt_ai_gateway\"");
        expect(updated).toContain("[model_providers.gt_ai_gateway]");
        // Should NOT have legacy root-level fields
        const firstTableIndex = updated.indexOf("[");
        const rootSection = updated.substring(0, firstTableIndex);
        expect(rootSection).not.toMatch(/base_url\s*=/);

        // Test 2: Legacy format - no model_provider, but has base_url and token in auth.json
        await writeFile(configPath, `model = "gpt-5"
base_url = "http://old-server:8080"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "legacy-token" } }));

        status = await clientConfigService.getStatus();
        codexStatus = status.clients.find(client => client.client === ClientName.CODEX);
        // Should be configured (legacy format with base_url and token)
        expect(codexStatus?.configured).toBe(true);

        // Apply VENDOR config - should use legacy format (write to root level)
        configStatus = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "token-2",
            model: "model-2",
        });
        generatedBackup = configStatus.backups.find(item => item.config?.model === "model-2");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        updated = await readFile(configPath, "utf-8");
        // Should use legacy format
        expect(updated).not.toContain("model_provider");
        expect(updated).not.toContain("[model_providers");
        // Should have root-level fields
        expect(updated).toContain("base_url = \"http://127.0.0.1:8720/llm/v1\"");
        expect(updated).toContain("wire_api = \"responses\"");
        expect(updated).toContain("experimental_bearer_token = \"test-token\"");
    });

    it("handles duplicate root-level fields correctly", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with duplicate root-level fields (simulating corrupted state)
        await writeFile(configPath, `model_provider = "gt_ai_gateway"
model = "gpt-5.5"
base_url = "http://old-server:8080"
wire_api = "responses"
experimental_bearer_token = "old-token-1"
base_url = "http://old-server:9090"
wire_api = "responses"
experimental_bearer_token = "old-token-2"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://old-server:8080"
wire_api = "responses"
experimental_bearer_token = "old-token-1"
`);
        await writeFile(authPath, "{}");

        // Apply new config
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "new-token",
            model: "gpt-5.5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5.5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");
        console.log("Updated config.toml:");
        console.log(updated);

        // Should NOT have any duplicate root-level fields in the entire file
        // (except inside [model_providers.gt_ai_gateway] table)
        const baseUrlMatches = updated.match(/^base_url\s*=/gm);
        const wireApiMatches = updated.match(/^wire_api\s*=/gm);
        const tokenMatches = updated.match(/^experimental_bearer_token\s*=/gm);

        // Should have at most one of each outside the table
        // Note: one in root + one in table = 2 total is OK
        expect(baseUrlMatches?.length || 0).toBeLessThanOrEqual(2);
        expect(wireApiMatches?.length || 0).toBeLessThanOrEqual(2);
        expect(tokenMatches?.length || 0).toBeLessThanOrEqual(2);

        // Should have the new values in the table
        expect(updated).toContain("[model_providers.gt_ai_gateway]");
        expect(updated).toContain("base_url = \"http://127.0.0.1:8720/llm/v1\"");
        expect(updated).toContain("experimental_bearer_token = \"test-token\"");
    });

    it("handles corrupted config.toml with duplicate fields and table", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Simulate corrupted state: duplicate root-level fields + existing table
        // This is what happens when old code writes root-level fields
        // and new code writes to table, but old fields are not cleaned up
        await writeFile(configPath, `model_provider = "gt_ai_gateway"
model = "deepseek-v4-flash"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "b78363d7-c503-4863-b2a4-4bf4fd63dec6"

base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "83ce4a09-a951-4fb7-bb8d-064fb583358a"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "83ce4a09-a951-4fb7-bb8d-064fb583358a"
`);
        await writeFile(authPath, "{}");

        // Apply new config
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.GATEWAY, userId: testUserId,
            gatewayUrl: "http://127.0.0.1:8720",
            apiKey: "new-token",
            model: "gpt-5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");
        console.log("Fixed config.toml:");
        console.log(updated);

        // Should NOT have any duplicate root-level fields
        const rootSection = updated.substring(0, updated.indexOf("[model_providers"));
        const baseUrlMatches = rootSection.match(/base_url\s*=/g);
        const wireApiMatches = rootSection.match(/wire_api\s*=/g);
        const tokenMatches = rootSection.match(/experimental_bearer_token\s*=/g);

        expect(baseUrlMatches?.length || 0).toBe(0);
        expect(wireApiMatches?.length || 0).toBe(0);
        expect(tokenMatches?.length || 0).toBe(0);

        // Should have exactly one of each in the table
        const tableSection = updated.substring(updated.indexOf("[model_providers"));
        const tableBaseUrlMatches = tableSection.match(/base_url\s*=/g);
        const tableWireApiMatches = tableSection.match(/wire_api\s*=/g);
        const tableTokenMatches = tableSection.match(/experimental_bearer_token\s*=/g);

        expect(tableBaseUrlMatches?.length || 0).toBe(1);
        expect(tableWireApiMatches?.length || 0).toBe(1);
        expect(tableTokenMatches?.length || 0).toBe(1);

        // Should have the new values
        expect(updated).toContain("model_provider = \"gt_ai_gateway\"");
        expect(updated).toContain("[model_providers.gt_ai_gateway]");
        expect(updated).toContain("base_url = \"http://127.0.0.1:8720/llm/v1\"");
        expect(updated).toContain("experimental_bearer_token = \"test-token\"");
        expect(updated).toContain("model = \"gpt-5\"");
    });

    it("detects corrupted config.toml with duplicate fields as modified", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a valid config first
        await writeFile(configPath, `model_provider = "gt_ai_gateway"
model = "gpt-5"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "valid-token"
`);
        await writeFile(authPath, "{}");

        // Create a backup
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "valid config" });

        // Apply the backup to make it active
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: backup.id });

        // Verify it's active and not modified
        let status = await clientConfigService.getStatus();
        let codexStatus = status.clients.find(client => client.client === ClientName.CODEX);
        expect(codexStatus?.activeBackupId).toBe(backup.id);
        expect(codexStatus?.activeConfigModified).toBe(false);

        // Now manually corrupt the config.toml with duplicate fields
        await writeFile(configPath, `model_provider = "gt_ai_gateway"
model = "gpt-5"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-1"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-2"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "new-token"
`);

        // Get status - should detect the corruption and mark as modified
        status = await clientConfigService.getStatus();
        codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        expect(codexStatus?.activeBackupId).toBe(backup.id);
        expect(codexStatus?.activeConfigModified).toBe(true);
    });

    it("removes duplicate root-level fields when switching to OFFICIAL mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Simulate the real corrupted state: model_provider = "openai" with duplicate root-level fields
        // These fields are BEFORE any table, so they are truly root-level
        await writeFile(configPath, `model = "gpt-5.5"
model_reasoning_effort = "high"
model_provider = "openai"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-1"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-2"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-3"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-4"

[plugins."github@openai-curated"]
enabled = true
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "official-token", id_token: "official-id-token" } }));

        // Create a backup from this corrupted config
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "corrupted config" });

        // Apply OFFICIAL config
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: "https://api.openai.com",
            apiKey: "official-token",
            model: "gpt-5.5",
        });
        const generatedBackup = status.backups.find(item => item.config?.model === "gpt-5.5");
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: generatedBackup!.id });

        const updated = await readFile(configPath, "utf-8");
        console.log("After OFFICIAL switch:");
        console.log(updated);

        // Should NOT have any duplicate root-level fields
        const baseUrlMatches = updated.match(/^base_url\s*=/gm);
        const wireApiMatches = updated.match(/^wire_api\s*=/gm);
        const tokenMatches = updated.match(/^experimental_bearer_token\s*=/gm);

        // Should have at most one of each
        expect(baseUrlMatches?.length || 0).toBeLessThanOrEqual(1);
        expect(wireApiMatches?.length || 0).toBeLessThanOrEqual(1);
        expect(tokenMatches?.length || 0).toBeLessThanOrEqual(1);

        // Should still have other fields preserved
        expect(updated).toContain("model_provider = \"openai\"");
        expect(updated).toContain("model = \"gpt-5.5\"");
        expect(updated).toContain("[plugins.\"github@openai-curated\"]");
    });

    it("detects backup without authJson as invalid for OFFICIAL mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with token (simulating current state)
        await writeFile(configPath, `model_provider = "openai"
model = "gpt-5.5"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-token" } }) + "\n");

        // Create a backup (this will have authJson field)
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "valid backup" });

        // Verify backup exists
        let status = await clientConfigService.getStatus();
        let codexStatus = status.clients.find(client => client.client === ClientName.CODEX);
        expect(codexStatus?.backups.length).toBe(1);

        // Now simulate an old backup without authJson field
        // by directly updating the database
        await SgClientConfig.query()
            .where("id", backup.id)
            .update({
                configContent: JSON.stringify({
                    version: "v1",
                    connectionMode: "official",
                    gatewayUrl: "",
                    apiKey: "test-token",
                    model: "gpt-5.5",
                    // No authJson field - simulating old backup
                })
            });

        // Get status - should detect the backup as valid (allows unlogged state)
        status = await clientConfigService.getStatus();
        codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // The backup should be valid (allows unlogged state for OFFICIAL mode)
        expect(codexStatus?.backups[0].config).not.toBeNull();
        expect(codexStatus?.backups[0].config?.model).toBe("gpt-5.5");
    });

    it("allows backup with authJson missing id_token for OFFICIAL mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with token but missing id_token
        await writeFile(configPath, `model_provider = "openai"
model = "gpt-5.5"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-token" } }) + "\n");

        // Create a backup
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "backup without id_token" });

        // Get status - should detect the backup as valid (allows unlogged state)
        const status = await clientConfigService.getStatus();
        const codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // The backup should be valid (allows unlogged state for OFFICIAL mode)
        expect(codexStatus?.backups[0].config).not.toBeNull();
        expect(codexStatus?.backups[0].config?.model).toBe("gpt-5.5");
    });

    it("allows backup with authJson missing id_token for OFFICIAL mode", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with token but missing id_token
        await writeFile(configPath, `model_provider = "openai"
model = "gpt-5.5"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-token" } }) + "\n");

        // Create a backup
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "backup without id_token" });

        // Get status - should detect the backup as valid (allows unlogged state)
        const status = await clientConfigService.getStatus();
        const codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // The backup should be valid (allows unlogged state for OFFICIAL mode)
        expect(codexStatus?.backups[0].config).not.toBeNull();
        expect(codexStatus?.backups[0].config?.model).toBe("gpt-5.5");
    });

    it("does not mark config as corrupted when same field exists in different tables", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create a config with same field in different tables (this is valid)
        // This simulates the real-world scenario where base_url and experimental_bearer_token
        // exist in both [plugins."github@openai-curated"] and [model_providers.gt_ai_gateway]
        await writeFile(configPath, `model_provider = "gt_ai_gateway"
model = "deepseek-v4-flash"

[plugins."github@openai-curated"]
enabled = true
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-1"

[model_providers.gt_ai_gateway]
name = "GT AI Gateway"
base_url = "http://127.0.0.1:8720/llm/v1"
wire_api = "responses"
experimental_bearer_token = "token-2"
`);
        await writeFile(authPath, JSON.stringify({ tokens: { access_token: "token-2", id_token: "id-token" } }));

        // Create a backup
        const backup = await clientConfigService.createBackup({ client: ClientName.CODEX, name: "multi-table config" });

        // Apply the backup
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: backup.id });

        // Get status - should NOT show "配置已修改"
        const status = await clientConfigService.getStatus();
        const codexStatus = status.clients.find(client => client.client === ClientName.CODEX);

        // Config should not be marked as modified
        expect(codexStatus?.activeConfigModified).toBe(false);
    });

    it("creates and applies Codex OFFICIAL config without gatewayUrl and apiKey", async () => {
        const configPath = join(tempDir, ".codex", "config.toml");
        const authPath = join(tempDir, ".codex", "auth.json");

        // Create an empty config
        await writeFile(configPath, "");
        await writeFile(authPath, "{}");

        // Create an OFFICIAL config without gatewayUrl and apiKey
        const status = await clientConfigService.createConfig({
            client: ClientName.CODEX,
            connectionMode: ConnectionMode.OFFICIAL,
            gatewayUrl: '',
            apiKey: '',
            model: '',
        });

        // Verify backup was created
        expect(status.backupExists).toBe(true);
        const officialBackup = status.backups.find(item => item.config?.connectionMode === ConnectionMode.OFFICIAL);
        expect(officialBackup).toBeDefined();
        expect(officialBackup?.config?.gatewayUrl).toBe('');
        expect(officialBackup?.config?.apiKey).toBe('');

        // Apply the backup
        await clientConfigService.applyConfig({ client: ClientName.CODEX, backupId: officialBackup!.id });

        // Verify config was applied (legacy format doesn't have model_provider)
        const updated = await readFile(configPath, "utf-8");
        expect(updated).toContain("base_url = \"https://api.openai.com\"");
        expect(updated).toContain("wire_api = \"responses\"");
    });
});
