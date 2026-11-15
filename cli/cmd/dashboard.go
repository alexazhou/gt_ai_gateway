package cmd

import (
	"context"
	"fmt"
	"sync"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
)

// dashboardStats 是 `GET /stats/dashboard.json` 的响应结构（见 src/controller/statsController.ts）。
type dashboardStats struct {
	TotalRequests int64    `json:"total_requests"`
	SuccessCount  int64    `json:"success_count"`
	FailedCount   int64    `json:"failed_count"`
	SuccessRate   *float64 `json:"success_rate"`
	ActiveUsers   int64    `json:"active_users"`
	ActiveModels  int64    `json:"active_models"`
	TodayRequests int64    `json:"today_requests"`
}

// recentRecord 是 `GET /stats/recent.json` 单条记录的结构。
type recentRecord struct {
	ID        int64  `json:"id"`
	UserID    int64  `json:"user_id"`
	ModelID   int64  `json:"model_id"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

func (a *App) newDashboardCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "dashboard",
		Short: "查看仪表盘汇总与近期请求（并发请求 /stats/dashboard.json 与 /stats/recent.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := a.Printer()
			cl, _, err := a.NewClient(client.DefaultTimeout)
			if err != nil {
				return err
			}
			dash, recent, err := fetchDashboard(cmd.Context(), cl)
			if err != nil {
				return err
			}
			if a.flagJSON {
				return p.JSONValue(map[string]any{"dashboard": dash, "recent": recent})
			}
			rate := "-"
			if dash.SuccessRate != nil {
				rate = fmt.Sprintf("%.2f%%", *dash.SuccessRate*100)
			}
			if a.flagQuiet {
				p.Line("%d", dash.TotalRequests)
				return nil
			}
			pairs := [][2]string{
				{"total_requests", fmt.Sprintf("%d", dash.TotalRequests)},
				{"today_requests", fmt.Sprintf("%d", dash.TodayRequests)},
				{"success_count", fmt.Sprintf("%d", dash.SuccessCount)},
				{"failed_count", fmt.Sprintf("%d", dash.FailedCount)},
				{"success_rate", rate},
				{"active_users", fmt.Sprintf("%d", dash.ActiveUsers)},
				{"active_models", fmt.Sprintf("%d", dash.ActiveModels)},
			}
			if err := p.KV(pairs); err != nil {
				return err
			}
			if len(recent) == 0 {
				return nil
			}
			fmt.Fprintln(a.out)
			rows := make([][]string, 0, len(recent))
			for _, r := range recent {
				rows = append(rows, []string{
					fmt.Sprintf("%d", r.ID),
					fmt.Sprintf("%d", r.UserID),
					fmt.Sprintf("%d", r.ModelID),
					r.Status,
					r.CreatedAt,
				})
			}
			return p.Table([]string{"ID", "USER", "MODEL", "STATUS", "CREATED_AT"}, rows)
		},
	}
}

// fetchDashboard 并发拉取汇总与近期记录：两者互相独立，串行没有意义。
func fetchDashboard(ctx context.Context, cl *client.Client) (dashboardStats, []recentRecord, error) {
	var (
		wg     sync.WaitGroup
		stats  dashboardStats
		recent []recentRecord
		statsE error
		recE   error
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, statsE = cl.GetJSON(ctx, "/stats/dashboard.json", &stats)
	}()
	go func() {
		defer wg.Done()
		_, recE = cl.GetJSON(ctx, "/stats/recent.json", &recent)
	}()
	wg.Wait()
	if statsE != nil {
		return stats, nil, statsE
	}
	if recE != nil {
		return stats, nil, recE
	}
	return stats, recent, nil
}
