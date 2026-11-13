import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const splashStartedAt = performance.now();
const backendStartingText = '正在启动中...';
const databaseMigratingText = '数据库升级中，请等待，不要关闭程序';

function splashLog(message: string) {
    const elapsedMs = Math.round(performance.now() - splashStartedAt);
    const logMessage = `[splash +${elapsedMs}ms] ${message}`;
    console.log(logMessage);
    invoke('log_to_rust', { msg: logMessage }).catch((error) => {
        console.warn('[splash] failed to send log to rust', error);
    });
}

async function initSplash() {
    const loadingState = document.getElementById('loadingState')!;
    const errorState = document.getElementById('errorState')!;
    const btnExit = document.getElementById('btnExit')!;
    const errorText = document.getElementById('errorText')!;
    const loadingText = document.getElementById('loadingText')!;

    let hasError = false;

    const formatError = (error: unknown): string => {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string') {
            return error;
        }
        const serialized = JSON.stringify(error);
        if (serialized) {
            return serialized;
        }
        return String(error);
    };

    const showInitializationError = (message: string) => {
        splashLog(`show initialization error: ${message}`);
        hasError = true;
        loadingState.style.display = 'none';
        errorState.style.display = 'flex';
        errorText.innerText = `初始化失败：${message}`;
    };

    const showBackendError = (code: unknown) => {
        splashLog(`show backend error: ${formatError(code)}`);
        hasError = true;
        loadingState.style.display = 'none';
        errorState.style.display = 'flex';

        if (code === 98) {
            errorText.innerHTML = `后端 <b>6722</b> 端口被占用。 请清理占用端口的进程，或者修改配置文件中的服务端口。`;
        } else if (typeof code === 'string') {
            errorText.innerText = code;
        } else {
            errorText.innerHTML = `后端异常退出 (代码：${code})`;
        }
    };

    btnExit.addEventListener('click', async () => {
        await invoke('exit_app');
    });

    try {
        await Promise.all([
            listen('backend-error', (event) => {
                splashLog(`backend-error event received, payload=${formatError(event.payload)}`);
                showBackendError(event.payload);
            }),
            listen('backend-migration-start', () => {
                loadingText.innerText = databaseMigratingText;
                splashLog('backend migration started');
            }),
            listen('backend-migration-end', () => {
                loadingText.innerText = backendStartingText;
                splashLog('backend migration ended');
            }),
        ]);

        splashLog('splash event listeners registered');

    } catch (e) {
        splashLog(`catch splash error: ${formatError(e)}`);
        if (!hasError) {
            showInitializationError(formatError(e));
        }
    }
}

initSplash().catch(console.error);
