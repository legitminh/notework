/** A new visit after going back discards the forward branch. */
export class NavigationHistory {
  private entries: string[];
  private index: number;
  constructor(initial?: string) {
    this.entries = initial ? [initial] : [];
    this.index = this.entries.length - 1;
  }
  visit(id: string) {
    if (this.entries[this.index] === id) return;
    this.entries = [...this.entries.slice(0, this.index + 1), id];
    this.index = this.entries.length - 1;
  }
  forget(matches: (id: string) => boolean) {
    const before = this.entries.slice(0, this.index + 1).filter((id) => !matches(id));
    const after = this.entries.slice(this.index + 1).filter((id) => !matches(id));
    this.entries = [...before, ...after];
    this.index = before.length - 1;
  }
  target(delta: number) { return this.entries[this.index + delta]; }
  move(delta: number) { if (this.target(delta)) this.index += delta; }
}
