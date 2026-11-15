package cmd

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
)

// TestIntegrationEnvSQLSyntax 四种 shell 的导出语法：逐行断言关键字，避免「看起来像」但 eval 不了。
func TestIntegrationEnvShellSyntax(t *testing.T) {
	mock := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)

	cases := []struct {
		shell string
		want  []string
	}{
		{"bash", []string{
			`export OPENAI_BASE_URL="` + mock.URL + `/llm/v1"`,
			`export OPENAI_API_KEY="tok"`,
			`export ANTHROPIC_BASE_URL="` + mock.URL + `/llm"`,
			`export ANTHROPIC_AUTH_TOKEN="tok"`,
		}},
		{"zsh", []string{
			`export ANTHROPIC_BASE_URL="` + mock.URL + `/llm"`,
		}},
		{"fish", []string{
			`set -gx OPENAI_BASE_URL "` + mock.URL + `/llm/v1"`,
			`set -gx ANTHROPIC_AUTH_TOKEN "tok"`,
		}},
		{"powershell", []string{
			`$env:OPENAI_BASE_URL = "` + mock.URL + `/llm/v1"`,
			`$env:ANTHROPIC_BASE_URL = "` + mock.URL + `/llm"`,
		}},
	}
	for _, tc := range cases {
		t.Run(tc.shell, func(t *testing.T) {
			out.Reset()
			errOut.Reset()
			code := runCLI(app, "--url", mock.URL, "--token", "tok", "integration", "env", "--shell", tc.shell)
			if code != 0 {
				t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
			}
			got := out.String()
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Fatalf("%s 输出缺少 %q\n实际输出：\n%s", tc.shell, want, got)
				}
			}
			lines := strings.Split(strings.TrimSpace(got), "\n")
			if len(lines) != 4 {
				t.Fatalf("应恰好 4 行导出语句，实际 %d 行：\n%s", len(lines), got)
			}
			if strings.Contains(got, "#") {
				t.Fatalf("脚本不能带注释（eval 后要保持干净）：\n%s", got)
			}
		})
	}
}

// TestIntegrationEnvUnknownShell 未知 shell ⇒ 退出码 2。
func TestIntegrationEnvUnknownShell(t *testing.T) {
	mock := newMockGateway(t, nil)
	app, _, errOut, _ := newTestApp(t)
	if code := runCLI(app, "--url", mock.URL, "--token", "tok", "integration", "env", "--shell", "cmd.exe"); code != 2 {
		t.Fatalf("退出码 = %d，期望 2（stderr=%s）", code, errOut.String())
	}
}

// TestIntegrationEnvEvalInRealShell 在真实 shell 里 eval 生成的脚本，再用 env 读回来。
// 这是「语法真的能用」的证据：只比对字符串无法发现引号/转义错误。
func TestIntegrationEnvEvalInRealShell(t *testing.T) {
	mock := newMockGateway(t, nil)
	app, out, errOut, _ := newTestApp(t)
	if code := runCLI(app, "--url", mock.URL, "--token", "sk-a$b`c\"d", "integration", "env"); code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	script := out.String()

	// 故意用带 $ / 引号 / 反引号的 token，验证转义真的生效
	cases := []struct {
		shell string
		cmd   []string
		check []string
	}{
		{"bash", []string{"bash", "-c", `eval "$SCRIPT"; env | grep -E '^(OPENAI|ANTHROPIC)_' | sort`},
			[]string{"OPENAI_API_KEY=sk-a$b`c\"d", "ANTHROPIC_BASE_URL=" + mock.URL + "/llm"}},
		{"zsh", []string{"zsh", "-c", `eval "$SCRIPT"; env | grep -E '^(OPENAI|ANTHROPIC)_' | sort`},
			[]string{"OPENAI_BASE_URL=" + mock.URL + "/llm/v1", "ANTHROPIC_AUTH_TOKEN=sk-a$b`c\"d"}},
	}
	for _, tc := range cases {
		t.Run(tc.shell, func(t *testing.T) {
			bin, err := exec.LookPath(tc.shell)
			if err != nil {
				t.Skipf("本机没有 %s，跳过实测（在 accept_p3.sh 里同样会标注跳过原因）", tc.shell)
			}
			cmd := exec.Command(bin, tc.cmd[1:]...)
			cmd.Env = append(cmd.Environ(), "SCRIPT="+script)
			got, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("eval 失败：%v\n输出：%s", err, got)
			}
			text := string(got)
			for _, want := range tc.check {
				if !strings.Contains(text, want) {
					t.Fatalf("eval 后环境变量缺少 %q\n实际：\n%s", want, text)
				}
			}
			if n := len(strings.Split(strings.TrimSpace(text), "\n")); n != 4 {
				t.Fatalf("eval 后应有 4 个变量，实际 %d：\n%s", n, text)
			}
		})
	}
}

// TestIntegrationEnvTrimsTrailingSlash 网关地址尾斜杠不能拼出 //llm。
func TestIntegrationEnvTrimsTrailingSlash(t *testing.T) {
	var out, errOut bytes.Buffer
	app := NewApp(&out, &errOut, func(k string) string { return "" }, "test", "sha")
	if code := runCLI(app, "--url", "http://127.0.0.1:8720///", "--token", "t", "integration", "env"); code != 0 {
		t.Fatalf("退出码 = %d，stderr=%s", code, errOut.String())
	}
	got := out.String()
	if strings.Contains(got, "8720//") {
		t.Fatalf("尾斜杠没有规范化：\n%s", got)
	}
	if !strings.Contains(got, `"http://127.0.0.1:8720/llm"`) {
		t.Fatalf("ANTHROPIC_BASE_URL 不是 /llm 收尾：\n%s", got)
	}
}
