package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// envFunc 返回一个可注入的环境变量读取函数。
func envFunc(pairs map[string]string) func(string) string {
	return func(key string) string { return pairs[key] }
}

func TestResolvePriority(t *testing.T) {
	fileWithProfile := func() *File {
		f := NewFile()
		f.SetProfile("prod", Profile{
			BaseURL:       "http://profile.example:8720",
			Token:         "profile-token",
			DefaultTenant: "profile-tenant",
		})
		f.ActiveProfile = "prod"
		return f
	}

	t.Run("flag 覆盖 env 与 profile", func(t *testing.T) {
		res, err := Resolve(ResolveOptions{
			URL:    "http://flag.example:9000",
			Token:  "flag-token",
			Tenant: "flag-tenant",
			Getenv: envFunc(map[string]string{EnvURL: "http://env.example:8000", EnvToken: "env-token", EnvTenant: "env-tenant"}),
			File:   fileWithProfile(),
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.BaseURL != "http://flag.example:9000" || res.Source("base_url") != SourceFlag {
			t.Fatalf("base_url = %q (%s), 期望 flag 层生效", res.BaseURL, res.Source("base_url"))
		}
		if res.Token != "flag-token" || res.Source("token") != SourceFlag {
			t.Fatalf("token = %q, 期望 flag 层生效", res.Token)
		}
		if res.Tenant != "flag-tenant" || res.Source("tenant") != SourceFlag {
			t.Fatalf("tenant = %q, 期望 flag 层生效", res.Tenant)
		}
	})

	t.Run("env 覆盖 profile", func(t *testing.T) {
		res, err := Resolve(ResolveOptions{
			Getenv: envFunc(map[string]string{EnvURL: "http://env.example:8000", EnvToken: "env-token", EnvTenant: "env-tenant"}),
			File:   fileWithProfile(),
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.BaseURL != "http://env.example:8000" || res.Source("base_url") != SourceEnv {
			t.Fatalf("base_url = %q (%s), 期望 env 层生效", res.BaseURL, res.Source("base_url"))
		}
		if res.Token != "env-token" || res.Source("token") != SourceEnv {
			t.Fatalf("token = %q (%s), 期望 env 层生效", res.Token, res.Source("token"))
		}
		if res.Tenant != "env-tenant" || res.Source("tenant") != SourceEnv {
			t.Fatalf("tenant = %q (%s), 期望 env 层生效", res.Tenant, res.Source("tenant"))
		}
	})

	t.Run("无 flag/env 时用 profile", func(t *testing.T) {
		res, err := Resolve(ResolveOptions{
			Getenv: envFunc(nil),
			File:   fileWithProfile(),
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.BaseURL != "http://profile.example:8720" || res.Source("base_url") != SourceProfile {
			t.Fatalf("base_url = %q (%s), 期望 profile 层生效", res.BaseURL, res.Source("base_url"))
		}
		if res.ProfileName != "prod" {
			t.Fatalf("ProfileName = %q, 期望 prod", res.ProfileName)
		}
	})

	t.Run("显式 --profile 优先于 active_profile", func(t *testing.T) {
		f := fileWithProfile()
		f.SetProfile("local", Profile{BaseURL: "http://127.0.0.1:8720", Token: "local-token"})
		res, err := Resolve(ResolveOptions{Getenv: envFunc(nil), File: f, ProfileName: "local"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.ProfileName != "local" || res.BaseURL != "http://127.0.0.1:8720" {
			t.Fatalf("res = %+v, 期望使用 local profile", res)
		}
	})

	t.Run("无 flag/env/profile 时不产生任何地址（隐式回退已删除）", func(t *testing.T) {
		res, err := Resolve(ResolveOptions{Getenv: envFunc(nil), File: NewFile()})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.BaseURL != "" || res.Token != "" {
			t.Fatalf("res = %+v, 期望空地址（不得自动连任何地址）", res)
		}
		if res.Source("base_url") != "" {
			t.Fatalf("base_url 来源 = %q, 期望空", res.Source("base_url"))
		}
	})

	t.Run("profile 的 FromDesktop 标记随解析带出", func(t *testing.T) {
		f := NewFile()
		f.SetProfile("foo", Profile{BaseURL: "http://127.0.0.1:6722", Token: "tauri-token", FromDesktop: true})
		f.ActiveProfile = "foo"
		res, err := Resolve(ResolveOptions{Getenv: envFunc(nil), File: f})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !res.ProfileFromDesktop || res.ProfileName != "foo" {
			t.Fatalf("res = %+v, 期望带出 foo 的桌面端标记", res)
		}
		if res.BaseURL != "http://127.0.0.1:6722" || res.Source("base_url") != SourceProfile {
			t.Fatalf("base_url = %q (%s), 期望 profile 层生效", res.BaseURL, res.Source("base_url"))
		}
	})

	t.Run("显式 --profile 不存在时报参数错误（退出码 2）", func(t *testing.T) {
		_, err := Resolve(ResolveOptions{Getenv: envFunc(nil), File: NewFile(), ProfileName: "nope"})
		if err == nil {
			t.Fatal("期望报错")
		}
		if code := client.ExitCodeOf(err); code != client.ExitUsage {
			t.Fatalf("退出码 = %d, 期望 %d", code, client.ExitUsage)
		}
	})
}

func TestSaveToPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 POSIX 权限位，权限判据不适用（P1 报告已标注未覆盖）")
	}
	dir := filepath.Join(t.TempDir(), "gtgw")
	f := NewFile()
	f.SetProfile("local", Profile{BaseURL: "http://127.0.0.1:8720", Token: "sk-1234567890"})
	f.ActiveProfile = "local"
	if err := SaveTo(dir, f); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("目录权限 = %#o, 期望 0700", perm)
	}
	fileInfo, err := os.Stat(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("stat file: %v", err)
	}
	if perm := fileInfo.Mode().Perm(); perm != 0o600 {
		t.Fatalf("文件权限 = %#o, 期望 0600", perm)
	}
}

// TestSaveToAtomic 验证写入失败时原配置不变、无残留临时文件。
func TestSaveToAtomic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 下无法用目录只读模拟写入失败")
	}
	dir := filepath.Join(t.TempDir(), "gtgw")
	original := NewFile()
	original.SetProfile("local", Profile{BaseURL: "http://127.0.0.1:8720", Token: "keep-me"})
	original.ActiveProfile = "local"
	if err := SaveTo(dir, original); err != nil {
		t.Fatalf("首次 SaveTo: %v", err)
	}
	before, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	// 目录改成只读，模拟「写入中断 / 目标不可写」
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	broken := NewFile()
	broken.SetProfile("local", Profile{BaseURL: "http://broken:1", Token: "should-not-land"})
	broken.ActiveProfile = "local"
	saveErr := SaveTo(dir, broken)
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("chmod back: %v", err)
	}
	if saveErr == nil {
		t.Fatal("目录不可写时 SaveTo 应返回错误")
	}

	after, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(before) != string(after) {
		t.Fatalf("原配置被破坏：\nbefore=%s\nafter=%s", before, after)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("残留临时文件：%s", e.Name())
		}
	}

	// 恢复可写后应能正常覆盖
	if err := SaveTo(dir, broken); err != nil {
		t.Fatalf("恢复可写后 SaveTo: %v", err)
	}
	loaded, err := LoadFrom(dir)
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	if got := loaded.Profiles["local"].Token; got != "should-not-land" {
		t.Fatalf("token = %q, 期望覆盖成功", got)
	}
}

func TestLoadFromMissingFile(t *testing.T) {
	f, err := LoadFrom(filepath.Join(t.TempDir(), "no-such-dir"))
	if err != nil {
		t.Fatalf("文件不存在不应报错，实际：%v", err)
	}
	if f == nil || f.Profiles == nil {
		t.Fatal("应返回初始化过的空配置")
	}
	if len(f.Profiles) != 0 {
		t.Fatalf("Profiles = %v, 期望为空", f.Profiles)
	}
}

func TestLoadFromInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := LoadFrom(dir); err == nil {
		t.Fatal("损坏的配置应报错，而不是静默当成空配置")
	}
}

func TestLoadFromRoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "gtgw")
	f := NewFile()
	f.SetProfile("local", Profile{BaseURL: "http://127.0.0.1:8720", Token: "sk-abcdefghijk", DefaultTenant: "main"})
	f.ActiveProfile = "local"
	if err := SaveTo(dir, f); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	loaded, err := LoadFrom(dir)
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	got, ok := loaded.Profile("local")
	if !ok {
		t.Fatal("profile local 丢失")
	}
	if got != f.Profiles["local"] {
		t.Fatalf("profile = %+v, 期望 %+v", got, f.Profiles["local"])
	}
	if loaded.ActiveProfile != "local" {
		t.Fatalf("active_profile = %q", loaded.ActiveProfile)
	}
	// 落盘结构必须与 step2 的 JSON 形态一致
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"active_profile", "profiles"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("落盘 JSON 缺少字段 %q：%s", key, raw)
		}
	}
}

func TestMaskToken(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"1234567", "****"},
		{"12345678", "****"},
		{"sk-1234567890", "sk-1****7890"},
		{"abcdefgh", "****"},
		{"abcdefghi", "abcd****fghi"},
	}
	for _, c := range cases {
		if got := MaskToken(c.in); got != c.want {
			t.Fatalf("MaskToken(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestDirFrom(t *testing.T) {
	t.Run("统一为家目录下的 .gtgw", func(t *testing.T) {
		dir, err := DirFrom(envFunc(map[string]string{"HOME": "/tmp/home"}))
		if err != nil {
			t.Fatalf("DirFrom: %v", err)
		}
		if want := filepath.Join("/tmp/home", ".gtgw"); dir != want {
			t.Fatalf("dir = %q, 期望 %q", dir, want)
		}
	})

	t.Run("XDG_CONFIG_HOME 不再参与（旧路径不读）", func(t *testing.T) {
		dir, err := DirFrom(envFunc(map[string]string{"HOME": "/tmp/home", "XDG_CONFIG_HOME": "/tmp/xdg"}))
		if err != nil {
			t.Fatalf("DirFrom: %v", err)
		}
		if want := filepath.Join("/tmp/home", ".gtgw"); dir != want {
			t.Fatalf("dir = %q, 期望 %q（XDG_CONFIG_HOME 必须被忽略）", dir, want)
		}
	})

	// Windows 分支只在本机是 Windows 时可执行；其它平台由 CI 的 Rust/Windows 门之外的
	// 手工核对覆盖（本报告会写明「未在本机实跑 Windows」）。
	t.Run("Windows 优先 USERPROFILE", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("仅 Windows 上可验证 USERPROFILE 优先")
		}
		dir, err := DirFrom(envFunc(map[string]string{"USERPROFILE": `C:\Users\alice`, "HOME": `C:\msys\home`}))
		if err != nil {
			t.Fatalf("DirFrom: %v", err)
		}
		if want := filepath.Join(`C:\Users\alice`, ".gtgw"); dir != want {
			t.Fatalf("dir = %q, 期望 %q", dir, want)
		}
	})
}

// TestOldConfigPathIsNotRead 是本次最容易写错的一条：旧路径 `~/.config/gtgw/config.json`
// 里的 profile 不得被读到（不双读、不静默兼容）。
func TestOldConfigPathIsNotRead(t *testing.T) {
	home := t.TempDir()
	oldDir := filepath.Join(home, ".config", "gtgw")
	if err := os.MkdirAll(oldDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	legacy := []byte(`{"active_profile":"legacy","profiles":{"legacy":{"base_url":"http://127.0.0.1:6722","token":"old-token"}}}`)
	if err := os.WriteFile(filepath.Join(oldDir, "config.json"), legacy, 0o600); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	dir, err := DirFrom(envFunc(map[string]string{"HOME": home}))
	if err != nil {
		t.Fatalf("DirFrom: %v", err)
	}
	if want := filepath.Join(home, ".gtgw"); dir != want {
		t.Fatalf("dir = %q, 期望 %q", dir, want)
	}
	f, err := LoadFrom(dir)
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	if name, _, ok := f.Active(); ok {
		t.Fatalf("读到了旧路径的 profile（active=%q），旧路径必须不被读取", name)
	}
}

// TestProfileFromDesktopRoundTrip 断言「来自本机桌面端」是**持久化**标记：
// 落盘后能读回，且普通 profile 不会写出该字段（不能靠 profile 名字识别）。
func TestProfileFromDesktopRoundTrip(t *testing.T) {
	dir := t.TempDir()
	f := NewFile()
	f.SetProfile("foo", Profile{BaseURL: "http://127.0.0.1:6722", Token: "tauri-token", FromDesktop: true})
	f.SetProfile("plain", Profile{BaseURL: "http://gateway.example:8720", Token: "manual-token"})
	f.ActiveProfile = "foo"
	if err := SaveTo(dir, f); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if n := strings.Count(string(raw), "from_desktop"); n != 1 {
		t.Fatalf("落盘 JSON 里 from_desktop 出现 %d 次，期望 1 次（只有桌面端 profile）：%s", n, raw)
	}

	loaded, err := LoadFrom(dir)
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	foo, _ := loaded.Profile("foo")
	if !foo.FromDesktop || foo.Origin() != ProfileOriginDesktop {
		t.Fatalf("foo = %+v, 期望带桌面端标记", foo)
	}
	plain, _ := loaded.Profile("plain")
	if plain.FromDesktop || plain.Origin() != "" {
		t.Fatalf("plain = %+v, 期望不带桌面端标记", plain)
	}
}
