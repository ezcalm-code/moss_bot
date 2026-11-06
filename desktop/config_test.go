package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func baseData() *ConfigData {
	return &ConfigData{
		Models: &ModelsSection{
			Default: "glm",
			Entries: []ModelEntry{
				{Alias: "glm", Provider: "internal", Model: "glm-5.3-flash"},
				{Alias: "ds", Provider: "deepseek", Model: "deepseek-chat"},
			},
		},
		Providers: map[string]ProviderConfig{
			"internal":  {BaseURL: "https://gw.example.com/v1", APIKeyEnv: "INTERNAL_API_KEY"},
			"deepseek": {BaseURL: "https://api.deepseek.com/v1", APIKeyEnv: "DEEPSEEK_API_KEY"},
		},
	}
}

func TestValidateOK(t *testing.T) {
	if errs := Validate(baseData()); len(errs) != 0 {
		t.Fatalf("合法数据报错: %v", errs)
	}
}

func TestValidateCatches(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*ConfigData)
		want   string
	}{
		{"空 entries", func(d *ConfigData) { d.Models.Entries = nil }, "不能为空"},
		{"alias 重复", func(d *ConfigData) {
			d.Models.Entries = append(d.Models.Entries, ModelEntry{Alias: "glm", Provider: "deepseek", Model: "x"})
		}, "重复"},
		{"provider 未引用", func(d *ConfigData) {
			d.Models.Entries[0].Provider = "ghost"
		}, "不存在的 provider"},
		{"default 悬空", func(d *ConfigData) { d.Models.Default = "nope" }, "不在 entries 中"},
		{"baseUrl 空", func(d *ConfigData) { d.Providers["deepseek"] = ProviderConfig{APIKeyEnv: "X"} }, "baseUrl"},
		{"baseUrl 非法", func(d *ConfigData) {
			p := d.Providers["deepseek"]
			p.BaseURL = "not-a-url"
			d.Providers["deepseek"] = p
		}, "不是合法 URL"},
		{"缺 key 来源", func(d *ConfigData) { d.Providers["deepseek"] = ProviderConfig{BaseURL: "https://x.com"} }, "缺少 apiKeyEnv"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := baseData()
			c.mutate(d)
			errs := Validate(d)
			if len(errs) == 0 || !strings.Contains(strings.Join(errs, ";"), c.want) {
				t.Fatalf("期望错误包含 %q，实际: %v", c.want, errs)
			}
		})
	}
}

func TestAddEntryRollback(t *testing.T) {
	d := baseData()
	if errs := d.AddEntry(ModelEntry{Alias: "glm", Provider: "deepseek", Model: "x"}, nil); len(errs) == 0 {
		t.Fatal("重复 alias 应被拒绝")
	}
	if len(d.Models.Entries) != 2 {
		t.Fatalf("失败后 entries 应回滚，实际 %d 条", len(d.Models.Entries))
	}

	if errs := d.AddEntry(ModelEntry{Alias: "local", Provider: "ollama", Model: "qwen"}, &ProviderConfig{BaseURL: "http://localhost:11434/v1", APIKeyEnv: "LOCAL_API_KEY"}); len(errs) != 0 {
		t.Fatalf("新增失败: %v", errs)
	}
	if len(d.Models.Entries) != 3 || len(d.Providers) != 3 {
		t.Fatalf("新增后数量不对: %d entries, %d providers", len(d.Models.Entries), len(d.Providers))
	}
}

func TestUpdateEntrySyncsDefault(t *testing.T) {
	d := baseData()
	if errs := d.UpdateEntry("glm", ModelEntry{Alias: "glm2", Provider: "internal", Model: "next"}); len(errs) != 0 {
		t.Fatalf("改名失败: %v", errs)
	}
	if d.Models.Default != "glm2" {
		t.Fatalf("default 应同步为 glm2，实际 %q", d.Models.Default)
	}
	if errs := d.UpdateEntry("ds", ModelEntry{Alias: "glm2", Provider: "deepseek", Model: "x"}); len(errs) == 0 {
		t.Fatal("改成已存在的 alias 应被拒绝")
	}
	if d.Models.Entries[1].Alias != "ds" {
		t.Fatal("失败的更新应回滚")
	}
}

func TestRemoveEntryOrphanAndDefaultFallback(t *testing.T) {
	// 删除非默认项：default 不变，provider 变 orphan
	d := baseData()
	orphan, errs := d.RemoveEntry("ds")
	if len(errs) != 0 {
		t.Fatalf("删除失败: %v", errs)
	}
	if orphan != "deepseek" {
		t.Fatalf("deepseek 应成为 orphan，实际 %q", orphan)
	}
	if d.Models.Default != "glm" {
		t.Fatalf("删除非默认项 default 不应变化，实际 %q", d.Models.Default)
	}

	// 删除默认项：default 清空，隐式回退 entries[0]
	d2 := baseData()
	d2.Models.Entries = append(d2.Models.Entries, ModelEntry{Alias: "local", Provider: "deepseek", Model: "qwen"})
	if _, errs := d2.RemoveEntry("glm"); len(errs) != 0 {
		t.Fatalf("删除默认项失败: %v", errs)
	}
	if d2.Models.Default != "" {
		t.Fatalf("删除默认项后 default 应清空，实际 %q", d2.Models.Default)
	}
	if d2.currentDefault() != "ds" {
		t.Fatalf("隐式默认应回退到 ds，实际 %q", d2.currentDefault())
	}

	// 最后一个渠道不可删
	if _, errs := d.RemoveEntry("glm"); len(errs) == 0 {
		t.Fatal("删到最后一个渠道应被拒绝")
	}
}

func TestRemoveProviderRequiresNoRefs(t *testing.T) {
	d := baseData()
	if errs := d.RemoveProvider("internal"); len(errs) == 0 {
		t.Fatal("仍被引用的 provider 应拒绝删除")
	}
	orphan, errs := d.RemoveEntry("ds")
	if len(errs) != 0 || orphan != "deepseek" {
		t.Fatalf("前置删除失败: orphan=%q errs=%v", orphan, errs)
	}
	if errs := d.RemoveProvider("deepseek"); len(errs) != 0 {
		t.Fatalf("删除 orphan provider 失败: %v", errs)
	}
	if _, ok := d.Providers["deepseek"]; ok {
		t.Fatal("provider 应已删除")
	}
}

const sampleYAML = `# 顶部注释应保留
log:
  level: info

persona:
  name: Moss

models:
  default: glm
  entries:
    - alias: glm
      provider: internal
      model: glm-5.3-flash
    - alias: ds
      provider: deepseek
      model: deepseek-chat

providers:
  internal:
    baseUrl: https://gw.example.com/v1
    apiKeyEnv: INTERNAL_API_KEY
  deepseek:
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY

session:
  store: memory
`

func TestLoadSavePreservesOtherSections(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	root, data, err := LoadDoc(path)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if data.Models.Default != "glm" || len(data.Models.Entries) != 2 {
		t.Fatalf("解码结果不对: %+v", data.Models)
	}
	if errs := data.SetDefault("glm"); len(errs) != 0 {
		t.Fatal("SetDefault 失败")
	}
	data.Models.Entries[0].Model = "glm-next"
	if err := SaveDoc(path, root, data); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(after)
	// 其他段与注释保留
	for _, want := range []string{"# 顶部注释应保留", "log:", "persona:", "name: Moss", "session:", "store: memory"} {
		if !strings.Contains(s, want) {
			t.Fatalf("保存后丢失了 %q，文件内容:\n%s", want, s)
		}
	}
	// 修改生效
	var check ConfigData
	var root2 yaml.Node
	if err := yaml.Unmarshal(after, &root2); err != nil {
		t.Fatal(err)
	}
	if err := root2.Content[0].Decode(&check); err != nil {
		t.Fatal(err)
	}
	if check.Models.Entries[0].Model != "glm-next" {
		t.Fatalf("修改未生效: %+v", check.Models)
	}
}
