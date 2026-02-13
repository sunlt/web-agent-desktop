export interface StreamEnvelope<T> {
  readonly seq: number;
  readonly event: T;
}

interface StreamSubscriber<T> {
  readonly onEvent: (envelope: StreamEnvelope<T>) => void;
  readonly onClose: () => void;
}

interface StreamState<T> {
  nextSeq: number;
  closed: boolean;
  events: StreamEnvelope<T>[];
  subscribers: Set<StreamSubscriber<T>>;
}

export class StreamBus<T> {
  private readonly streams = new Map<string, StreamState<T>>();

  constructor(private readonly maxEventsPerStream: number = 1000) {}

  publish(streamId: string, event: T): StreamEnvelope<T> {
    const state = this.ensureState(streamId);
    const envelope: StreamEnvelope<T> = {
      seq: state.nextSeq,
      event,
    };
    state.nextSeq += 1;
    state.events.push(envelope);
    if (state.events.length > this.maxEventsPerStream) {
      state.events.splice(0, state.events.length - this.maxEventsPerStream);
    }

    for (const subscriber of state.subscribers) {
      subscriber.onEvent(envelope);
    }

    return envelope;
  }

  close(streamId: string): void {
    const state = this.ensureState(streamId);
    if (state.closed) {
      return;
    }

    state.closed = true;
    for (const subscriber of state.subscribers) {
      subscriber.onClose();
    }
    state.subscribers.clear();
  }

  subscribe(input: {
    streamId: string;
    afterSeq: number;
    onEvent: (envelope: StreamEnvelope<T>) => void;
    onClose: () => void;
  }): () => void {
    const state = this.ensureState(input.streamId);
    const replay = state.events.filter((entry) => entry.seq > input.afterSeq);
    for (const entry of replay) {
      input.onEvent(entry);
    }

    if (state.closed) {
      input.onClose();
      return () => {};
    }

    const subscriber: StreamSubscriber<T> = {
      onEvent: input.onEvent,
      onClose: input.onClose,
    };
    state.subscribers.add(subscriber);

    return () => {
      state.subscribers.delete(subscriber);
    };
  }

  isClosed(streamId: string): boolean {
    return this.ensureState(streamId).closed;
  }

  private ensureState(streamId: string): StreamState<T> {
    const existing = this.streams.get(streamId);
    if (existing) {
      return existing;
    }

    const created: StreamState<T> = {
      nextSeq: 1,
      closed: false,
      events: [],
      subscribers: new Set(),
    };
    this.streams.set(streamId, created);
    return created;
  }
}
