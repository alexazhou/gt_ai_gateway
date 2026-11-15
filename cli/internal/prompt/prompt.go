// Package prompt 负责终端交互：TTY 检测、危险操作二次确认、密文输入。
//
// 设计底线：非交互环境（管道 / CI）绝不允许「静默当成确认」——
// 未传 --yes 时必须报参数错误（退出码 2），而不是默认执行。
package prompt

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// IsTTY 判断文件是否连着终端。
func IsTTY(f *os.File) bool {
	if f == nil {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}

// Confirm 执行危险操作前的确认：
//   - assumeYes 为 true 时直接通过（--yes / -y）；
//   - 非 TTY 且未传 --yes：返回 UsageError（退出码 2），绝不默认执行；
//   - TTY：读一行，只有 y / yes 视为确认。
//
// 返回的错误若为 nil 表示可以继续。
func Confirm(errOut io.Writer, in *os.File, question string, assumeYes bool) error {
	if assumeYes {
		return nil
	}
	if !IsTTY(in) {
		return client.Usagef("%s：当前不是交互终端，请显式加 --yes（或 -y）确认后重试", question)
	}
	fmt.Fprintf(errOut, "%s [y/N]: ", question)
	reader := bufio.NewReader(in)
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return fmt.Errorf("读取确认输入失败：%w", err)
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return nil
	case "":
		return fmt.Errorf("已取消")
	default:
		return fmt.Errorf("已取消：输入不是 y/yes")
	}
}

// ReadSecret 读取 Token：
//   - TTY：关闭回显（term.ReadPassword），读完补一个换行；
//   - 非 TTY：直接从 stdin 读一行（便于 `echo $TOKEN | gtgw login`）。
func ReadSecret(errOut io.Writer, in *os.File) (string, error) {
	if !IsTTY(in) {
		reader := bufio.NewReader(in)
		line, err := reader.ReadString('\n')
		if err != nil && err != io.EOF {
			return "", fmt.Errorf("读取 Token 失败：%w", err)
		}
		token := strings.TrimSpace(line)
		if token == "" {
			return "", client.Usagef("Token 为空：请传 --token、设置 GTGW_TOKEN，或交互式输入")
		}
		return token, nil
	}
	fmt.Fprint(errOut, "Token（输入不回显）: ")
	raw, err := term.ReadPassword(int(in.Fd()))
	fmt.Fprintln(errOut)
	if err != nil {
		return "", fmt.Errorf("读取 Token 失败：%w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", client.Usagef("Token 为空：请重新执行 login 并输入有效 Token")
	}
	return token, nil
}
