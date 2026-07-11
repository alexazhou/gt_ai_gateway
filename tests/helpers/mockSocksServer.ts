/**
 * Mock SOCKS5 Server
 *
 * 最简单的 SOCKS5 正向代理，仅支持 CONNECT 命令。
 * 用于测试供应商 SOCKS5 代理配置的端到端流程。
 */
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { createServer, Socket } from "net";
import { URL } from "url";


const DEFAULT_SOCKS_PORT = 9996;
const DEFAULT_QUERY_PORT = 10096;

let server: ReturnType<typeof createServer> | null = null;
let queryServer: ReturnType<typeof createHttpServer> | null = null;
let isRunning = false;

// 记录经过代理的连接
let forwardedConnections: Array<{
    host: string;
    port: number;
    timestamp: string;
}> = [];


function createSocksServer(): ReturnType<typeof createServer> {
    return createServer((clientSocket: Socket) => {
        handleClient(clientSocket);
    });
}


function handleClient(clientSocket: Socket): void {
    // SOCKS5 握手阶段
    clientSocket.once("data", (data: Buffer) => {
        if (data.length < 2 || data[0] !== 0x05) {
            clientSocket.destroy();
            return;
        }

        // 回复：无认证需求
        clientSocket.write(Buffer.from([0x05, 0x00]));

        // 等待 CONNECT 请求
        clientSocket.once("data", (req: Buffer) => {
            handleConnectRequest(clientSocket, req);
        });
    });

    clientSocket.on("error", () => {
        clientSocket.destroy();
    });
}


function handleConnectRequest(clientSocket: Socket, req: Buffer): void {
    // VER CMD RSV ATYP DST.ADDR DST.PORT
    if (req.length < 7 || req[0] !== 0x05 || req[1] !== 0x01) {
        // 只支持 CONNECT (0x01)
        sendReply(clientSocket, 0x07); // Command not supported
        return;
    }

    const atyp = req[3];
    let host: string;
    let port: number;
    let headerLen: number;

    if (atyp === 0x01) {
        // IPv4: 4 bytes
        host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
        port = req.readUInt16BE(8);
        headerLen = 10;
    } else if (atyp === 0x03) {
        // Domain: 1 byte length + name
        const domainLen = req[4];
        host = req.slice(5, 5 + domainLen).toString("ascii");
        port = req.readUInt16BE(5 + domainLen);
        headerLen = 5 + domainLen + 2;
    } else if (atyp === 0x04) {
        // IPv6: 16 bytes
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(req.readUInt16BE(4 + i).toString(16));
        }
        host = parts.join(":");
        port = req.readUInt16BE(20);
        headerLen = 22;
    } else {
        sendReply(clientSocket, 0x08); // Address type not supported
        return;
    }

    console.log(`[Mock SOCKS5] CONNECT ${host}:${port}`);

    // 记录连接
    forwardedConnections.push({
        host,
        port,
        timestamp: new Date().toISOString(),
    });

    // 连接到目标服务器
    const targetSocket = new Socket();
    targetSocket.connect(port, host, () => {
        // 连接成功，回复 SOCKS5
        sendReply(clientSocket, 0x00);

        // 双向管道
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
    });

    targetSocket.on("error", () => {
        sendReply(clientSocket, 0x05); // Connection refused
        clientSocket.destroy();
    });

    clientSocket.on("error", () => {
        targetSocket.destroy();
    });

    clientSocket.on("close", () => {
        targetSocket.destroy();
    });

    targetSocket.on("close", () => {
        clientSocket.destroy();
    });
}


function sendReply(socket: Socket, status: number): void {
    // VER REP RSV ATYP BND.ADDR BND.PORT
    const reply = Buffer.alloc(10);
    reply[0] = 0x05; // VER
    reply[1] = status; // REP
    reply[2] = 0x00; // RSV
    reply[3] = 0x01; // ATYP (IPv4)
    // BND.ADDR = 0.0.0.0 (4 bytes of 0)
    reply.writeUInt16BE(0, 8); // BND.PORT
    socket.write(reply);
}


/**
 * 启动 mock SOCKS5 服务器 + HTTP 查询端点
 */
async function startMockSocks(port: number = DEFAULT_SOCKS_PORT): Promise<ReturnType<typeof createServer> | null> {
    if (isRunning) {
        console.log(`Mock SOCKS5 already running on port ${port}`);
        return null;
    }

    return new Promise((resolve, reject) => {
        server = createSocksServer();

        // HTTP 查询服务器（共享 forwardedConnections 数据）
        queryServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.method === "GET" && req.url === "/_test/connections") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(forwardedConnections));
                return;
            }
            if (req.method === "DELETE" && req.url === "/_test/connections") {
                forwardedConnections = [];
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            res.writeHead(404);
            res.end();
        });

        let serversStarted = 0;
        const onBothReady = () => {
            serversStarted++;
            if (serversStarted === 2) {
                isRunning = true;
                console.log(`Mock SOCKS5 server listening on port ${port}`);
                resolve(server);
            }
        };

        server.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                reject(new Error(`Mock SOCKS5 port ${port} already in use`));
            } else {
                reject(err);
            }
        });

        server.listen(port, onBothReady);
        queryServer.listen(DEFAULT_QUERY_PORT, onBothReady);
    });
}


/**
 * 停止 mock SOCKS5 服务器 + HTTP 查询端点
 */
async function stopMockSocks(serverInstance: ReturnType<typeof createServer> | null): Promise<void> {
    if (serverInstance) {
        return new Promise((resolve) => {
            serverInstance.close(() => {
                if (queryServer) {
                    queryServer.close(() => {
                        queryServer = null;
                        isRunning = false;
                        console.log("Mock SOCKS5 server stopped");
                        resolve();
                    });
                } else {
                    isRunning = false;
                    console.log("Mock SOCKS5 server stopped");
                    resolve();
                }
            });
        });
    }
}


function getForwardedConnections(): typeof forwardedConnections {
    return forwardedConnections;
}


function clearForwardedConnections(): void {
    forwardedConnections = [];
}


export default {
    startMockSocks,
    stopMockSocks,
    getForwardedConnections,
    clearForwardedConnections,
};
