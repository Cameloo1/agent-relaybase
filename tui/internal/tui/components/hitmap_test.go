package components

import "testing"

func TestRectUsesHalfOpenCoordinates(t *testing.T) {
	rect := Rect{X: 3, Y: 4, Width: 5, Height: 2}
	for _, point := range [][2]int{{3, 4}, {7, 4}, {3, 5}, {7, 5}} {
		if !rect.Contains(point[0], point[1]) {
			t.Fatalf("expected point %#v inside %#v", point, rect)
		}
	}
	for _, point := range [][2]int{{2, 4}, {8, 4}, {3, 3}, {3, 6}} {
		if rect.Contains(point[0], point[1]) {
			t.Fatalf("expected point %#v outside %#v", point, rect)
		}
	}
}

func TestClipAndTranslateHandlesPartialAndInvisibleRegions(t *testing.T) {
	rect := Rect{X: 2, Y: 8, Width: 6, Height: 5}
	clip := Rect{X: 0, Y: 10, Width: 10, Height: 3}
	translated, ok := ClipAndTranslate(rect, clip, 1, -4)
	if !ok || translated != (Rect{X: 3, Y: 6, Width: 6, Height: 3}) {
		t.Fatalf("translated=%#v ok=%v", translated, ok)
	}
	if _, ok := ClipAndTranslate(rect, Rect{X: 20, Y: 20, Width: 2, Height: 2}, 0, 0); ok {
		t.Fatal("disjoint region should be omitted")
	}
}

func TestHitMapContainsOnlyExplicitInteractiveRegionsAndTopmostWins(t *testing.T) {
	var hitMap HitMap
	if hitMap.Add(HitRegion{}) {
		t.Fatal("invalid placeholder-like region should not be added")
	}
	if !hitMap.Add(HitRegion{Rect: Rect{X: 0, Y: 0, Width: 10, Height: 5}, Kind: HitPaneLogs, PaneID: "pane-a"}) {
		t.Fatal("valid pane log region was rejected")
	}
	if !hitMap.Add(HitRegion{Rect: Rect{X: 2, Y: 1, Width: 3, Height: 1}, Kind: HitPaneCopyLogs, PaneID: "pane-a"}) {
		t.Fatal("valid copy region was rejected")
	}
	if !hitMap.Add(HitRegion{Rect: Rect{X: 5, Y: 1, Width: 3, Height: 1}, Kind: HitPaneRestart, PaneID: "pane-a"}) {
		t.Fatal("valid restart region was rejected")
	}
	if hitMap.Add(HitRegion{Rect: Rect{X: 8, Y: 1, Width: 3, Height: 1}, Kind: HitPaneRestart}) {
		t.Fatal("restart region without a pane ID must be rejected")
	}
	if len(hitMap.Regions()) != 3 {
		t.Fatalf("unexpected region count: %#v", hitMap.Regions())
	}
	region, ok := hitMap.Hit(3, 1)
	if !ok || region.Kind != HitPaneCopyLogs {
		t.Fatalf("topmost copy region did not win: %#v ok=%v", region, ok)
	}
	region, ok = hitMap.Hit(6, 1)
	if !ok || region.Kind != HitPaneRestart {
		t.Fatalf("restart region missing: %#v ok=%v", region, ok)
	}
	region, ok = hitMap.Hit(8, 3)
	if !ok || region.Kind != HitPaneLogs {
		t.Fatalf("pane log region missing: %#v ok=%v", region, ok)
	}
	if _, ok := hitMap.Hit(10, 3); ok {
		t.Fatal("half-open right edge should not hit")
	}
}
