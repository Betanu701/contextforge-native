#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
if(!process.argv.slice(2).includes('--live')){console.error('No inference performed. Explicit --live --endpoint URL --model NAME is required.');process.exitCode=1;}
else {const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('./live-runner.ts',import.meta.url).pathname,...process.argv.slice(2)],{stdio:'inherit'});process.exitCode=result.status??1;}
