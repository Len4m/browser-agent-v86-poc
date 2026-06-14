export type AppEventMap = {
  "app:language-changed": { lang: string };
  "console:state-changed": { source: string };
  "llm:availability-refresh-requested": { source: string };
  "llm:artifact": Record<string, unknown>;
  "llm:artifact-clear": Record<string, unknown>;
  "llm:artifact-context": Record<string, unknown>;
  "llm:artifact-remove": Record<string, unknown>;
  "llm:capabilities": Record<string, unknown>;
  "llm:context": Record<string, unknown>;
  "llm:native-tools": Record<string, unknown>;
  "llm:progress": Record<string, unknown>;
  "llm:resource": Record<string, unknown>;
  "llm:status": Record<string, unknown>;
  "llm:tool-done": Record<string, unknown>;
  "llm:tool-error": Record<string, unknown>;
  "llm:tool-policy": Record<string, unknown>;
  "llm:tool-start": Record<string, unknown>;
};

class TypedEventBus<Events extends Record<string, unknown>> {
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
