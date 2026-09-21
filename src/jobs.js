import { randomUUID } from "node:crypto";

// 작업(job) 하나의 이벤트 기록과 구독자(SSE 연결)를 관리한다.
// 이벤트를 모두 보관하므로 브라우저가 늦게 연결되거나 새로고침해도 처음부터 다시 재생된다.
export class Job {
  constructor(task, mode) {
    this.id = randomUUID();
    this.task = task;
    this.mode = mode;
    this.events = [];
    this.subscribers = new Set();
    this.finished = false;
    this.createdAt = Date.now();
  }

  emit(type, data = {}) {
    const event = { seq: this.events.length, type, t: Date.now(), ...data };
    this.events.push(event);
    for (const send of this.subscribers) send(event);
    if (type === "job_done" || type === "job_error") this.finished = true;
  }

  subscribe(send) {
    for (const event of this.events) send(event);
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }
}

const jobs = new Map();
const MAX_JOBS = 20;

export function createJob(task, mode) {
  const job = new Job(task, mode);
  jobs.set(job.id, job);
  // 오래된 작업은 메모리에서 정리
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    jobs.delete(oldest.id);
  }
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}
