package relaybaseclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type EventStream struct {
	response *http.Response
	reader   *bufio.Reader
}

type AgentEventStream struct {
	stateMu          sync.Mutex
	nextMu           sync.Mutex
	closeOnce        sync.Once
	response         *http.Response
	reader           *bufio.Reader
	responseClosed   bool
	reconnect        func(context.Context, int64) (*http.Response, error)
	reconnectBackoff func(int) time.Duration
	lifecycleContext context.Context
	lifecycleCancel  context.CancelFunc
	closeErr         error
	closed           bool

	// The remaining fields are owned by Next, which is serialized by nextMu.
	lastSequence     int64
	reconnectAttempt int
	reconnectPending bool
}

func newEventStream(resp *http.Response) *EventStream {
	return &EventStream{
		response: resp,
		reader:   bufio.NewReader(resp.Body),
	}
}

func newAgentEventStream(resp *http.Response, reconnect func(context.Context, int64) (*http.Response, error)) *AgentEventStream {
	lifecycleContext, lifecycleCancel := context.WithCancel(context.Background())
	return &AgentEventStream{
		response:         resp,
		reader:           bufio.NewReader(resp.Body),
		reconnect:        reconnect,
		reconnectBackoff: agentEventReconnectBackoff,
		lifecycleContext: lifecycleContext,
		lifecycleCancel:  lifecycleCancel,
	}
}

func (s *EventStream) Close() error {
	if s == nil || s.response == nil || s.response.Body == nil {
		return nil
	}
	return s.response.Body.Close()
}

func (s *AgentEventStream) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		s.stateMu.Lock()
		s.closed = true
		cancel := s.lifecycleCancel
		s.stateMu.Unlock()
		if cancel != nil {
			cancel()
		}
		err := s.closeActiveResponse()
		s.stateMu.Lock()
		s.closeErr = err
		s.stateMu.Unlock()
	})
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.closeErr
}

func (s *EventStream) Next(ctx context.Context) (DaemonEvent, error) {
	if s == nil {
		return DaemonEvent{}, io.ErrClosedPipe
	}

	for {
		select {
		case <-ctx.Done():
			return DaemonEvent{}, ctx.Err()
		default:
		}

		eventName, eventID, data, err := s.readBlock()
		if err != nil {
			return DaemonEvent{}, err
		}
		if data == "" && eventName == "" && eventID == "" {
			continue
		}

		event := DaemonEvent{ID: eventID, Type: eventName}
		if data != "" {
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				return DaemonEvent{}, err
			}
			if event.ID == "" {
				event.ID = eventID
			}
			if event.Type == "" {
				event.Type = eventName
			}
		}
		if event.Sequence == 0 {
			if sequence, err := strconv.ParseInt(event.ID, 10, 64); err == nil {
				event.Sequence = sequence
			}
		}
		if event.Type == "" {
			continue
		}
		return event, nil
	}
}

func (s *AgentEventStream) Next(ctx context.Context) (AgentRunEvent, error) {
	if s == nil {
		return AgentRunEvent{}, io.ErrClosedPipe
	}
	s.nextMu.Lock()
	defer s.nextMu.Unlock()
	if s.isClosed() {
		return AgentRunEvent{}, io.ErrClosedPipe
	}
	operationContext, cancelOperation := s.operationContext(ctx)
	defer cancelOperation()

	for {
		select {
		case <-operationContext.Done():
			return AgentRunEvent{}, s.operationError(ctx, operationContext)
		default:
		}
		if s.reconnectPending {
			if err := s.reconnectFromLastSequence(operationContext); err != nil {
				if operationContext.Err() != nil {
					return AgentRunEvent{}, s.operationError(ctx, operationContext)
				}
				return AgentRunEvent{}, err
			}
			if s.reconnectPending {
				return s.reconnectingEvent(), nil
			}
		}

		reader := s.readerSnapshot()
		if reader == nil {
			return AgentRunEvent{}, io.ErrClosedPipe
		}
		eventName, eventID, data, err := readSSEBlock(reader)
		if err != nil {
			if operationContext.Err() != nil {
				return AgentRunEvent{}, s.operationError(ctx, operationContext)
			}
			if s.reconnect == nil {
				return AgentRunEvent{}, err
			}
			s.reconnectPending = true
			s.reconnectAttempt = 0
			_ = s.closeActiveResponse()
			return s.reconnectingEvent(), nil
		}
		if data == "" && eventName == "" && eventID == "" {
			continue
		}

		event := AgentRunEvent{ID: eventID, Type: eventName}
		if data != "" {
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				return AgentRunEvent{}, err
			}
			if event.ID == "" {
				event.ID = eventID
			}
			if event.Type == "" {
				event.Type = eventName
			}
		}
		if event.Sequence == 0 {
			if sequence, err := strconv.ParseInt(event.ID, 10, 64); err == nil {
				event.Sequence = sequence
			}
		}
		if event.Sequence > 0 {
			if event.Sequence <= s.lastSequence {
				continue
			}
			s.lastSequence = event.Sequence
		}
		if event.Type == "" {
			continue
		}
		return event, nil
	}
}

func (s *AgentEventStream) operationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	operationContext, cancel := context.WithCancel(ctx)
	s.stateMu.Lock()
	lifecycleContext := s.lifecycleContext
	s.stateMu.Unlock()
	if lifecycleContext == nil {
		return operationContext, cancel
	}
	stop := context.AfterFunc(lifecycleContext, cancel)
	return operationContext, func() {
		stop()
		cancel()
	}
}

func (s *AgentEventStream) operationError(callerContext context.Context, operationContext context.Context) error {
	if s.isClosed() {
		return io.ErrClosedPipe
	}
	if callerContext.Err() != nil {
		return callerContext.Err()
	}
	return operationContext.Err()
}

func (s *AgentEventStream) isClosed() bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.closed
}

func (s *AgentEventStream) readerSnapshot() *bufio.Reader {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.reader
}

func (s *AgentEventStream) closeActiveResponse() error {
	s.stateMu.Lock()
	if s.response == nil || s.response.Body == nil || s.responseClosed {
		s.stateMu.Unlock()
		return nil
	}
	s.responseClosed = true
	body := s.response.Body
	s.stateMu.Unlock()
	return body.Close()
}

func (s *AgentEventStream) installResponse(response *http.Response) error {
	if response == nil || response.Body == nil {
		return io.ErrUnexpectedEOF
	}
	s.stateMu.Lock()
	if s.closed {
		s.stateMu.Unlock()
		_ = response.Body.Close()
		return io.ErrClosedPipe
	}
	s.response = response
	s.reader = bufio.NewReader(response.Body)
	s.responseClosed = false
	s.stateMu.Unlock()
	return nil
}

const maxAgentEventReconnectAttempts = 4

func (s *AgentEventStream) reconnectFromLastSequence(ctx context.Context) error {
	if s.reconnect == nil {
		return io.ErrClosedPipe
	}
	if s.reconnectAttempt >= maxAgentEventReconnectAttempts {
		return fmt.Errorf("agent event stream reconnect exhausted after %d attempts", maxAgentEventReconnectAttempts)
	}
	s.reconnectAttempt++
	backoff := agentEventReconnectBackoff(s.reconnectAttempt)
	if s.reconnectBackoff != nil {
		backoff = s.reconnectBackoff(s.reconnectAttempt)
	}
	if backoff > 0 {
		timer := time.NewTimer(backoff)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	response, err := s.reconnect(ctx, s.lastSequence)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if s.reconnectAttempt >= maxAgentEventReconnectAttempts {
			return fmt.Errorf("agent event stream reconnect exhausted after %d attempts: %w", maxAgentEventReconnectAttempts, err)
		}
		return nil
	}
	if err := s.installResponse(response); err != nil {
		return err
	}
	s.reconnectPending = false
	s.reconnectAttempt = 0
	return nil
}

func (s *AgentEventStream) reconnectingEvent() AgentRunEvent {
	data, _ := json.Marshal(map[string]any{
		"afterSequence": s.lastSequence,
		"attempt":       s.reconnectAttempt + 1,
	})
	return AgentRunEvent{Type: "stream.reconnecting", Sequence: s.lastSequence, Data: data}
}

func agentEventReconnectBackoff(attempt int) time.Duration {
	switch attempt {
	case 1:
		return 100 * time.Millisecond
	case 2:
		return 250 * time.Millisecond
	case 3:
		return 500 * time.Millisecond
	default:
		return time.Second
	}
}

func (s *EventStream) readBlock() (eventName string, eventID string, data string, err error) {
	return readSSEBlock(s.reader)
}

func readSSEBlock(reader *bufio.Reader) (eventName string, eventID string, data string, err error) {
	var dataLines []string
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return "", "", "", readErr
		}

		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if readErr == io.EOF && len(dataLines) == 0 && eventName == "" && eventID == "" {
				return "", "", "", io.EOF
			}
			return eventName, eventID, strings.Join(dataLines, "\n"), nil
		}
		if strings.HasPrefix(line, ":") {
			if readErr == io.EOF {
				return eventName, eventID, strings.Join(dataLines, "\n"), nil
			}
			continue
		}
		if value, ok := strings.CutPrefix(line, "event:"); ok {
			eventName = strings.TrimSpace(value)
		} else if value, ok := strings.CutPrefix(line, "id:"); ok {
			eventID = strings.TrimSpace(value)
		} else if value, ok := strings.CutPrefix(line, "data:"); ok {
			dataLines = append(dataLines, strings.TrimSpace(value))
		}

		if readErr == io.EOF {
			if len(dataLines) == 0 && eventName == "" && eventID == "" {
				return "", "", "", io.EOF
			}
			return eventName, eventID, strings.Join(dataLines, "\n"), nil
		}
	}
}
