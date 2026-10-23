import { randomUUID } from "node:crypto";

// 작업(job) 하나의 이벤트 기록과 구독자를 관리한다.
// 작업은 /api/run 요청 하나 안에서 실행되고, 이벤트는 그 응답으로 바로 흘려보낸다.
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
