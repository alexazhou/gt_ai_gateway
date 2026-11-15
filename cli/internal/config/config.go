// Package config 负责 gtgw 的本地配置：Profile 结构、配置优先级合并
// （flag > 环境变量 > profile）、0700/0600 权限与原子写入，以及
// `login --from-tauri` 读取桌面端配置的入口（见 tauri.go）。
//
// 2026-11-15 变更：配置目录统一为 `~/.gtgw`；旧的 `${XDG_CONFIG_HOME:-~/.config}/gtgw`
// **不再读取**；`config.Resolve()` 的「隐式 tauri 回退」整层删除——本机桌面端只以
// 一个**显式 profile**（`gtgw login --from-tauri`）的形式存在。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// 环境变量名（step1 §配置优先级）。
const (
	EnvURL    = "GTGW_URL"
	EnvToken  = "GTGW_TOKEN"
	EnvTenant = "GTGW_TENANT"
	// EnvTauriConfig 显式指定桌面端 config.json 路径，绕开按平台探测默认路径。
	// CI / 测试夹具用：让 `login --from-tauri` 这条链路在任何机器上都可复现。
	EnvTauriConfig = "GTGW_TAURI_CONFIG"
)

// ConfigDirName 是配置目录名。2026-11-15 起全平台统一为家目录下的 `.gtgw`：
// macOS / Linux = `~/.gtgw`，Windows = `%USERPROFILE%\.gtgw`（**不落 `%APPDATA%`**）。
const ConfigDirName = ".gtgw"

// 配置来源（写入 Resolved.Sources，便于判据「断言实际生效的值来自哪一层」）。
const (
	SourceFlag    = "flag"
	SourceEnv     = "env"
	SourceProfile = "profile"
	SourceDefault = "default"
)

// Profile 是一套网关环境的连接配置。
type Profile struct {
	BaseURL       string `json:"base_url"`
	Token         string `json:"token"`
	DefaultTenant string `json:"default_tenant,omitempty"`
	// FromDesktop 是「这条 profile 的地址与 Token 来自本机桌面端」的持久标记。
	//
	// 由 `gtgw login --from-tauri` 写入、其它登录方式显式清零。
	// 破坏性闸门（cli/cmd/safety.go）据此判断，**不看 profile 名字**：
	// 用户可以用 `login --from-tauri --profile foo` 把桌面端凭据存成任意名字，
	// 光靠名字识别会被绕过（2026-11-15 Operator 口径）。
	FromDesktop bool `json:"from_desktop,omitempty"`
}

// ProfileOriginDesktop 是「凭据来自本机桌面端」的来源标签（`profile list` / `status` 展示用）。
const ProfileOriginDesktop = "本机桌面端"

// Origin 返回 profile 的来源标签：桌面端 profile 返回 ProfileOriginDesktop，
// 普通 profile 返回空串（表示由 --url / 环境变量手工登录）。
func (p Profile) Origin() string {
	if p.FromDesktop {
		return ProfileOriginDesktop
	}
	return ""
}

// File 是磁盘上 config.json 的结构。
type File struct {
	ActiveProfile string             `json:"active_profile"`
	Profiles      map[string]Profile `json:"profiles"`
}

// NewFile 返回一个空的配置结构（Profiles 已初始化，避免 nil map 写入 panic）。
func NewFile() *File {
	return &File{Profiles: map[string]Profile{}}
}

// Profile 返回指定名字的 profile 及是否存在。
func (f *File) Profile(name string) (Profile, bool) {
	if f == nil || f.Profiles == nil || name == "" {
		return Profile{}, false
	}
	p, ok := f.Profiles[name]
	return p, ok
}

// SetProfile 写入 / 覆盖一个 profile。
func (f *File) SetProfile(name string, p Profile) {
	if f.Profiles == nil {
		f.Profiles = map[string]Profile{}
	}
	f.Profiles[name] = p
}

// Active 返回当前激活 profile 的名字与内容。
func (f *File) Active() (string, Profile, bool) {
	if f == nil || f.ActiveProfile == "" {
		return "", Profile{}, false
	}
	p, ok := f.Profile(f.ActiveProfile)
	return f.ActiveProfile, p, ok
}

// HomeDirFrom 返回用户主目录。
//
// 所有取值都经过 getenv（而不是直接读进程环境），这样单测与 e2e 才能注入 HOME 做隔离：
//   - Windows 先看 %USERPROFILE%，再看 HOME（git-bash / MSYS 会设 HOME）；
//   - 其它平台先看 HOME，再看 USERPROFILE；
//   - 都取不到时退回 os.UserHomeDir()（它自己也是读这两个变量，只是兜底）。
func HomeDirFrom(getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	keys := []string{"HOME", "USERPROFILE"}
	if runtime.GOOS == "windows" {
		keys = []string{"USERPROFILE", "HOME"}
	}
	for _, key := range keys {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("无法确定用户主目录：%w", err)
	}
	return home, nil
}

// DirFrom 返回配置目录：`<家目录>/.gtgw`（全平台统一）。
//
// 2026-11-15 变更：旧路径 `${XDG_CONFIG_HOME:-~/.config}/gtgw` **不再读取**——
// 不双读、不做静默兼容（Operator 口径）。因此这里刻意**不看** XDG_CONFIG_HOME：
// 留着它会让「配置到底落在哪」依赖环境变量，正是本次要消灭的不确定性。
func DirFrom(getenv func(string) string) (string, error) {
	home, err := HomeDirFrom(getenv)
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ConfigDirName), nil
}

// PathFrom 返回 config.json 的完整路径。
func PathFrom(getenv func(string) string) (string, error) {
	dir, err := DirFrom(getenv)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

// LoadFrom 读取 dir/config.json。文件不存在时返回空配置（不报错），
// 这样「首次使用」与「配置损坏」能被区分开：前者静默，后者报错。
func LoadFrom(dir string) (*File, error) {
	path := filepath.Join(dir, "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewFile(), nil
		}
		return nil, fmt.Errorf("读取配置文件 %s 失败：%w", path, err)
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return NewFile(), nil
	}
	f := NewFile()
	if err := json.Unmarshal(raw, f); err != nil {
		return nil, fmt.Errorf("配置文件 %s 不是合法 JSON：%w", path, err)
	}
	if f.Profiles == nil {
		f.Profiles = map[string]Profile{}
	}
	return f, nil
}

// SaveTo 原子写入 dir/config.json：
// 目录以 0700 创建（已存在则收紧到 0700），临时文件 0600，写完 fsync 后 rename 覆盖。
// 任何一步失败都不会破坏原文件，也不会留下临时文件。
func SaveTo(dir string, f *File) error {
	if f == nil {
		f = NewFile()
	}
	if f.Profiles == nil {
		f.Profiles = map[string]Profile{}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建配置目录 %s 失败：%w", dir, err)
	}
	// 目录可能是上次以更宽权限创建的：只「收紧」不「放宽」。
	// 反例是目录被显式设为 0500（只读）时，若无条件 chmod 0700 会把它悄悄改回可写，
	// 既掩盖了真实的写入失败，也违背了使用者的意图（Windows 上 chmod 语义有限，跳过）。
	if info, statErr := os.Stat(dir); statErr == nil {
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			if err := os.Chmod(dir, 0o700); err != nil && runtime.GOOS != "windows" {
				return fmt.Errorf("设置配置目录权限失败：%w", err)
			}
		}
	}

	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败：%w", err)
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("创建临时配置文件失败：%w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		cleanup()
		return fmt.Errorf("设置临时文件权限失败：%w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		cleanup()
		return fmt.Errorf("写入临时配置文件失败：%w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("刷新临时配置文件失败：%w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("关闭临时配置文件失败：%w", err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("替换配置文件 %s 失败：%w", path, err)
	}
	return nil
}

// MaskToken 对 token 做脱敏：长度 <= 8 显示 `****`，否则保留前 4 位与后 4 位。
// 判据要求 `profile list` / `status` 输出里看不到完整 token，因此 JSON 输出同样脱敏。
func MaskToken(token string) string {
	if token == "" {
		return ""
	}
	if len(token) <= 8 {
		return "****"
	}
	return token[:4] + "****" + token[len(token)-4:]
}

// ResolveOptions 是配置解析的输入：命令行参数 + 环境变量 + 已加载的配置。
type ResolveOptions struct {
	// URL / Token / Tenant / ProfileName 来自命令行参数，空串表示「未提供」。
	URL         string
	Token       string
	Tenant      string
	ProfileName string

	// Getenv 允许测试注入环境变量；nil 表示 os.Getenv。
	Getenv func(string) string

	// File 是已加载的本地配置；nil 视为空配置。
	File *File
}

// Resolved 是合并后的实际生效配置，Sources 记录每个字段的来源层级。
type Resolved struct {
	BaseURL     string
	Token       string
	Tenant      string
	ProfileName string
	// ProfileFromDesktop 表示当前生效的 profile 带有「来自本机桌面端」的持久标记
	// （`gtgw login --from-tauri` 写入）。破坏性闸门据此判断，见 cli/cmd/safety.go。
	ProfileFromDesktop bool
	Sources            map[string]string
}

// Source 返回字段来源（"base_url" / "token" / "tenant"），未解析到时为空串。
func (r Resolved) Source(field string) string { return r.Sources[field] }

// HasCredentials 表示解析后是否具备可用的地址与 token。
func (r Resolved) HasCredentials() bool {
	return r.BaseURL != "" && r.Token != ""
}

// Resolve 按 step2 §配置解析优先级合并配置：命令行参数 > 环境变量 > 指定/激活 Profile。
//
// 2026-11-15：第 4 层「隐式 tauri 回退」已删除——tauri 只作为「一种 profile」显式存在
// （`gtgw login --from-tauri`）。因此三层都没配时，Resolve 返回**空地址**，
// 由调用方报「没有可用的网关地址」，绝不自动连任何地址（#257 事故的直接教训）。
func Resolve(o ResolveOptions) (Resolved, error) {
	getenv := o.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	res := Resolved{Sources: map[string]string{}}

	envURL := strings.TrimSpace(getenv(EnvURL))
	envToken := strings.TrimSpace(getenv(EnvToken))
	envTenant := strings.TrimSpace(getenv(EnvTenant))

	// 第 3 层：profile（显式 --profile 优先于 active_profile）
	profileName := strings.TrimSpace(o.ProfileName)
	var prof Profile
	hasProfile := false
	if o.File != nil {
		if profileName == "" {
			profileName = strings.TrimSpace(o.File.ActiveProfile)
		}
		if profileName != "" {
			p, ok := o.File.Profile(profileName)
			if !ok {
				if strings.TrimSpace(o.ProfileName) != "" {
					return res, client.Usagef("profile %q 不存在，可用 `gtgw profile list` 查看已有环境", o.ProfileName)
				}
				// active_profile 指向已删除的 profile：视为「无有效 profile」，
				// 不报错也不回退（回退层已删除），最终由调用方报「没有可用的网关地址」。
				profileName = ""
			} else {
				prof, hasProfile = p, true
			}
		}
	}
	res.ProfileName = profileName
	// 桌面端标记随 profile 一起带出来（判断只看这个布尔，不看 profile 名字）。
	res.ProfileFromDesktop = hasProfile && prof.FromDesktop

	// 第 1、2、3 层逐字段覆盖
	pick := func(field, flagVal, envVal, profileVal string) (string, string) {
		switch {
		case strings.TrimSpace(flagVal) != "":
			return strings.TrimSpace(flagVal), SourceFlag
		case envVal != "":
			return envVal, SourceEnv
		case strings.TrimSpace(profileVal) != "":
			return strings.TrimSpace(profileVal), SourceProfile
		}
		return "", ""
	}

	res.BaseURL, res.Sources["base_url"] = pick("base_url", o.URL, envURL, prof.BaseURL)
	res.Token, res.Sources["token"] = pick("token", o.Token, envToken, prof.Token)
	res.Tenant, res.Sources["tenant"] = pick("tenant", o.Tenant, envTenant, prof.DefaultTenant)
	return res, nil
}
