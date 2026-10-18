export {};

declare global {
  interface Window {
    /** Only the current interview cache is exposed; no filesystem or API keys. */
    desktopSession?: {
      read(): string | null;
      write(value: string): void;
      clear(): void;
    };
  }
}
