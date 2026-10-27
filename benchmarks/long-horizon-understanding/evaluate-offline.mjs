#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('./runner.ts',import.meta.url).pathname,...process.argv.slice(2)],{stdio:'inherit'});
process.exitCode=result.status??1;
