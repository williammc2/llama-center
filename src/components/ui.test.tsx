import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SettingToggle, FlagToggle } from './ui'

describe('SettingToggle', () => {
  afterEach(cleanup)

  it('renders label and hint', () => {
    render(<SettingToggle label="Test" hint="Test hint" value={true} onChange={() => {}} />)
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(screen.getByText('Test hint')).toBeInTheDocument()
  })

  it('calls onChange when toggled', () => {
    const onChange = vi.fn()
    const { container } = render(<SettingToggle label="Test" hint="Hint" value={false} onChange={onChange} />)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    checkbox.click()
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('FlagToggle', () => {
  afterEach(cleanup)

  it('renders label', () => {
    render(<FlagToggle label="Test flag" checked={true} onChange={() => {}} />)
    expect(screen.getByText('Test flag')).toBeInTheDocument()
  })

  it('calls onChange with true when checked', () => {
    const onChange = vi.fn()
    const { container } = render(<FlagToggle label="Test" checked={false} onChange={onChange} />)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    checkbox.click()
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('calls onChange with undefined when unchecked', () => {
    const onChange = vi.fn()
    const { container } = render(<FlagToggle label="Test" checked={true} onChange={onChange} />)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    checkbox.click()
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
