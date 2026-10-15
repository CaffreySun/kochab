import { Button } from 'tdesign-react';
import type { ComponentProps, ReactElement } from 'react';

/**
 * TDesign `Button` 在 `disabled` 为真时会把根节点渲染成 `<div>`（见 tdesign-react
 * `button.js` 的 `renderTag`），这会丢失 button 的语义角色与不可聚焦能力，
 * 对键盘操作与读屏软件都不友好。
 *
 * 这里统一强制 `tag="button"`，让禁用态仍然是真正的 `<button disabled>`。
 */
export type ActionButtonProps = Omit<ComponentProps<typeof Button>, 'tag'>;

export function ActionButton(props: ActionButtonProps): ReactElement {
  return <Button tag="button" {...props} />;
}
