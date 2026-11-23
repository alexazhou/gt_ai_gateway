package prompt

import (
	"bytes"
	"os"

	"testing"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// pipeStdin 返回一个非 TTY 的 *os.File 作为 stdin，并预置内容。
func pipeStdin(t *testing.T, content string) *os.File {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	if _, err := w.WriteString(content); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r
}

func TestConfirmAssumeYes(t *testing.T) {
	var errOut bytes.Buffer
	in := pipeStdin(t, "")
	if err := Confirm(&errOut, in, "确定删除？", true); err != nil {
		t.Fatalf("--yes 应直接通过，实际：%v", err)
	}
}

// TestConfirmNonTTYRequiresYes 是危险操作保护的硬判据：
// 非交互环境未传 --yes 时必须报参数错误（退出码 2），不能默认执行。
func TestConfirmNonTTYRequiresYes(t *testing.T) {
	var errOut bytes.Buffer
	in := pipeStdin(t, "y\n")
	err := Confirm(&errOut, in, "确定删除？", false)
	if err == nil {
		t.Fatal("非 TTY 且未传 --yes 时必须报错")
	}
	if code := client.ExitCodeOf(err); code != client.ExitUsage {
		t.Fatalf("退出码 = %d, 期望 %d", code, client.ExitUsage)
	}
}

func TestReadSecretFromPipe(t *testing.T) {
	var errOut bytes.Buffer
	in := pipeStdin(t, "  sk-piped-token\n")
	got, err := ReadSecret(&errOut, in)
	if err != nil {
		t.Fatalf("ReadSecret: %v", err)
	}
	if got != "sk-piped-token" {
		t.Fatalf("token = %q, 期望去掉首尾空白", got)
	}
}

func TestReadSecretEmpty(t *testing.T) {
	in := pipeStdin(t, "\n")
	if _, err := ReadSecret(&bytes.Buffer{}, in); err == nil {
		t.Fatal("空 Token 应报错")
	}
}

func TestIsTTYOnRegularFile(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "not-a-tty")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	defer f.Close()
	if IsTTY(f) {
		t.Fatal("普通文件不应被判定为 TTY")
	}
	if IsTTY(nil) {
		t.Fatal("nil 不应被判定为 TTY")
	}
}
