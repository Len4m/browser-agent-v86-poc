#!/usr/bin/env node
import { buildTargets, cleanTargets } from "./clean/targets.mjs";

// Default clean is intentionally limited to rebuildable frontend/build outputs.
// Runtime assets are large and may require network/Docker to recreate, so they
// stay in place unless the caller explicitly runs pnpm clean:runtime.
cleanTargets("clean build", buildTargets);
