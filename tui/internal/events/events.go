package events

import (
	"context"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

type StreamConnectedMsg struct {
	Stream *relaybaseclient.EventStream
}

type DaemonEventMsg struct {
	Stream *relaybaseclient.EventStream
	Event  relaybaseclient.DaemonEvent
}

type StreamDisconnectedMsg struct {
	Err error
}

func ConnectCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		if client == nil {
			return StreamDisconnectedMsg{Err: relaybaseclient.ErrMissingToken}
		}
		stream, err := client.OpenEvents(ctx)
		if err != nil {
			return StreamDisconnectedMsg{Err: err}
		}
		return StreamConnectedMsg{Stream: stream}
	}
}

func NextCmd(ctx context.Context, stream *relaybaseclient.EventStream) tea.Cmd {
	return func() tea.Msg {
		event, err := stream.Next(ctx)
		if err != nil {
			return StreamDisconnectedMsg{Err: err}
		}
		return DaemonEventMsg{Stream: stream, Event: event}
	}
}
