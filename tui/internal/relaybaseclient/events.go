package relaybaseclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type EventStream struct {
	response *http.Response
	reader   *bufio.Reader
}

type AgentEventStream struct {
	response *http.Response
	reader   *bufio.Reader
}

func newEventStream(resp *http.Response) *EventStream {
	return &EventStream{
		response: resp,
		reader:   bufio.NewReader(resp.Body),
	}
}

func newAgentEventStream(resp *http.Response) *AgentEventStream {
	return &AgentEventStream{
		response: resp,
		reader:   bufio.NewReader(resp.Body),
	}
}

func (s *EventStream) Close() error {
	if s == nil || s.response == nil || s.response.Body == nil {
		return nil
	}
	return s.response.Body.Close()
}

func (s *AgentEventStream) Close() error {
	if s == nil || s.response == nil || s.response.Body == nil {
		return nil
	}
	return s.response.Body.Close()
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

	for {
		select {
		case <-ctx.Done():
			return AgentRunEvent{}, ctx.Err()
		default:
		}

		eventName, eventID, data, err := readSSEBlock(s.reader)
		if err != nil {
			return AgentRunEvent{}, err
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
		if event.Type == "" {
			continue
		}
		return event, nil
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
