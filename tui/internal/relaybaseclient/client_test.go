package relaybaseclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetStateSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/state" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apps":[{"id":"notes","name":"Notes","runtimeStatus":"running"}],"groups":[{"groupId":"notes","aggregateStatus":"running"}],"components":[{"appId":"notes-web","groupId":"notes","role":"frontend","paneLabel":"frontend","displayName":"Notes","status":"running","route":{"humanUrl":"http://notes.localhost:7777","agentUrl":"http://127.0.0.1:7777","reachable":true}}]}`))
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	state, err := client.GetState(context.Background())
	if err != nil {
		t.Fatalf("GetState returned error: %v", err)
	}
	if len(state.Apps) != 1 || state.Apps[0].ID != "notes" {
		t.Fatalf("unexpected state apps: %#v", state.Apps)
	}
	if len(state.Groups) != 1 || state.Groups[0].GroupID != "notes" {
		t.Fatalf("unexpected state groups: %#v", state.Groups)
	}
	if len(state.Components) != 1 || state.Components[0].Route.HumanURL == "" {
		t.Fatalf("route object did not parse: %#v", state.Components)
	}
}

func TestSetTokenAppliesRotationToSubsequentRequests(t *testing.T) {
	request := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request++
		want := "Bearer old-token"
		if request == 2 {
			want = "Bearer new-token"
		}
		if got := r.Header.Get("Authorization"); got != want {
			t.Fatalf("request %d authorization=%q want=%q", request, got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apps":[]}`))
	}))
	defer server.Close()

	client := New(server.URL, "old-token", server.Client())
	if _, err := client.GetState(context.Background()); err != nil {
		t.Fatalf("first state request: %v", err)
	}
	client.SetToken(" new-token ")
	if _, err := client.GetState(context.Background()); err != nil {
		t.Fatalf("second state request: %v", err)
	}
	if got := client.Token(); got != "new-token" {
		t.Fatalf("client token=%q", got)
	}
}

func TestQueryLogsSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/apps/notes/logs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("limit") != "50" {
			t.Fatalf("unexpected limit query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"notes","events":[{"sequence":1,"appId":"notes","groupId":"notes","componentRole":"frontend","stream":"stdout","message":"ready"}],"page":{"limit":50,"nextBefore":1,"oldestSequence":1,"newestSequence":1,"hasMore":true},"diagnostics":[]}`))
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	snapshot, err := client.QueryLogs(context.Background(), "notes", LogQuery{Limit: 50})
	if err != nil {
		t.Fatalf("QueryLogs returned error: %v", err)
	}
	if len(snapshot.Events) != 1 || snapshot.Events[0].DisplayLine() != "[stdout] ready" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
	if string(snapshot.Page.NextBefore) != "1" {
		t.Fatalf("numeric nextBefore did not decode as cursor string: %#v", snapshot.Page)
	}
}

func TestAppUnregisterClientUsesPreviewAndConfirmedApplyRoutes(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.EscapedPath())
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"preview":{"app":{"id":"notes worker","name":"Notes Worker","projectDirectory":"C:/work/notes"},"runtimeStatus":"stopped","canUnregister":true,"blockers":[],"packageReferences":[],"preserved":{"projectFiles":true,"manifest":true,"logs":true,"operationHistory":true}}}`))
		case http.MethodPost:
			var body map[string]bool
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["confirm"] != true {
				t.Fatalf("unregister apply body=%#v", body)
			}
			_, _ = w.Write([]byte(`{"result":{"unregistered":true,"app":{"id":"notes worker","name":"Notes Worker","projectDirectory":"C:/work/notes"},"runtimeStatus":"stopped","preserved":{"projectFiles":true,"manifest":true,"logs":true,"operationHistory":true}}}`))
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	preview, err := client.PreviewAppUnregister(context.Background(), "notes worker")
	if err != nil || !preview.CanUnregister || preview.App.ID != "notes worker" || !preview.Preserved.OperationHistory {
		t.Fatalf("preview=%#v err=%v", preview, err)
	}
	result, err := client.UnregisterApp(context.Background(), "notes worker")
	if err != nil || !result.Unregistered || result.App.ID != "notes worker" || !result.Preserved.Logs {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	want := []string{"GET /__hub/api/apps/notes%20worker/unregister", "POST /__hub/api/apps/notes%20worker/unregister"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want=%#v", requests, want)
	}
}

func TestAppRenameClientUsesPreviewBoundApplyRoutes(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.EscapedPath())
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Path {
		case "/__hub/api/apps/notes worker/rename/preview":
			if body["name"] != "Notes API" || len(body) != 1 {
				t.Fatalf("rename preview body=%#v", body)
			}
			_, _ = w.Write([]byte(`{"preview":{"previewId":"rename-1","canRename":true,"noop":false,"app":{"id":"notes worker","currentName":"Notes","proposedName":"Notes API"},"runtimeStatus":"running","manifest":{"changes":[{"field":"name","before":"Notes","after":"Notes API"}],"displayNameBehavior":"inherited"},"blockers":[],"preserved":{"stableAppId":"notes worker","route":"http://notes-worker.localhost:7777","runningProcess":true,"packages":true,"logs":true,"operationHistory":true,"automation":true},"recoveryGuidance":"confirm"}}`))
		case "/__hub/api/apps/notes worker/rename/apply":
			if body["previewId"] != "rename-1" || body["confirm"] != true || len(body) != 2 {
				t.Fatalf("rename apply body=%#v", body)
			}
			_, _ = w.Write([]byte(`{"result":{"renamed":true,"app":{"id":"notes worker","oldName":"Notes","newName":"Notes API"},"manifestPath":"C:/work/notes/relaybase.app.json","runtimeStatus":"running","preserved":{"stableAppId":"notes worker","route":"http://notes-worker.localhost:7777","runningProcess":true,"packages":true,"logs":true,"operationHistory":true,"automation":true}}}`))
		default:
			t.Fatalf("unexpected rename route %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	preview, err := client.PreviewAppRename(context.Background(), "notes worker", "Notes API")
	if err != nil || preview.PreviewID != "rename-1" || preview.App.ProposedName != "Notes API" || !preview.Preserved.RunningProcess {
		t.Fatalf("preview=%#v err=%v", preview, err)
	}
	result, err := client.RenameApp(context.Background(), "notes worker", preview.PreviewID)
	if err != nil || !result.Renamed || result.App.NewName != "Notes API" || result.App.ID != "notes worker" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	want := []string{"POST /__hub/api/apps/notes%20worker/rename/preview", "POST /__hub/api/apps/notes%20worker/rename/apply"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests=%#v want=%#v", requests, want)
	}
}

func TestAPIErrorDecodesRelaybaseEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"auth_invalid","message":"Token rejected","retryable":false,"correlationId":"c1"}}`))
	}))
	defer server.Close()

	client := New(server.URL, "bad-token", server.Client())
	_, err := client.GetState(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	var apiError *APIError
	if !errors.As(err, &apiError) {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiError.ErrorBody.Code != "auth_invalid" {
		t.Fatalf("unexpected error body: %#v", apiError.ErrorBody)
	}
	if apiError.ErrorBody.CorrelationID != "c1" {
		t.Fatalf("expected correlation id from response")
	}
}

func TestEventStreamParsesDaemonEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("id: 12\n"))
		_, _ = w.Write([]byte("event: daemon.ready\n"))
		_, _ = w.Write([]byte(`data: {"type":"daemon.ready","sequence":12}` + "\n\n"))
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	stream, err := client.OpenEvents(context.Background())
	if err != nil {
		t.Fatalf("OpenEvents returned error: %v", err)
	}
	defer stream.Close()

	event, err := stream.Next(context.Background())
	if err != nil {
		t.Fatalf("Next returned error: %v", err)
	}
	if event.Type != "daemon.ready" || event.Sequence != 12 {
		t.Fatalf("unexpected event: %#v", event)
	}
}

func TestStreamingRequestsOutliveBoundedJSONClientTimeout(t *testing.T) {
	const requestTimeout = 25 * time.Millisecond
	const delayedEvent = 75 * time.Millisecond
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/__hub/api/events":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			time.Sleep(delayedEvent)
			_, _ = w.Write([]byte("id: 12\nevent: daemon.ready\ndata: {\"type\":\"daemon.ready\",\"sequence\":12}\n\n"))
		case "/__hub/api/agent/sessions/session-1/events":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			time.Sleep(delayedEvent)
			_, _ = w.Write([]byte("id: 1\nevent: run.started\ndata: {\"type\":\"run.started\",\"sequence\":1}\n\n"))
		case "/__hub/api/state":
			time.Sleep(delayedEvent)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"apps":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	httpClient := server.Client()
	httpClient.Timeout = requestTimeout
	client := New(server.URL, "test-token", httpClient)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	daemonStream, err := client.OpenEvents(ctx)
	if err != nil {
		t.Fatalf("OpenEvents returned error: %v", err)
	}
	defer daemonStream.Close()
	if event, nextErr := daemonStream.Next(ctx); nextErr != nil || event.Type != "daemon.ready" {
		t.Fatalf("daemon stream event=%#v err=%v", event, nextErr)
	}

	agentStream, err := client.StreamAgentSessionEvents(ctx, "session-1")
	if err != nil {
		t.Fatalf("StreamAgentSessionEvents returned error: %v", err)
	}
	defer agentStream.Close()
	if event, nextErr := agentStream.Next(ctx); nextErr != nil || event.Type != "run.started" {
		t.Fatalf("agent stream event=%#v err=%v", event, nextErr)
	}

	if _, err := client.GetState(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("bounded JSON request error=%v, want context deadline exceeded", err)
	}
}

func TestAgentEventStreamReconnectsFromLastSequenceAndDeduplicatesReplay(t *testing.T) {
	connection := 0
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		connection++
		body := ""
		switch connection {
		case 1:
			if got := r.URL.Query().Get("afterSequence"); got != "" {
				t.Fatalf("initial stream unexpectedly requested replay from %q", got)
			}
			body = "id: 1\nevent: run.started\ndata: {\"type\":\"run.started\",\"sequence\":1}\n\n"
		case 2:
			if got := r.URL.Query().Get("afterSequence"); got != "1" {
				t.Fatalf("reconnect afterSequence=%q, want 1", got)
			}
			if got := r.Header.Get("Last-Event-ID"); got != "1" {
				t.Fatalf("reconnect Last-Event-ID=%q, want 1", got)
			}
			body = "id: 1\nevent: run.started\ndata: {\"type\":\"run.started\",\"sequence\":1}\n\n" +
				"id: 2\nevent: answer\ndata: {\"type\":\"answer\",\"sequence\":2,\"data\":{\"content\":\"done\"}}\n\n"
		default:
			t.Fatalf("unexpected stream connection %d", connection)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	})}

	client := New("http://relaybase.test", "test-token", httpClient)
	stream, err := client.StreamAgentSessionEvents(context.Background(), "session-1")
	if err != nil {
		t.Fatalf("StreamAgentSessionEvents returned error: %v", err)
	}
	defer stream.Close()
	stream.reconnectBackoff = func(int) time.Duration { return 0 }

	first, err := stream.Next(context.Background())
	if err != nil || first.Sequence != 1 {
		t.Fatalf("first event=%#v err=%v", first, err)
	}
	reconnecting, err := stream.Next(context.Background())
	if err != nil || reconnecting.Type != "stream.reconnecting" {
		t.Fatalf("reconnect status event=%#v err=%v", reconnecting, err)
	}
	replayed, err := stream.Next(context.Background())
	if err != nil {
		t.Fatalf("replayed Next returned error: %v", err)
	}
	if replayed.Sequence != 2 || replayed.Type != "answer" {
		t.Fatalf("duplicate replay was not discarded: %#v", replayed)
	}
	if connection != 2 {
		t.Fatalf("connection count=%d, want 2", connection)
	}
}

func TestAgentEventStreamCloseDuringNextIsConcurrentAndIdempotent(t *testing.T) {
	body := newBlockingReadCloser()
	stream := newAgentEventStream(&http.Response{StatusCode: http.StatusOK, Body: body}, nil)
	nextResult := make(chan error, 1)
	go func() {
		_, err := stream.Next(context.Background())
		nextResult <- err
	}()

	select {
	case <-body.readStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("Next did not begin its blocking read")
	}

	const closeCallers = 8
	closeErrors := make(chan error, closeCallers)
	var waiters sync.WaitGroup
	waiters.Add(closeCallers)
	for range closeCallers {
		go func() {
			defer waiters.Done()
			closeErrors <- stream.Close()
		}()
	}
	waiters.Wait()
	close(closeErrors)
	for err := range closeErrors {
		if err != nil {
			t.Fatalf("concurrent Close returned error: %v", err)
		}
	}

	select {
	case err := <-nextResult:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("Next error=%v, want io.ErrClosedPipe", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not unblock Next")
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("idempotent Close returned error: %v", err)
	}
	if got := body.closeCount.Load(); got != 1 {
		t.Fatalf("response body closed %d times, want exactly once", got)
	}
}

func TestAgentEventStreamCloseDuringReconnectCancelsWithoutDeadlock(t *testing.T) {
	reconnectStarted := make(chan struct{})
	stream := newAgentEventStream(
		&http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(
				"id: 1\nevent: run.started\ndata: {\"type\":\"run.started\",\"sequence\":1}\n\n",
			)),
		},
		func(ctx context.Context, _ int64) (*http.Response, error) {
			close(reconnectStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	)
	stream.reconnectBackoff = func(int) time.Duration { return 0 }

	if event, err := stream.Next(context.Background()); err != nil || event.Sequence != 1 {
		t.Fatalf("initial event=%#v err=%v", event, err)
	}
	if event, err := stream.Next(context.Background()); err != nil || event.Type != "stream.reconnecting" {
		t.Fatalf("reconnect status event=%#v err=%v", event, err)
	}

	nextResult := make(chan error, 1)
	go func() {
		_, err := stream.Next(context.Background())
		nextResult <- err
	}()
	select {
	case <-reconnectStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("reconnect did not begin")
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("Close during reconnect returned error: %v", err)
	}
	select {
	case err := <-nextResult:
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("reconnect Next error=%v, want io.ErrClosedPipe", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not cancel reconnect")
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("second Close returned error: %v", err)
	}
}

type blockingReadCloser struct {
	readStarted chan struct{}
	closed      chan struct{}
	readOnce    sync.Once
	closeOnce   sync.Once
	closeCount  atomic.Int32
}

func newBlockingReadCloser() *blockingReadCloser {
	return &blockingReadCloser{
		readStarted: make(chan struct{}),
		closed:      make(chan struct{}),
	}
}

func (b *blockingReadCloser) Read(_ []byte) (int, error) {
	b.readOnce.Do(func() { close(b.readStarted) })
	<-b.closed
	return 0, io.ErrClosedPipe
}

func (b *blockingReadCloser) Close() error {
	b.closeOnce.Do(func() {
		b.closeCount.Add(1)
		close(b.closed)
	})
	return nil
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestSetupClientMethodsUseDaemonSetupRoutes(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing authorization header for %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/__hub/api/setup/detect":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","packageManager":"npm","framework":"vite","diagnostics":[]}}`))
		case "/__hub/api/setup/plans":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","choices":[{"id":"managed","label":"Managed","architecture":"managed_dynamic_port","score":90}],"diagnostics":[]}}`))
		case "/__hub/api/setup/preview":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","selectedPlan":{"id":"managed","label":"Managed","choice":{"id":"managed"},"writes":[]},"choices":[{"id":"managed"}],"fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[{"path":"C:/project/relaybase.app.json","action":"create","reason":"manifest","diff":{"path":"C:/project/relaybase.app.json","beforeExists":false,"afterExists":true,"changed":true,"hunks":["+ {\"id\":\"app\"}"]}}],"risks":[]},"diagnostics":[]}}`))
		case "/__hub/api/setup/apply":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","selectedPlan":{"id":"managed"},"appliedFiles":[{"path":"C:/project/relaybase.app.json","action":"created"}],"registeredApp":{"id":"app","name":"App","manifestPath":"C:/project/relaybase.app.json"},"diagnostics":[]}}`))
		case "/__hub/api/setup/register-manifest":
			_, _ = w.Write([]byte(`{"setup":{"app":{"id":"app","name":"App","manifestPath":"C:/project/relaybase.app.json"},"manifestPath":"C:/project/relaybase.app.json"}}`))
		case "/__hub/api/setup/inspect-manifest", "/__hub/api/setup/validate-manifest":
			_, _ = w.Write([]byte(`{"setup":{"path":"C:/project/relaybase.app.json","exists":true,"valid":true,"app":{"id":"app","name":"App"},"diagnostics":[]}}`))
		case "/__hub/api/setup/patch-manifest/preview":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","manifestPath":"C:/project/relaybase.app.json","fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[{"path":"C:/project/relaybase.app.json","action":"update","diff":{"path":"C:/project/relaybase.app.json","beforeExists":true,"afterExists":true,"changed":true,"hunks":["- old","+ new"]}}],"risks":[]},"diagnostics":[]}}`))
		case "/__hub/api/setup/patch-manifest/apply":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","manifestPath":"C:/project/relaybase.app.json","app":{"id":"app","name":"App"},"file":{"path":"C:/project/relaybase.app.json","action":"updated"},"diagnostics":[]}}`))
		case "/__hub/api/setup/open":
			_, _ = w.Write([]byte(`{"setup":{"plan":{"cwd":"C:/project","approvalRequired":true,"risks":[]},"result":{"ok":true}}}`))
		case "/__hub/api/setup/prove":
			_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","result":{"ok":true}}}`))
		case "/__hub/api/setup/repair":
			_, _ = w.Write([]byte(`{"setup":{"plan":{"cwd":"C:/project","choices":[{"id":"managed"}],"previews":[],"diagnostics":[]}}}`))
		default:
			t.Fatalf("unexpected setup path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	ctx := context.Background()
	if result, err := client.DetectProject(ctx, SetupDetectRequest{CWD: "C:/project"}); err != nil || result.Framework != "vite" {
		t.Fatalf("DetectProject result=%#v err=%v", result, err)
	}
	if result, err := client.CreateSetupPlans(ctx, SetupPlanRequest{CWD: "C:/project"}); err != nil || len(result.Choices) != 1 {
		t.Fatalf("CreateSetupPlans result=%#v err=%v", result, err)
	}
	if result, err := client.PreviewSetupPlan(ctx, SetupPlanRequest{CWD: "C:/project"}); err != nil || len(result.FileWritePlan.Writes) != 1 {
		t.Fatalf("PreviewSetupPlan result=%#v err=%v", result, err)
	}
	if result, err := client.ApplySetupPlan(ctx, SetupApplyRequest{SetupPlanRequest: SetupPlanRequest{CWD: "C:/project"}, Confirm: true}); err != nil || result.RegisteredApp.ID != "app" {
		t.Fatalf("ApplySetupPlan result=%#v err=%v", result, err)
	}
	if result, err := client.RegisterManifest(ctx, RegisterManifestRequest{ManifestPath: "C:/project/relaybase.app.json"}); err != nil || result.App.ID != "app" {
		t.Fatalf("RegisterManifest result=%#v err=%v", result, err)
	}
	if result, err := client.InspectManifest(ctx, RegisterManifestRequest{ManifestPath: "C:/project/relaybase.app.json"}); err != nil || !result.Valid {
		t.Fatalf("InspectManifest result=%#v err=%v", result, err)
	}
	if result, err := client.ValidateManifest(ctx, RegisterManifestRequest{ManifestPath: "C:/project/relaybase.app.json"}); err != nil || !result.Valid {
		t.Fatalf("ValidateManifest result=%#v err=%v", result, err)
	}
	if result, err := client.PreviewManifestPatch(ctx, ManifestPatchRequest{ManifestPath: "C:/project/relaybase.app.json", Patch: map[string]any{"healthUrl": "/health"}}); err != nil || len(result.FileWritePlan.Writes) != 1 {
		t.Fatalf("PreviewManifestPatch result=%#v err=%v", result, err)
	}
	if result, err := client.ApplyManifestPatch(ctx, ManifestPatchRequest{ManifestPath: "C:/project/relaybase.app.json", Patch: map[string]any{"healthUrl": "/health"}, Confirm: true}); err != nil || result.File.Action != "updated" {
		t.Fatalf("ApplyManifestPatch result=%#v err=%v", result, err)
	}
	if result, err := client.OpenProjectOrApp(ctx, OpenProjectRequest{CWD: "C:/project", Confirm: true}); err != nil || result.Plan.CWD != "C:/project" {
		t.Fatalf("OpenProjectOrApp result=%#v err=%v", result, err)
	}
	if result, err := client.ProveHealth(ctx, ProveHealthRequest{CWD: "C:/project", Confirm: true}); err != nil || result.CWD != "C:/project" {
		t.Fatalf("ProveHealth result=%#v err=%v", result, err)
	}
	if result, err := client.RepairSetup(ctx, RepairSetupRequest{SetupPlanRequest: SetupPlanRequest{CWD: "C:/project"}}); err != nil || len(result.Plan.Choices) != 1 {
		t.Fatalf("RepairSetup result=%#v err=%v", result, err)
	}

	expected := []string{
		"POST /__hub/api/setup/detect",
		"POST /__hub/api/setup/plans",
		"POST /__hub/api/setup/preview",
		"POST /__hub/api/setup/apply",
		"POST /__hub/api/setup/register-manifest",
		"POST /__hub/api/setup/inspect-manifest",
		"POST /__hub/api/setup/validate-manifest",
		"POST /__hub/api/setup/patch-manifest/preview",
		"POST /__hub/api/setup/patch-manifest/apply",
		"POST /__hub/api/setup/open",
		"POST /__hub/api/setup/prove",
		"POST /__hub/api/setup/repair",
	}
	if len(requests) != len(expected) {
		t.Fatalf("unexpected request count: %#v", requests)
	}
	for index, request := range requests {
		if request != expected[index] {
			t.Fatalf("request %d: expected %s, got %s", index, expected[index], request)
		}
	}
}

func TestAgentGatewayClientMethodsUseDaemonRoutes(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing authorization header for %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /__hub/api/agent/config":
			_, _ = w.Write([]byte(`{"agent":{"config":{"enabled":true,"provider":{"provider":"openrouter","modelSlug":"openrouter/test","apiKeySource":{"type":"environment","envVar":"OPENROUTER_API_KEY","configured":false},"remoteModelEnabled":true},"toolAllowlist":["list_apps"],"approvalPolicy":"always_for_mutations","setupFileWritePolicy":"approval_required","updatedAt":"2026-06-02T00:00:00Z"}}}`))
		case "PUT /__hub/api/agent/config":
			_, _ = w.Write([]byte(`{"agent":{"config":{"enabled":true,"provider":{"provider":"openrouter","modelSlug":"openrouter/new","apiKeySource":{"type":"environment","envVar":"OPENROUTER_API_KEY","configured":true},"remoteModelEnabled":true},"updatedAt":"2026-06-02T00:00:01Z"}}}`))
		case "POST /__hub/api/agent/sessions":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-1","title":"Relaybase TUI","createdAt":"2026-06-02T00:00:00Z","updatedAt":"2026-06-02T00:00:00Z","messages":[],"runs":[]}}}`))
		case "GET /__hub/api/agent/sessions":
			_, _ = w.Write([]byte(`{"agent":{"sessions":[{"id":"session-1","messages":[],"runs":[]}]}}`))
		case "GET /__hub/api/agent/sessions/active":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-1","title":"Active","summary":{"messageCount":2,"recoveredApprovalCount":1},"messages":[],"runs":[]}}}`))
		case "POST /__hub/api/agent/sessions/session-1/activate":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-1","title":"Active","lastActiveAt":"2026-06-02T00:00:02Z","messages":[],"runs":[]}}}`))
		case "PATCH /__hub/api/agent/sessions/session-1":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-1","title":"Renamed","titleSource":"user","messages":[],"runs":[]}}}`))
		case "POST /__hub/api/agent/sessions/session-1/clear":
			_, _ = w.Write([]byte(`{"agent":{"session":{"sessionId":"session-1","cleared":true}}}`))
		case "GET /__hub/api/agent/sessions/session-1/export":
			_, _ = w.Write([]byte(`{"agent":{"export":{"exportId":"agent_thread_session-1","status":"succeeded","format":"markdown","outputPath":"C:/tmp/thread.md","sessionId":"session-1","messageCount":2,"auditEventCount":1,"redactionReport":{"totalReplacements":1,"categories":{"token":1}}}}}`))
		case "GET /__hub/api/agent/sessions/session-1/context-preview":
			_, _ = w.Write([]byte(`{"agent":{"contextPreview":{"sessionId":"session-1","active":true,"title":"Active","summary":{"messageCount":2,"runCount":1,"eventCount":3,"pendingApprovalCount":0,"recoveredApprovalCount":1},"privacy":{"mode":"standard","advancedRedactedDetailEnabled":false},"recentMessages":[],"pendingApprovals":[],"recallPolicy":{"scope":"active_thread_only","includesRawSecrets":false,"includesRawLogs":false,"includesRawDiffs":false,"extraModelCalls":false}}}}`))
		case "POST /__hub/api/agent/sessions/session-1/messages":
			_, _ = w.Write([]byte(`{"agent":{"message":{"id":"message-1","sessionId":"session-1","role":"user","content":"start notes","createdAt":"2026-06-02T00:00:00Z"},"run":{"id":"run-1","sessionId":"session-1","status":"waiting_for_approval","provider":"openrouter","events":[{"id":"event-1","sequence":1,"sessionId":"session-1","runId":"run-1","type":"tool.approval_required","data":{"approval":{"id":"approval-1","sessionId":"session-1","runId":"run-1","status":"pending","createdAt":"2026-06-02T00:00:00Z","action":"start_app","target":"notes","risk":"medium","expectedResult":"Start app through daemon."}}}]},"diagnostics":[]}}`))
		case "POST /__hub/api/agent/approvals/approval-1/approve":
			_, _ = w.Write([]byte(`{"agent":{"approval":{"id":"approval-1","sessionId":"session-1","runId":"run-1","status":"approved","action":"start_app","target":"notes","risk":"medium"}}}`))
		case "POST /__hub/api/agent/approvals/approval-1/reject":
			_, _ = w.Write([]byte(`{"agent":{"approval":{"id":"approval-1","sessionId":"session-1","runId":"run-1","status":"rejected","action":"start_app","target":"notes","risk":"medium"}}}`))
		case "GET /__hub/api/agent/diagnostics":
			_, _ = w.Write([]byte(`{"agent":{"diagnostics":[{"id":"agent.key","severity":"warning","code":"OPENROUTER_API_KEY_MISSING","message":"Set OPENROUTER_API_KEY.","checkedAt":"2026-06-02T00:00:00Z"}]}}`))
		case "GET /__hub/api/agent/sessions/session-1/events":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("id: event-2\n"))
			_, _ = w.Write([]byte("event: answer\n"))
			_, _ = w.Write([]byte(`data: {"id":"event-2","sequence":2,"sessionId":"session-1","runId":"run-1","type":"answer","data":{"content":"Ready."}}` + "\n\n"))
		default:
			t.Fatalf("unexpected agent route: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := New(server.URL, "test-token", server.Client())
	ctx := context.Background()
	config, err := client.GetAgentConfig(ctx)
	if err != nil || !config.Enabled || config.Provider.ModelSlug != "openrouter/test" {
		t.Fatalf("GetAgentConfig result=%#v err=%v", config, err)
	}
	updated, err := client.UpdateAgentConfig(ctx, AgentConfigUpdate{Provider: &AgentProviderConfigUpdate{ModelSlug: "openrouter/new"}})
	if err != nil || updated.Provider.ModelSlug != "openrouter/new" {
		t.Fatalf("UpdateAgentConfig result=%#v err=%v", updated, err)
	}
	session, err := client.CreateAgentSession(ctx, AgentSessionCreateRequest{Title: "Relaybase TUI"})
	if err != nil || session.ID != "session-1" {
		t.Fatalf("CreateAgentSession result=%#v err=%v", session, err)
	}
	sessions, err := client.ListAgentSessions(ctx)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("ListAgentSessions result=%#v err=%v", sessions, err)
	}
	active, err := client.GetActiveAgentSession(ctx)
	if err != nil || active == nil || active.ID != "session-1" || active.Summary == nil || active.Summary.RecoveredApprovalCount != 1 {
		t.Fatalf("GetActiveAgentSession result=%#v err=%v", active, err)
	}
	activated, err := client.ActivateAgentSession(ctx, "session-1")
	if err != nil || activated.ID != "session-1" || activated.LastActiveAt == "" {
		t.Fatalf("ActivateAgentSession result=%#v err=%v", activated, err)
	}
	renamed, err := client.UpdateAgentSession(ctx, "session-1", AgentSessionUpdateRequest{Title: "Renamed"})
	if err != nil || renamed.Title != "Renamed" || renamed.TitleSource != "user" {
		t.Fatalf("UpdateAgentSession result=%#v err=%v", renamed, err)
	}
	cleared, err := client.ClearAgentSession(ctx, "session-1")
	if err != nil || cleared == nil || !cleared.Cleared {
		t.Fatalf("ClearAgentSession result=%#v err=%v", cleared, err)
	}
	exported, err := client.ExportAgentSession(ctx, "session-1", AgentSessionExportRequest{Format: "markdown"})
	if err != nil || exported.Format != "markdown" || exported.OutputPath == "" {
		t.Fatalf("ExportAgentSession result=%#v err=%v", exported, err)
	}
	preview, err := client.GetAgentSessionContextPreview(ctx, "session-1")
	if err != nil || preview.RecallPolicy.Scope != "active_thread_only" || preview.Summary.RecoveredApprovalCount != 1 {
		t.Fatalf("GetAgentSessionContextPreview result=%#v err=%v", preview, err)
	}
	message, err := client.SendAgentMessage(ctx, "session-1", AgentMessageRequest{Content: "start notes"})
	if err != nil || message.Run.Status != "waiting_for_approval" || len(message.Run.Events) != 1 {
		t.Fatalf("SendAgentMessage result=%#v err=%v", message, err)
	}
	approval, err := client.ApproveAgentToolCall(ctx, "approval-1", AgentApprovalResolutionRequest{})
	if err != nil || approval.Status != "approved" {
		t.Fatalf("ApproveAgentToolCall result=%#v err=%v", approval, err)
	}
	rejected, err := client.RejectAgentToolCall(ctx, "approval-1", AgentApprovalResolutionRequest{Reason: "test"})
	if err != nil || rejected.Status != "rejected" {
		t.Fatalf("RejectAgentToolCall result=%#v err=%v", rejected, err)
	}
	diagnostics, err := client.GetAgentDiagnostics(ctx)
	if err != nil || len(diagnostics) != 1 || diagnostics[0].Code != "OPENROUTER_API_KEY_MISSING" {
		t.Fatalf("GetAgentDiagnostics result=%#v err=%v", diagnostics, err)
	}
	stream, err := client.StreamAgentSessionEvents(ctx, "session-1")
	if err != nil {
		t.Fatalf("StreamAgentSessionEvents returned error: %v", err)
	}
	defer stream.Close()
	event, err := stream.Next(ctx)
	if err != nil || event.Type != "answer" || event.Sequence != 2 {
		t.Fatalf("Agent event result=%#v err=%v", event, err)
	}

	expected := []string{
		"GET /__hub/api/agent/config",
		"PUT /__hub/api/agent/config",
		"POST /__hub/api/agent/sessions",
		"GET /__hub/api/agent/sessions",
		"GET /__hub/api/agent/sessions/active",
		"POST /__hub/api/agent/sessions/session-1/activate",
		"PATCH /__hub/api/agent/sessions/session-1",
		"POST /__hub/api/agent/sessions/session-1/clear",
		"GET /__hub/api/agent/sessions/session-1/export",
		"GET /__hub/api/agent/sessions/session-1/context-preview",
		"POST /__hub/api/agent/sessions/session-1/messages",
		"POST /__hub/api/agent/approvals/approval-1/approve",
		"POST /__hub/api/agent/approvals/approval-1/reject",
		"GET /__hub/api/agent/diagnostics",
		"GET /__hub/api/agent/sessions/session-1/events",
	}
	if len(requests) != len(expected) {
		t.Fatalf("unexpected request count: %#v", requests)
	}
	for index, request := range requests {
		if request != expected[index] {
			t.Fatalf("request %d: expected %s, got %s", index, expected[index], request)
		}
	}
}
