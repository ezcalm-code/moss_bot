package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type ModelEntry struct {
	Alias    string `yaml:"alias"`
	Provider string `yaml:"provider"`
	Model    string `yaml:"model"`
}

type ProviderConfig struct {
	BaseURL   string `yaml:"baseUrl"`
	APIKeyEnv string `yaml:"apiKeyEnv,omitempty"`
	APIKey    string `yaml:"apiKey,omitempty"`
}

// ConfigData 是文档中 models/providers 两个段的强类型视图；
// 其余段（log/persona/session/telegram/feishu…）经由 yaml.Node 原样保留。
type ConfigData struct {
	Models    *ModelsSection
	Providers map[string]ProviderConfig
}

type ModelsSection struct {
	Default string       `yaml:"default,omitempty"`
	Entries []ModelEntry `yaml:"entries,omitempty"`
}

// LoadDoc 读取 config.yaml：返回根 Node（含全部段）与 models/providers 的解码结果。
func LoadDoc(path string) (*yaml.Node, *ConfigData, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var root yaml.Node
	if err := yaml.Unmarshal(b, &root); err != nil {
		return nil, nil, fmt.Errorf("yaml 解析失败: %w", err)
	}
	if len(root.Content) == 0 {
		return nil, nil, fmt.Errorf("yaml 文档为空")
	}
	var data ConfigData
	if err := root.Content[0].Decode(&data); err != nil {
		return nil, nil, fmt.Errorf("配置结构不符合预期: %w", err)
	}
	return &root, &data, nil
}

// SaveDoc 把 data 的 models/providers 写回根 Node 并落盘；其他段原样保留。
func SaveDoc(path string, root *yaml.Node, data *ConfigData) error {
	mapping := root.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return fmt.Errorf("顶层节点不是 mapping，无法安全写入")
	}
	if data.Models == nil || len(data.Models.Entries) == 0 {
		return fmt.Errorf("models.entries 不能为空，拒绝保存")
	}
	for _, section := range []struct {
		key   string
		value any
	}{
		{"models", data.Models},
		{"providers", data.Providers},
	} {
		node, err := marshalNode(section.value)
		if err != nil {
			return fmt.Errorf("编码 %s 段失败: %w", section.key, err)
		}
		replaceMappingValue(mapping, section.key, node)
	}

	f, err := os.CreateTemp("", "moss-config-*.yaml")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	enc := yaml.NewEncoder(f)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		f.Close()
		return err
	}
	if err := enc.Close(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func marshalNode(v any) (*yaml.Node, error) {
	b, err := yaml.Marshal(v)
	if err != nil {
		return nil, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	if len(doc.Content) == 0 {
		return nil, fmt.Errorf("空节点")
	}
	return doc.Content[0], nil
}

// replaceMappingValue 在 mapping 节点里替换 key 对应的 value；不存在则追加。
func replaceMappingValue(mapping *yaml.Node, key string, value *yaml.Node) {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			mapping.Content[i+1] = value
			return
		}
	}
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	mapping.Content = append(mapping.Content, keyNode, value)
}

// Validate 返回 models/providers 段的全部问题（空切片 = 合法）。
func Validate(data *ConfigData) []string {
	var errs []string
	if data.Models == nil || len(data.Models.Entries) == 0 {
		return append(errs, "models.entries 不能为空")
	}
	seen := map[string]bool{}
	for _, e := range data.Models.Entries {
		if strings.TrimSpace(e.Alias) == "" {
			errs = append(errs, "存在空 alias")
		} else if seen[e.Alias] {
			errs = append(errs, fmt.Sprintf("alias %q 重复", e.Alias))
		}
		seen[e.Alias] = true
		if strings.TrimSpace(e.Model) == "" {
			errs = append(errs, fmt.Sprintf("alias %q 的 model 为空", e.Alias))
		}
		if _, ok := data.Providers[e.Provider]; !ok {
			errs = append(errs, fmt.Sprintf("alias %q 引用了不存在的 provider %q", e.Alias, e.Provider))
		}
	}
	def := data.Models.Default
	if def == "" {
		def = data.Models.Entries[0].Alias
	}
	if !seen[def] {
		errs = append(errs, fmt.Sprintf("models.default %q 不在 entries 中", data.Models.Default))
	}
	for id, p := range data.Providers {
		if strings.TrimSpace(p.BaseURL) == "" {
			errs = append(errs, fmt.Sprintf("provider %q 的 baseUrl 为空", id))
			continue
		}
		if u, err := url.Parse(p.BaseURL); err != nil || u.Scheme == "" || u.Host == "" {
			errs = append(errs, fmt.Sprintf("provider %q 的 baseUrl 不是合法 URL: %q", id, p.BaseURL))
		}
		if p.APIKey == "" && strings.TrimSpace(p.APIKeyEnv) == "" {
			errs = append(errs, fmt.Sprintf("provider %q 缺少 apiKeyEnv 或 apiKey", id))
		}
	}
	return errs
}

func (d *ConfigData) indexOfAlias(alias string) int {
	if d.Models == nil {
		return -1
	}
	for i, e := range d.Models.Entries {
		if e.Alias == alias {
			return i
		}
	}
	return -1
}

func (d *ConfigData) currentDefault() string {
	if d.Models == nil || len(d.Models.Entries) == 0 {
		return ""
	}
	if d.Models.Default != "" && d.indexOfAlias(d.Models.Default) != -1 {
		return d.Models.Default
	}
	return d.Models.Entries[0].Alias
}

// AddEntry 新增模型渠道；新 provider 一并登记。校验失败返回错误列表。
func (d *ConfigData) AddEntry(entry ModelEntry, newProvider *ProviderConfig) []string {
	if d.Models == nil {
		d.Models = &ModelsSection{}
	}
	if d.indexOfAlias(entry.Alias) != -1 {
		return []string{fmt.Sprintf("alias %q 已存在", entry.Alias)}
	}
	if newProvider != nil {
		if d.Providers == nil {
			d.Providers = map[string]ProviderConfig{}
		}
		if _, ok := d.Providers[entry.Provider]; ok {
			return []string{fmt.Sprintf("provider %q 已存在", entry.Provider)}
		}
		d.Providers[entry.Provider] = *newProvider
	}
	d.Models.Entries = append(d.Models.Entries, entry)
	if errs := d.ValidateAll(); len(errs) > 0 {
		d.Models.Entries = d.Models.Entries[:len(d.Models.Entries)-1]
		if newProvider != nil {
			delete(d.Providers, entry.Provider)
		}
		return errs
	}
	return nil
}

// UpdateEntry 修改渠道；alias 改名时同步 default。
func (d *ConfigData) UpdateEntry(oldAlias string, entry ModelEntry) []string {
	idx := d.indexOfAlias(oldAlias)
	if idx == -1 {
		return []string{fmt.Sprintf("alias %q 不存在", oldAlias)}
	}
	if entry.Alias != oldAlias && d.indexOfAlias(entry.Alias) != -1 {
		return []string{fmt.Sprintf("alias %q 已存在", entry.Alias)}
	}
	prev := d.Models.Entries[idx]
	wasDefault := d.Models.Default == oldAlias
	d.Models.Entries[idx] = entry
	if wasDefault {
		d.Models.Default = entry.Alias
	}
	if errs := d.ValidateAll(); len(errs) > 0 {
		d.Models.Entries[idx] = prev
		if wasDefault {
			d.Models.Default = oldAlias
		}
		return errs
	}
	return nil
}

// RemoveEntry 删除渠道；删的是默认时清空 default（隐式回退 entries[0]）。
// 返回值 orphanProvider 是失去全部引用的 provider id（调用方决定是否删除）。
func (d *ConfigData) RemoveEntry(alias string) (orphanProvider string, errs []string) {
	idx := d.indexOfAlias(alias)
	if idx == -1 {
		return "", []string{fmt.Sprintf("alias %q 不存在", alias)}
	}
	if len(d.Models.Entries) <= 1 {
		return "", []string{"至少保留一个渠道"}
	}
	removed := d.Models.Entries[idx]
	wasDefault := d.Models.Default == alias
	d.Models.Entries = append(d.Models.Entries[:idx], d.Models.Entries[idx+1:]...)
	if wasDefault {
		d.Models.Default = ""
	}
	if errs := d.ValidateAll(); len(errs) > 0 {
		d.Models.Entries = append(d.Models.Entries[:idx], append([]ModelEntry{removed}, d.Models.Entries[idx:]...)...)
		if wasDefault {
			d.Models.Default = alias
		}
		return "", errs
	}
	stillUsed := map[string]bool{}
	for _, e := range d.Models.Entries {
		stillUsed[e.Provider] = true
	}
	if _, ok := d.Providers[removed.Provider]; ok && !stillUsed[removed.Provider] {
		orphanProvider = removed.Provider
	}
	return orphanProvider, nil
}

// RemoveProvider 删除 provider（前提：无模型引用）。
func (d *ConfigData) RemoveProvider(id string) []string {
	if _, ok := d.Providers[id]; !ok {
		return []string{fmt.Sprintf("provider %q 不存在", id)}
	}
	for _, e := range d.Models.Entries {
		if e.Provider == id {
			return []string{fmt.Sprintf("provider %q 仍被 %q 引用，先删除对应模型", id, e.Alias)}
		}
	}
	delete(d.Providers, id)
	return nil
}

// SetDefault 设置默认模型。
func (d *ConfigData) SetDefault(alias string) []string {
	if d.indexOfAlias(alias) == -1 {
		return []string{fmt.Sprintf("alias %q 不存在", alias)}
	}
	d.Models.Default = alias
	return nil
}

// ValidateAll 是 Validate 的方法形式，便于 errcheck 场景统一调用。
func (d *ConfigData) ValidateAll() []string {
	return Validate(d)
}
