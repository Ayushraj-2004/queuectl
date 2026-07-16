'use strict';

/**
 * delay = base ^ attempts seconds, as specified in the assignment.
 * attempts is the count *after* the failure that just happened, so the
 * first retry (attempts=1) waits base^1s, the second (attempts=2) waits
 * base^2s, etc. — the wait grows with each successive failure.
 */
function computeDelaySeconds(base, attempts) {
  return Math.pow(base, attempts);
}

function computeRunAt(base, attempts, fromDate = new Date()) {
  const delayMs = computeDelaySeconds(base, attempts) * 1000;
  return new Date(fromDate.getTime() + delayMs).toISOString();
}

module.exports = { computeDelaySeconds, computeRunAt };
