package slash

import (
	"reflect"
	"strings"
	"testing"
)

func TestCatalogCoversEveryCurrentCommandKindWithParseableExamples(t *testing.T) {
	wantKinds := []string{
		KindLaunch, KindStart, KindStop, KindRestart, KindLogsExport, KindPage, KindPaneColor, KindPin, KindUnpin,
		KindTheme, KindHelp, KindList, KindUsage, KindConfirm, KindCancel, KindDaemonStatus, KindDaemonRepair,
		KindCreatePackage, KindPackages, KindLaunchPackage, KindDeletePackage, KindPackageRunRetry, KindPackageRunAbort,
		KindThreadList, KindThreadNew, KindThreadSwitch, KindThreadRename, KindThreadClear, KindThreadExport, KindThreadPreview,
		KindAddApp, KindRegister, KindConfigure, KindOpen, KindProve, KindHealthProve, KindRepair,
		KindManifestInspect, KindManifestEdit, KindHealthRoute, KindPortPinned, KindComponentRole, KindComponentGroup, KindComponentLabel,
	}

	catalog := Catalog()
	if len(catalog) != len(wantKinds) {
		t.Fatalf("catalog has %d descriptors, want %d", len(catalog), len(wantKinds))
	}
	seenKinds := map[string]bool{}
	seenCanonical := map[string]bool{}
	for _, descriptor := range catalog {
		if descriptor.Kind == "" || descriptor.Canonical == "" || descriptor.Insertion == "" || descriptor.Description == "" || descriptor.Category == "" {
			t.Fatalf("descriptor has missing required metadata: %#v", descriptor)
		}
		if seenKinds[descriptor.Kind] {
			t.Fatalf("duplicate command kind %q", descriptor.Kind)
		}
		if seenCanonical[strings.ToLower(descriptor.Canonical)] {
			t.Fatalf("duplicate canonical command %q", descriptor.Canonical)
		}
		seenKinds[descriptor.Kind] = true
		seenCanonical[strings.ToLower(descriptor.Canonical)] = true
		if len(descriptor.Usages) == 0 || len(descriptor.Examples) == 0 {
			t.Fatalf("descriptor %q needs usage and examples", descriptor.Kind)
		}
		for _, example := range descriptor.Examples {
			parsed, err := Parse(example)
			if err != nil {
				t.Fatalf("example %q for %q did not parse: %v", example, descriptor.Kind, err)
			}
			if parsed.Kind != descriptor.Kind {
				t.Fatalf("example %q parsed as %q, want %q", example, parsed.Kind, descriptor.Kind)
			}
		}
	}
	for _, kind := range wantKinds {
		if !seenKinds[kind] {
			t.Errorf("catalog is missing kind %q", kind)
		}
	}
}

func TestCatalogApprovalMetadataMatchesRepresentativeCommands(t *testing.T) {
	for _, descriptor := range Catalog() {
		parsed, err := Parse(descriptor.Examples[0])
		if err != nil {
			t.Fatalf("parse representative for %q: %v", descriptor.Kind, err)
		}
		if got := RequiresConfirmation(parsed); got != descriptor.Approval {
			t.Errorf("approval for %q = %v, want %v", descriptor.Kind, got, descriptor.Approval)
		}
	}
}

func TestStartCatalogDeclaresConditionalConfirmation(t *testing.T) {
	descriptor, ok := DescriptorForKind(KindStart)
	if !ok || descriptor.ConfirmationPolicy != ConfirmationWhenTargeted {
		t.Fatalf("start descriptor does not expose conditional safety: %#v", descriptor)
	}
	chooser, err := Parse("/start")
	if err != nil || RequiresConfirmation(chooser) {
		t.Fatalf("bare start must remain read-only: command=%#v err=%v", chooser, err)
	}
	targeted, err := Parse("/start notes")
	if err != nil || !RequiresConfirmation(targeted) {
		t.Fatalf("targeted start must require confirmation: command=%#v err=%v", targeted, err)
	}
}

func TestCatalogReturnsDeepCopy(t *testing.T) {
	first := Catalog()
	first[0].Canonical = "/mutated"
	first[0].Usages[0] = "/mutated"
	second := Catalog()
	if second[0].Canonical == "/mutated" || second[0].Usages[0] == "/mutated" {
		t.Fatal("Catalog exposed mutable shared state")
	}
}

func TestIsKnownPrefixUsesCanonicalAndAliases(t *testing.T) {
	for _, input := range []string{"/launch notes", "/thread unknown", "/daemon repair", "/daemon retry", "  /MANIFEST inspect notes  "} {
		if !IsKnownPrefix(input) {
			t.Errorf("expected %q to be a known slash prefix", input)
		}
	}
	for _, input := range []string{"", "/", "/bogus", "/launchpad notes"} {
		if IsKnownPrefix(input) {
			t.Errorf("expected %q to be unknown", input)
		}
	}
}

func TestSearchCatalogRankingAndCoverage(t *testing.T) {
	tests := []struct {
		name  string
		query string
		first string
	}{
		{name: "exact", query: "/thread switch", first: KindThreadSwitch},
		{name: "canonical prefix", query: "mani ins", first: KindManifestInspect},
		{name: "fuzzy subsequence", query: "th sw", first: KindThreadSwitch},
		{name: "description", query: "redacted log scope", first: KindLogsExport},
		{name: "keyword", query: "reconnect", first: KindDaemonRepair},
		{name: "multi token and", query: "health endpoint", first: KindHealthRoute},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			matches := SearchCatalog(test.query)
			if len(matches) == 0 {
				t.Fatalf("SearchCatalog(%q) returned no matches", test.query)
			}
			if got := matches[0].Descriptor.Kind; got != test.first {
				t.Fatalf("SearchCatalog(%q) first = %q, want %q", test.query, got, test.first)
			}
		})
	}
	if matches := SearchCatalog("words-not-present-anywhere"); len(matches) != 0 {
		t.Fatalf("expected no matches, got %#v", matches)
	}
}

func TestSearchCatalogEmptyQueryPreservesStableCatalogOrder(t *testing.T) {
	catalog := Catalog()
	matches := SearchCatalog("/")
	got := make([]string, len(matches))
	want := make([]string, len(catalog))
	for index := range matches {
		got[index] = matches[index].Descriptor.Kind
		want[index] = catalog[index].Kind
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("empty-query order changed\ngot:  %#v\nwant: %#v", got, want)
	}
}
