#!/usr/bin/env node

import { runCli } from "./tui-go.mjs";

process.exitCode = runCli(["build", ...process.argv.slice(2)]);
