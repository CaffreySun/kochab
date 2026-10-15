import { describe, expect, it } from 'vitest';

import {
  annexBToAvcc,
  avcCodecString,
  buildAvcDescription,
  fallbackCodecString,
  nalUnitType,
  parseConfigPacket,
  pickParameterSets,
  splitNalUnits,
} from './annexb';

/** 构造一段 Annex-B 数据，`fourByte` 决定起始码长度 */
function annexB(units: number[][], fourByte = false): Uint8Array {
  const startCode = fourByte ? [0, 0, 0, 1] : [0, 0, 1];
  const out: number[] = [];
  for (const unit of units) out.push(...startCode, ...unit);
  return Uint8Array.from(out);
}

/** 一段最小但结构合法的 SPS：profile=0x64(High), level=0x28(4.0) */
const SPS = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];

describe('splitNalUnits', () => {
  it('按 3 字节起始码切分', () => {
    const units = splitNalUnits(annexB([SPS, PPS]));
    expect(units).toHaveLength(2);
    expect(Array.from(units[0] ?? [])).toEqual(SPS);
    expect(Array.from(units[1] ?? [])).toEqual(PPS);
  });

  it('按 4 字节起始码切分，多出的 0 不会被算进 NAL', () => {
    const units = splitNalUnits(annexB([SPS, PPS], true));
    expect(units).toHaveLength(2);
    expect(Array.from(units[0] ?? [])).toEqual(SPS);
    expect(Array.from(units[1] ?? [])).toEqual(PPS);
  });

  it('剪掉 NAL 之间的 trailing_zero_8bits', () => {
    const data = Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0, 0, 0, 0, 1, 0x68, 0xce]);
    const units = splitNalUnits(data);
    expect(units).toHaveLength(2);
    expect(Array.from(units[0] ?? [])).toEqual([0x67, 0x42]);
    expect(Array.from(units[1] ?? [])).toEqual([0x68, 0xce]);
  });

  it('没有起始码时返回空数组', () => {
    expect(splitNalUnits(Uint8Array.from([1, 2, 3, 4]))).toEqual([]);
  });

  it('忽略起始码之间的空 NAL', () => {
    const data = Uint8Array.from([0, 0, 1, 0, 0, 1, 0x65, 0x88]);
    const units = splitNalUnits(data);
    expect(units).toHaveLength(1);
    expect(Array.from(units[0] ?? [])).toEqual([0x65, 0x88]);
  });
});

describe('nalUnitType', () => {
  it('取首字节低 5 位', () => {
    expect(nalUnitType(Uint8Array.from([0x67]))).toBe(7);
    expect(nalUnitType(Uint8Array.from([0x68]))).toBe(8);
    expect(nalUnitType(Uint8Array.from([0x65]))).toBe(5);
    expect(nalUnitType(Uint8Array.from([0x41]))).toBe(1);
  });

  it('空 NAL 返回 -1', () => {
    expect(nalUnitType(new Uint8Array())).toBe(-1);
  });
});

describe('annexBToAvcc', () => {
  it('把起始码换成 4 字节大端长度', () => {
    const avcc = annexBToAvcc(annexB([SPS, PPS]));
    // SPS 长度 6 → 00 00 00 06
    expect(Array.from(avcc.subarray(0, 4))).toEqual([0, 0, 0, 6]);
    expect(Array.from(avcc.subarray(4, 10))).toEqual(SPS);
    // PPS 长度 6
    expect(Array.from(avcc.subarray(10, 14))).toEqual([0, 0, 0, 6]);
    expect(Array.from(avcc.subarray(14, 20))).toEqual(PPS);
  });

  it('长度前缀与数据总长度自洽', () => {
    const avcc = annexBToAvcc(annexB([SPS, PPS]));
    let offset = 0;
    let count = 0;
    while (offset + 4 <= avcc.length) {
      const length =
        ((avcc[offset] ?? 0) << 24) |
        ((avcc[offset + 1] ?? 0) << 16) |
        ((avcc[offset + 2] ?? 0) << 8) |
        (avcc[offset + 3] ?? 0);
      offset += 4 + length;
      count += 1;
    }
    expect(offset).toBe(avcc.length);
    expect(count).toBe(2);
  });

  it('没有起始码时原样返回', () => {
    const raw = Uint8Array.from([9, 9, 9]);
    expect(annexBToAvcc(raw)).toBe(raw);
  });
});

describe('buildAvcDescription', () => {
  it('按 ISO/IEC 14496-15 生成 AVCDecoderConfigurationRecord', () => {
    const description = buildAvcDescription(Uint8Array.from(SPS), Uint8Array.from(PPS));

    expect(description.length).toBe(11 + SPS.length + PPS.length);
    expect(description[0]).toBe(1); // configurationVersion
    expect(description[1]).toBe(0x64); // profile = High
    expect(description[2]).toBe(0x00); // compatibility
    expect(description[3]).toBe(0x28); // level = 4.0
    expect(description[4]).toBe(0xff); // lengthSizeMinusOne = 3
    expect(description[5]).toBe(0xe1); // 1 个 SPS
    expect(description[6]).toBe(0x00);
    expect(description[7]).toBe(SPS.length);
    expect(Array.from(description.subarray(8, 8 + SPS.length))).toEqual(SPS);

    const ppsOffset = 8 + SPS.length;
    expect(description[ppsOffset]).toBe(1); // 1 个 PPS
    expect(description[ppsOffset + 1]).toBe(0x00);
    expect(description[ppsOffset + 2]).toBe(PPS.length);
    expect(Array.from(description.subarray(ppsOffset + 3))).toEqual(PPS);
  });

  it('SPS 过短时抛出可读错误', () => {
    expect(() => buildAvcDescription(Uint8Array.from([0x67]), new Uint8Array())).toThrow(
      /SPS 至少需要 4 字节/,
    );
  });
});

describe('avcCodecString', () => {
  it('由 SPS 推导 profile / level', () => {
    expect(avcCodecString(Uint8Array.from(SPS))).toBe('avc1.640028');
  });

  it('SPS 不完整时退回默认值', () => {
    expect(avcCodecString(Uint8Array.from([0x67]))).toBe('avc1.42E01E');
  });
});

describe('parseConfigPacket', () => {
  it('从 config 包里抽出 SPS 与 PPS', () => {
    const { sps, pps } = parseConfigPacket(annexB([SPS, PPS]));
    expect(sps && Array.from(sps)).toEqual(SPS);
    expect(pps && Array.from(pps)).toEqual(PPS);
  });

  it('夹带 SEI 时仍能挑出参数集', () => {
    const sei = [0x06, 0x05, 0x01];
    const { sps, pps } = parseConfigPacket(annexB([sei, SPS, PPS]));
    expect(sps && Array.from(sps)).toEqual(SPS);
    expect(pps && Array.from(pps)).toEqual(PPS);
  });

  it('只有 SPS 时 pps 为 null', () => {
    const { sps, pps } = parseConfigPacket(annexB([SPS]));
    expect(sps).not.toBeNull();
    expect(pps).toBeNull();
  });
});

describe('pickParameterSets', () => {
  it('按类型分组', () => {
    const units = splitNalUnits(annexB([SPS, PPS, PPS]));
    const { sps, pps } = pickParameterSets(units);
    expect(sps).toHaveLength(1);
    expect(pps).toHaveLength(2);
  });
});

describe('fallbackCodecString', () => {
  it('已知编码各有对应字符串', () => {
    expect(fallbackCodecString('h265')).toBe('hev1.1.6.L93.B0');
    expect(fallbackCodecString('av1')).toBe('av01.0.04M.08');
    expect(fallbackCodecString('vp8')).toBe('vp8');
    expect(fallbackCodecString('vp9')).toBe('vp09.00.10.08');
  });

  it('未知编码退回 H.264', () => {
    expect(fallbackCodecString('unknown')).toBe('avc1.42E01E');
  });
});
