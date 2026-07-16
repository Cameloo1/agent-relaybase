package model

import (
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestRegistrationFailureMessagesKeepRepairAndCleanupStateTruthful(t *testing.T) {
	portClosed := false
	repairable := registrationPreviewMessage(&relaybaseclient.RegistrationSetupResult{
		Status:     "registered_verification_failed",
		Message:    "Notes is registered, but launch verification failed.",
		Registered: true,
		Started:    false,
		Verification: &relaybaseclient.RegistrationVerificationResult{
			Status: "failed",
			Failure: &relaybaseclient.RegistrationVerificationFailure{
				Boundary:          "health",
				Message:           "The declared health route did not return success.",
				RecommendedAction: "Preview the detected health route.",
				BackendPortOpen:   &portClosed,
			},
			Repairs: []relaybaseclient.RegistrationRepairOption{{
				ID:          "health-route:/api/ping",
				Label:       "Use health route /api/ping",
				Recommended: true,
			}},
		},
	})
	for _, required := range []string{
		"failed boundary health",
		"next Preview the detected health route",
		"recommended repair Use health route /api/ping",
		"app ends stopped",
	} {
		if !strings.Contains(repairable, required) {
			t.Fatalf("repairable registration failure omitted %q: %s", required, repairable)
		}
	}

	portOpen := true
	cleanupFailed := registrationPreviewMessage(&relaybaseclient.RegistrationSetupResult{
		Status:     "registered_cleanup_failed",
		Message:    "Notes is registered, but verification cleanup failed.",
		Registered: true,
		Started:    false,
		Verification: &relaybaseclient.RegistrationVerificationResult{
			Status: "cleanup_failed",
			Failure: &relaybaseclient.RegistrationVerificationFailure{
				Boundary:          "closure",
				Message:           "The backend port remains open.",
				RecommendedAction: "Stop the remaining port owner before retrying.",
				ProcessRunning:    true,
				BackendPortOpen:   &portOpen,
			},
		},
	})
	for _, required := range []string{"process still running", "backend port still open"} {
		if !strings.Contains(cleanupFailed, required) {
			t.Fatalf("cleanup failure omitted %q: %s", required, cleanupFailed)
		}
	}
	if strings.Contains(cleanupFailed, "app ends stopped") {
		t.Fatalf("cleanup failure overclaimed stopped state: %s", cleanupFailed)
	}
}

func TestAutomaticRegistrationRepairsOrderSafeChoicesAndExcludeManualInput(t *testing.T) {
	preview := &relaybaseclient.RegistrationSetupResult{
		Status: "registered_verification_failed",
		Verification: &relaybaseclient.RegistrationVerificationResult{Repairs: []relaybaseclient.RegistrationRepairOption{
			{ID: "setup-plan:static-preview", Kind: "setup_plan", Label: "Use Static build preview", Recommended: true},
			{ID: "pinned-upstream", Kind: "pinned_port", Label: "Use pinned port"},
		}},
	}
	repairs := automaticRegistrationRepairs(preview)
	if len(repairs) != 2 || repairs[0].ID != "setup-plan:static-preview" || repairs[1].ID != "pinned-upstream" {
		t.Fatalf("expected recommended repair first and alternate second, got %#v", repairs)
	}

	preview.Verification.Repairs[0].StructuredInputRequired = []string{"executable"}
	repairs = automaticRegistrationRepairs(preview)
	if len(repairs) != 1 || repairs[0].ID != "pinned-upstream" {
		t.Fatalf("structured-input repair must be excluded, got %#v", repairs)
	}

	preview.Verification.Repairs = []relaybaseclient.RegistrationRepairOption{
		{ID: "manual", Kind: "manual_launch", Recommended: true},
		{ID: "dynamic", Kind: "dynamic_binding", Recommended: true, StructuredInputRequired: []string{"arguments"}},
	}
	if repairs := automaticRegistrationRepairs(preview); len(repairs) != 0 {
		t.Fatalf("manual repairs must not be prepared automatically, got %#v", repairs)
	}
}
