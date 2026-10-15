/**
 * Annex-B ↔ AVCC 转换。
 *
 * scrcpy 服务端把 MediaCodec 的输出**原样**下发，也就是 Annex-B：
 * 每个 NAL 单元以 `00 00 01` 或 `00 00 00 01` 起始码分隔。
 *
 * 但 WebCodecs 的 `VideoDecoder` 在 H.264 上默认按 **AVCC** 解释数据
 * （每个 NAL 前面是 4 字节大端长度），并且要求 `description` 是
 * `AVCDecoderConfigurationRecord`。所以必须在渲染进程里做一次转换。
 *
 * 这些函数是纯函数，因此可以脱离浏览器单测——这是把它们从解码器里拆出来的原因。
 */

/** NAL 单元类型（H.264） */
export const NAL_TYPE = {
  /** 非 IDR 图像 */
  SLICE: 1,
  /** 序列参数集 */
  SPS: 7,
  /** 图像参数集 */
  PPS: 8,
  /** IDR 起始的分隔符 */
  IDR: 5,
  /** SEI 补充增强信息 */
  SEI: 6,
} as const;

/**
 * 按起始码切分 Annex-B 字节流。
 *
 * 返回每个 NAL 的**载荷**（不含起始码），空 NAL 会被丢弃。
 */
export function splitNalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;

  while (i + 2 < data.length) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) {
      i += 1;
      continue;
    }

    if (start >= 0) {
      pushTrimmed(units, data.subarray(start, i));
    }
    // 4 字节起始码多出来的那个 0 会落到上一个 NAL 的尾部，
    // `pushTrimmed` 会把它们剪掉
    i += 3;
    start = i;
  }

  if (start >= 0) {
    pushTrimmed(units, data.subarray(start));
  }
  return units;
}

/** Annex-B 允许在 NAL 之间填充 `trailing_zero_8bits`，这些 0 不能算进 NAL 长度。 */
function pushTrimmed(units: Uint8Array[], unit: Uint8Array): void {
  let end = unit.length;
  while (end > 0 && unit[end - 1] === 0) end -= 1;
  if (end > 0) units.push(unit.subarray(0, end));
}

/** NAL 类型（H.264：首字节低 5 位） */
export function nalUnitType(nal: Uint8Array): number {
  return nal.length === 0 ? -1 : byteAt(nal, 0) & 0x1f;
}

/**
 * 把 Annex-B 数据转成 AVCC（长度前缀）格式。
 *
 * 已经在 AVCC 格式的数据会被原样返回——判断依据是「找不到起始码但前面
 * 的长度的确能走完整个缓冲」，这样同一段数据重复转换也不会被破坏。
 */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  const units = splitNalUnits(data);
  if (units.length === 0) {
    // 没有起始码：要么本来就是 AVCC，要么是垃圾。原样交给解码器。
    return data;
  }

  let total = 0;
  for (const unit of units) total += 4 + unit.length;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const unit of units) {
    const length = unit.length;
    out[offset] = (length >>> 24) & 0xff;
    out[offset + 1] = (length >>> 16) & 0xff;
    out[offset + 2] = (length >>> 8) & 0xff;
    out[offset + 3] = length & 0xff;
    out.set(unit, offset + 4);
    offset += 4 + length;
  }
  return out;
}

/** 从一串 NAL 中挑出 SPS / PPS。 */
export function pickParameterSets(units: Uint8Array[]): {
  sps: Uint8Array[];
  pps: Uint8Array[];
} {
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  for (const unit of units) {
    const type = nalUnitType(unit);
    if (type === NAL_TYPE.SPS) sps.push(unit);
    else if (type === NAL_TYPE.PPS) pps.push(unit);
  }
  return { sps, pps };
}

/**
 * 构造 `AVCDecoderConfigurationRecord`（ISO/IEC 14496-15 §5.2.4.1）。
 *
 * 这是 WebCodecs 在 AVCC 模式下必须拿到的 `description`。
 * 长度前缀固定用 4 字节，与 {@link annexBToAvcc} 保持一致。
 */
export function buildAvcDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  if (sps.length < 4) {
    throw new Error('SPS 至少需要 4 字节才能读出 profile / level');
  }

  const size = 11 + sps.length + pps.length;
  const out = new Uint8Array(size);
  let offset = 0;

  out[offset++] = 1; // configurationVersion
  out[offset++] = byteAt(sps, 1); // AVCProfileIndication
  out[offset++] = byteAt(sps, 2); // profile_compatibility
  out[offset++] = byteAt(sps, 3); // AVCLevelIndication
  out[offset++] = 0xff; // 6 bits reserved + lengthSizeMinusOne = 3

  out[offset++] = 0xe1; // 3 bits reserved + numOfSequenceParameterSets = 1
  out[offset++] = (sps.length >> 8) & 0xff;
  out[offset++] = sps.length & 0xff;
  out.set(sps, offset);
  offset += sps.length;

  out[offset++] = 1; // numOfPictureParameterSets
  out[offset++] = (pps.length >> 8) & 0xff;
  out[offset++] = pps.length & 0xff;
  out.set(pps, offset);

  return out;
}

/** 由 H.264 profile/level 推导 WebCodecs 的 codec 字符串。 */
export function avcCodecString(sps: Uint8Array): string {
  if (sps.length < 4) return 'avc1.42E01E';
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `avc1.${hex(byteAt(sps, 1))}${hex(byteAt(sps, 2))}${hex(byteAt(sps, 3))}`;
}

/** 越界即抛错：这些位置都已经用长度检查保证存在，越界说明调用方违反了前置条件。 */
function byteAt(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new Error(`字节数组越界访问：索引 ${index}，长度 ${bytes.length}`);
  }
  return value;
}

/** H.265 / AV1 的编解码器字符串（无 description 时的退路）。 */
export function fallbackCodecString(codec: string): string {
  switch (codec) {
    case 'h265':
      return 'hev1.1.6.L93.B0';
    case 'av1':
      return 'av01.0.04M.08';
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return 'vp09.00.10.08';
    default:
      return 'avc1.42E01E';
  }
}

/**
 * 判断一个 Annex-B **config 包**里是否含关键参数集。
 *
 * scrcpy 的 config 包是 `MediaCodec.BUFFER_FLAG_CODEC_CONFIG` 的产物，
 * 通常就是 SPS + PPS，但不同厂商可能夹带 SEI，所以要按 NAL 类型筛。
 */
export function parseConfigPacket(data: Uint8Array): {
  sps: Uint8Array | null;
  pps: Uint8Array | null;
} {
  const { sps, pps } = pickParameterSets(splitNalUnits(data));
  return { sps: sps[0] ?? null, pps: pps[0] ?? null };
}
