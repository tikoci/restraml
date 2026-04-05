// Vendored from tikoci/tiktui src/lib/protocol.ts @ f3d36c5
// Do not edit directly — sync changes upstream to tiktui.
// See: https://github.com/tikoci/tiktui
//
// NOTE: This file is retained for potential future use. CI currently uses REST-only transport
// because RouterOS native API `/console/inspect` with request=completion is non-deterministic
// (~20-30% random entry drops per call). REST is 100% deterministic. This protocol is fully
// functional for `request=child` and `request=syntax` work, and may be useful for Phase 3
// ARM64 tree crawl or if MikroTik fixes the completion bug. See BACKLOG.md Phase 2.9.
//
// Wire protocol: length-prefixed UTF-8 words, grouped into sentences (null terminator).
// Multiplexing: each command gets a unique .tag, router echoes it back in replies.
// Login: post-6.43 plaintext (send user+password, get !done).
// TLS: optional — port 8729 is the standard API-SSL port.
// Minimum RouterOS version: 7.20.8
//
// Reference: https://help.mikrotik.com/docs/spaces/ROS/pages/47579160/API

// ── Word encoding/decoding ──

/** Encode a word length as RouterOS variable-length prefix (1-5 bytes). */
function encodeLength(len: number): Uint8Array {
  if (len < 0x80) {
    return new Uint8Array([len]);
  }
  if (len < 0x4000) {
    return new Uint8Array([(len >> 8) | 0x80, len & 0xff]);
  }
  if (len < 0x200000) {
    return new Uint8Array([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  }
  if (len < 0x10000000) {
    return new Uint8Array([
      (len >> 24) | 0xe0,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
  return new Uint8Array([
    0xf0,
    (len >> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
  ]);
}

/** Encode a single word (length prefix + UTF-8 content). */
function encodeWord(word: string): Uint8Array {
  const content = new TextEncoder().encode(word);
  const prefix = encodeLength(content.length);
  const buf = new Uint8Array(prefix.length + content.length);
  buf.set(prefix);
  buf.set(content, prefix.length);
  return buf;
}

/** Encode a full sentence: words + null terminator. */
function encodeSentence(words: string[]): Uint8Array {
  const parts = words.map(encodeWord);
  const terminator = new Uint8Array([0x00]); // zero-length word = end of sentence
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0) + 1;
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    buf.set(part, offset);
    offset += part.length;
  }
  buf.set(terminator, offset);
  return buf;
}

/**
 * Decode length prefix from buffer at given offset.
 * Returns [bytesConsumed, wordLength] or null if buffer incomplete.
 */
function decodeLength(
  buf: Uint8Array,
  offset: number,
): [number, number] | null {
  if (offset >= buf.length) return null;
  const b0 = buf[offset];

  if ((b0 & 0x80) === 0) {
    // 1-byte: 0-127
    return [1, b0];
  }
  if ((b0 & 0xc0) === 0x80) {
    // 2-byte: 128-16383
    if (offset + 1 >= buf.length) return null;
    return [2, ((b0 & 0x3f) << 8) | buf[offset + 1]];
  }
  if ((b0 & 0xe0) === 0xc0) {
    // 3-byte: 16384-2097151
    if (offset + 2 >= buf.length) return null;
    return [3, ((b0 & 0x1f) << 16) | (buf[offset + 1] << 8) | buf[offset + 2]];
  }
  if ((b0 & 0xf0) === 0xe0) {
    // 4-byte: 2097152-268435455
    if (offset + 3 >= buf.length) return null;
    return [
      4,
      ((b0 & 0x0f) << 24) |
        (buf[offset + 1] << 16) |
        (buf[offset + 2] << 8) |
        buf[offset + 3],
    ];
  }
  if ((b0 & 0xf8) === 0xf0) {
    // 5-byte: 0xF0 prefix + 4 bytes
    if (offset + 4 >= buf.length) return null;
    return [
      5,
      (buf[offset + 1] << 24) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 8) |
        buf[offset + 4],
    ];
  }
  throw new Error(`Invalid RouterOS length descriptor: 0x${b0.toString(16)}`);
}

// ── Parsed sentence types ──

interface Sentence {
  type: string; // "!re", "!done", "!trap", "!fatal", "!empty"
  tag: string; // .tag value (empty string if untagged)
  data: Record<string, string>; // key=value attributes
}

// ── Tag-based command routing ──

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  replies: Sentence[]; // accumulated !re sentences
  streaming?: (sentence: Sentence) => void; // callback for streaming mode
}

interface CommandResult {
  re: Sentence[]; // !re sentences
  done: Record<string, string>; // attributes from !done sentence
}

// ── RouterOS API Error ──

/** Machine-readable error codes for upstream callers. */
const RosErrorCode = {
  /** TCP connection refused — port not open or service not running */
  ECONNREFUSED: "ECONNREFUSED",
  /** Host unreachable — wrong IP or network issue */
  EHOSTUNREACH: "EHOSTUNREACH",
  /** DNS resolution failed */
  ENOTFOUND: "ENOTFOUND",
  /** Connection timed out */
  ETIMEDOUT: "ETIMEDOUT",
  /** TLS handshake failed — typically no certificate assigned to api-ssl service */
  TLSHANDSHAKE: "TLSHANDSHAKE",
  /** Bad username or password */
  LOGINDENIED: "LOGINDENIED",
  /** RouterOS too old — pre-6.43 challenge-based login */
  LEGACYLOGIN: "LEGACYLOGIN",
  /** Connection closed unexpectedly */
  CONNRESET: "CONNRESET",
  /** RouterOS command trap (see .category for trap category) */
  TRAP: "TRAP",
  /** RouterOS fatal error — connection will be closed */
  FATAL: "FATAL",
} as const;

type RosErrorCodeType = (typeof RosErrorCode)[keyof typeof RosErrorCode];

class RosError extends Error {
  code: string;
  category: number;
  constructor(message: string, code: RosErrorCodeType | string = "", category = 0) {
    super(message);
    this.name = "RosError";
    this.code = code;
    this.category = category;
  }
}

// ── Constants ──

// ── Main client ──

class RosAPI {
  private host: string;
  private port: number;
  private user: string;
  private password: string;
  private tls: boolean;
  private socket!: ReturnType<typeof Bun.connect> extends Promise<infer T>
    ? T
    : never;
  private connected = false;
  private nextTag = 0;
  private pending = new Map<string, PendingCommand>();
  private recvBuf = new Uint8Array(0);
  private decoder = new TextDecoder();
  private connectPromise: Promise<void> | null = null;

  constructor(
    host: string,
    port: number,
    user: string,
    password: string,
    tls = false,
  ) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.tls = tls;
  }

  // ── Connection lifecycle ──

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _doConnect(): Promise<void> {
    const self = this;
    const readyPromise = Promise.withResolvers<void>();
    // Prevent unhandled rejection if Bun.connect() rejects before readyPromise is awaited
    readyPromise.promise.catch(() => {});

    const socketOpts = {
      hostname: this.host,
      port: this.port,
      socket: {
        data(_socket: any, data: any) {
          self._onData(new Uint8Array(data));
        },
        open(_socket: any) {
          self.connected = true;
          // For plaintext, open = ready to write.
          // For TLS, we must wait for the handshake callback.
          if (!self.tls) readyPromise.resolve();
        },
        close(_socket: any) {
          self.connected = false;
          self._onClose();
        },
        error(_socket: any, err: any) {
          self._onError(err);
        },
        connectError(_socket: any, err: any) {
          // Wrap native errors preserving .code for upstream callers
          const code = err?.code || err?.errno || "";
          const rosErr = new RosError(
            err?.message || "Connection failed",
            code,
          );
          readyPromise.reject(rosErr);
        },
        handshake(_socket: any, success: boolean, _authError: any) {
          if (success) readyPromise.resolve();
          else {
            readyPromise.reject(
              new RosError(
                "TLS handshake failed — check that the api-ssl service has a certificate assigned",
                RosErrorCode.TLSHANDSHAKE,
              ),
            );
          }
        },
      },
      ...(this.tls ? { tls: true } : {}),
    };

    try {
      this.socket = await Bun.connect(socketOpts as any);
    } catch (err) {
      // Bun.connect() rejects on connectError; wrap preserving .code
      const code = (err as any)?.code || (err as any)?.errno || "";
      throw new RosError((err as any)?.message || "Connection failed", code);
    }

    await readyPromise.promise;
    await this._login();
  }

  close(): void {
    if (this.socket) {
      this.socket.end();
      this.connected = false;
    }
  }

  // ── Login (post-6.43: plaintext user+password) ──

  private async _login(): Promise<void> {
    const result = await this._writeRaw([
      "/login",
      `=name=${this.user}`,
      `=password=${this.password}`,
    ]);
    // Successful login: resolved promise means !done was received.
    // Check for legacy challenge (=ret= in !done data).
    if (result.done.ret) {
      throw new RosError(
        "Legacy login challenge not supported (RouterOS < 6.43)",
        RosErrorCode.LEGACYLOGIN,
      );
    }
  }

  // ── Command execution ──

  /** Send a command and collect all !re replies until !done. */
  async write(command: string, ...params: string[]): Promise<Sentence[]> {
    if (!this.connected) await this.connect();
    const result = await this._send(command, ...params);
    return result.re;
  }

  /** Send a command, returning both !re sentences and !done data. */
  async writeFull(command: string, ...params: string[]): Promise<CommandResult> {
    if (!this.connected) await this.connect();
    return this._send(command, ...params);
  }

  /** Send a command, returning both !re sentences and !done data. */
  private _send(command: string, ...params: string[]): Promise<CommandResult> {
    const tag = `t${++this.nextTag}`;
    const words = [command, ...params, `.tag=${tag}`];

    return new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(tag, { resolve, reject, replies: [] });
      this.socket.write(encodeSentence(words));
    });
  }

  /**
   * Like write(), but sends /cancel to the router when `signal` is aborted.
   *
   * This is the correct way to abort a native API in-flight command — it tells
   * the router to stop processing, preventing "ghost" commands that hold router
   * resources and compete for serialized handlers like /console/inspect.
   *
   * On cancellation the router sends !trap category=2 ("interrupted"), which
   * _routeSentence resolves as an empty result (not an error). The caller gets
   * an empty Sentence[] and can treat that as "retry needed".
   *
   * If signal is undefined, behaves identically to write().
   */
  async writeAbortable(signal: AbortSignal | undefined, command: string, ...params: string[]): Promise<Sentence[]> {
    // Fast path: already aborted before we even start
    if (signal?.aborted) return [];
    if (!this.connected) await this.connect();

    const tag = `t${++this.nextTag}`;
    const words = [command, ...params, `.tag=${tag}`];

    const commandPromise = new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(tag, { resolve, reject, replies: [] });
      this.socket.write(encodeSentence(words));
    });

    let cancelSent = false;

    const onAbort = (): void => {
      // Only send cancel once, and only if the command is still pending.
      if (cancelSent || !this.pending.has(tag)) return;
      cancelSent = true;

      // Immediately reject the caller's promise — do NOT wait for the router
      // to acknowledge /cancel. This gives REST-like abort semantics: abort is
      // instant, the caller can retry immediately. The router's eventual
      // response (if any) is silently discarded by _routeSentence since we
      // replace the pending entry with a zombie handler below.
      const cmd = this.pending.get(tag);
      if (cmd) {
        // Replace with zombie handler that silently absorbs the router's
        // eventual response (e.g. !trap category=2 from /cancel ack, or
        // !done if the command completes after we gave up). Without this,
        // the router's response for the dead tag would log "orphan sentence".
        this.pending.set(tag, {
          resolve: () => { this.pending.delete(tag); },
          reject: () => { this.pending.delete(tag); },
          replies: [],
        });

        cmd.reject(new RosError(
          "Command aborted",
          RosErrorCode.ETIMEDOUT,
        ));
      }

      // Send /cancel as a fire-and-forget courtesy to the router. Even though
      // we already rejected the caller's promise, /cancel tells the router to
      // stop processing the command and free server-side resources. The cancel
      // tag handler silently consumes the router's !done for the /cancel itself.
      if (this.connected && this.socket) {
        try {
          const cancelTag = `cc${++this.nextTag}`;
          this.pending.set(cancelTag, {
            resolve: () => { this.pending.delete(cancelTag); },
            reject: () => { this.pending.delete(cancelTag); },
            replies: [],
          });
          this.socket.write(encodeSentence(["/cancel", `=tag=${tag}`, `.tag=${cancelTag}`]));
        } catch {
          // Socket gone — _onClose will clean up remaining pending entries
        }
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await commandPromise;
      return result.re;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Send a streaming command. Returns a handle with:
   * - on(callback): receive each !re sentence as it arrives
   * - cancel(): send /cancel to stop the stream
   * - done: promise that resolves when the stream ends
   */
  listen(
    command: string,
    ...params: string[]
  ): {
    on: (callback: (data: Record<string, string>) => void) => void;
    cancel: () => Promise<void>;
    done: Promise<CommandResult>;
    tag: string;
  } {
    const tag = `l${++this.nextTag}`;
    const words = [command, ...params, `.tag=${tag}`];

    let streamCallback: ((data: Record<string, string>) => void) | null = null;

    const done = new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(tag, {
        resolve,
        reject,
        replies: [],
        streaming: (sentence) => {
          if (streamCallback) {
            streamCallback(sentence.data);
          }
        },
      });
      this.socket.write(encodeSentence(words));
    });

    return {
      on: (callback) => {
        streamCallback = callback;
      },
      cancel: async () => {
        // Send /cancel command targeting this tag
        await this.write("/cancel", `=tag=${tag}`);
      },
      done,
      tag,
    };
  }

  // ── Internal: raw write without auto-connect (used for login) ──

  private _writeRaw(words: string[]): Promise<CommandResult> {
    const tag = `t${++this.nextTag}`;
    words.push(`.tag=${tag}`);

    return new Promise<CommandResult>((resolve, reject) => {
      this.pending.set(tag, { resolve, reject, replies: [] });
      this.socket.write(encodeSentence(words));
    });
  }

  // ── Data reception & sentence parsing ──

  private _onData(chunk: Uint8Array): void {
    // Append to receive buffer
    const newBuf = new Uint8Array(this.recvBuf.length + chunk.length);
    newBuf.set(this.recvBuf);
    newBuf.set(chunk, this.recvBuf.length);
    this.recvBuf = newBuf;

    // Parse complete sentences
    this._parseSentences();
  }

  private _parseSentences(): void {
    let offset = 0;
    const words: string[] = [];

    while (offset < this.recvBuf.length) {
      const decoded = decodeLength(this.recvBuf, offset);
      if (decoded === null) break; // incomplete length prefix

      const [prefixLen, wordLen] = decoded;

      if (wordLen === 0) {
        // End of sentence — process accumulated words
        if (words.length > 0) {
          this._processSentence([...words]);
          words.length = 0;
        }
        offset += prefixLen;
        continue;
      }

      const wordEnd = offset + prefixLen + wordLen;
      if (wordEnd > this.recvBuf.length) break; // incomplete word

      const word = this.decoder.decode(
        this.recvBuf.subarray(offset + prefixLen, wordEnd),
      );
      words.push(word);
      offset = wordEnd;
    }

    // Keep unprocessed bytes
    if (offset > 0) {
      this.recvBuf = this.recvBuf.slice(offset);
    }
  }

  private _processSentence(words: string[]): void {
    if (words.length === 0) return;

    const sentence: Sentence = { type: words[0], tag: "", data: {} };

    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w.startsWith(".tag=")) {
        sentence.tag = w.substring(5);
      } else if (w.startsWith("=")) {
        // =key=value — split on second =
        const eqIdx = w.indexOf("=", 1);
        if (eqIdx === -1) {
          sentence.data[w.substring(1)] = "";
        } else {
          sentence.data[w.substring(1, eqIdx)] = w.substring(eqIdx + 1);
        }
      }
    }

    this._routeSentence(sentence);
  }

  private _routeSentence(sentence: Sentence): void {
    const cmd = this.pending.get(sentence.tag);
    if (!cmd) return; // orphan sentence (shouldn't happen with tags)

    switch (sentence.type) {
      case "!re":
        cmd.replies.push(sentence);
        if (cmd.streaming) {
          cmd.streaming(sentence);
        }
        break;

      case "!done":
        this.pending.delete(sentence.tag);
        cmd.resolve({ re: cmd.replies, done: sentence.data });
        break;

      case "!trap": {
        const msg = sentence.data.message || "Unknown trap";
        const cat = parseInt(sentence.data.category || "0", 10);
        if (cat === 2) {
          // "interrupted" — result of /cancel (for any command type) or stream cancel.
          // Treat as clean done with whatever replies accumulated so far.
          this.pending.delete(sentence.tag);
          cmd.resolve({ re: cmd.replies, done: sentence.data });
        } else {
          // Detect login-denied specifically so callers can differentiate
          const isLoginDenied = /invalid user|cannot log in|login failure/i.test(msg);
          const code = isLoginDenied ? RosErrorCode.LOGINDENIED : RosErrorCode.TRAP;
          this.pending.delete(sentence.tag);
          cmd.reject(new RosError(msg, code, cat));
        }
        break;
      }

      case "!fatal": {
        const msg = sentence.data.message || "Fatal error";
        this.pending.delete(sentence.tag);
        cmd.reject(new RosError(msg, RosErrorCode.FATAL));
        break;
      }

      case "!empty":
        // RouterOS 7.18+: equivalent to !done with no data
        this.pending.delete(sentence.tag);
        cmd.resolve({ re: cmd.replies, done: sentence.data });
        break;

      default:
        // Unknown reply type — don't crash, log and continue
        console.warn(
          `RouterOS: unknown reply type "${sentence.type}" for tag ${sentence.tag}`,
        );
        break;
    }
  }

  // ── Connection event handlers ──

  private _onClose(): void {
    const err = new RosError("Connection closed", RosErrorCode.CONNRESET);
    for (const [tag, cmd] of this.pending) {
      cmd.reject(err);
      this.pending.delete(tag);
    }
  }

  private _onError(err: Error): void {
    const code = (err as any).code || "";
    const rosErr = new RosError(err.message, code);
    for (const [tag, cmd] of this.pending) {
      cmd.reject(rosErr);
      this.pending.delete(tag);
    }
  }
}

export {
  RosAPI,
  RosError,
  RosErrorCode,
  encodeLength,
  encodeWord,
  encodeSentence,
  decodeLength,
};
export type { Sentence, CommandResult, RosErrorCodeType };
