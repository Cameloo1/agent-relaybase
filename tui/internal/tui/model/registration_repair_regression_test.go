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
