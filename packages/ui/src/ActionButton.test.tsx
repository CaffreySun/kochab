import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionButton } from './ActionButton';

describe('ActionButton', () => {
  it('禁用时仍然渲染为 button 元素（而不是 div）', () => {
    render(<ActionButton disabled>投屏</ActionButton>);

    const button = screen.getByRole('button', { name: '投屏' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toBeDisabled();
  });

  it('非禁用时正常渲染', () => {
    render(<ActionButton variant="outline">刷新</ActionButton>);

    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
  });
});
