import { StringDecoder } from "node:string_decoder";

export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly onRecord: (record: unknown) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    this.drain(false);
  }

  end(): void {
    this.buffer += this.decoder.end();
    this.drain(true);
  }

  private drain(ending: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.parse(line);
    }
    if (ending && this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.parse(line);
    }
  }

  private parse(line: string): void {
    if (!line.trim()) return;
    this.onRecord(JSON.parse(line) as unknown);
  }
}
