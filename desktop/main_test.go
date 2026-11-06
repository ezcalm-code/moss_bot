package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func newTestApp(t *testing.T) (*app, *ui.Tester) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(sampleYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &app{path: path, editIdx: -1, confirmIdx: -1}
	if err := a.reload(); err != nil {
		t.Fatal(err)
	}
	return a, ui.NewTester(a.view, 620, 560)
}

func TestListShowsEntries(t *testing.T) {
	_, tt := newTestApp(t)
	if !tt.HasText("glm（默认）") {
		t.Fatalf("应显示默认标记，texts: %q", tt.Texts())
	}
	if !tt.HasText("internal / glm-5.3-flash") {
		t.Fatalf("应显示渠道详情，texts: %q", tt.Texts())
	}
}

func TestEditFlow(t *testing.T) {
	a, tt := newTestApp(t)
	if err := tt.Click("编辑"); err != nil {
		t.Fatal(err)
	}
	if !tt.HasText("编辑渠道") {
		t.Fatalf("应进入编辑表单，texts: %q", tt.Texts())
	}
	// 表单输入框是 *string 指针绑定，直接写绑定值等价于键盘输入
	a.fModel = "glm-next"
	if err := tt.Click("保存"); err != nil {
		t.Fatal(err)
	}
	if a.data.Models.Entries[0].Model != "glm-next" {
		t.Fatalf("model 未更新: %+v", a.data.Models.Entries[0])
	}
	if !tt.HasText("已保存") {
		t.Fatalf("应显示保存成功提示，texts: %q", tt.Texts())
	}
}

func TestAddFlow(t *testing.T) {
	a, tt := newTestApp(t)
	if err := tt.Click("添加渠道"); err != nil {
		t.Fatal(err)
	}
	a.fAlias, a.fModel = "local", "qwen"
	// provider 不操作 Select，保持初始选中（排序后的第一个现有 provider）
	if err := tt.Click("保存"); err != nil {
		t.Fatal(err)
	}
	if len(a.data.Models.Entries) != 3 {
		t.Fatalf("应新增一条渠道至 3 条，实际 %d 条", len(a.data.Models.Entries))
	}
	b, err := os.ReadFile(a.path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "alias: local") {
		t.Fatalf("修改应写入 config.yaml:\n%s", b)
	}
}

func TestAddRequiresAliasAndModel(t *testing.T) {
	_, tt := newTestApp(t)
	if err := tt.Click("添加渠道"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("保存"); err != nil {
		t.Fatal(err)
	}
	if !tt.HasText("必填") {
		t.Fatalf("空表单应提示必填，texts: %q", tt.Texts())
	}
}

func TestDeleteConfirmFlow(t *testing.T) {
	a, tt := newTestApp(t)
	if err := tt.Click("删除"); err != nil {
		t.Fatal(err)
	}
	if !tt.HasText("确认删除") {
		t.Fatalf("删除应先要求确认，texts: %q", tt.Texts())
	}
	if err := tt.Click("确认删除"); err != nil {
		t.Fatal(err)
	}
	if len(a.data.Models.Entries) != 1 {
		t.Fatalf("删除后应剩 1 条，实际 %d 条", len(a.data.Models.Entries))
	}
	// glm 是默认项，删除后 default 清空、隐式回退到 ds
	if a.data.currentDefault() != "ds" {
		t.Fatalf("默认应回退到 ds，实际 %q", a.data.currentDefault())
	}
}
