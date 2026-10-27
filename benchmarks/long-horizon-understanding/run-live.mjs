#!/usr/bin/env node
// Explicit live entry point; never used by offline tests.
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('./runner.ts',import.meta.url).pathname,'--live',...process.argv.slice(2)],{stdio:'inherit'});
process.exitCode=result.status??1;
