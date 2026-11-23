package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

func (a *App) newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "查看与修改全局配置（GET / PUT /config.json，写操作仅 main 租户视角）",
		Args:  noArgs,
	}
	cmd.AddCommand(a.newConfigGetCmd(), a.newConfigSetCmd())
	return cmd
}

func (a *App) newConfigGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get",
		Short: "获取全部全局配置（GET /config.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := a.Printer()
			cl, _, err := a.NewClient(client.DefaultTimeout)
			if err != nil {
				return err
			}
			resp, err := cl.GetJSON(cmd.Context(), "/config.json", nil)
			if err != nil {
				return err
			}
			if a.flagJSON {
				return p.JSONRaw(resp.Body)
			}
			values, keys, err := decodeConfig(resp.Body)
			if err != nil {
				return err
			}
			if a.flagQuiet {
				for _, k := range keys {
					p.Line("%s", values[k])
				}
				return nil
			}
			pairs := make([][2]string, 0, len(keys))
			for _, k := range keys {
				pairs = append(pairs, [2]string{k, values[k]})
			}
			return p.KV(pairs)
		},
	}
}

func (a *App) newConfigSetCmd() *cobra.Command {
	var (
		filePath string
		kvPairs  []string
	)
	cmd := &cobra.Command{
		Use:   "set",
		Short: "修改全局配置（PUT /config.json）",
		Long: `两种传参方式二选一：
  --file <path>   传入 JSON 文件（"-" 表示从 stdin 读取）
  --key k=v       逐项指定，可重复使用`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := a.Printer()
			body, err := buildJSONBody(filePath, kvPairs, a.in)
			if err != nil {
				return err
			}
			cl, _, err := a.NewClient(client.DefaultTimeout)
			if err != nil {
				return err
			}
			resp, err := cl.PutJSON(cmd.Context(), "/config.json", body, nil)
			if err != nil {
				return err
			}
			if a.flagJSON {
				return p.JSONRaw(resp.Body)
			}
			values, keys, err := decodeConfig(resp.Body)
			if err != nil {
				return err
			}
			if a.flagQuiet {
				for _, k := range keys {
					p.Line("%s", values[k])
				}
				return nil
			}
			pairs := make([][2]string, 0, len(keys))
			for _, k := range keys {
				pairs = append(pairs, [2]string{k, values[k]})
			}
			return p.KV(pairs)
		},
	}
	cmd.Flags().StringVarP(&filePath, "file", "f", "", "配置文件路径（- 表示从 stdin 读取 JSON）")
	cmd.Flags().StringArrayVar(&kvPairs, "key", nil, "逐项设置，格式 key=value，可重复")
	return cmd
}

// buildConfigBody 把 --file 或 --key k=v 转换成 PUT 请求体。
// 两者互斥；都不传或 key 格式非法一律归为参数错误（退出码 2）。
func buildJSONBody(filePath string, kvPairs []string, stdin *os.File) (map[string]any, error) {
	if filePath != "" && len(kvPairs) > 0 {
		return nil, client.Usagef("--file 与 --key 不能同时使用，请二选一")
	}
	if filePath == "" && len(kvPairs) == 0 {
		return nil, client.Usagef("缺少要修改的配置：请用 --file <path> 或 --key key=value 指定")
	}
	if filePath != "" {
		var raw []byte
		var err error
		if filePath == "-" {
			if stdin == nil {
				return nil, client.Usagef("无法从 stdin 读取配置：stdin 不可用")
			}
			raw, err = io.ReadAll(stdin)
		} else {
			raw, err = os.ReadFile(filePath)
		}
		if err != nil {
			return nil, client.Usagef("读取配置失败：%v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			return nil, client.Usagef("配置文件不是合法 JSON 对象：%v", err)
		}
		if body == nil {
			return nil, client.Usagef("配置文件必须是 JSON 对象（形如 {\"key\": \"value\"}）")
		}
		return body, nil
	}
	body := make(map[string]any, len(kvPairs))
	for _, pair := range kvPairs {
		idx := strings.Index(pair, "=")
		if idx <= 0 {
			return nil, client.Usagef("--key 格式应为 key=value，实际为 %q", pair)
		}
		key := strings.TrimSpace(pair[:idx])
		if key == "" {
			return nil, client.Usagef("--key 的键名不能为空：%q", pair)
		}
		body[key] = pair[idx+1:]
	}
	return body, nil
}

// decodeConfig 把配置响应体解成「键 → 字符串值」与排序后的键列表。
// 后端返回 Record<string, string>，这里对非字符串值做 fmt 兜底，避免因类型变化直接报错。
func decodeConfig(raw []byte) (map[string]string, []string, error) {
	var loose map[string]any
	if err := json.Unmarshal(raw, &loose); err != nil {
		return nil, nil, fmt.Errorf("解析配置响应失败：%w", err)
	}
	values := make(map[string]string, len(loose))
	keys := make([]string, 0, len(loose))
	for k, v := range loose {
		keys = append(keys, k)
		switch typed := v.(type) {
		case string:
			values[k] = typed
		case nil:
			values[k] = ""
		case bool:
			values[k] = fmt.Sprintf("%t", typed)
		case float64:
			values[k] = fmt.Sprintf("%v", typed)
		default:
			compact, err := json.Marshal(typed)
			if err != nil {
				values[k] = fmt.Sprintf("%v", typed)
				continue
			}
			values[k] = string(compact)
		}
	}
	sort.Strings(keys)
	return values, keys, nil
}
