package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// updateStatus 是 `GET /update.json` 的响应结构（见 src/service/updateService.ts）。
type updateStatus struct {
	Success        bool   `json:"success"`
	HasUpdate      bool   `json:"has_update"`
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	ReleaseURL     string `json:"release_url,omitempty"`
	ReleaseNotes   string `json:"release_notes,omitempty"`
	ErrorMessage   string `json:"error_message,omitempty"`
}

func (a *App) newUpdateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "update",
		Short: "版本更新相关命令",
		Args:  noArgs,
	}
	var force bool
	check := &cobra.Command{
		Use:   "check",
		Short: "检查网关是否有新版本（GET /update.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := a.Printer()
			cl, _, err := a.NewClient(client.DefaultTimeout)
			if err != nil {
				return err
			}
			path := "/update.json"
			if force {
				path += "?force=1"
			}
			resp, err := cl.GetJSON(cmd.Context(), path, nil)
			if err != nil {
				return err
			}
			if a.flagJSON {
				return p.JSONRaw(resp.Body)
			}
			var st updateStatus
			if err := resp.Unmarshal(&st); err != nil {
				return err
			}
			if a.flagQuiet {
				p.Line("%s", st.LatestVersion)
				return nil
			}
			pairs := [][2]string{
				{"current_version", st.CurrentVersion},
				{"latest_version", st.LatestVersion},
				{"has_update", fmt.Sprintf("%t", st.HasUpdate)},
			}
			if st.ReleaseURL != "" {
				pairs = append(pairs, [2]string{"release_url", st.ReleaseURL})
			}
			if st.ErrorMessage != "" {
				pairs = append(pairs, [2]string{"error_message", st.ErrorMessage})
			}
			if err := p.KV(pairs); err != nil {
				return err
			}
			if st.HasUpdate {
				p.Info("有新版本 %s 可用（当前 %s）", st.LatestVersion, st.CurrentVersion)
			}
			return nil
		},
	}
	check.Flags().BoolVar(&force, "force", false, "强制刷新（?force=1），忽略服务端 12 小时缓存")
	cmd.AddCommand(check)
	return cmd
}
