package config

import (
	"path/filepath"
	"testing"
)

func TestNormalizeTauriHost(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "127.0.0.1"},
		{"0.0.0.0", "127.0.0.1"},
		{"::", "127.0.0.1"},
		{"  ", "127.0.0.1"},
		{"127.0.0.1", "127.0.0.1"},
		{"192.168.1.20", "192.168.1.20"},
		{"localhost", "localhost"},
	}
	for _, c := range cases {
		if got := NormalizeTauriHost(c.in); got != c.want {
			t.Fatalf("NormalizeTauriHost(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestTauriPathFor(t *testing.T) {
	home := func() (string, error) { return "/home/tester", nil }
	cases := []struct {
		goos string
		env  map[string]string
		want string
	}{
		{"darwin", nil, filepath.Join("/home/tester", "Library", "Application Support", "GtCoder", "AiGateway", "config.json")},
		{"linux", nil, filepath.Join("/home/tester", ".local", "share", "GtCoder", "AiGateway", "config.json")},
		{"linux", map[string]string{"XDG_DATA_HOME": "/xdg-data"}, filepath.Join("/xdg-data", "GtCoder", "AiGateway", "config.json")},
		{"windows", map[string]string{"APPDATA": `C:\Users\tester\AppData\Roaming`}, filepath.Join(`C:\Users\tester\AppData\Roaming`, "GtCoder", "AiGateway", "config.json")},
		{"windows", nil, filepath.Join("/home/tester", "AppData", "Roaming", "GtCoder", "AiGateway", "config.json")},
	}
	for _, c := range cases {
		got, err := TauriPathFor(c.goos, envFunc(c.env), home)
		if err != nil {
			t.Fatalf("TauriPathFor(%s): %v", c.goos, err)
		}
		if got != c.want {
			t.Fatalf("TauriPathFor(%s) = %q, 期望 %q", c.goos, got, c.want)
		}
	}
}

func TestParseTauriConfig(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		wantURL  string
		wantTok  string
		wantPort int
	}{
		{
			name:     "监听 0.0.0.0 映射回环",
			raw:      `{"host":"0.0.0.0","port":6722,"root_token":"root-token-123"}`,
			wantURL:  "http://127.0.0.1:6722",
			wantTok:  "root-token-123",
			wantPort: 6722,
		},
		{
			name:     "空 host 映射回环",
			raw:      `{"host":"","port":8720,"root_token":"t"}`,
			wantURL:  "http://127.0.0.1:8720",
			wantTok:  "t",
			wantPort: 8720,
		},
		{
			name:     "IPv6 通配 :: 映射回环",
			raw:      `{"host":"::","port":6722,"root_token":"t"}`,
			wantURL:  "http://127.0.0.1:6722",
			wantTok:  "t",
			wantPort: 6722,
		},
		{
			name:     "缺省 port 用 6722（与 tauri DEFAULT_PORT 一致）",
			raw:      `{"host":"127.0.0.1","root_token":"t"}`,
			wantURL:  "http://127.0.0.1:6722",
			wantTok:  "t",
			wantPort: 6722,
		},
		{
			name:     "自定义 host 原样保留",
			raw:      `{"host":"192.168.1.20","port":9000,"root_token":"t"}`,
			wantURL:  "http://192.168.1.20:9000",
			wantTok:  "t",
			wantPort: 9000,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := ParseTauriConfig([]byte(c.raw), "/tmp/config.json")
			if err != nil {
				t.Fatalf("ParseTauriConfig: %v", err)
			}
			if got.BaseURL != c.wantURL {
				t.Fatalf("BaseURL = %q, 期望 %q", got.BaseURL, c.wantURL)
			}
			if got.Token != c.wantTok {
				t.Fatalf("Token = %q, 期望 %q", got.Token, c.wantTok)
			}
			if got.Port != c.wantPort {
				t.Fatalf("Port = %d, 期望 %d", got.Port, c.wantPort)
			}
		})
	}
}

func TestParseTauriConfigInvalidJSON(t *testing.T) {
	if _, err := ParseTauriConfig([]byte("nope"), "/tmp/config.json"); err == nil {
		t.Fatal("非法 JSON 应报错")
	}
}
