// Minimal typing for the terminal-kit slice Sterling uses (no official types).
declare module 'terminal-kit' {
  interface Terminal {
    width: number;
    height: number;
    fullscreen(on: boolean): void;
    hideCursor(hide?: boolean): void;
    grabInput(options: { mouse?: string } | false): void;
    on(event: 'key', cb: (name: string) => void): void;
    on(event: 'mouse', cb: (name: string, data: { x: number; y: number }) => void): void;
    on(event: 'resize', cb: (width: number, height: number) => void): void;
  }
  interface ScreenBufferAttr {
    bold?: boolean;
    dim?: boolean;
    inverse?: boolean;
    color?: string;
  }
  class ScreenBuffer {
    constructor(options: { dst: Terminal; width?: number; height?: number });
    width: number;
    height: number;
    fill(options: { attr: ScreenBufferAttr }): void;
    put(options: { x: number; y: number; attr: ScreenBufferAttr }, str: string): void;
    draw(options: { delta: boolean }): void;
  }
  const termkit: { terminal: Terminal; ScreenBuffer: typeof ScreenBuffer };
  export default termkit;
}
