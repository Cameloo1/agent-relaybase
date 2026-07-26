package slash

import (
	"reflect"
	"testing"
)

func TestParseCreatePackageCommand(t *testing.T) {
	command, err := Parse(`/create-package {'Operations Dashboard', "Credential Manager"} 'operations-stack'`)
	if err != nil {
		t.Fatalf("Parse create package: %v", err)
	}
	if command.Kind != KindCreatePackage || command.PackageName != "operations-stack" {
		t.Fatalf("unexpected command: %#v", command)
	}
	want := []string{"Operations Dashboard", "Credential Manager"}
	if !reflect.DeepEqual(command.Members, want) {
		t.Fatalf("members = %#v, want %#v", command.Members, want)
	}
}

func TestParseCreatePackageEscapes(t *testing.T) {
	command, err := Parse(`/create-package {'Owner\'s App', "Web \"Blue\""} 'team\\stack'`)
	if err != nil {
		t.Fatalf("Parse escaped create package: %v", err)
	}
	want := []string{"Owner's App", `Web "Blue"`}
	if !reflect.DeepEqual(command.Members, want) || command.PackageName != `team\stack` {
		t.Fatalf("unexpected escaped values: %#v", command)
	}
}

func TestParsePackageCommands(t *testing.T) {
	tests := []struct {
		input string
		kind  string
		name  string
		runID string
	}{
		{input: "/packages", kind: KindPackages},
		{input: `/launch-package 'operations stack'`, kind: KindLaunchPackage, name: "operations stack"},
		{input: `/delete-package "operations stack"`, kind: KindDeletePackage, name: "operations stack"},
		{input: "/package-run retry pkg_run_123", kind: KindPackageRunRetry, runID: "pkg_run_123"},
		{input: "/package-run abort pkg_run_123", kind: KindPackageRunAbort, runID: "pkg_run_123"},
	}
	for _, test := range tests {
		command, err := Parse(test.input)
		if err != nil {
			t.Fatalf("Parse(%q): %v", test.input, err)
		}
		if command.Kind != test.kind || command.PackageName != test.name || command.RunID != test.runID {
			t.Fatalf("Parse(%q) = %#v", test.input, command)
		}
	}
}

func TestParseCreatePackageRejectsMalformedGrammar(t *testing.T) {
	inputs := []string{
		`/create-package`,
		`/create-package {} 'empty'`,
		`/create-package {'A',} 'trailing'`,
		`/create-package {A} 'unquoted'`,
		`/create-package {'A' 'missing-comma'} 'bad'`,
		`/create-package {'A'} unquoted`,
		`/create-package {'A'} 'name' extra`,
		`/create-package {'A} 'name'`,
	}
	for _, input := range inputs {
		if _, err := Parse(input); err == nil {
			t.Errorf("Parse(%q) unexpectedly succeeded", input)
		}
	}
}

func TestPackageMutationsRequireConfirmation(t *testing.T) {
	for _, input := range []string{
		`/launch-package 'stack'`,
		`/delete-package 'stack'`,
		`/package-run retry pkg_run_1`,
		`/package-run abort pkg_run_1`,
	} {
		command, err := Parse(input)
		if err != nil {
			t.Fatalf("Parse(%q): %v", input, err)
		}
		if !RequiresConfirmation(command) {
			t.Errorf("%q should require confirmation", input)
		}
	}
	command, err := Parse(`/create-package {'A'} 'stack'`)
	if err != nil || RequiresConfirmation(command) {
		t.Fatalf("create package should parse without confirmation: %#v %v", command, err)
	}
}
