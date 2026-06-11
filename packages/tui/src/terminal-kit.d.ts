// Minimal typing for the terminal-kit slice Sterling uses (no official types).
declare module 'terminal-kit' {
  interface Terminal {
    width: number;
    height: number;
    fullscreen(on: boolean): void;
    moveTo(x: number, y: number): Terminal;
    (s: string): Terminal;
    inverse(s: string): Terminal;
    bold(s: string): Terminal;
    dim(s: string): Terminal;
    yellow(s: string): Terminal;
    eraseLineAfter(): Terminal;
    eraseDisplayBelow(): Terminal;
    grabInput(options: { mouse?: string } | false): void;
    on(event: 'key', cb: (name: string) => void): void;
    on(event: 'mouse', cb: (name: string, data: { x: number; y: number }) => void): void;
  }
  const termkit: { terminal: Terminal };
  export default termkit;
}
