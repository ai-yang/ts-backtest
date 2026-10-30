export interface ClockEvent { at: number; kind: 'open' | 'close' | 'action' | 'pay' | 'flow' | 'replay'; symbol?: string; index: number }

/** Bounded k-way merge: only the next open/close per instrument is queued. */
export class EventClock {
  private heap: ClockEvent[] = [];
  get size(): number { return this.heap.length; }
  peek(): ClockEvent | undefined { return this.heap[0]; }
  push(event: ClockEvent): void {
    let i = this.heap.length; this.heap.push(event);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.at <= event.at) break;
      this.heap[i] = this.heap[parent]!; i = parent;
    }
    this.heap[i] = event;
  }
  pop(): ClockEvent {
    const first = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length) {
      let i = 0;
      while (i * 2 + 1 < this.heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.heap.length && this.heap[child + 1]!.at < this.heap[child]!.at) child++;
        if (this.heap[child]!.at >= last.at) break;
        this.heap[i] = this.heap[child]!; i = child;
      }
      this.heap[i] = last;
    }
    return first;
  }
}
