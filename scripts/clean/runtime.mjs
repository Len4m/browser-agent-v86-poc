#!/usr/bin/env node
import { cleanTargets, runtimeTargets } from "./targets.mjs";

cleanTargets("clean runtime", runtimeTargets);
