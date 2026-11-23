package cmd

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/prompt"
)

// bodySource 是 create / update 类命令的通用传参：
//
//	--file <path>（"-" 从 stdin 读）
//	--key k=v（可重复，值一律按字符串发送）
//
// 两种方式互斥，缺一报参数错误（退出码 2）；JSON 非法同样不发请求。
type bodySource struct {
	file string
	kv   []string
}

func (b *bodySource) addFlags(cmd *cobra.Command) {
	cmd.Flags().StringVarP(&b.file, "file", "f", "", "请求体 JSON 文件路径（- 表示从 stdin 读取）")
	cmd.Flags().StringArrayVar(&b.kv, "key", nil, "逐项设置请求体字段，格式 key=value，可重复")
}

// build 组装请求体（必须有 --file 或 --key，否则报参数错误）。
func (b *bodySource) build(stdin *os.File) (map[string]any, error) {
	return buildJSONBody(b.file, b.kv, stdin)
}

// buildOptional 在既没有 --file 也没有 --key 时返回 (nil, nil)，
// 供「也可以用专用快捷 Flag 传参」的命令使用。
func (b *bodySource) buildOptional(stdin *os.File) (map[string]any, error) {
	if strings.TrimSpace(b.file) == "" && len(b.kv) == 0 {
		return nil, nil
	}
	return buildJSONBody(b.file, b.kv, stdin)
}

// listQuery 拼装列表类接口的 query string。
// 后端真实参数名以 controller 为准（见 route-command-map.md），不臆造参数。
type listQuery struct {
	pairs []string
	page  int
	limit int
}

func (q *listQuery) addCommonFlags(cmd *cobra.Command) {
	cmd.Flags().IntVar(&q.page, "page", 0, "页码（从 1 开始）")
	cmd.Flags().IntVar(&q.limit, "limit", 0, "每页条数（后端上限 100）")
}

// set 追加一个筛选参数；空值不拼。
func (q *listQuery) set(key, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	q.pairs = append(q.pairs, key+"="+url.QueryEscape(value))
}

// String 返回 "?..."/"" 形式的 query string。
func (q *listQuery) String() string {
	pairs := make([]string, 0, len(q.pairs)+2)
	if q.page > 0 {
		pairs = append(pairs, "page="+strconv.Itoa(q.page))
	}
	if q.limit > 0 {
		pairs = append(pairs, "limit="+strconv.Itoa(q.limit))
	}
	pairs = append(pairs, q.pairs...)
	if len(pairs) == 0 {
		return ""
	}
	return "?" + strings.Join(pairs, "&")
}

// idArg 校验并返回路径参数：只接受正整数，非法立刻按参数错误退出（2），不发请求。
func idArg(what, raw string) (string, error) {
	id, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || id <= 0 {
		return "", client.Usagef("%s 必须是正整数，实际为 %q", what, raw)
	}
	return strconv.Itoa(id), nil
}

// apiCall 执行一次 HTTP 请求（管理接口默认 30s 超时）。
func (a *App) apiCall(cmd *cobra.Command, method, path string, body any) (*client.Response, error) {
	return a.apiCallWithTimeout(cmd, method, path, body, client.DefaultTimeout)
}

// apiCallWithTimeout 执行一次 HTTP 请求，并指定超时（连通性测试类用 120s）。
//
// 超时会追加「服务端可能已执行」提示：客户端超时与服务端完成是两件事
// （#257 验收事故里三个 DELETE 客户端全部 exit 1，服务端全部 200）。
func (a *App) apiCallWithTimeout(cmd *cobra.Command, method, path string, body any, timeout time.Duration) (*client.Response, error) {
	cl, _, err := a.NewClient(timeout)
	if err != nil {
		return nil, err
	}
	resp, err := cl.Do(cmd.Context(), method, path, body)
	return resp, withNonIdempotentHint(err)
}

// apiCallLong 用于长耗时清理类接口（默认 5 分钟，--timeout 可覆盖）。
func (a *App) apiCallLong(cmd *cobra.Command, method, path string, body any) (*client.Response, error) {
	return a.apiCallWithTimeout(cmd, method, path, body, client.CleanupTimeout)
}

// outList 输出列表响应：--json 原样透传，否则按 columns 渲染表格。
func (a *App) outList(resp *client.Response, columns []string) error {
	p := a.Printer()
	if a.flagJSON {
		return p.JSONRaw(resp.Body)
	}
	return p.RenderList(resp.Body, columns)
}

// outObject 输出单个对象：--json 原样透传，否则键值摘要。
func (a *App) outObject(resp *client.Response) error {
	p := a.Printer()
	if a.flagJSON {
		return p.JSONRaw(resp.Body)
	}
	return p.RenderObject(resp.Body)
}

// confirmDestructive 是危险操作的统一确认：未传 --yes 且非 TTY ⇒ 退出码 2，且请求不会发出。
//
// 本机桌面端 profile 下把来源写进确认提示：事故的根因之一就是
// 「用户以为在打 mock，其实连的是本机真实网关」。放行判定在 guardDestructive 里，
// 这里只负责让确认文案带上 profile 名与目标地址。
func (a *App) confirmDestructive(what string) error {
	question := fmt.Sprintf("确定%s？", what)
	if profile, baseURL, hit := a.isLocalDesktopConnection(); hit {
		question = fmt.Sprintf("确定%s？（当前 profile %q 来自本机桌面端：%s）", what, profile, baseURL)
	}
	return prompt.Confirm(a.errOut, a.in, question, a.flagYes)
}

// jsonBodyFromResponse 把已有对象解码成 map，用于「先 GET 再合并再 PUT」（model update）。
func jsonBodyFromResponse(resp *client.Response) (map[string]any, error) {
	var body map[string]any
	if err := resp.Unmarshal(&body); err != nil {
		return nil, err
	}
	if body == nil {
		return nil, fmt.Errorf("服务端返回的对象为空，无法合并更新")
	}
	return body, nil
}

// mergeBody 把补丁合并进基准对象（浅合并：顶层键覆盖）。
func mergeBody(base, patch map[string]any) map[string]any {
	merged := make(map[string]any, len(base)+len(patch))
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range patch {
		merged[k] = v
	}
	return merged
}
