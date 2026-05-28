#!/usr/bin/env node
import { buildTargets, cleanTargets } from "./clean-targets.mjs";

cleanTargets("clean build", buildTargets);
