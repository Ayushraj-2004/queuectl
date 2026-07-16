#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { getDb } = require('../src/db');
const jobStore = require('../src/jobStore');
const { setConfig, getAllConfig } = require('../src/config');
const workerManager = require('../src/workerManager');

const program = new Command();
program.name('queuectl').description('CLI-based background job queue system').version('1.0.0');

program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('<json>', 'Job JSON, e.g. \'{"id":"job1","command":"sleep 2"}\'')
  .action((json) => {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      console.error('Error: enqueue argument must be valid JSON');
      process.exit(1);
    }
    if (!parsed.id || !parsed.command) {
      console.error('Error: job JSON must include at least "id" and "command"');
      process.exit(1);
    }
    const db = getDb();
    try {
      const job = jobStore.enqueue(db, parsed);
      console.log(`Enqueued job "${job.id}" (state=${job.state})`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

const worker = program.command('worker').description('Manage worker processes');

worker
  .command('start')
  .description('Start one or more workers')
  .option('--count <n>', 'number of worker processes to start', '1')
  .action((opts) => {
    const count = parseInt(opts.count, 10);
    const pids = workerManager.startWorkers(count);
    console.log(`Started ${pids.length} worker(s): ${pids.join(', ')}`);
    console.log('Workers run detached in the background; logs are in .queuectl/logs/');
  });

worker
  .command('stop')
  .description('Stop running workers gracefully')
  .action(() => {
    const stopped = workerManager.stopWorkers();
    if (stopped.length === 0) {
      console.log('No running workers found.');
    } else {
      console.log(`Sent SIGTERM to ${stopped.length} worker(s): ${stopped.join(', ')}`);
      console.log('Each will finish its current job before exiting.');
    }
  });

program
  .command('status')
  .description('Show summary of all job states & active workers')
  .action(() => {
    const db = getDb();
    const summary = jobStore.statusSummary(db);
    const activeWorkers = workerManager.listRunningWorkers();
    console.log('Job states:');
    for (const [state, count] of Object.entries(summary)) {
      console.log(`  ${state.padEnd(10)} ${count}`);
    }
    console.log(`Active workers: ${activeWorkers.length}${activeWorkers.length ? ' (' + activeWorkers.join(', ') + ')' : ''}`);
  });

program
  .command('list')
  .description('List jobs, optionally filtered by state')
  .option('--state <state>', 'pending|processing|completed|failed|dead')
  .action((opts) => {
    const db = getDb();
    const jobs = jobStore.listJobs(db, opts.state);
    if (jobs.length === 0) {
      console.log('No jobs found.');
      return;
    }
    for (const j of jobs) {
      console.log(
        `${j.id.padEnd(15)} state=${j.state.padEnd(10)} attempts=${j.attempts}/${j.max_retries}  ${j.command}`
      );
    }
  });

const dlq = program.command('dlq').description('View or retry dead-lettered jobs');

dlq
  .command('list')
  .description('List jobs in the Dead Letter Queue')
  .action(() => {
    const db = getDb();
    const jobs = jobStore.listJobs(db, 'dead');
    if (jobs.length === 0) {
      console.log('DLQ is empty.');
      return;
    }
    for (const j of jobs) {
      console.log(`${j.id.padEnd(15)} attempts=${j.attempts}  last_error="${j.last_error}"`);
    }
  });

dlq
  .command('retry')
  .description('Move a DLQ job back to pending')
  .argument('<id>', 'job id')
  .action((id) => {
    const db = getDb();
    try {
      const job = jobStore.retryDlqJob(db, id);
      console.log(`Job "${job.id}" requeued (state=${job.state})`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

const config = program.command('config').description('Manage configuration (retry, backoff, etc.)');

config
  .command('set')
  .description('Set a config value, e.g. queuectl config set max-retries 5')
  .argument('<key>', 'max-retries | backoff-base')
  .argument('<value>', 'new value')
  .action((key, value) => {
    const map = { 'max-retries': 'max_retries', 'backoff-base': 'backoff_base' };
    const dbKey = map[key];
    if (!dbKey) {
      console.error(`Error: unknown config key "${key}". Valid keys: ${Object.keys(map).join(', ')}`);
      process.exit(1);
    }
    const db = getDb();
    setConfig(db, dbKey, value);
    console.log(`Set ${key} = ${value}`);
  });

config
  .command('list')
  .description('Show current configuration')
  .action(() => {
    const db = getDb();
    const cfg = getAllConfig(db);
    for (const [k, v] of Object.entries(cfg)) console.log(`${k} = ${v}`);
  });

program.parse(process.argv);
