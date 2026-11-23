// Tauri 桌面端配置探测：对应 tauri/src-tauri/src/lib.rs 的持久化路径与字段。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrTauriConfigNotFound 表示本机没有 Tauri 桌面端配置（未安装 / 未启动过桌面端）。
var ErrTauriConfigNotFound = errors.New("未找到 Tauri 桌面端配置")

// Tauri 桌面端默认值，与 tauri/src-tauri/src/lib.rs 的 DEFAULT_PORT / DEFAULT_HOST 一致。
const (
	TauriDefaultPort = 6722
	TauriDefaultHost = "127.0.0.1"
)

// TauriConfig 是从桌面端 config.json 里读出的连接信息。
type TauriConfig struct {
	BaseURL string
	Token   string
	Host    string
	Port    int
	// Path 是实际读取的文件路径，便于报错时指认来源。
	Path string
}

// TauriPathFor 返回当前平台桌面端 config.json 的路径。
//
// 对应 tauri 的 `app.path().data_dir()`：
//   - macOS：~/Library/Application Support/GtCoder/AiGateway/config.json
//   - Linux：${XDG_DATA_HOME:-~/.local/share}/GtCoder/AiGateway/config.json
//   - Windows：%APPDATA%\GtCoder\AiGateway\config.json
//
// goos / getenv / homeDir 允许测试注入，避免依赖真实运行平台。
func TauriPathFor(goos string, getenv func(string) string, homeDir func() (string, error)) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if homeDir == nil {
		homeDir = os.UserHomeDir
	}
	switch goos {
	case "windows":
		if appData := strings.TrimSpace(getenv("APPDATA")); appData != "" {
			return filepath.Join(appData, "GtCoder", "AiGateway", "config.json"), nil
		}
		home, err := homeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "AppData", "Roaming", "GtCoder", "AiGateway", "config.json"), nil
	case "darwin":
		home, err := homeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "GtCoder", "AiGateway", "config.json"), nil
	default: // linux 及其它 POSIX
		if dataHome := strings.TrimSpace(getenv("XDG_DATA_HOME")); dataHome != "" {
			return filepath.Join(dataHome, "GtCoder", "AiGateway", "config.json"), nil
		}
		home, err := homeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "share", "GtCoder", "AiGateway", "config.json"), nil
	}
}

// NormalizeTauriHost 把桌面端可能写下的监听地址规范成可连接的 host：
// 空串 / `0.0.0.0` / `::` 一律映射为 `127.0.0.1`，其余原样返回。
//
// 说明（与 step2 表述的差异，已在 P1 报告里标注）：
// tauri/src-tauri/src/utils.rs 目前只映射 `0.0.0.0`；空 host 由 lib.rs 的
// read_config 回落到 DEFAULT_HOST。CLI 这里按文档实现三例，是对真实行为的超集：
// 即使桌面端配置里出现空串或 `::`（手改配置、容器环境），也不会拼出 `http://:6722`。
func NormalizeTauriHost(host string) string {
	switch strings.TrimSpace(host) {
	case "", "0.0.0.0", "::":
		return "127.0.0.1"
	default:
		return strings.TrimSpace(host)
	}
}

// ParseTauriConfig 解析桌面端 config.json 内容。
func ParseTauriConfig(raw []byte, path string) (*TauriConfig, error) {
	var body struct {
		Host      string `json:"host"`
		Port      int    `json:"port"`
		RootToken string `json:"root_token"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("Tauri 配置 %s 不是合法 JSON：%w", path, err)
	}
	port := body.Port
	if port <= 0 || port > 65535 {
		port = TauriDefaultPort
	}
	host := NormalizeTauriHost(body.Host)
	return &TauriConfig{
		BaseURL: fmt.Sprintf("http://%s:%d", host, port),
		Token:   strings.TrimSpace(body.RootToken),
		Host:    host,
		Port:    port,
		Path:    path,
	}, nil
}

// TauriConfigPath 返回实际要读取的桌面端配置文件路径。
//
// 优先 GTGW_TAURI_CONFIG（显式指定，CI / 测试夹具用），否则按平台默认路径探测。
// 显式指定时若文件不存在，错误信息里会带上你给的那个路径，不会静默回退到默认路径。
func TauriConfigPath(getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if custom := strings.TrimSpace(getenv(EnvTauriConfig)); custom != "" {
		return custom, nil
	}
	return TauriPathFor(runtime.GOOS, getenv, nil)
}

// LoadTauriConfigFrom 读取本机桌面端配置。找不到文件返回 ErrTauriConfigNotFound。
func LoadTauriConfigFrom(getenv func(string) string) (*TauriConfig, error) {
	path, err := TauriConfigPath(getenv)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// 显式指定的路径（CI / 夹具）不存在时必须报出该路径：静默回落成
			// ErrTauriConfigNotFound 会让人以为「本机没装桌面端」，实际是夹具路径写错。
			if getenv != nil && strings.TrimSpace(getenv(EnvTauriConfig)) != "" {
				return nil, fmt.Errorf("Tauri 配置（%s 指定）不存在：%s", EnvTauriConfig, path)
			}
			return nil, ErrTauriConfigNotFound
		}
		return nil, fmt.Errorf("读取 Tauri 配置 %s 失败：%w", path, err)
	}
	return ParseTauriConfig(raw, path)
}
