/**
 * WebCodecs 解码管线。
 *
 * 职责很小但很关键：把 Rust 广播来的编码包喂给 `VideoDecoder`，
 * 再把 `VideoFrame` 交给调用方去绘制。
 *
 * # 为什么丢帧而不是排队
 *
 * 投屏是**实时**场景。解码跟不上时，正确做法是丢掉中间帧、追上最新画面，
 * 而不是把队列越堆越长（那会让画面延迟持续增长）。
 * 因此这里只保留「最新一个关键帧之后」的数据：队列过长就丢非关键帧。
 */

import type { VideoCodec } from '@ac/ipc-contract';
import {
  annexBToAvcc,
  avcCodecString,
  buildAvcDescription,
  fallbackCodecString,
  parseConfigPacket,
} from './annexb';

/** 交给解码器的编码包（`data` 已是解码后的字节） */
export interface EncodedPacket {
  config: boolean;
  keyFrame: boolean;
  ptsUs: number;
  data: Uint8Array;
}

export interface DecoderOptions {
  codec: VideoCodec;
  width: number;
  height: number;
  /** 每一帧解码完成时回调；调用方负责 `frame.close()` */
  onFrame: (frame: VideoFrame) => void;
  /** 不可恢复的错误（解码器内部错误、配置失败） */
  onError?: (error: Error) => void;
}

/** 允许排队等待解码的关键帧数量上限 */
const MAX_QUEUE = 4;

/**
 * 一条会话对应一个解码器。
 *
 * 生命周期：`configure()` 由构造完成 → `push()` 喂包 → `close()` 释放。
 */
export class VideoStreamDecoder {
  private decoder: VideoDecoder | null = null;
  private configured = false;
  private closed = false;
  private readonly options: DecoderOptions;
  private readonly isAvc: boolean;

  /** 等待解码的包数，用于判断是否需要丢帧 */
  private pending = 0;

  constructor(options: DecoderOptions) {
    this.options = options;
    this.isAvc = options.codec === 'h264' || options.codec === 'unknown';
  }

  /** 解码器是否已经成功配置 */
  get ready(): boolean {
    return this.configured && !this.closed;
  }

  /**
   * 喂一个编码包。
   *
   * config 包不会直接送去解码，而是抽出 SPS/PPS 用于构建 `description`
   * 并（重新）配置解码器——分辨率可能在旋转后变化。
   */
  push(packet: EncodedPacket): void {
    if (this.closed) return;

    if (packet.config) {
      this.applyConfig(packet.data);
      return;
    }

    if (!this.configured) {
      // 还没拿到参数集，丢帧即可：后续关键帧会重新同步
      return;
    }

    // 背压：队列堆积时丢掉非关键帧，等下一个关键帧追上
    if (this.pending >= MAX_QUEUE && !packet.keyFrame) {
      return;
    }

    const data = this.isAvc ? annexBToAvcc(packet.data) : packet.data;
    const chunk = new EncodedVideoChunk({
      type: packet.keyFrame ? 'key' : 'delta',
      timestamp: packet.ptsUs,
      data,
    });

    this.pending += 1;
    try {
      this.decoder?.decode(chunk);
    } catch (error) {
      this.pending -= 1;
      this.options.onError?.(toError(error, '解码失败'));
    }
  }

  /** 释放解码器资源。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.decoder?.close();
    } catch {
      // 已经关闭或从未配置，忽略
    }
    this.decoder = null;
  }

  /** 处理 config 包：抽参数集、按需重建解码器。 */
  private applyConfig(data: Uint8Array): void {
    if (!this.isAvc) {
      // 非 H.264 目前直接按 Annex-B 交给解码器，不做 description
      this.ensureDecoder(null, fallbackCodecString(this.options.codec));
      return;
    }

    const { sps, pps } = parseConfigPacket(data);
    if (!sps || !pps) {
      // 有些不规范的编码器把 SPS/PPS 混在帧里，等真正的关键帧
      return;
    }

    const description = buildAvcDescription(sps, pps);
    this.ensureDecoder(description, avcCodecString(sps));
  }

  /** 按需创建 / 重建 `VideoDecoder`。尺寸与描述变化时必须重建。 */
  private ensureDecoder(description: Uint8Array | null, codec: string): void {
    const config: VideoDecoderConfig = {
      codec,
      codedWidth: this.options.width,
      codedHeight: this.options.height,
      optimizeForLatency: true,
    };
    if (description) {
      config.description = description;
    }

    if (typeof VideoDecoder !== 'undefined') {
      // 重建前必须彻底关掉旧实例，否则会泄漏硬件解码器
      if (this.decoder) {
        try {
          this.decoder.close();
        } catch {
          // 忽略：旧实例可能已因错误自动关闭
        }
        this.decoder = null;
      }
    } else {
      this.options.onError?.(new Error('当前运行环境不支持 WebCodecs'));
      return;
    }

    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.pending = Math.max(0, this.pending - 1);
        this.options.onFrame(frame);
      },
      error: (error) => {
        this.configured = false;
        this.options.onError?.(toError(error, '解码器内部错误'));
      },
    });

    try {
      this.decoder.configure(config);
      this.configured = true;
    } catch (error) {
      this.configured = false;
      this.options.onError?.(toError(error, '配置解码器失败'));
    }
  }
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(`${fallback}：${String(error)}`);
}

/** base64 → 字节。事件负载走 JSON，字节以 base64 传输。 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
