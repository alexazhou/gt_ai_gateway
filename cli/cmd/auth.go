package cmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alexazhou/gt_ai_gateway/cli/internal/client"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/config"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/output"
	"github.com/alexazhou/gt_ai_gateway/cli/internal/prompt"
)

// statusResponse 是 `GET /status.json` 中 CLI 需要展示的字段（其余字段原样留给 --json）。
type statusResponse struct {
	Status   string  `json:"status"`
	Mode     string  `json:"mode"`
	UserType string  `json:"user_type"`
	UserID   *int64  `json:"user_id"`
	UserName *string `json:"user_name"`
	Tenant   struct {
		ID                *int64 `json:"id"`
		MainID            *int64 `json:"main_id"`
		MultiTenantEnable bool   `json:"multi_tenant_enabled"`
	} `json:"tenant"`
	Statistics struct {
		Users   int64 `json:"users"`
		Vendors int64 `json:"vendors"`
		Models  int64 `json:"models"`
		Records int64 `json:"records"`
	} `json:"statistics"`
	System struct {
		Environment string `json:"environment"`
		Version     string `json:"version"`
		APIAddress  string `json:"apiAddress"`
		StartTime   string `json:"startTime"`
		Uptime      string `json:"uptime"`
	} `json:"system"`
}

func (a *App) newLoginCmd() *cobra.Command {
	var fromTauri bool
	cmd := &cobra.Command{
		Use:   "login",
		Short: "登录网关并保存 Profile（会调用 GET /status.json 校验）",
		Long: `登录会调用 GET /status.json 校验地址与 Token 是否有效，校验通过后保存为 Profile。
未传 --token 且处于交互终端时会隐藏回显地提示输入。`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runLogin(cmd, fromTauri)
		},
	}
	cmd.Flags().BoolVar(&fromTauri, "from-tauri", false,
		fmt.Sprintf("从 Tauri 桌面端配置读取地址与 Token 并保存为 profile `tauri`（配置文件可用 %s 指定）", config.EnvTauriConfig))
	return cmd
}

func (a *App) runLogin(cmd *cobra.Command, fromTauri bool) error {
	p := a.Printer()

	url := strings.TrimSpace(a.flagURL)
	token := strings.TrimSpace(a.flagToken)
	tenant := strings.TrimSpace(a.flagTenant)
	profileName := strings.TrimSpace(a.flagProfile)

	if url == "" {
		url = strings.TrimSpace(a.getenv(config.EnvURL))
	}
	if token == "" {
		token = strings.TrimSpace(a.getenv(config.EnvToken))
	}
	if tenant == "" {
		tenant = strings.TrimSpace(a.getenv(config.EnvTenant))
	}

	var tauriPath string
	if fromTauri {
		tc, err := a.loadTauri()
		if err != nil {
			if err == config.ErrTauriConfigNotFound {
				return fmt.Errorf("未找到 Tauri 桌面端配置：请先启动一次桌面端（可用 `gtgw login --url ... --token ...` 手动登录）")
			}
			return err
		}
		tauriPath = tc.Path
		if url == "" {
			url = tc.BaseURL
		}
		if token == "" {
			token = tc.Token
		}
		if profileName == "" {
			profileName = "tauri"
		}
	}

	if url == "" {
		return client.Usagef("缺少网关地址：请传 --url、设置 %s，或使用 --from-tauri", config.EnvURL)
	}
	if token == "" {
		if !prompt.IsTTY(a.in) {
			return client.Usagef("缺少 Token：请传 --token、设置 %s，或使用 --from-tauri", config.EnvToken)
		}
		var err error
		token, err = prompt.ReadSecret(a.errOut, a.in)
		if err != nil {
			return err
		}
	}

	cl, err := client.New(client.Options{BaseURL: url, Token: token, Tenant: tenant, Timeout: client.DefaultTimeout})
	if err != nil {
		return err
	}
	ctx := cmd.Context()
	var st statusResponse
	if _, err := cl.GetJSON(ctx, "/status.json", &st); err != nil {
		return err
	}

	// 保存 profile：名字优先级 --profile > 现有 active > "default"
	f, err := a.loadFile()
	if err != nil {
		return err
	}
	if profileName == "" {
		if active := strings.TrimSpace(f.ActiveProfile); active != "" {
			profileName = active
		} else {
			profileName = "default"
		}
	}
	tenantToSave := tenant
	if tenantToSave == "" {
		tenantToSave = st.tenantName()
	}
	// FromDesktop 随登录方式一起落盘：`--from-tauri` 才置位，其它登录方式显式清零
	// （同一个 profile 名被手动 login 覆盖后，就不再是桌面端凭据了）。
	f.SetProfile(profileName, config.Profile{
		BaseURL:       cl.BaseURL(),
		Token:         token,
		DefaultTenant: tenantToSave,
		FromDesktop:   fromTauri,
	})
	f.ActiveProfile = profileName
	if err := a.saveFile(f); err != nil {
		return err
	}

	if a.flagJSON {
		out := map[string]any{
			"profile":     profileName,
			"base_url":    cl.BaseURL(),
			"tenant":      tenantToSave,
			"user_type":   st.UserType,
			"user_name":   stringOrEmpty(st.UserName),
			"server":      st.System.Version,
			"environment": st.System.Environment,
		}
		if fromTauri {
			out["origin"] = config.ProfileOriginDesktop
		}
		return p.JSONValue(out)
	}
	pairs := [][2]string{
		{"profile", profileName},
		{"base_url", cl.BaseURL()},
		{"token", output.MaskToken(token)},
	}
	if fromTauri {
		pairs = append(pairs, [2]string{"profile_origin", config.ProfileOriginDesktop})
	}
	if tenantToSave != "" {
		pairs = append(pairs, [2]string{"tenant", tenantToSave})
	}
	if st.UserType != "" {
		pairs = append(pairs, [2]string{"user_type", st.UserType})
	}
	if st.System.Version != "" {
		pairs = append(pairs, [2]string{"server_version", st.System.Version})
	}
	if tauriPath != "" {
		pairs = append(pairs, [2]string{"tauri_config", tauriPath})
	}
	return p.KV(pairs)
}

// tenantName 返回用于保存到 profile 的默认租户：优先租户名，其次 id。
func (st statusResponse) tenantName() string {
	if st.Tenant.ID != nil {
		return fmt.Sprintf("%d", *st.Tenant.ID)
	}
	return ""
}

func stringOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (a *App) newLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "清除当前激活 Profile 的 Token（保留地址，便于下次直接输入新 Token）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := a.Printer()
			f, err := a.loadFile()
			if err != nil {
				return err
			}
			name := strings.TrimSpace(a.flagProfile)
			if name == "" {
				name = strings.TrimSpace(f.ActiveProfile)
			}
			if name == "" {
				p.Info("当前没有激活的 profile，无需登出")
				return nil
			}
			prof, ok := f.Profile(name)
			if !ok {
				return client.Usagef("profile %q 不存在，可用 `gtgw profile list` 查看", name)
			}
			prof.Token = ""
			f.SetProfile(name, prof)
			if err := a.saveFile(f); err != nil {
				return err
			}
			if a.flagJSON {
				return p.JSONValue(map[string]any{"profile": name, "token_cleared": true})
			}
			p.Line("已登出 profile %q（profile 与地址保留，下次 login 可复用）", name)
			return nil
		},
	}
}

func (a *App) newProfileCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profile",
		Short: "管理多环境 Profile（list / use / remove）",
		Args:  noArgs,
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "列出全部 Profile（Token 脱敏）",
			Args:  noArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				p := a.Printer()
				f, err := a.loadFile()
				if err != nil {
					return err
				}
				names := make([]string, 0, len(f.Profiles))
				for name := range f.Profiles {
					names = append(names, name)
				}
				sort.Strings(names)

				if a.flagJSON {
					type item struct {
						Name    string `json:"name"`
						Active  bool   `json:"active"`
						BaseURL string `json:"base_url"`
						Token   string `json:"token"`
						Tenant  string `json:"default_tenant,omitempty"`
						Origin  string `json:"origin,omitempty"`
					}
					items := make([]item, 0, len(names))
					for _, name := range names {
						prof := f.Profiles[name]
						items = append(items, item{
							Name:    name,
							Active:  name == f.ActiveProfile,
							BaseURL: prof.BaseURL,
							Token:   output.MaskToken(prof.Token),
							Tenant:  prof.DefaultTenant,
							Origin:  prof.Origin(),
						})
					}
					return p.JSONValue(map[string]any{"active_profile": f.ActiveProfile, "profiles": items})
				}
				if a.flagQuiet {
					for _, name := range names {
						p.Line("%s", name)
					}
					return nil
				}
				rows := make([][]string, 0, len(names))
				for _, name := range names {
					prof := f.Profiles[name]
					active := ""
					if name == f.ActiveProfile {
						active = "*"
					}
					rows = append(rows, []string{active, name, prof.BaseURL, output.MaskToken(prof.Token), prof.DefaultTenant, prof.Origin()})
				}
				return p.Table([]string{"ACTIVE", "NAME", "BASE_URL", "TOKEN", "TENANT", "ORIGIN"}, rows)
			},
		},
		&cobra.Command{
			Use:   "use <name>",
			Short: "切换当前激活 Profile",
			Args:  exactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				p := a.Printer()
				f, err := a.loadFile()
				if err != nil {
					return err
				}
				name := args[0]
				if _, ok := f.Profile(name); !ok {
					return client.Usagef("profile %q 不存在，可用 `gtgw profile list` 查看", name)
				}
				f.ActiveProfile = name
				if err := a.saveFile(f); err != nil {
					return err
				}
				if a.flagJSON {
					return p.JSONValue(map[string]any{"active_profile": name})
				}
				p.Line("已切换到 profile %q", name)
				return nil
			},
		},
		&cobra.Command{
			Use:   "remove <name>",
			Short: "删除 Profile（彻底清除该环境的凭证）",
			Args:  exactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				p := a.Printer()
				name := args[0]
				if err := prompt.Confirm(a.errOut, a.in, fmt.Sprintf("删除 profile %q（其 Token 将不可恢复）？", name), a.flagYes); err != nil {
					return err
				}
				f, err := a.loadFile()
				if err != nil {
					return err
				}
				if _, ok := f.Profile(name); !ok {
					return client.Usagef("profile %q 不存在，可用 `gtgw profile list` 查看", name)
				}
				delete(f.Profiles, name)
				if f.ActiveProfile == name {
					f.ActiveProfile = ""
				}
				if err := a.saveFile(f); err != nil {
					return err
				}
				if a.flagJSON {
					return p.JSONValue(map[string]any{"removed": name})
				}
				p.Line("已删除 profile %q", name)
				return nil
			},
		},
	)
	return cmd
}

func (a *App) newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "查看网关系统状态（GET /status.json）",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			p := a.Printer()
			cl, res, err := a.NewClient(client.DefaultTimeout)
			if err != nil {
				return err
			}
			resp, err := cl.GetJSON(cmd.Context(), "/status.json", nil)
			if err != nil {
				return err
			}
			if a.flagJSON {
				return p.JSONRaw(resp.Body)
			}
			var st statusResponse
			if err := resp.Unmarshal(&st); err != nil {
				return err
			}
			if a.flagQuiet {
				p.Line("%s", st.Status)
				return nil
			}
			pairs := [][2]string{
				{"base_url", cl.BaseURL()},
				{"token", output.MaskToken(res.Token)},
			}
			if res.ProfileName != "" {
				pairs = append(pairs, [2]string{"profile", res.ProfileName})
			}
			if res.ProfileFromDesktop {
				pairs = append(pairs, [2]string{"profile_origin", config.ProfileOriginDesktop})
			}
			pairs = append(pairs,
				[2]string{"status", st.Status},
				[2]string{"mode", st.Mode},
				[2]string{"environment", st.System.Environment},
				[2]string{"version", st.System.Version},
				[2]string{"uptime", st.System.Uptime},
				[2]string{"user_type", st.UserType},
			)
			if res.Tenant != "" {
				pairs = append(pairs, [2]string{"tenant", res.Tenant})
			}
			pairs = append(pairs,
				[2]string{"users", fmt.Sprintf("%d", st.Statistics.Users)},
				[2]string{"vendors", fmt.Sprintf("%d", st.Statistics.Vendors)},
				[2]string{"models", fmt.Sprintf("%d", st.Statistics.Models)},
				[2]string{"records", fmt.Sprintf("%d", st.Statistics.Records)},
			)
			return p.KV(pairs)
		},
	}
}
