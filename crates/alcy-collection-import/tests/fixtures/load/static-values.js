import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const base = 'https://api.example.test';
const settings = { path: '/items', pause: 0.125, headers: { 'Content-Type': 'application/json' } };
const stages = [{ duration: '1s', target: 2 }];
const metricName = 'business_events';
const eventCount = new Counter(metricName);
export const options = {
  scenarios: { smoke: { executor: 'ramping-vus', startVUs: 1, stages } },
  thresholds: { business_events: ['count>0'] },
};

export default function () {
  const url = `${base}${settings.path}`;
  const payload = { z: 'line\n"quoted"', '10': 'ten', '2': 'two', a: [true, null, -0, 1e21] };
  const params = { headers: settings.headers, tags: { operation: 'create' }, timeout: '1s' };
  const response = http.post(url, JSON.stringify(payload), params);
  check(response, { 'created': r => r.status === 201 });
  eventCount.add(1, { operation: 'create' });
  sleep(settings.pause);
}
