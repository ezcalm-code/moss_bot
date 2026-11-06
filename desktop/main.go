package main

import (
	"fmt"
	"log"
	"os"
	"sort"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"gopkg.in/yaml.v3"
)

const newProviderTag = "＋ 新建 provider…"

// app 是窗口的全部状态；view 每帧从它重建界面。
type app struct {
	path string
	root *yaml.Node
	data *ConfigData

	editing    bool
	editIdx    int // -1 = 新增，>=0 = 编辑 entries 下标
	origAlias  string
	fAlias     string
	fModel     string
	fProvider  string
	fBaseURL   string
	fAPIKeyEnv string
	formErr    string

	confirmIdx int // >=0 = 待确认删除的行下标，-1 = 无
	msg        string
	msgIsErr   bool
}

func (a *app) reload() error {
	root, data, err := LoadDoc(a.path)
	if err != nil {
		return err
	}
	a.root, a.data = root, data
	return nil
}

// persist 把当前 data 写回磁盘；失败时设置错误消息。
func (a *app) persist() bool {
	if err := SaveDoc(a.path, a.root, a.data); err != nil {
		a.msg, a.msgIsErr = err.Error(), true
		return false
	}
	return true
}

func (a *app) notify(ok bool, msg string) {
	a.msg, a.msgIsErr = msg, !ok
}

func (a *app) providerOptions() []string {
	ids := make([]string, 0, len(a.data.Providers)+1)
	for id := range a.data.Providers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return append(ids, newProviderTag)
}

func (a *app) beginAdd() {
	a.editing = true
	a.editIdx = -1
	a.origAlias = ""
	a.formErr = ""
	a.fAlias, a.fModel = "", ""
	opts := a.providerOptions()
	if len(opts) > 1 {
		a.fProvider = opts[0]
	} else {
		a.fProvider = newProviderTag
	}
	a.fBaseURL, a.fAPIKeyEnv = "", ""
	a.confirmIdx = -1
}

func (a *app) beginEdit(i int) {
	e := a.data.Models.Entries[i]
	a.editing = true
	a.editIdx = i
	a.origAlias = e.Alias
	a.formErr = ""
	a.fAlias, a.fModel, a.fProvider = e.Alias, e.Model, e.Provider
	a.fBaseURL, a.fAPIKeyEnv = "", ""
	a.confirmIdx = -1
}

func (a *app) cancelEdit() {
	a.editing = false
	a.formErr = ""
}

func (a *app) submitForm() {
	entry := ModelEntry{
		Alias:    strings.TrimSpace(a.fAlias),
		Provider: strings.TrimSpace(a.fProvider),
		Model:    strings.TrimSpace(a.fModel),
	}
	if entry.Alias == "" || entry.Model == "" {
		a.formErr = "alias 与 model 为必填项"
		return
	}
	isNewProvider := entry.Provider == newProviderTag
	var newProvider *ProviderConfig
	if isNewProvider {
		baseURL := strings.TrimSpace(a.fBaseURL)
		apiKeyEnv := strings.TrimSpace(a.fAPIKeyEnv)
		if baseURL == "" || apiKeyEnv == "" {
			a.formErr = "新建 provider 需要填写 baseUrl 与 apiKeyEnv"
			return
		}
		newProvider = &ProviderConfig{BaseURL: baseURL, APIKeyEnv: apiKeyEnv}
	}
	var errs []string
	if a.editIdx == -1 {
		errs = a.data.AddEntry(entry, newProvider)
	} else {
		errs = a.data.UpdateEntry(a.origAlias, entry)
	}
	if len(errs) > 0 {
		a.formErr = strings.Join(errs, "；")
		return
	}
	if a.persist() {
		a.notify(true, "已保存，运行中的 bot 重启后生效")
	}
	a.cancelEdit()
}

func (a *app) setDefault(i int) {
	if errs := a.data.SetDefault(a.data.Models.Entries[i].Alias); len(errs) > 0 {
		a.notify(false, strings.Join(errs, "；"))
		return
	}
	if a.persist() {
		a.notify(true, "已设为默认模型，重启 bot 生效")
	}
}

func (a *app) doDelete(i int) {
	e := a.data.Models.Entries[i]
	orphan, errs := a.data.RemoveEntry(e.Alias)
	if len(errs) > 0 {
		a.notify(false, strings.Join(errs, "；"))
		a.confirmIdx = -1
		return
	}
	msg := fmt.Sprintf("已删除 %s", e.Alias)
	if orphan != "" {
		a.data.RemoveProvider(orphan)
		msg = fmt.Sprintf("已删除 %s，并清理了无引用的 provider %s", e.Alias, orphan)
	}
	a.confirmIdx = -1
	if a.persist() {
		a.notify(true, msg+"；重启 bot 生效")
	}
}

func (a *app) view(c *ui.Context) {
	t := c.Theme()
	ui.Column(c).Fill().Gap(10).Padding(20).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "Moss 渠道管理").FontSize(20).Bold().Grow(1)
			ui.Text(c, a.path).TextColor(t.TextMuted)
		})
		if a.msg != "" {
			prefix := "✓ "
			if a.msgIsErr {
				prefix = "⚠ "
			}
			ui.Textf(c, "%s%s", prefix, a.msg)
		}
		if a.data == nil {
			ui.Textf(c, "配置加载失败：%s", a.msg).Grow(1)
			return
		}
		a.listSection(c, t)
		if a.editing {
			a.editForm(c, t)
		}
	})
}

func (a *app) listSection(c *ui.Context, t *ui.Theme) {
	ui.Scroll(c).Grow(1).Gap(4).Children(func() {
		for i, e := range a.data.Models.Entries {
			a.entryRow(c, t, i, e)
		}
	})
	ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
		if ui.PrimaryButton(c, "添加渠道").Clicked() {
			a.beginAdd()
		}
		ui.Text(c, "● 为默认模型；改动即时写入 config.yaml").TextColor(t.TextMuted)
	})
}

func (a *app) entryRow(c *ui.Context, t *ui.Theme, i int, e ModelEntry) {
	isDefault := e.Alias == a.data.currentDefault()
	marker := "○"
	if isDefault {
		marker = "●"
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Padding(8).Children(func() {
		ui.Text(c, marker)
		ui.Column(c).Grow(1).Gap(2).Children(func() {
			if isDefault {
				ui.Textf(c, "%s（默认）", e.Alias).Bold()
			} else {
				ui.Text(c, e.Alias).Bold()
			}
			ui.Textf(c, "%s / %s", e.Provider, e.Model).TextColor(t.TextMuted)
		})
		if a.confirmIdx == i {
			if ui.PrimaryButton(c, "确认删除").Clicked() {
				a.doDelete(i)
			}
			if ui.Button(c, "取消").Clicked() {
				a.confirmIdx = -1
			}
		} else {
			if ui.Button(c, "启用").Disabled(isDefault).Clicked() {
				a.setDefault(i)
			}
			if ui.Button(c, "编辑").Clicked() {
				a.beginEdit(i)
			}
			if ui.Button(c, "删除").Clicked() {
				a.confirmIdx = i
			}
		}
	})
	ui.Divider(c)
}

func (a *app) editForm(c *ui.Context, t *ui.Theme) {
	title := "添加渠道"
	if a.editIdx != -1 {
		title = "编辑渠道"
	}
	label := func(text string) {
		ui.Text(c, text).Width(90)
	}
	ui.Column(c).Fill().Gap(10).Padding(12).Border(1, t.Border).Children(func() {
		ui.Text(c, title).FontSize(16).Bold()
		if a.formErr != "" {
			ui.Textf(c, "⚠ %s", a.formErr)
		}
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			label("渠道名称")
			ui.TextInput(c, &a.fAlias).Grow(1).Placeholder("如 glm，/model 命令用的短名")
		})
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			label("模型名称")
			ui.TextInput(c, &a.fModel).Grow(1).Placeholder("如 glm-5.3-flash，传给 API 的 model 参数")
		})
		ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
			label("服务")
			ui.Select(c, &a.fProvider, a.providerOptions()).Grow(1)
		})
		if a.fProvider == newProviderTag {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				label("接口地址")
				ui.TextInput(c, &a.fBaseURL).Grow(1).Placeholder("https://api.x.ai/v1（OpenAI 兼容端点）")
			})
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				label("密钥变量名")
				ui.TextInput(c, &a.fAPIKeyEnv).Grow(1).Placeholder("如 XAI_API_KEY，写在 .env 里")
			})
		}
		ui.Row(c).Gap(8).Justify(ui.End).Children(func() {
			if ui.Button(c, "取消").Clicked() {
				a.cancelEdit()
			}
			if ui.PrimaryButton(c, "保存").Clicked() {
				a.submitForm()
			}
		})
	})
}

func main() {
	path := os.Getenv("MOSS_CONFIG")
	if path == "" {
		path = "config.yaml"
	}
	a := &app{path: path, editIdx: -1, confirmIdx: -1}
	if err := a.reload(); err != nil {
		a.msg, a.msgIsErr = err.Error(), true
	}
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:     "Moss 渠道管理",
			Width:     620,
			Height:    560,
			MinWidth:  480,
			MinHeight: 400,
			StateKey:  "main",
			Content:   ui.View(a.view),
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
