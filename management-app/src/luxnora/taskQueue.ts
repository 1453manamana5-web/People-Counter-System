export type Task<T> = {id: number; key: string; value: T};
type Active<T> = {task: Task<T>; controller: AbortController};
export type QueueState = {active: boolean; waiting: number; paused: boolean};

export class TaskQueue<T> {
  private nextId = 0;
  private pending: Task<T>[] = [];
  private active?: Active<T>;
  private paused = false;
  private disposed = false;

  constructor(private readonly run: (task: Task<T>, signal: AbortSignal) => Promise<void>,
    private readonly changed: (state: QueueState) => void,
    private readonly failed: (task: Task<T>) => void) {}

  enqueue(key: string, value: T) {
    if ((this.active?.task.key === key && !this.active.controller.signal.aborted) || this.pending.some(task => task.key === key)) return "duplicate";
    if (this.pending.length >= 4) return "full";
    this.pending.push({id: ++this.nextId, key, value});
    this.drain();
    return "accepted";
  }

  isLatest(task: Task<T>) {
    return task.id === this.nextId;
  }

  pause() {
    this.paused = true;
    if (this.active && !this.active.controller.signal.aborted) {
      this.pending.unshift(this.active.task);
      this.active.controller.abort();
    }
    this.notify();
  }

  resume() {
    this.paused = false;
    this.drain();
  }

  cancel(notify = true) {
    this.active?.controller.abort();
    this.pending = [];
    this.paused = false;
    if (notify) this.notify();
  }

  dispose() {
    this.disposed = true;
    this.cancel(false);
  }

  private notify() {
    if (this.disposed) return;
    this.changed({active: Boolean(this.active && !this.active.controller.signal.aborted),
      waiting: this.pending.length, paused: this.paused});
  }

  private drain() {
    if (this.active || this.paused || !this.pending.length) {
      this.notify();
      return;
    }
    const task = this.pending.shift()!;
    const controller = new AbortController();
    this.active = {task, controller};
    this.notify();
    void this.run(task, controller.signal).catch(() => {
      if (!controller.signal.aborted) this.failed(task);
    }).finally(() => {
      this.active = undefined;
      this.drain();
    });
  }
}
