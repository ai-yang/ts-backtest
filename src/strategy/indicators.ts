/** Incremental numeric operators. Missing observations reset recursive seeds. */
export interface NumericState { next(value: number): number }

export class RollingWindow {
  readonly values: Float64Array;
  cursor = 0;
  size = 0;
  valid = 0;
  sum = 0;
  constructor(readonly period: number) { this.values = new Float64Array(period).fill(NaN); }
  push(value: number): number {
    const removed = this.values[this.cursor]!;
    if (Number.isFinite(removed)) { this.valid--; this.sum -= removed; }
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.period;
    this.size = Math.min(this.size + 1, this.period);
    if (Number.isFinite(value)) { this.valid++; this.sum += value; }
    return removed;
  }
  get complete(): boolean { return this.size === this.period && this.valid === this.period; }
}

export class SMA implements NumericState {
  readonly window: RollingWindow;
  constructor(period: number) { this.window = new RollingWindow(period); }
  next(value: number): number {
    this.window.push(value);
    return this.window.complete ? this.window.sum / this.window.period : NaN;
  }
}

export class EMA implements NumericState {
  private count = 0;
  private sum = 0;
  private average = NaN;
  constructor(readonly period: number, readonly alpha = 2 / (period + 1)) {}
  next(value: number): number {
    if (!Number.isFinite(value)) { this.count = 0; this.sum = 0; this.average = NaN; return NaN; }
    if (this.count < this.period) {
      this.count++; this.sum += value;
      if (this.count === this.period) this.average = this.sum / this.period;
    } else this.average += this.alpha * (value - this.average);
    return this.average;
  }
}

export class RSI implements NumericState {
  private previous = NaN;
  private gain: EMA;
  private loss: EMA;
  constructor(readonly period: number) {
    this.gain = new EMA(period, 1 / period);
    this.loss = new EMA(period, 1 / period);
  }
  next(value: number): number {
    const change = value - this.previous;
    this.previous = value;
    if (!Number.isFinite(change)) { this.gain.next(NaN); this.loss.next(NaN); return NaN; }
    const gain = this.gain.next(Math.max(0, change));
    const loss = this.loss.next(Math.max(0, -change));
    if (!Number.isFinite(gain) || !Number.isFinite(loss)) return NaN;
    if (gain === 0 && loss === 0) return 50;
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
}

export class ATR {
  private previousClose = NaN;
  private average: EMA;
  constructor(period: number) { this.average = new EMA(period, 1 / period); }
  next(high: number, low: number, close: number): number {
    if (![high, low, close].every(Number.isFinite)) {
      this.previousClose = NaN;
      return this.average.next(NaN);
    }
    const range = Number.isFinite(this.previousClose)
      ? Math.max(high - low, Math.abs(high - this.previousClose), Math.abs(low - this.previousClose))
      : high - low;
    this.previousClose = close;
    return this.average.next(range);
  }
}

export class Lag implements NumericState {
  private window: RollingWindow;
  constructor(period: number) { this.window = new RollingWindow(period); }
  next(value: number): number { return this.window.push(value); }
}

/** Monotonic deque: O(1) amortized, without rescanning the rolling window. */
export class RollingExtreme implements NumericState {
  private window: RollingWindow;
  private indices: Float64Array;
  private values: Float64Array;
  private sequence = 0;
  private head = 0;
  private tail = 0;
  private capacity: number;
  constructor(period: number, readonly maximum: boolean) {
    this.window = new RollingWindow(period);
    this.capacity = period + 1;
    this.indices = new Float64Array(this.capacity);
    this.values = new Float64Array(this.capacity);
  }
  next(value: number): number {
    this.window.push(value);
    const sequence = this.sequence++;
    while (this.head !== this.tail && this.indices[this.head]! <= sequence - this.window.period) {
      this.head = (this.head + 1) % this.capacity;
    }
    if (Number.isFinite(value)) {
      while (this.head !== this.tail) {
        const last = (this.tail + this.capacity - 1) % this.capacity;
        if (this.maximum ? this.values[last]! > value : this.values[last]! < value) break;
        this.tail = last;
      }
      this.values[this.tail] = value;
      this.indices[this.tail] = sequence;
      this.tail = (this.tail + 1) % this.capacity;
    }
    return this.window.complete ? this.values[this.head]! : NaN;
  }
}

interface TreeNode { key: number; priority: number; count: number; size: number; left?: TreeNode; right?: TreeNode }
const size = (node: TreeNode | undefined): number => node?.size ?? 0;
function refresh(node: TreeNode): TreeNode { node.size = node.count + size(node.left) + size(node.right); return node; }

/** Order-statistic treap. Deterministic priorities, expected O(log period) updates. */
class OrderedValues {
  private root?: TreeNode;
  private random = 0x9e3779b9;
  private priority(): number {
    let x = this.random;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.random = x >>> 0;
    return this.random;
  }
  private rotateRight(node: TreeNode): TreeNode {
    const top = node.left!; node.left = top.right; top.right = refresh(node); return refresh(top);
  }
  private rotateLeft(node: TreeNode): TreeNode {
    const top = node.right!; node.right = top.left; top.left = refresh(node); return refresh(top);
  }
  add(key: number): void {
    const put = (node: TreeNode | undefined): TreeNode => {
      if (!node) return { key, priority: this.priority(), count: 1, size: 1 };
      if (key === node.key) node.count++;
      else if (key < node.key) {
        node.left = put(node.left);
        if (node.left.priority < node.priority) node = this.rotateRight(node);
      } else {
        node.right = put(node.right);
        if (node.right.priority < node.priority) node = this.rotateLeft(node);
      }
      return refresh(node);
    };
    this.root = put(this.root);
  }
  remove(key: number): void {
    const merge = (left: TreeNode | undefined, right: TreeNode | undefined): TreeNode | undefined => {
      if (!left) return right;
      if (!right) return left;
      if (left.priority < right.priority) { left.right = merge(left.right, right); return refresh(left); }
      right.left = merge(left, right.left); return refresh(right);
    };
    const drop = (node: TreeNode | undefined): TreeNode | undefined => {
      if (!node) return undefined;
      if (key < node.key) node.left = drop(node.left);
      else if (key > node.key) node.right = drop(node.right);
      else if (node.count > 1) node.count--;
      else return merge(node.left, node.right);
      return refresh(node);
    };
    this.root = drop(this.root);
  }
  at(index: number): number {
    let node = this.root;
    while (node) {
      const left = size(node.left);
      if (index < left) node = node.left;
      else if (index < left + node.count) return node.key;
      else { index -= left + node.count; node = node.right; }
    }
    return NaN;
  }
}

export class RollingQuantile implements NumericState {
  private window: RollingWindow;
  private ordered = new OrderedValues();
  constructor(period: number, readonly quantile: number) { this.window = new RollingWindow(period); }
  next(value: number): number {
    const removed = this.window.push(value);
    if (Number.isFinite(removed)) this.ordered.remove(removed);
    if (Number.isFinite(value)) this.ordered.add(value);
    if (!this.window.complete) return NaN;
    const position = (this.window.period - 1) * this.quantile;
    const lo = Math.floor(position), fraction = position - lo;
    const left = this.ordered.at(lo);
    return fraction === 0 ? left : left + fraction * (this.ordered.at(lo + 1) - left);
  }
}

export class Crossing {
  private previousLeft = NaN;
  private previousRight = NaN;
  constructor(readonly up: boolean) {}
  next(left: number, right: number): number {
    const valid = [left, right, this.previousLeft, this.previousRight].every(Number.isFinite);
    const crossed = this.up ? left > right && this.previousLeft <= this.previousRight
      : left < right && this.previousLeft >= this.previousRight;
    this.previousLeft = left; this.previousRight = right;
    return valid ? Number(crossed) : NaN;
  }
}
