#!/usr/bin/env node
import { cleanTargets, runtimeTargets } from "./clean-targets.mjs";

cleanTargets("clean runtime", runtimeTargets);
