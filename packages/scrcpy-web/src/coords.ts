/**
 * 画布坐标 ↔ 设备像素坐标的映射。
 *
 * 投屏画布按设备原始宽高比「letterbox」居中显示，因此 CSS 像素与设备像素
 * 之间存在缩放与偏移。所有指针事件都必须经过本模块换算后才能发给设备，
 * 否则在高 DPI 或窗口缩放时会出现点击偏移。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 元素在视口中的位置与 CSS 尺寸 */
export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 在容器内按比例居中显示 frame 所占的实际矩形 */
export interface VideoLayoutRect {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  /** frame 缩放到实际显示尺寸的比例因子 */
  scale: number;
}

const isPositive = (n: number) => Number.isFinite(n) && n > 0;

/**
 * 计算 frame 在 container 内的 letterbox 显示矩形。
 *
 * 始终保持宽高比，多余空间均分为上下/左右留白。
 */
export function computeVideoLayout(frame: Size, container: Size): VideoLayoutRect {
  if (!isPositive(frame.width) || !isPositive(frame.height)) {
    throw new RangeError('视频尺寸必须为正数');
  }
  if (!isPositive(container.width) || !isPositive(container.height)) {
    return { offsetX: 0, offsetY: 0, width: 0, height: 0, scale: 0 };
  }

  const scale = Math.min(container.width / frame.width, container.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;

  return {
    offsetX: (container.width - width) / 2,
    offsetY: (container.height - height) / 2,
    width,
    height,
    scale,
  };
}

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

/**
 * 把视口坐标换算为设备像素坐标。
 *
 * @param point 指针事件的 clientX / clientY
 * @param canvas 画布元素在视口中的矩形
 * @param frame  设备原始分辨率
 * @returns 设备坐标系下的整数坐标；点落在 letterbox 留白区时会被夹取到画面边缘
 */
export function clientPointToDevice(point: Point, canvas: ElementRect, frame: Size): Point {
  if (!isPositive(canvas.width) || !isPositive(canvas.height)) {
    throw new RangeError('画布尺寸必须为正数');
  }

  const scaleX = frame.width / canvas.width;
  const scaleY = frame.height / canvas.height;

  const x = Math.floor((point.x - canvas.left) * scaleX);
  const y = Math.floor((point.y - canvas.top) * scaleY);

  return {
    x: clamp(x, 0, frame.width - 1),
    y: clamp(y, 0, frame.height - 1),
  };
}

/**
 * 把设备像素坐标反算为 CSS 像素坐标（用于绘制点击涟漪、按键指示等本地反馈）。
 */
export function devicePointToClient(point: Point, canvas: ElementRect, frame: Size): Point {
  if (!isPositive(canvas.width) || !isPositive(canvas.height)) {
    throw new RangeError('画布尺寸必须为正数');
  }

  const scaleX = canvas.width / frame.width;
  const scaleY = canvas.height / frame.height;

  return {
    x: canvas.left + point.x * scaleX,
    y: canvas.top + point.y * scaleY,
  };
}

/** 判断一个点是否落在 letterbox 留白区域内（即无效点击） */
export function isOutsideVideo(point: Point, canvas: ElementRect, frame: Size): boolean {
  const layout = computeVideoLayout(frame, { width: canvas.width, height: canvas.height });
  const localX = point.x - canvas.left;
  const localY = point.y - canvas.top;

  return (
    localX < layout.offsetX ||
    localY < layout.offsetY ||
    localX > layout.offsetX + layout.width ||
    localY > layout.offsetY + layout.height
  );
}
