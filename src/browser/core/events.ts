export type AppEventMap = {
  "app:ready": { version: string; source: string };
  "app:error": { message: string; error?: unknown };
};

export type AppEventName = keyof AppEventMap;

export class TypedEventBus<Events extends Record<string, unknown>> {
  private readonly target = new EventTarget();

  on<Name extends keyof Events & string>(
    name: Name,
    listener: (detail: Events[Name]) => void,
  ): () => void {
    const wrapped = (event: Event) => listener((event as CustomEvent<Events[Name]>).detail);
    this.target.addEventListener(name, wrapped);
    return () => this.target.removeEventListener(name, wrapped);
  }

  emit<Name extends keyof Events & string>(name: Name, detail: Events[Name]): void {
    this.target.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

export const appEvents = new TypedEventBus<AppEventMap>();
