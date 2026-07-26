# Relaybase platform packages

These packages deliver the prebuilt Go TUI selected by the optional dependencies in `@cameloo/relaybase`. The root package contains the compiled Node runtime while npm installs only the matching platform payload. Generated `bin/` payloads are never committed.

Run `npm run tui:build:all`, then `npm run package:prepare-platforms`, before strict package verification or publication.
